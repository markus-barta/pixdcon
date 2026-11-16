/**
 * Home Assistant MQTT discovery payloads. Pure builders, no I/O.
 *
 * Byte-compatible with v1 (matrix C-118 to C-138) so that the entities in the
 * existing Home Assistant registry stay the same: topic, unique_id, object_id,
 * state_topic, value_template, device identifiers, names, units, classes.
 *
 *  Ulanzi (needs stats.uid): 10 sensors under
 *    <prefix>/sensor/pixdcon_<name>_<field>/config
 *    fields uptime, bat, bat_raw, wifi_signal, ram, temp, hum, lux, messages, app
 *    device {identifiers: ["pixdcon_<uid>"], name, model "Ulanzi TC001 / AWTRIX <version>", manufacturer "Ulanzi", sw_version?, configuration_url}
 *    availability_topic <statusBase>/health with the v1 template
 *  Pixoo: binary_sensor pixdcon_<name>_reachable and sensor pixdcon_<name>_brightness
 *    device {identifiers: ["pixdcon_<name>"], name, model "Divoom Pixoo64", manufacturer "Divoom", configuration_url}
 *
 * Fixed in the caller (health/telemetry.js), not in the payloads: discovery is
 * sent again after every reconnect and when uid, firmware or address changed
 * (C-139, B-C05).
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
 * @param {{name: string, ip: string}} device
 * @param {Record<string, unknown>} stats answer of GET /api/stats; uid and version are read from it
 * @param {import("./topics.js").Topics} topics
 * @returns {DiscoveryMessage[]} ten messages, in the v1 order
 */
export function ulanziDiscovery(device, stats, topics) {
  return todo("ulanziDiscovery", device, stats, topics);
}

/**
 * @param {{name: string, ip: string}} device
 * @param {import("./topics.js").Topics} topics
 * @returns {DiscoveryMessage[]} two messages: reachable, brightness
 */
export function pixooDiscovery(device, topics) {
  return todo("pixooDiscovery", device, topics);
}
