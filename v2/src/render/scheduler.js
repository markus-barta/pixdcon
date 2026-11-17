/**
 * Scheduler: supervises one runtime per device and applies changes per device.
 *
 * A device runtime is {driver, render loop, preview feed, telemetry poller}.
 * It is built from the EffectiveDevice (types.js): the device entry as it
 * runs, with blob patches applied and the output resolved. The scheduler
 * never reads config.json for a device, so a blob entry that changes
 * `minFrameMs` or `powerCyclePlugin`, and a device that exists only in the
 * blob, behave like any other (A-071, C-055).
 *
 * The scheduler listens to the state store's "desired" events (scene, mode,
 * brightness) and to the runtime config's "changed" events (everything else,
 * with a diff per device) and does the least that is needed, for that device
 * only:
 *
 *   change (see config/schema.js changeImpact)        action
 *   ------------------------------------------------  -----------------------------------------
 *   scene, mode, brightness override                  loop.apply(), no restart
 *   saved scene settings                              settings service notifies the scene, no restart (A-102)
 *   displayName, comment, preview.showGrid            nothing running changes
 *   preview.pollMs                                    preview feed re-armed
 *   address, type, output, enabled, minFrameMs,       this device's runtime is stopped and built again;
 *   power-cycle options, cleanupLegacyApps            its last preview frame stays, marked by age (B-052).
 *                                                     output changes also when v1 releases or takes back a display (interlock)
 *   device added / removed                            runtime started / stopped; retained artefacts of a removed device are listed, not silently left (C-079)
 *   scene file or scene registry changed              reloadScene() on the loops that run it (A-033, B-022)
 *
 * Isolation (the brief's rule "one device's failure never stops others"):
 *  - devices start concurrently, after the HTTP server is up (A-019, A-BUG-12)
 *  - every action runs in the device's own queue with its own deadline;
 *    an exception or a timeout is logged for that device and ends there
 *  - a watchdog checks every loop's `alive` and `nextWakeAt`; a loop that died
 *    or is overdue is restarted and reported (A-027: v1 left it dead and green)
 *    The tick is 1 s; grace is 30 s after a planned wake, or 60 s without one.
 *    A factory that failed is retried after 10 s, without resetting health's age.
 *  - v1 stopped and started every device on any config or overlay change
 *    (A-030, A-032, B-047, S-15); v2 never does
 *
 * Shutdown: stop loops (bounded), then telemetry and previews. The whole
 * process keeps v1's 8 s limit (A-035).
 *
 * Order (core/ordering.js).
 *  - runtime "changed" is applied only when `effective.rev` is higher than
 *    the one the scheduler holds; state "desired" events of one device are
 *    applied in the order they arrive, in the device's queue.
 *  - Every device runtime gets a token, a number that rises with every
 *    runtime the scheduler builds for that device, and the scheduler tells
 *    the state store (`state.runtimeStarted(name, token)`). What a runtime
 *    reports reaches the state store, the health model and the preview
 *    store only through `whileCurrent()` (core/ordering.js): a render that
 *    hung and comes back after its runtime was replaced (another address,
 *    another output) reports into nothing. Its frame is not a good frame of
 *    the new runtime, and its phase does not overwrite the new one.
 *  - What a key of the diff needs is asked from `factories.changeImpact`
 *    (config/schema.js through main.js), not worked out here.
 *  - The watchdog is a timer: it restarts a loop that is dead or overdue by
 *    its own measured times; it never changes what a device should show.
 *
 * Owner: drivers worker.
 */

import { createLane, decideStamp, whileCurrent } from "../core/ordering.js";
import { NotImplementedError } from "../core/todo.js";
import { DeviceError } from "../core/errors.js";
import { RenderLoop } from "./render-loop.js";

