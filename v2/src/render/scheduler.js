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

import { todo } from "../core/todo.js";

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
  }

  /** Start a runtime for every enabled device, concurrently, and begin to follow changes. Resolves without waiting for any display. */
  async start() {
    return todo("Scheduler.start");
  }

  /**
   * @param {{deadlineMs?: number}} [options] default 6000
   * @returns {Promise<void>}
   */
  async stop(options) {
    return todo("Scheduler.stop", options);
  }

  /**
   * @param {string} name
   * @returns {import("./render-loop.js").RenderLoop|undefined}
   */
  loop(name) {
    return todo("Scheduler.loop", name);
  }

  /**
   * Measured liveness of the supervision itself. main.js feeds it into the
   * controller health (health-model.js controller()), which decides between
   * 200 and 503 for GET /api/health.
   *
   * @returns {{devices: number, loopsAlive: number, restarts: number, lastWatchdogAt: string|null, watchdogIntervalMs: number}}
   */
  status() {
    return todo("Scheduler.status");
  }
}
