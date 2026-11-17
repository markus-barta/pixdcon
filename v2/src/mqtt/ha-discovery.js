/**
 * Home Assistant MQTT discovery payloads. Pure builders, no I/O.
 *
 * IDENTITY is v1's, byte for byte (matrix C-118 to C-138), so the entities in
 * the existing Home Assistant registry stay the same entities: discovery
 * topic, unique_id, object_id, state_topic, value_template, name, unit,
 * classes, icon, entity_category and the device block.
 *
 *  Ulanzi (needs stats.uid): 10 sensors under
 *    <prefix>/sensor/pixdcon_<name>_<field>/config
 *    fields uptime, bat, bat_raw, wifi_signal, ram, temp, hum, lux, messages, app
 *    device {identifiers: ["pixdcon_<uid>"], name, model "Ulanzi TC001 / AWTRIX <version>", manufacturer "Ulanzi", sw_version?, configuration_url}
 *  Pixoo: binary_sensor pixdcon_<name>_reachable and sensor pixdcon_<name>_brightness
 *    device {identifiers: ["pixdcon_<name>"], name, model "Divoom Pixoo64", manufacturer "Divoom", configuration_url}
 *
 * AVAILABILITY is new (the fix of C-121, C-137, C-138). v1 gives the Ulanzi
 * sensors one availability_topic, the controller health, and the Pixoo
 * entities none. v2 writes, instead of `availability_topic` and
 * `availability_template` (Home Assistant does not allow both forms in one
 * payload):
 *
 *   Ulanzi sensors, Pixoo brightness:
 *     availability: [
 *       {topic: "<statusBase>/health", value_template: "{{ 'online' if value_json.status in ['ok', 'degraded'] else 'offline' }}"},
 *       {topic: "<base>/<name>/availability"}                    // "online" | "offline", status-publisher.js
 *     ],
 *     availability_mode: "all"
 *   Pixoo reachable (its state already says whether the display answers):
 *     availability: [ the controller health entry only ]
 *   every entity, Ulanzi and Pixoo:
 *     expire_after: 3 × telemetry interval in seconds, at least 30   // no telemetry, no state
 *
 * So an entity is unavailable when the controller is gone (last will) or its
 * own display is offline, and one display that is down does not touch the
 * entities of another. `expire_after` is the backstop for what availability
 * cannot say: a display that nobody publishes telemetry for any more
 * (removed from the config while the process was down, or after a crash)
 * loses its state after three intervals, although a retained "online" may
 * still sit on its availability topic. Changing these fields does not create new entities:
 * Home Assistant updates the existing ones on the next discovery message.
 * Rolling a device back to v1 puts v1's discovery payload back.
 *
 * Fixed in the caller (health/telemetry.js), not in the payloads: discovery is
 * sent again after every reconnect and when uid, firmware or address changed
 * (C-139, B-C05).
 *
 * The telemetry collector gets these two functions through main.js
 * (`Factories.discovery`, types.js); it does not import this file.
 *
 * Owner: API + live channel worker.
 */

import { todo } from "../core/todo.js";

/**
 * @typedef {object} DiscoveryMessage
 * @property {string} topic
 * @property {Record<string, unknown>} payload
 */

/**
 * @param {{name: string, address: string}} device address: host or host:port, for configuration_url
 * @param {Record<string, unknown>} stats answer of GET /api/stats; uid and version are read from it
 * @param {import("./topics.js").Topics} topics
 * @param {{telemetryIntervalMs: number}} options for expire_after
 * @returns {DiscoveryMessage[]} ten messages, in the v1 order
 */
export function ulanziDiscovery(device, stats, topics, options) {
  return todo("ulanziDiscovery", device, stats, topics, options);
}

/**
 * `expire_after` of every entity: three telemetry intervals in seconds, at
 * least 30. Finished code, so both builders and their tests agree.
 *
 * @param {number} telemetryIntervalMs
 * @returns {number} seconds
 */
export function expireAfterSeconds(telemetryIntervalMs) {
  return Math.max(30, Math.ceil((3 * telemetryIntervalMs) / 1000));
}

/**
 * @param {{name: string, address: string}} device
 * @param {import("./topics.js").Topics} topics
 * @param {{telemetryIntervalMs: number}} options for expire_after
 * @returns {DiscoveryMessage[]} two messages: reachable, brightness
 */
export function pixooDiscovery(device, topics, options) {
  return todo("pixooDiscovery", device, topics, options);
}