/**
 * @typedef {object} SchedulerDeps
 * @property {import("../state/state-store.js").StateStore} state desired state per device, and where the loops report
 * @property {import("../state/runtime-config.js").RuntimeConfig} runtime the devices as they run; "changed" with a diff
 * @property {Pick<import("../types.js").Factories, "createDriver"|"createSurface"|"rasterizeAwtrixApp"|"changeImpact">} factories what the device runtimes are built with, and the classification of changed keys (main.js)
 * @property {import("../scenes/scene-runtime.js").SceneRuntime} scenes
 * @property {import("./preview-store.js").PreviewStore} previews
 * @property {import("../health/health-model.js").HealthModel} health
 * @property {import("../health/telemetry.js").TelemetryCollector|null} telemetry
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway|null} mqtt
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

export class Scheduler {
  /** @param {SchedulerDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.active = false;
    this.rev = -1;
    this.restarts = 0;
    this.lastWatchdogAt = /** @type {string|null} */ (null);
    this.watchdogIntervalMs = 1000;
    /** @type {Map<string, ReturnType<typeof createLane>>} */
    this.queues = new Map();
    /** @type {Map<string, number>} */
    this.tokens = new Map();
    /** @type {Map<string, import('../types.js').EffectiveDevice>} */
    this.expected = new Map();
    /** @type {Map<string, number>} */
    this.retryAfter = new Map();
    /** @type {Map<string, {token: number, device: import('../types.js').EffectiveDevice, driver: import('../drivers/driver.js').DeviceDriver, loop: RenderLoop, stopFeed: () => void}>} */
    this.runtimes = new Map();
    this.timer = /** @type {{cancel: () => void}|null} */ (null);
    /** @param {{effective: import('../types.js').EffectiveConfig, diff: import('../types.js').EffectiveDiff}} change */
    this.onChanged = ({ effective, diff }) => {
      if (!this.active || decideStamp({ source: "effective", position: this.rev }, { source: "effective", position: effective.rev }).action !== "apply") return;
      this.rev = effective.rev;
      this.expected = new Map(effective.devices.filter((device) => device.enabled).map((device) => [device.name, device]));
      for (const name of diff.devicesRemoved) this.enqueue(name, async () => { await this.retire(name); this.deps.previews.remove(name); this.deps.health.unregister(name); });
      for (const name of diff.devicesAdded) {
        const device = effective.devices.find((entry) => entry.name === name);
        if (device) this.enqueue(name, () => this.build(device));
      }
      for (const [name, keys] of Object.entries(diff.devicesChanged)) {
        const device = effective.devices.find((entry) => entry.name === name);
        if (!device) continue;
        const impacts = keys.map((key) => this.deps.factories.changeImpact(key));
        this.enqueue(name, async () => {
          if (impacts.includes("restart")) {
            if (this.runtimes.get(name)?.device === device) return;
            await this.retire(name); await this.build(device);
          }
          else {
            const record = this.runtimes.get(name);
            if (record && impacts.includes("preview")) {
              record.stopFeed();
              record.stopFeed = record.driver.info.drives && record.driver.readScreen ? this.deps.previews.feedFromDevice(name, record.driver, device.preview.pollMs) : () => {};
            }
            // SettingsService owns saved setting notifications; no scene replacement here.
          }
        });
      }
      const scenes = new Set([...diff.scenesChanged, ...diff.scenesRemoved]);
      for (const [name, record] of this.runtimes) if (scenes.has(record.loop.target.scene ?? "")) this.enqueue(name, () => record.loop.reloadScene());
    };
    /** @param {{name: string, desired: import('../types.js').DesiredState, changed: string[]}} event */
    this.onDesired = ({ name, desired, changed }) => {
      const target = this.targetOf(desired, this.deps.runtime.device(name)?.type ?? "pixoo");
      this.enqueue(name, () => {
        const loop = this.runtimes.get(name)?.loop;
        if (!loop) return;
        const patch = {};
        if (changed.some((key) => key === "scene" || key.startsWith("scene."))) Object.assign(patch, { scene: target.scene });
        if (changed.some((key) => key === "mode" || key.startsWith("mode."))) Object.assign(patch, { mode: target.mode });
        if (changed.some((key) => key === "brightness" || key.startsWith("brightness."))) Object.assign(patch, { brightnessOverride: target.brightnessOverride });
        loop.apply(patch);
      });
    };
    /** @param {{name: string}} event */
    this.onRetry = ({ name }) => this.enqueue(name, () => this.runtimes.get(name)?.loop.retryNow());
    /** @param {{device: string, health: import('../types.js').DeviceHealth}} event */
    this.onHealth = ({ device, health }) => { if (this.active) this.deps.state.reportHealth(device, health); };
  }

  /** Start a runtime for every enabled device, concurrently, and begin to follow changes. Resolves without waiting for any display. */
  async start() {
    if (this.active) return;
    const effective = this.deps.runtime.get();
    this.rev = effective.rev;
    this.active = true;
    this.expected = new Map(effective.devices.filter((device) => device.enabled).map((device) => [device.name, device]));
    this.deps.runtime.on("changed", this.onChanged);
    this.deps.state.on("desired", this.onDesired);
    this.deps.state.on("retry", this.onRetry);
    this.deps.health.on("health", this.onHealth);
    for (const device of effective.devices) this.enqueue(device.name, () => this.build(device));
    this.lastWatchdogAt = new Date(this.deps.clock.now()).toISOString();
    this.timer = this.deps.clock.every(() => this.watchdog(), this.watchdogIntervalMs);
  }

  /**
   * @param {{deadlineMs?: number}} [options] default 6000
   * @returns {Promise<void>}
   */
  async stop(options) {
    this.active = false;
    this.expected.clear();
    this.timer?.cancel(); this.timer = null;
    this.deps.runtime.off("changed", this.onChanged);
    this.deps.state.off("desired", this.onDesired);
    this.deps.state.off("retry", this.onRetry);
    this.deps.health.off("health", this.onHealth);
    for (const lane of this.queues.values()) lane.close();
    // Invalidate all report views before waiting for any old render.
    const records = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(records.map(async (record) => {
      record.stopFeed();
      await record.loop.stop(options);
      this.deps.telemetry?.stop(record.device.name);
      await record.driver.close();
    }));
    await Promise.all([...this.queues.values()].map((lane) => lane.drain()));
    this.queues.clear();
  }

  /**
   * @param {string} name
   * @returns {import("./render-loop.js").RenderLoop|undefined}
   */
  loop(name) {
    return this.runtimes.get(name)?.loop;
  }

  /**
   * Measured liveness of the supervision itself. main.js feeds it into the
   * controller health (health-model.js controller()), which decides between
   * 200 and 503 for GET /api/health.
   *
   * @returns {{devices: number, loopsAlive: number, restarts: number, lastWatchdogAt: string|null, watchdogIntervalMs: number}}
   */
  status() {
    // Composition's skeleton adapter reports unmeasured until RuntimeConfig can start us.
    if (this.lastWatchdogAt === null) throw new NotImplementedError("Scheduler awaiting runtime config");
    return { devices: this.expected.size, loopsAlive: [...this.runtimes.values()].filter((record) => record.loop.status().alive).length, restarts: this.restarts, lastWatchdogAt: this.lastWatchdogAt, watchdogIntervalMs: this.watchdogIntervalMs };
  }

  /** @param {string} name @param {() => unknown} task */
  enqueue(name, task) {
    if (!this.active) return;
    let lane = this.queues.get(name);
    if (!lane) {
      lane = createLane({ onError: (_, error) => {
        this.deps.logger.error(`[Scheduler] ${name}`, error);
        this.retryAfter.set(name, this.deps.clock.now() + 10000);
        const device = this.expected.get(name);
        if (device && !this.deps.health.get(name)) {
          this.deps.health.register(name, { shadow: device.output.mode === "shadow", powerCycleMax: device.maxPowerCycles, plugTopic: device.powerCyclePlugin?.topic ?? null });
          this.deps.health.expect(name, { framesDue: true, hasScene: !!device.savedScene });
        }
        this.deps.health.renderFailed(name, error);
      } });
      this.queues.set(name, lane);
    }
    void lane.run(name, task);
  }

  /** @param {import('../types.js').DesiredState} desired @param {import('../types.js').DeviceType} type @returns {import('./render-loop.js').LoopTarget} */
  targetOf(desired, type) {
    const percent = desired.brightness.override;
    return { scene: desired.scene.scene, mode: desired.mode.value, brightnessOverride: percent === null ? null : type === "pixoo" ? percent : Math.round(percent * 255 / 100) };
  }

  /** @param {import('../types.js').EffectiveDevice} device */
  async build(device) {
    if (!this.active || !device.enabled) return;
    const name = device.name;
    const token = (this.tokens.get(name) ?? 0) + 1;
    this.tokens.set(name, token);
    this.deps.state.runtimeStarted(name, token);
    const current = () => this.active && this.runtimes.get(name)?.token === token;
    const driver = this.deps.factories.createDriver({ ...device, output: device.output.mode }, { clock: this.deps.clock, logger: this.deps.logger, rasterizeAwtrixApp: this.deps.factories.rasterizeAwtrixApp });
    // Rare scene pass-throughs (channel, power, notify) obey the same runtime fence.
    const driverView = new Proxy(driver, { get(target, key) {
      const member = Reflect.get(target, key);
      if (typeof member !== "function") return member;
      if (key === "close") return member.bind(target);
      return (/** @type {unknown[]} */ ...args) => current() ? member.apply(target, args) : Promise.reject(new DeviceError("Device runtime retired", { device: name }));
    } });
    const health = /** @type {import('../health/health-model.js').HealthModel} */ (whileCurrent(current, this.deps.health, ["frameOk", "contactOk", "renderFailed", "expect", "powerCycles"]));
    const previews = /** @type {import('./preview-store.js').PreviewStore} */ (whileCurrent(current, this.deps.previews, ["put"]));
    const report = whileCurrent(current, { report: (/** @type {Partial<import('../types.js').EffectiveState>} */ patch) => { this.deps.state.reportEffective(name, patch, token); } }, ["report"]).report;
    const desired = this.deps.state.get(name)?.desired;
    const target = desired ? this.targetOf(desired, device.type) : { scene: device.savedScene, mode: /** @type {const} */ ("play"), brightnessOverride: null };
    const loop = new RenderLoop({ device: { ...device, output: device.output.mode }, driver: driverView, createSurface: this.deps.factories.createSurface, scenes: this.deps.scenes, health, previews, report, mqtt: this.deps.mqtt, clock: this.deps.clock, logger: this.deps.logger, probeIntervalMs: () => this.deps.runtime.get().health.probeIntervalMs }, target);
    const record = { device, token, driver, loop, stopFeed: () => {} };
    this.runtimes.set(name, record);
    this.retryAfter.delete(name);
    this.deps.health.register(name, { shadow: device.output.mode === "shadow", powerCycleMax: device.maxPowerCycles, plugTopic: device.powerCyclePlugin?.topic ?? null });
    if (device.output.mode === "drive") {
      if (driver.readScreen) record.stopFeed = this.deps.previews.feedFromDevice(name, driver, device.preview.pollMs);
      this.deps.telemetry?.start(device, driver, health);
    }
    loop.start();
  }

  /** @param {string} name */
  async retire(name) {
    const record = this.runtimes.get(name);
    if (!record) return;
    this.runtimes.delete(name);
    this.deps.health.unregister(name);
    record.stopFeed();
    this.deps.telemetry?.stop(name);
    const stopping = record.loop.stop();
    // Retirement revokes queued transport work immediately, including a drive → shadow change.
    await record.driver.close();
    await stopping;
  }

  watchdog() {
    if (!this.active) return;
    const now = this.deps.clock.now();
    this.lastWatchdogAt = new Date(now).toISOString();
    for (const [name, record] of this.runtimes) {
      const status = record.loop.status();
      const deadline = status.nextWakeAt ? Date.parse(status.nextWakeAt) + 30000 : Date.parse(status.lastTickAt ?? this.lastWatchdogAt) + 60000;
      if (!status.alive || now > deadline) {
        // Mark once, before the queued stop, so watchdog ticks cannot enqueue repeated restarts.
        this.restarts += 1;
        this.deps.logger.warn(`[Scheduler] ${name}: loop ${status.alive ? "overdue" : "dead"}, restarting`);
        this.runtimes.delete(name);
        this.enqueue(name, async () => {
          record.stopFeed(); this.deps.telemetry?.stop(name);
          const stopping = record.loop.stop(); await record.driver.close(); await stopping;
          const device = this.deps.runtime.device(name);
          if (device) await this.build(device);
        });
      }
    }
    for (const [name, device] of this.expected) {
      if (this.runtimes.has(name) || (this.queues.get(name)?.pending() ?? 0) > 0 || now < (this.retryAfter.get(name) ?? 0)) continue;
      this.restarts += 1;
      this.enqueue(name, () => this.build(device));
    }
  }
}
