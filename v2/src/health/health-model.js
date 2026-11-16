/**
 * Health model: measured, never assumed.
 *
 * Lesson behind it (matrix index, "silent failure"): a status can show green
 * while the loop behind it is dead. So health here is computed from events
 * that really happened and from how long ago they happened, and the things
 * that produce those events are themselves watched (scheduler watchdog).
 *
 * Per display. The rule is Markus's, taken literally (PIXD-81 approval; it
 * replaces v1's "5 failed renders", B-066, S-14):
 *
 *   With an active scene (mode play and a custom scene), by the clock since
 *   the last frame the display accepted:
 *     less than 30 s              → online   (starting: before the first good frame)
 *     30 s up to less than 2 min  → stale
 *     2 min or more               → offline
 *   Nothing is subtracted and nothing is added: not the delay the scene asked
 *   for, not the render time, not a backoff. The thresholds are inclusive at
 *   their lower end: 29 999 ms is online, 30 000 ms is stale, 119 999 ms is
 *   stale, 120 000 ms is offline. Before the first good frame the same
 *   thresholds count from the start of the runtime (starting, then stale,
 *   then offline).
 *
 *   Without an active scene there are no frames to count: pause, stop, a
 *   built-in mode, no scene chosen. There the render loop probes every
 *   probeIntervalMs (10 s), and the same two thresholds apply to the time
 *   since the last good contact. With no scene chosen and a fresh contact the
 *   state is idle.
 *
 *   output shadow                 → shadow   (not measured)
 *
 * `reason` says why a display is not online: device_unreachable (DeviceError),
 * scene_error (the display answers, the scene fails: no hardware steps, no
 * power cycle, S-6), power_cycles_exhausted, not_started.
 *
 * Controller health for GET /api/health and the Docker HEALTHCHECK (A-161):
 * ok when the scheduler watchdog ran within 2 × its interval; degraded when
 * a driven display is stale or offline, config.json on disk is invalid, a
 * configured broker is offline, or a restart is required; failed when the
 * watchdog is overdue. controller() computes it from inputs that main.js
 * collects every second; main.js owns that wiring (the status in snapshots,
 * 503 for failed, the "controller" live event), so building this model is
 * enough to make the health check real.
 *
 * Events (EventEmitter): "health" ({device: string, health: DeviceHealth, previous: DeviceHealth}).
 *
 * Owner: drivers worker.
 */

import { EventEmitter } from "node:events";
import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").DeviceHealth} DeviceHealth */
/** @typedef {import("../types.js").HealthConfig} HealthConfig */

/**
 * Facts the model keeps per device. Everything is a time or a counter; the
 * state is derived, never stored.
 *
 * @typedef {object} HealthFacts
 * @property {number} startedAt epoch ms when the runtime started
 * @property {number|null} lastFrameAt
 * @property {number|null} lastContactAt
 * @property {boolean} framesDue true with an active scene: mode play and a custom scene
 * @property {boolean} hasScene
 * @property {boolean} shadow
 * @property {number} consecutiveErrors
 * @property {{message: string, kind: "device"|"scene"|"config"|"internal", at: number}|null} lastError
 * @property {{count: number, max: number, plugTopic: string|null, exhausted: boolean}} powerCycles
 * @property {string|null} apSsid
 */

/**
 * The rule above as a pure function, so the stale and offline timing can be
 * tested without a clock.
 *
 * @param {HealthFacts} facts
 * @param {number} now epoch ms
 * @param {HealthConfig} config
 * @returns {{state: import("../types.js").HealthState, reason: DeviceHealth["reason"]}}
 */
export function deriveHealth(facts, now, config) {
  return todo("deriveHealth", facts, now, config);
}

export class HealthModel extends EventEmitter {
  /** @param {{config: () => HealthConfig, clock: import("../types.js").Clock, logger: import("../types.js").Logger}} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /** Re-derive every device on a timer (1 s), so a display turns stale without any new event. */
  start() {
    return todo("HealthModel.start");
  }

  stop() {
    return todo("HealthModel.stop");
  }

  /**
   * @param {string} device
   * @param {{shadow: boolean, powerCycleMax: number, plugTopic: string|null}} options
   */
  register(device, options) {
    return todo("HealthModel.register", device, options);
  }

  /** @param {string} device */
  unregister(device) {
    return todo("HealthModel.unregister", device);
  }

  /**
   * The display accepted a frame. The time is the clock's now; nothing else
   * about the frame matters to health.
   * @param {string} device
   */
  frameOk(device) {
    return todo("HealthModel.frameOk", device);
  }

  /**
   * The display answered something else: probe, telemetry read, control.
   * @param {string} device
   * @param {{apSsid?: string|null}} [info]
   */
  contactOk(device, info) {
    return todo("HealthModel.contactOk", device, info);
  }

  /**
   * A render attempt failed.
   * @param {string} device
   * @param {unknown} error classified with core/errors.js classifyError
   */
  renderFailed(device, error) {
    return todo("HealthModel.renderFailed", device, error);
  }

  /**
   * The loop's expectations changed (mode, scene, built-in).
   * @param {string} device
   * @param {{framesDue: boolean, hasScene: boolean}} expectation
   */
  expect(device, expectation) {
    return todo("HealthModel.expect", device, expectation);
  }

  /**
   * @param {string} device
   * @param {{count: number, exhausted: boolean}} cycles
   */
  powerCycles(device, cycles) {
    return todo("HealthModel.powerCycles", device, cycles);
  }

  /**
   * @param {string} device
   * @returns {DeviceHealth|undefined}
   */
  get(device) {
    return todo("HealthModel.get", device);
  }

  /**
   * @param {{watchdogAt: string|null, watchdogIntervalMs: number, mqtt: import("../types.js").MqttStatus, configValid: boolean, restartRequired: boolean}} inputs watchdogAt and watchdogIntervalMs from Scheduler.status()
   * @returns {{status: "ok"|"degraded"|"failed", reasons: string[]}} reasons as listed for ControllerStatus (types.js)
   */
  controller(inputs) {
    return todo("HealthModel.controller", inputs);
  }
}
