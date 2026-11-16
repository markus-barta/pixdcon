/**
 * Scheduler: supervises one runtime per device and applies changes per device.
 *
 * A device runtime is {driver, render loop, preview feed, telemetry poller}.
 * The scheduler listens to the state store's "desired" events and to config
 * diffs and does the least that is needed, for that device only:
 *
 *   change (see config/schema.js changeImpact)        action
 *   ------------------------------------------------  -----------------------------------------
 *   scene, mode, brightness override                  loop.apply(), no restart
 *   saved scene settings                              settings service notifies the scene, no restart (A-102)
 *   displayName, comment, preview.showGrid            nothing running changes
 *   preview.pollMs                                    preview feed re-armed
 *   address, type, output, enabled, minFrameMs,       this device's runtime is stopped and built again;
 *   power-cycle options, cleanupLegacyApps            its last preview frame stays, marked by age (B-052)
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
 * Owner: drivers worker.
 */

import { todo } from "../core/todo.js";

/**
 * @typedef {object} SchedulerDeps
 * @property {import("../state/state-store.js").StateStore} state
 * @property {import("../config/config-store.js").ConfigStore} config
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
   * Measured liveness of the supervision itself, for GET /api/health.
   *
   * @returns {{devices: number, loopsAlive: number, restarts: number, lastWatchdogAt: string|null}}
   */
  status() {
    return todo("Scheduler.status");
  }
}
