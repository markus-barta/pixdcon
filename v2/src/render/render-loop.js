/**
 * Render loop: one per device. Runs the scene, paces the frames, recovers.
 *
 * Kept from v1 (src/render-loop.js; matrix B-023 to B-048, D-113 to D-132):
 *  - a loop exists for every enabled device, also while the display is unreachable
 *  - frame pacing: after a good frame sleep max(delay the scene returned, minFrameMs − render time); minFrameMs default 500
 *  - a scene or mode change takes effect at the next frame boundary and cuts every sleep short (B-026, B-048)
 *  - errors: wait 1, 2, 4, 8, 16, 30, 30 … s (cap 30 s); during a wait probe the display every 10 s and stop waiting when it answers (B-030 to B-032)
 *  - breaker: after 10 failures in a row, with a power-cycle plug and MQTT connected:
 *    publish offPayload, wait offWaitMs (10 s), publish onPayload (always, also when stopped meanwhile), wait onWaitMs (30 s), force a re-init; at most maxPowerCycles (10) in a row (B-034, D-122 to D-125)
 *    without a plug: one more wait with probing, then start counting again (B-033)
 *  - modes: pause = render one frame, then hold; stop = blank, power or screen off; play = power on, init, reclaim;
 *    play while playing = re-init (B-036 to B-040). Stop and pause keep the scene instance (B-171).
 *  - built-in modes: hand the display to its firmware and push nothing (B-041, B-042)
 *  - brightness override replaces what the scene asks for (B-043)
 *  - after every frame: is my scene instance still the current one? If not, reload (B-045)
 *
 * Fixed:
 *  - Only a DeviceError counts towards the breaker and the power cycle. A scene
 *    that fails to import, to init or to render is a SceneError: the display
 *    stays claimed, the last good frame stays up, the error is shown, and no
 *    plug is switched (S-6, B-022, B-030). A scene may reject with null (S-36).
 *  - Every return value of render() gets the frame floor: a number > 0 is the
 *    delay, anything else (undefined, 0, negative, NaN, null) means "again
 *    after minFrameMs". A scene can no longer spin the process (S-7, B-009).
 *  - Mode and brightness are known before the first frame (S-11).
 *  - On clearing the brightness override, the level the scene last asked for
 *    is applied again (S-12, D-B10). A failed brightness call is retried with
 *    the next frame instead of being remembered as done (S-13).
 *  - Built-in activation is checked; failures retry with their own counter
 *    that never triggers a power cycle (D-B04, D-B28). Stop works without a scene (S-34).
 *  - Power cycles used up: phase "exhausted", probing every 60 s, and
 *    retryNow() or a good probe starts over (v1: dead until restart, B-035, S-8).
 *    The log says what was really sent (D-B16).
 *  - stop() has a deadline; a render that hangs cannot block the process (B-044, A-028).
 *  - Output "shadow": no MQTT publish, so no power cycle, ever. `device.output`
 *    is the resolved policy, the same value that selected the driver.
 *  - A good frame is reported to the health model as a fact, without the
 *    delay the scene asked for: health is by the clock since the last good
 *    frame (stale 30 s, offline 2 min), whatever a scene returns. A scene
 *    that asks for a delay of 30 s or more shows as stale between its frames;
 *    the longest delay of a shipped scene is 1 s.
 *
 * The loop reports, it does not judge: it tells the health model about every
 * good frame, contact and error, and the state store about its phase.
 *
 * Order (core/ordering.js). A loop belongs to one device runtime. What it
 * is given as `health`, `previews` and `report` are the scheduler's views
 * of them for that runtime (whileCurrent): once the runtime was replaced,
 * calls through them do nothing. So a render that hung and comes back late
 * cannot report a good frame, a phase or a preview for the runtime that
 * took its place. Every sleep and every wait in here is a timer: it decides
 * when the next frame, probe or plug step happens, never what the display's
 * state is; that is measured (a frame accepted, a probe answered).
 *
 * Owner: drivers worker.
 */

import { DeviceError, SceneError } from "../core/errors.js";
import { isBuiltin } from "../drivers/builtin-modes.js";

/** @typedef {import("../types.js").PlaybackMode} PlaybackMode */
/** @typedef {import("../types.js").EffectiveState} EffectiveState */

