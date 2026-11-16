/**
 * Overlay service: the retained MQTT layer.
 *
 * Everything an outside MQTT client can store to change what a display does:
 *   structural overlays   <base>/overlay/device/<name>/{scene,ip,enabled}
 *                         <base>/overlay/scene/<key>/path, <base>/overlay/blob
 *   setting overlays      <settingsBase>/<device>/<scene>/settings/<key>
 *   retained controls     <base>/<device>/mode, <base>/<device>/brightness_override
 * The broker owns this layer. The service mirrors it in memory with receipt
 * time and origin, tells the state store when it changes, and performs the
 * few writes pixdcon makes to it. It never writes config.json.
 *
 * Rules that fix v1:
 *  - Every stored overlay is visible (list()), with "since" and what it
 *    replaces (A-080, spec section 11).
 *  - An unchanged value is not a change: no event, no restart (A-079, A-BUG-03).
 *  - The mirror is rebuilt from the retained set at every (re)connect: an
 *    overlay deleted while pixdcon was away is gone here too (A-182).
 *  - A value that is not usable is kept, marked invalid with the reason, and
 *    never blocks config.json changes (A-077, A-BUG-06, B-C10).
 *  - A setting overlay whose scene or key has no schema yet is kept raw and
 *    looked at again when schemas change (A-100, B-C13).
 *  - A clear is a retained empty payload with QoS 1; it stays pending and is
 *    retried until the broker confirmed it, and is flushed after a reconnect.
 *  - Output "shadow": the device's overlays are read, but nothing is ever
 *    published for it. Supersede and clear then act on the mirror only.
 *
 * Events (EventEmitter):
 *  - "changed"   ({records: OverlayRecord[], devices: string[], scenes: string[]})  debounced 300 ms for live bursts (A-078)
 *  - "boundary"  ()  the retained messages of the current connection have been read
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").OverlayRecord} OverlayRecord */
/** @typedef {import("../types.js").PlaybackMode} PlaybackMode */
/** @typedef {import("../types.js").IsoTime} IsoTime */

/**
 * @typedef {object} OverlayServiceDeps
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway|null} mqtt null when MQTT is not configured: the layer is empty and controls live in memory
 * @property {ReturnType<typeof import("../mqtt/topics.js").createTopics>} topics
 * @property {(device: string) => import("../types.js").OutputMode} outputOf
 * @property {(scene: string) => Record<string, import("../types.js").SettingField>|null} schemaOf null while the scene is unknown or broken
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

/**
 * @typedef {object} ClearResult
 * @property {boolean} confirmed true when the broker acknowledged the empty retained payload
 * @property {boolean} pending true when it is queued for the next connection
 */

export class OverlayService extends EventEmitter {
  /** @param {OverlayServiceDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /**
   * Subscribe and read the retained layer. Resolves at the retained boundary
   * of the first connection, or after `timeoutMs` when the broker is not
   * reachable; devices start with what is known then (no fixed 200 ms sleep,
   * A-013, A-BUG-14).
   *
   * @param {{timeoutMs?: number}} [options] default 5000
   * @returns {Promise<{bootstrapped: boolean}>}
   */
  async start(options) {
    return todo("OverlayService.start", options);
  }

  /** Unsubscribe and cancel timers. Pending clears are dropped; retained state on the broker is left as it is. */
  async stop() {
    return todo("OverlayService.stop");
  }

  // -------------------------------------------------------------------------
  // Reading the mirror
  // -------------------------------------------------------------------------

  /** @returns {OverlayRecord[]} every stored overlay, also invalid and superseded ones */
  list() {
    return todo("OverlayService.list");
  }

  /**
   * @param {string} id
   * @returns {OverlayRecord|undefined}
   */
  get(id) {
    return todo("OverlayService.get", id);
  }

