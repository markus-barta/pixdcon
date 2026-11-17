/**
 * Status publisher: the controller-level topics, in the v1 shape, and the
 * per-device availability.
 *
 *   <statusBase>/health            retained  {status, timestamp, devices:[{name,status,lastSeen}], errorCount, lastError}   C-022
 *   <statusBase>/state             retained  {running, currentScene, uptime, devices:[{name,scene,frameCount}]}           C-023
 *   <statusBase>/config            retained  {configPath, deviceCount, sceneCount, timestamp}                             C-024
 *   <statusBase>/config/effective  retained  the running config with overlays applied (StateStore.runningConfigV1)       C-024
 *   <base>/<device>/availability   retained  "online" | "offline"                                                          new, C-121, C-137, C-138
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
 *  - Per-device availability. v1's entities have no freshness of their own:
 *    an unplugged Ulanzi keeps showing its last values as long as the
 *    controller is healthy (C-121), and the Pixoo entities never expire
 *    (C-137, C-138). v2 publishes <base>/<device>/availability for every
 *    driven device from its measured health: "offline" while the health
 *    state is offline, "online" otherwise; on every change, on every connect
 *    and with the 30 s republish. The discovery payloads name this topic
 *    next to the controller health (ha-discovery.js), so one display that is
 *    down takes its own entities down and nobody else's.
 *  - Availability is retired, not abandoned. A retained "online" that
 *    nobody takes back would keep the entities of a display available for
 *    ever while the controller is healthy. So when this instance stops
 *    driving a display for which it published "online" (the device left the
 *    effective config, was disabled, or its output changed from drive to
 *    shadow, also by the v1 interlock), it publishes "offline" for it once
 *    more, retained, and only then forgets it. This is the last message of
 *    the driving phase and the one publish for a device that is not driven;
 *    it says less, never more. It is owed until the broker confirmed it:
 *    after a reconnect it is sent again. On a clean stop every display this
 *    instance drives is retired the same way. planAvailability() below is
 *    the rule, finished code.
 *    What this cannot cover is a process that dies, or a device that is
 *    removed while the process is down: then the last will takes the
 *    controller health down, and after the next start the discovery
 *    payloads' `expire_after` (ha-discovery.js, now on the Ulanzi sensors
 *    too) ends the entities of a display that nobody publishes telemetry
 *    for.
 *  - A device that left the config leaves both lists (C-028).
 *  - `state.devices[].scene` is the scene on the display and is published at
 *    once when it changes, not only every 100 frames (C-081). Added fields per
 *    device: mode, source. `currentScene` stays null (C-026).
 *  - On a clean stop: state running false and health status "offline"; on a
 *    crash the last will says the same (C-033, B-C02).
 *  - Only devices this instance drives are listed and get an availability
 *    message. "Drives" is the resolved output policy (RuntimeConfig), so a
 *    device held back by the v1 interlock is not listed. An instance that
 *    drives nothing (edge lane, shadow) must not use v1's status base.
 *  - Nothing is rebuilt here: device entries come from the runtime config,
 *    the v1-shaped running config from the state store.
 *
 * Owner: API + live channel worker. The last will below is finished code, so
 * the gateway (core/state worker) does not depend on this file being built.
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
 * @property {import("../state/state-store.js").StateStore} state device states, health, and runningConfigV1()
 * @property {import("../state/runtime-config.js").RuntimeConfig} runtime which devices exist and which are driven
 * @property {import("../config/config-store.js").ConfigStore} config path of config.json for the summary topic
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 * @property {number} [intervalMs] default 30000
 */

/**
 * What to publish on the per-device availability topics, as a pure function
 * of what this instance last published and what it drives now.
 *
 * @param {Map<string, "online"|"offline">|Record<string, "online"|"offline">} published the last payload the broker confirmed per device, in this process
 * @param {Array<{name: string, driven: boolean, health: import("../types.js").HealthState|null}>} devices the devices of the effective config; driven = enabled and output drive; a device that left the config is simply not in the list
 * @returns {Array<{device: string, payload: "online"|"offline", retire: boolean}>} in the order of `devices`, then retirements of devices that left. retire = the device is no longer driven: after the broker confirmed this "offline" the device is forgotten
 */
export function planAvailability(published, devices) {
  const last =
    published instanceof Map ? published : new Map(Object.entries(published));
  /** @type {Array<{device: string, payload: "online"|"offline", retire: boolean}>} */
  const plan = [];
  const listed = new Set();
  for (const device of devices) {
    listed.add(device.name);
    if (device.driven) {
      plan.push({
        device: device.name,
        payload: device.health === "offline" ? "offline" : "online",
        retire: false,
      });
    } else if (last.get(device.name) === "online") {
      plan.push({ device: device.name, payload: "offline", retire: true });
    }
  }
  for (const [device, payload] of last) {
    if (!listed.has(device) && payload === "online")
      plan.push({ device, payload: "offline", retire: true });
  }
  return plan;
}

export class StatusPublisher {
  /**
   * The last will for the gateway: the health topic of this process's status
   * base, retained, in the v1 health shape with status "offline". Home
   * Assistant's availability template turns that into "offline" for every
   * entity (B-C02). The broker stores it at connect time, so it has no
   * timestamp of the death; `timestamp` is null.
   *
   * Built from the topics, and the topics from the loaded config: main.js
   * calls this after config.json was read, never with defaults.
   *
   * @param {import("./topics.js").Topics} topics
   * @returns {import("./mqtt-gateway.js").LastWill}
   */
  static lastWill(topics) {
    /** @type {V1HealthPayload} */
    const payload = {
      status: "offline",
      timestamp: null,
      devices: [],
      errorCount: 0,
      lastError: null,
    };
    return {
      topic: topics.health,
      payload: JSON.stringify(payload),
      retain: true,
      qos: 1,
    };
  }

  /** @param {StatusPublisherDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /** Publish now, on every connect, on every relevant change and every `intervalMs`. */
  start() {
    return todo("StatusPublisher.start");
  }

  /** Publish running false and health "offline", retire the availability of every display this instance drives ("offline"), then stop the timers. */
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
   * Availability of one display, for <base>/<device>/availability: the entry
   * of planAvailability() for it.
   *
   * @param {string} device
   * @returns {"online"|"offline"|null} null: nothing to publish. That is a device this instance does not drive and has no "online" to take back for
   */
  buildAvailability(device) {
    return todo("StatusPublisher.buildAvailability", device);
  }
}