/** v1 timing constants. Changing one changes how recovery feels on the real displays. */
export const LOOP_DEFAULTS = Object.freeze({
  minFrameMs: 500,
  initialBackoffMs: 1000,
  maxBackoffMs: 30000,
  probeIntervalMs: 10000,
  breakerErrors: 10,
  maxPowerCycles: 10,
  powerOffWaitMs: 10000,
  powerOnWaitMs: 30000,
  exhaustedProbeMs: 60000,
  stopDeadlineMs: 6000,
});

/**
 * @typedef {object} LoopTarget What the loop should do; set by the scheduler from DesiredState.
 * @property {string|null} scene registered scene key, "builtin:<mode>" or null
 * @property {PlaybackMode} mode
 * @property {number|null} brightnessOverride native units, null = the scene decides
 */

/**
 * @typedef {object} RenderLoopDeps
 * @property {{name: string, type: import("../types.js").DeviceType, address: string, output: import("../types.js").OutputMode, minFrameMs: number, maxPowerCycles: number, powerCyclePlugin: import("../types.js").PowerCyclePlugin|null}} device taken from the EffectiveDevice (types.js); output is its `output.mode`
 * @property {import("../drivers/driver.js").DeviceDriver} driver
 * @property {import("../types.js").Factories["createSurface"]} createSurface the object a scene draws on; the loop passes itself as the SurfaceSink (scenes/v1-device-facade.js) and creates one surface per driver
 * @property {import("../scenes/scene-runtime.js").SceneRuntime} scenes
 * @property {import("./preview-store.js").PreviewStore} previews
 * @property {import("../health/health-model.js").HealthModel} health
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway|null} mqtt used for the power-cycle plug only
 * @property {(patch: Partial<EffectiveState>) => void} report to the state store
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

export class RenderLoop {
  /**
   * @param {RenderLoopDeps} deps
   * @param {LoopTarget} target the first target; known before the first frame
   */
  constructor(deps, target) {
    this.deps = deps;
    this.target = { ...target };
    this.driver = deps.driver;
    this.running = false;
    this.alive = false;
    this.version = 0;
    this.reinit = true;
    this.reload = false;
    this.retry = false;
    this.deviceErrors = 0;
    this.errors = 0;
    this.cycles = 0;
    this.pausedFrame = false;
    this.lastSceneBrightness = /** @type {number|null} */ (null);
    this.appliedNative = /** @type {number|null} */ (null);
    this.instance = /** @type {import('../scenes/scene-runtime.js').SceneInstance|null} */ (null);
    this.surface = /** @type {import('../scenes/v1-device-facade.js').SceneSurface|null} */ (null);
    this.sleeper = /** @type {AbortController|null} */ (null);
    this.task = /** @type {Promise<void>|null} */ (null);
    this.quietKey = "";
    this.lastTickAt = /** @type {string|null} */ (null);
    this.nextWakeAt = /** @type {string|null} */ (null);
    /** @type {EffectiveState} */
    this.effective = { scene: null, phase: "idle", showingSince: null, frameCount: 0, lastBrightness: null, appliedBrightness: null, nextRetryAt: null };
  }

  /** Start the loop task. Returns at once and never throws; the task ends only through stop(). */
  start() {
    if (this.running) return;
    this.running = this.alive = true;
    this.task = this.run().catch((error) => {
      this.deps.logger.error(`[RenderLoop] ${this.deps.device.name}: loop ended`, error);
    }).finally(() => { this.alive = false; });
  }

  /**
   * Stop after the frame in flight, release the scene instance.
   *
   * @param {{deadlineMs?: number}} [options] default LOOP_DEFAULTS.stopDeadlineMs
   * @returns {Promise<{clean: boolean}>} clean false when the deadline cut a hanging render loose
   */
  async stop(options) {
    this.running = false;
    this.sleeper?.abort();
    if (!this.task) return { clean: true };
    const deadline = new AbortController();
    const clean = await Promise.race([
      this.task.then(() => true),
      this.deps.clock.sleep(options?.deadlineMs ?? LOOP_DEFAULTS.stopDeadlineMs, deadline.signal).then(() => false),
    ]);
    deadline.abort();
    if (!clean) {
      this.alive = false;
      void this.driver.close();
      // A stuck render must not keep its subscriptions alive during shutdown.
      if (this.instance) {
        const instance = this.instance; this.instance = null;
        void this.deps.scenes.release(instance).catch((error) => this.deps.logger.error("[RenderLoop] release", error));
      }
    }
    return { clean };
  }

  /**
   * Change scene, mode or brightness override. Idempotent; wakes every sleep.
   * Setting mode "play" while playing asks for a re-init (v1).
   *
   * @param {Partial<LoopTarget>} patch
   */
  apply(patch) {
    const changed = Object.entries(patch).some(([key, value]) => this.target[/** @type {keyof LoopTarget} */ (key)] !== value);
    const playAgain = patch.mode === "play" && this.target.mode === "play";
    if (!changed && !playAgain) return;
    if (playAgain) this.retry = true;
    const sceneChanged = patch.scene !== undefined && patch.scene !== this.target.scene;
    if (sceneChanged) this.effective.showingSince = null;
    if (patch.mode === "play" || sceneChanged) this.reinit = true;
    if (sceneChanged || patch.mode !== undefined) this.pausedFrame = false;
    this.target = { ...this.target, ...patch };
    this.version += 1;
    this.sleeper?.abort();
  }

  /** "Retry now": leave any wait, re-initialise the display, start counting again. */
  retryNow() {
    this.retry = true;
    this.sleeper?.abort();
  }

  /** The scene file changed or its settings schema did: reload at the next frame boundary. */
  reloadScene() {
    this.reload = true;
    this.pausedFrame = false;
    this.sleeper?.abort();
  }

  /**
   * @returns {EffectiveState & {alive: boolean, lastTickAt: string|null, nextWakeAt: string|null, consecutiveErrors: number, powerCycleCount: number}}
   * alive false: the task is not running although it should; the scheduler restarts it (A-027)
   */
  status() {
    return { ...this.effective, alive: this.alive, lastTickAt: this.lastTickAt, nextWakeAt: this.nextWakeAt, consecutiveErrors: this.errors, powerCycleCount: this.cycles };
  }

  /** @param {Partial<EffectiveState>} patch */
  report(patch) {
    if (!this.running) return;
    Object.assign(this.effective, patch);
    this.deps.report(patch);
  }

  /** @param {import('../drivers/driver.js').DeviceOutput} output */
  async show(output) {
    if (!this.running) return;
    const accepted = output.kind === "frame" ? { ...output, frame: { ...output.frame, rgb: output.frame.rgb.slice() } } : output;
    await this.driver.show(accepted);
    if (!this.running) return;
    const name = this.deps.device.name;
    this.deps.health.frameOk(name);
    if (accepted.kind === "frame") this.deps.previews.put(name, accepted.frame, this.driver.info.drives ? "runtime" : "simulated");
    else if (!this.driver.info.drives) {
      const frame = this.driver.previewFrame?.();
      if (frame) this.deps.previews.put(name, frame, "simulated");
    }
    this.deviceErrors = 0;
    this.cycles = 0;
    this.deps.health.powerCycles(name, { count: 0, exhausted: false });
    this.report({ frameCount: this.effective.frameCount + 1, showingSince: this.effective.showingSince ?? this.iso(), scene: this.instance?.scene ?? this.target.scene });
  }

  /** @param {number} native @returns {Promise<boolean>} */
  async requestBrightness(native) {
    if (!Number.isFinite(native) || !this.running) return false;
    this.lastSceneBrightness = native;
    this.report({ lastBrightness: this.percent(native) });
    try { await this.applyBrightness(); return true; }
    catch (error) {
      if (this.running) this.deps.health.renderFailed(this.deps.device.name, error);
      return false;
    }
  }

  /** @param {number} native */
  percent(native) { return this.deps.device.type === "pixoo" ? Math.max(1, Math.min(100, Math.round(native))) : Math.round(Math.max(0, Math.min(255, native)) / 255 * 100); }
  iso() { return new Date(this.deps.clock.now()).toISOString(); }

  async applyBrightness() {
    const native = this.target.brightnessOverride ?? this.lastSceneBrightness;
    if (native === null || native === this.appliedNative) return;
    await this.driver.setBrightness(native);
    if (!this.running) return;
    this.appliedNative = native;
    this.deps.health.contactOk(this.deps.device.name);
    this.report({ appliedBrightness: this.percent(native) });
  }

  /** @param {number} ms */
  async sleep(ms) {
    if (!this.running) return false;
    const controller = new AbortController();
    this.sleeper = controller;
    this.nextWakeAt = new Date(this.deps.clock.now() + ms).toISOString();
    const elapsed = await this.deps.clock.sleep(ms, controller.signal);
    if (this.sleeper === controller) this.sleeper = null;
    this.nextWakeAt = null;
    return elapsed;
  }

  async probe() {
    try {
      await this.driver.probe();
      if (!this.running) return false;
      this.deps.health.contactOk(this.deps.device.name);
      return true;
    } catch (error) {
      if (this.running) this.deps.health.renderFailed(this.deps.device.name, error);
      return false;
    }
  }

  /** @param {number} ms @param {boolean} [recover] */
  async waitWithProbes(ms, recover = true) {
    const end = this.deps.clock.now() + ms;
    while (this.running && this.deps.clock.now() < end) {
      const interval = Math.min(LOOP_DEFAULTS.probeIntervalMs, end - this.deps.clock.now());
      if (!await this.sleep(interval)) return;
      if (interval === LOOP_DEFAULTS.probeIntervalMs && await this.probe() && recover) return;
    }
  }

  async powerCycle() {
    const { device, mqtt, health } = this.deps;
    const plug = device.powerCyclePlugin;
    if (device.output !== "drive" || !plug || mqtt?.status().state !== "connected") return false;
    const off = await mqtt.publish(plug.topic, plug.offPayload ?? '{"state":"OFF"}', { qos: 1, retain: false });
    if (!off.ok) return false;
    this.cycles += 1;
    health.powerCycles(device.name, { count: this.cycles, exhausted: false });
    this.deps.logger.info(`[RenderLoop] ${device.name}: plug OFF sent`);
    // Once OFF was accepted, ON is owed even if stop interrupts the wait.
    await this.sleep(plug.offWaitMs ?? LOOP_DEFAULTS.powerOffWaitMs);
    const on = await mqtt.publish(plug.topic, plug.onPayload ?? '{"state":"ON"}', { qos: 1, retain: false });
    this.deps.logger[on.ok ? "info" : "warn"](`[RenderLoop] ${device.name}: plug ON ${on.ok ? "sent" : "failed"}`);
    if (this.running) await this.sleep(plug.onWaitMs ?? LOOP_DEFAULTS.powerOnWaitMs);
    this.reinit = true;
    this.appliedNative = null;
    this.deviceErrors = 0;
    return true;
  }

  async run() {
    try {
      while (this.running) {
        this.lastTickAt = this.iso();
        if (this.retry) {
          this.retry = false; this.errors = this.deviceErrors = this.cycles = 0; this.reinit = true;
          this.deps.health.powerCycles(this.deps.device.name, { count: 0, exhausted: false });
        }
        const version = this.version;
        const target = { ...this.target };
        const builtin = isBuiltin(target.scene);
        const custom = !!target.scene && !builtin;
        // A paused scene has frame boundaries too: a new instance gets one fresh frame.
        if (target.mode === "pause" && this.instance && !this.deps.scenes.isCurrent(this.instance)) this.pausedFrame = false;
        this.deps.health.expect(this.deps.device.name, { framesDue: target.mode === "play" && custom, hasScene: !!target.scene });
        try {
          await this.applyBrightness();
          if (!this.running || version !== this.version) continue;
          if (this.instance && this.instance.scene !== target.scene) {
            const old = this.instance; this.instance = null; await this.deps.scenes.release(old);
          }
          if (!this.running || version !== this.version) continue;
          const key = `${target.mode}:${target.scene ?? ""}`;
          if (target.mode === "stop") {
            if (this.quietKey !== key) {
              await this.driver.blank();
              if (!this.running || version !== this.version) continue;
              await this.driver.setPower(false);
              if (!this.running || version !== this.version) continue;
              this.deps.health.contactOk(this.deps.device.name);
              this.quietKey = key; this.reinit = true;
              const { width, height } = this.driver.info;
              this.deps.previews.put(this.deps.device.name, { width, height, rgb: new Uint8Array(width * height * 3) }, this.driver.info.drives ? "runtime" : "simulated");
            }
            this.report({ phase: "stopped", nextRetryAt: null });
          } else if (builtin) {
            if (this.quietKey !== key || this.reinit) {
              await this.driver.activateBuiltin(/** @type {string} */ (target.scene));
              if (!this.running || version !== this.version) continue;
              this.deps.health.contactOk(this.deps.device.name);
              this.quietKey = key; this.reinit = false;
              this.errors = 0;
            }
            this.report({ phase: "builtin", scene: target.scene, nextRetryAt: null });
          } else if (!custom || target.mode === "pause" && this.pausedFrame) {
            this.report({ phase: custom ? "paused" : "idle", scene: target.scene, nextRetryAt: null });
          } else {
            this.report({ phase: this.instance ? "running" : "starting", nextRetryAt: null });
            if (this.reinit || !this.driver.ready) {
              await this.driver.reclaim();
              if (!this.running || version !== this.version) continue;
              this.reinit = false; this.appliedNative = null;
              this.deps.health.contactOk(this.deps.device.name);
              await this.applyBrightness();
            }
            if (!this.surface) this.surface = await this.deps.createSurface(this.deps.device, this);
            if (!this.running || version !== this.version) continue;
            if (!this.instance || this.reload || !this.deps.scenes.isCurrent(this.instance)) {
              const next = await this.deps.scenes.acquire(/** @type {string} */ (target.scene), this.deps.device.name);
              if (!this.running || version !== this.version) { if (next !== this.instance) await this.deps.scenes.release(next); continue; }
              const old = this.instance; this.instance = next; this.reload = false;
              if (old && old !== next) await this.deps.scenes.release(old);
            }
            if (!this.running || version !== this.version) continue;
            const startedAt = this.deps.clock.now();
            const delay = await this.instance.renderFrame(this.surface);
            if (!this.running || version !== this.version) continue;
            this.errors = 0; this.quietKey = ""; this.pausedFrame = true;
            this.report({ phase: target.mode === "pause" ? "paused" : "running", scene: target.scene, nextRetryAt: null });
            const floor = Math.max(1, this.deps.device.minFrameMs ?? LOOP_DEFAULTS.minFrameMs);
            const wait = Math.max(typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? delay : 0, floor - (this.deps.clock.now() - startedAt));
            if (target.mode === "pause" || this.reload || !this.deps.scenes.isCurrent(this.instance)) continue;
            await this.sleep(Math.max(1, wait));
            continue;
          }
          if (await this.sleep(LOOP_DEFAULTS.probeIntervalMs)) await this.probe();
        } catch (error) {
          if (!this.running) break;
          if (version !== this.version || this.retry) continue;
          const classified = error instanceof DeviceError || error instanceof SceneError ? error : new SceneError(error instanceof Error ? error.message : String(error), { cause: error, phase: "render" });
          this.deps.health.renderFailed(this.deps.device.name, classified);
          this.errors += 1;
          if (classified instanceof DeviceError && !builtin) this.deviceErrors += 1;
          else this.deviceErrors = 0;
          if (this.deviceErrors >= LOOP_DEFAULTS.breakerErrors) {
            if (this.cycles >= this.deps.device.maxPowerCycles && this.deps.device.powerCyclePlugin && this.deps.device.output === "drive") {
              this.deps.health.powerCycles(this.deps.device.name, { count: this.cycles, exhausted: true });
              this.report({ phase: "exhausted", nextRetryAt: new Date(this.deps.clock.now() + LOOP_DEFAULTS.exhaustedProbeMs).toISOString() });
              while (this.running && !this.retry && version === this.version) {
                if (!await this.sleep(LOOP_DEFAULTS.exhaustedProbeMs)) break;
                if (await this.probe()) { this.retry = true; break; }
              }
              continue;
            }
            if (await this.powerCycle()) continue;
            this.deviceErrors = 0;
          }
          const backoff = Math.min(LOOP_DEFAULTS.maxBackoffMs, LOOP_DEFAULTS.initialBackoffMs * 2 ** Math.min(30, this.errors - 1));
          this.report({ phase: "retrying", nextRetryAt: new Date(this.deps.clock.now() + backoff).toISOString() });
          await this.waitWithProbes(backoff);
        }
      }
    } finally {
      if (this.instance) { const instance = this.instance; this.instance = null; await this.deps.scenes.release(instance); }
    }
  }
}