  /**
   * Structural inputs for the precedence of one device.
   *
   * @param {string} device
   * @returns {{granularScene: OverlayRecord|null, blobScene: {scene: string|null, record: OverlayRecord}|null, ip: {value: string, record: OverlayRecord}|null, blobIp: string|null, enabled: boolean|null}}
   */
  deviceInputs(device) {
    return todo("OverlayService.deviceInputs", device);
  }

  /**
   * Devices and scenes that exist only in the blob overlay (A-070 to A-072).
   *
   * @returns {{devices: Array<Record<string, unknown>>, scenes: Record<string, {path: string}>, scenePaths: Record<string, string>}}
   */
  structural() {
    return todo("OverlayService.structural");
  }

  /**
   * Valid setting overlay values of one device and scene.
   *
   * @param {string} device
   * @param {string} scene
   * @returns {Record<string, unknown>}
   */
  settingValues(device, scene) {
    return todo("OverlayService.settingValues", device, scene);
  }

  /**
   * Retained controls of one device.
   *
   * @param {string} device
   * @returns {{mode: {value: PlaybackMode, record: OverlayRecord}|null, brightness: {percent: number, record: OverlayRecord}|null}}
   */
  controls(device) {
    return todo("OverlayService.controls", device);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * A UI choice replaces the scene overlays of a device: the granular record
   * and the device's scene in the blob are marked superseded now, and their
   * retained values are cleared on the broker (granular: empty payload; blob:
   * the blob without this device's scene). While the clear is pending, a
   * retained replay of the old value is ignored and the clear is sent again;
   * a live message is a new command and ends the supersede.
   *
   * @param {string} device
   * @param {IsoTime} at time of the choice
   * @returns {{superseded: string[], clearPending: boolean}} ids of the records it replaced
   */
  supersedeScene(device, at) {
    return todo("OverlayService.supersedeScene", device, at);
  }

  /**
   * Explicit clear of one overlay ("Clear", "Restore", "Return to …").
   *
   * @param {string} id
   * @returns {Promise<ClearResult>}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_overlay, 503 mqtt_offline, 409 shadow_output for a device that is not driven
   */
  async clear(id) {
    return todo("OverlayService.clear", id);
  }

  /**
   * Clear outside setting overlays of one device and scene ("Clear N overlays"),
   * or only the given keys (Save clears the overlay of each saved setting).
   * Reports keys that could not be cleared instead of answering ok (A-BUG-43).
   *
   * @param {string} device
   * @param {string} scene
   * @param {string[]} [keys]
   * @returns {Promise<{cleared: string[], failed: string[]}>}
   */
  async clearSettings(device, scene, keys) {
    return todo("OverlayService.clearSettings", device, scene, keys);
  }

  /**
   * v1 POST /api/scene-settings/overlay: store setting values as retained
   * overlays, one message per key in schema order (C-098, C-219). Kept for
   * outside callers; the v2 UI uses preview sessions instead.
   *
   * @param {string} device
   * @param {string} scene
   * @param {Record<string, unknown>} values
   * @returns {Promise<{applied: string[], rejected: string[], failed: string[]}>}
   */
  async publishSettings(device, scene, values) {
    return todo("OverlayService.publishSettings", device, scene, values);
  }

  /**
   * v1 POST /api/overlay: store a scene overlay for a device (A-147). Kept
   * until it is known that no outside caller uses the route.
   *
   * @param {string} device
   * @param {string|null} scene null or "" clears
   * @returns {Promise<ClearResult>}
   */
  async publishSceneOverlay(device, scene) {
    return todo("OverlayService.publishSceneOverlay", device, scene);
  }

  /**
   * Store a retained control. Resolves when the broker confirmed it.
   *
   * @param {string} device
   * @param {{mode: PlaybackMode}|{brightness: number|null}} control brightness in percent, null clears
   * @returns {Promise<{confirmed: boolean}>}
   * @throws {import("../core/errors.js").HttpError} 503 mqtt_offline
   */
  async publishControl(device, control) {
    return todo("OverlayService.publishControl", device, control);
  }
}
