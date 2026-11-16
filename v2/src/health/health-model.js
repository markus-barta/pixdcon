/**
 * Health model: measured, never assumed.
 *
 * Lesson behind it (matrix index, "silent failure"): a status can show green
 * while the loop behind it is dead. So health here is computed from events
 * that really happened and from how long ago they happened, and the things
 * that produce those events are themselves watched (scheduler watchdog).
 *
 * Per display (decision Markus, PIXD-81 approval: by time since the last good
 * frame, stale 30 s, offline 2 min; replaces v1's "5 failed renders", B-066, S-14):
 *
 *   reference = last good frame, when frames are due
 *               (mode play and a custom scene), else last good contact
 *   age       = now − reference, minus the part of a long frame delay the scene asked for
 *   age < staleAfterMs                    → online   (starting: before the first frame or contact)
 *   staleAfterMs ≤ age < offlineAfterMs   → stale
 *   age ≥ offlineAfterMs                  → offline
 *   no scene chosen and contact fresh     → idle
 *   output shadow                         → shadow   (not measured)
 *
 * "Frames are not due" covers pause, stop, built-in modes and no scene. There
 * the render loop probes every probeIntervalMs (10 s) and a good probe is the
 * contact, so a quiet display does not drift to stale.
 *
 * `reason` says why a display is not online: device_unreachable (DeviceError),
 * scene_error (the display answers, the scene fails: no hardware steps, no
 * power cycle, S-6), power_cycles_exhausted, not_started.
 *
 * Controller health for GET /api/health and the Docker HEALTHCHECK (A-161):
 * ok when the HTTP server answers, the scheduler watchdog ran within 2 ×
 * its interval and the event loop is not stalled; degraded when a display is
 * stale or offline, config.json on disk is invalid or a configured broker is
 * offline; failed when the watchdog is overdue.
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
 * @property {number|null} lastRequestedDelayMs delay the scene returned with its last frame
 * @property {boolean} framesDue
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
   * The display accepted a frame.
   * @param {string} device
   * @param {{requestedDelayMs: number|null}} info
   */
  frameOk(device, info) {
    return todo("HealthModel.frameOk", device, info);
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
   * @param {{watchdogAt: string|null, mqtt: import("../types.js").MqttStatus, configValid: boolean}} inputs
   * @returns {{status: "ok"|"degraded"|"failed", reasons: string[]}}
   */
  controller(inputs) {
    return todo("HealthModel.controller", inputs);
  }
}
