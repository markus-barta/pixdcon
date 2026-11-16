/**
 * Status publisher: the controller-level topics, in the v1 shape.
 *
 *   <statusBase>/health            retained  {status, timestamp, devices:[{name,status,lastSeen}], errorCount, lastError}   C-022
 *   <statusBase>/state             retained  {running, currentScene, uptime, devices:[{name,scene,frameCount}]}           C-023
 *   <statusBase>/config            retained  {configPath, deviceCount, sceneCount, timestamp}                             C-024
 *   <statusBase>/config/effective  retained  the running config with overlays applied                                     C-024
 *
 * Kept: topic names, field names, retained, republished on connect and every
 * 30 s (C-013, C-031). The Home Assistant availability template of the Ulanzi
 * entities reads `health.status in ['ok','degraded']`, and the pixoo-189 scene
 * toggle reads the reported scene, so these payloads are an outside contract.
 *
 * Fixed:
 *  - Health follows the measured state and recovers: online → "ok", stale →
 *    "degraded", offline → "failed" per device; overall "ok" or "degraded".
 *    One display that is down no longer turns every entity unavailable
 *    (B-C03). `errorCount` stays the lifetime counter; `lastSeen` is the last
 *    contact, not the time of the status write (C-027, B-C04).
 *  - A device that left the config leaves both lists (C-028).
 *  - `state.devices[].scene` is the scene on the display and is published at
 *    once when it changes, not only every 100 frames (C-081). Added fields per
 *    device: mode, source. `currentScene` stays null (C-026).
 *  - On a clean stop: state running false and health status "offline"; on a
 *    crash the last will says the same (C-033, B-C02).
 *  - Only devices this instance drives are listed. An instance that drives
 *    nothing (edge lane, shadow) must not use v1's status base.
 *
 * Owner: API + live channel worker.
 */

import { todo } from "../core/todo.js";

/**
 * @typedef {object} V1HealthPayload
 * @property {"ok"|"degraded"|"failed"|"offline"|"unknown"} status
 * @property {string|null} timestamp
 * @property {Array<{name: string, status: "ok"|"degraded"|"failed"|"unreachable"|"offline"|"dead", lastSeen: string|null}>} devices
 * @property {number} errorCount
 * @property {{message: string, timestamp: string}|null} lastError
 */

/**
 * @typedef {object} V1StatePayload
 * @property {boolean} running
 * @property {null} currentScene
 * @property {number} uptime seconds
 * @property {Array<{name: string, scene: string|null, frameCount: number, mode?: string, source?: string}>} devices
 */

/**
 * @typedef {object} StatusPublisherDeps
 * @property {import("./mqtt-gateway.js").MqttGateway} mqtt
 * @property {import("./topics.js").Topics} topics
 * @property {import("../state/state-store.js").StateStore} state
 * @property {import("../config/config-store.js").ConfigStore} config
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 * @property {number} [intervalMs] default 30000
 */

export class StatusPublisher {
  /**
   * The last will for the gateway: the health topic with status "offline".
   *
   * @param {import("./topics.js").Topics} topics
   * @returns {{topic: string, payload: string, retain: boolean, qos: 0|1}}
   */
  static lastWill(topics) {
    return todo("StatusPublisher.lastWill", topics);
  }

  /** @param {StatusPublisherDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /** Publish now, on every connect, on every relevant change and every `intervalMs`. */
  start() {
    return todo("StatusPublisher.start");
  }

  /** Publish running false and health "offline", then stop the timers. */
  async stop() {
    return todo("StatusPublisher.stop");
  }

  /** @returns {V1HealthPayload} */
  buildHealth() {
    return todo("StatusPublisher.buildHealth");
  }

  /** @returns {V1StatePayload} */
  buildState() {
    return todo("StatusPublisher.buildState");
  }

  /**
   * The running config with overlays applied, as v1 publishes it. Contains no
   * secrets by construction (the config has none); bookkeeping keys are left out.
   *
   * @returns {Record<string, unknown>}
   */
  buildEffectiveConfig() {
    return todo("StatusPublisher.buildEffectiveConfig");
  }
}
