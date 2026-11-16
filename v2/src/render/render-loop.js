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
 *  - Output "shadow": no MQTT publish, so no power cycle, ever.
 *
 * The loop reports, it does not judge: it tells the health model about every
 * good frame, contact and error, and the state store about its phase.
 *
 * Owner: drivers worker.
 */

import { todo } from "../core/todo.js";

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
 * @property {{name: string, type: import("../types.js").DeviceType, output: import("../types.js").OutputMode, minFrameMs: number, maxPowerCycles: number, powerCyclePlugin: import("../types.js").PowerCyclePlugin|null}} device
 * @property {import("../drivers/driver.js").DeviceDriver} driver
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
    this.target = target;
  }

  /** Start the loop task. Returns at once and never throws; the task ends only through stop(). */
  start() {
    return todo("RenderLoop.start");
  }

  /**
   * Stop after the frame in flight, release the scene instance.
   *
   * @param {{deadlineMs?: number}} [options] default LOOP_DEFAULTS.stopDeadlineMs
   * @returns {Promise<{clean: boolean}>} clean false when the deadline cut a hanging render loose
   */
  async stop(options) {
    return todo("RenderLoop.stop", options);
  }

  /**
   * Change scene, mode or brightness override. Idempotent; wakes every sleep.
   * Setting mode "play" while playing asks for a re-init (v1).
   *
   * @param {Partial<LoopTarget>} patch
   */
  apply(patch) {
    return todo("RenderLoop.apply", patch);
  }

  /** "Retry now": leave any wait, re-initialise the display, start counting again. */
  retryNow() {
    return todo("RenderLoop.retryNow");
  }

  /** The scene file changed or its settings schema did: reload at the next frame boundary. */
  reloadScene() {
    return todo("RenderLoop.reloadScene");
  }

  /**
   * @returns {EffectiveState & {alive: boolean, lastTickAt: string|null, nextWakeAt: string|null, consecutiveErrors: number, powerCycleCount: number}}
   * alive false: the task is not running although it should; the scheduler restarts it (A-027)
   */
  status() {
    return todo("RenderLoop.status");
  }
}
