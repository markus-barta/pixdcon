/**
 * Overlay service: the retained MQTT layer.
 *
 * Everything an outside MQTT client can store to change what a display does:
 *   structural overlays   <base>/overlay/device/<name>/{scene,ip,enabled}
 *                         <base>/overlay/scene/<key>/path, <base>/overlay/blob
 *   setting overlays      <settingsBase>/<device>/<scene>/settings/<key>
 *   retained controls     <base>/<device>/mode, <base>/<device>/brightness_override
 * The broker owns this layer. The service mirrors it in memory, tells the
 * runtime config and the state store when it changes, and performs the few
 * writes pixdcon makes to it. It never writes config.json itself: the state
 * store saves what the service reports (suppressions).
 *
 * THE MIRROR
 *  M1  Per topic, the mirror is the last message delivered on the current
 *      connection, in delivery order. Own echoes count like any message.
 *  M2  Live beats replay: once a live message (retain flag clear) arrived for
 *      a topic on a connection, a replay (retain flag set) for that topic on
 *      the same connection is ignored. A replay shows what the store held
 *      when the subscribe was handled; a live message is newer by definition.
 *  M3  An unchanged value is not a change: no event, no restart (A-079).
 *  M4  A new connection rebuilds the mirror from its replay. A record that
 *      this connection has not confirmed by the time of the gateway's settle
 *      hint is dropped (an overlay deleted while pixdcon was away is gone
 *      here too, A-182). The hint may be early: a replay that arrives after
 *      it is applied like any other, so this is always undone by the facts.
 *      It is the only decision taken on the hint, and it changes neither the
 *      saved state nor the broker.
 *  M5  A value that is not usable is kept, marked invalid with the reason,
 *      and never blocks config.json changes (A-077, A-BUG-06, B-C10). A
 *      setting overlay whose scene or key has no schema yet is kept raw and
 *      judged again when schemas change (A-100, B-C13).
 *
 * A UI CHOICE AND THE STORED SCENE OVERLAYS (PIXD-75, and why v1's fix is
 * not enough). There are two scene layers per device: the granular topic and
 * the device's entry in the blob. Each has its own suppression
 * (types.js SceneSuppression), with the generation of the choice.
 *  S1  Create. A choice with generation g creates
 *        granular: always. value = the payload known on this connection, or
 *                  null. The clear (empty retained payload) is always sent.
 *        blob:     unless a blob was delivered on this connection and has no
 *                  scene for the device. value = the device's scene in that
 *                  blob, or null when no blob is known on this connection.
 *      The state store writes them into config.json in the same atomic write
 *      as the choice (planSupersede, then applySupersede).
 *  S2  Effect. While a suppression exists, the layer's value for the device
 *      is superseded, i.e. not in effect and listed as "replaced by your
 *      choice, clear pending", when it is the value the choice replaced, or a
 *      replay of `value`, or any replay when `value` is null. A superseded
 *      replay makes the service send the clear again.
 *  S3  End. Only on evidence:
 *        a. an outside live message on the layer (not an own echo): a new
 *           command. Non-empty: it wins again (the Home Assistant scene
 *           toggle). Empty: somebody else cleared it.
 *        b. a replay whose value differs from a known `value`: it was stored
 *           while pixdcon was not connected, so it is a new command.
 *        c. the broker confirmed the clear, or the blob rewrite, that was
 *           sent for this generation. From then on the suppression is not in
 *           config.json any more; in memory it keeps hiding replays until the
 *           own echo arrived on that connection (then M2 takes over) or the
 *           connection ended (then the store is known to be clean).
 *        d. blob only: a blob arrives that has no scene for the device.
 *        e. a newer choice replaces it. Its outstanding acknowledgement then
 *           matches no suppression and is ignored.
 *        f. the device becomes driven after a choice made in shadow, or the
 *           device leaves the effective config.
 *      Never: the settle hint, a timeout, or the fact that nothing arrived.
 *  S4  Clears. Only for a driven device (outputOf), only while connected,
 *      QoS 1, tagged with their generation. Pending clears are retried every
 *      second and after every connect, built from the state of that moment;
 *      every attempt asks outputOf again. Nothing is queued across a
 *      disconnect (gateway rule).
 *  S5  Restart. start() takes the suppressions that config.json holds before
 *      it reads the retained layer, so a stale overlay is superseded from the
 *      first message on.
 *
 * THE BLOB IS SOMEBODY ELSE'S MESSAGE. To remove one device's scene from it,
 * pixdcon has to publish the whole blob again (v1 does this since PIXD-75,
 * lib/config-overlay.js:145-197 and 345-384). The safeguards, all of v1's
 * plus the generation:
 *  B1  A rewrite is built from the blob as delivered on the current
 *      connection, minus `scene` and the legacy `scenes` array of every
 *      driven device with a blob suppression. (A `scenes` array is read as
 *      its first element, A-046, so leaving it would bring the scene back.)
 *  B2  Own writes are correlated: the exact payload is remembered until its
 *      echo arrived or the connection ended. A live blob that equals a
 *      remembered own payload is an own echo. It updates the mirror like any
 *      message (M1) and is never an outside command: it ends no suppression.
 *      So an older own write that echoes back cannot restore a scene of
 *      another device that a later choice cleared.
 *  B3  At a disconnect every rewrite that is not confirmed is cancelled and
 *      the remembered payloads are forgotten. After the next connect the
 *      rewrite is built again from the blob the broker replays, so fields
 *      that another publisher changed meanwhile are kept.
 *  B4  An outside blob that arrives while an own rewrite is not echoed yet:
 *      the mirror follows the delivery order (M1). When the own echo comes
 *      last, the store holds pixdcon's rewrite and the outside blob was
 *      overwritten; that is logged as a warning. It is the read-modify-write
 *      race of v1 and cannot be closed without the broker's help.
 *
 * OTHER RULES
 *  - Every stored overlay is visible (list()), with "since" and what it
 *    replaces (A-080, spec section 11).
 *  - An explicit clear is a retained empty payload with QoS 1; it stays
 *    pending and is retried until the broker confirmed it.
 *  - Output "shadow": the device's overlays are read, but nothing is ever
 *    published for it. A choice then acts on the mirror only, and its
 *    suppressions carry output "shadow" (S3 f).
 *
 * Events (EventEmitter):
 *  - "changed"      ({records: OverlayRecord[], devices: string[], scenes: string[]})  debounced 300 ms for live bursts (A-078)
 *  - "suppression"  ({device, layer, generation, ended: "outside_command"|"stored_while_away"|"confirmed"|"nothing_to_strip"|"replaced"|"dropped"})  the state store removes it from config.json
 *  - "settled"      ({connection, complete})  pacing hint passed on from the gateway
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").OverlayRecord} OverlayRecord */
/** @typedef {import("../types.js").PlaybackMode} PlaybackMode */
/** @typedef {import("../types.js").IsoTime} IsoTime */
/** @typedef {import("../types.js").SceneLayer} SceneLayer */
/** @typedef {import("../types.js").SceneSuppression} SceneSuppression */

/**
 * @typedef {object} OverlayServiceDeps
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway|null} mqtt null when MQTT is not configured: the layer is empty and controls live in memory
 * @property {ReturnType<typeof import("../mqtt/topics.js").createTopics>} topics
 * @property {(device: string|null) => import("../types.js").OutputMode} outputOf the one resolved output policy (RuntimeConfig.outputOf): "shadow" for an unknown device, for an interlocked one, and before the runtime config is started. null asks for an overlay that belongs to no single device (blob, scene path): "drive" only when this instance drives at least one device
 * @property {(scene: string) => Record<string, import("../types.js").SettingField>|null} schemaOf null while the scene is unknown or broken
 * @property {() => Array<{device: string, layer: SceneLayer, suppression: SceneSuppression}>} savedSuppressions what config.json holds; read once, in start()
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

/**
 * @typedef {object} ClearResult
 * @property {boolean} confirmed true when the broker acknowledged the empty retained payload
 * @property {boolean} pending true when it is queued for the next connection
 */

/**
 * What a UI choice does to the scene layers of one device. Made by
 * planSupersede() without changing anything, saved by the state store in the
 * write of the choice, then carried out by applySupersede().
 *
 * @typedef {object} SupersedePlan
 * @property {string} device
 * @property {number} generation
 * @property {IsoTime} at
 * @property {SceneSuppression|null} granular null only when MQTT is not configured: there is no overlay layer then
 * @property {SceneSuppression|null} blob null: a blob known on this connection has no scene for the device, or MQTT is not configured
 */

export class OverlayService extends EventEmitter {
  /** @param {OverlayServiceDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /**
   * Take the saved suppressions, subscribe and read the retained layer.
   * Resolves at the gateway's settle hint of the first connection, or after
   * `timeoutMs` when the broker is not reachable; devices start with what is
   * known then (no fixed 200 ms sleep, A-013, A-BUG-14). What arrives later
   * is applied like any change.
   *
   * @param {{timeoutMs?: number}} [options] default 5000
   * @returns {Promise<{settled: boolean}>}
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
   * Scene inputs for the precedence of one device: what each layer holds and
   * the suppression that applies to it.
   *
   * @param {string} device
   * @returns {{granular: {record: OverlayRecord, suppression: SceneSuppression|null}|null, blob: {scene: string|null, record: OverlayRecord, suppression: SceneSuppression|null}|null}}
   */
  sceneInputs(device) {
    return todo("OverlayService.sceneInputs", device);
  }

  /**
   * Active suppressions of a device, also those that are confirmed and only
   * drain in memory (S3 c).
   *
   * @param {string} device
   * @returns {{granular: (SceneSuppression & {confirmed: boolean})|null, blob: (SceneSuppression & {confirmed: boolean})|null}}
   */
  suppressions(device) {
    return todo("OverlayService.suppressions", device);
  }

  /**
   * What the overlay layer contributes to the effective config: blob devices
   * and scenes, granular scene paths, ip and enabled overlays. Entries are
   * checked one by one with v1's rules; unusable ones are left out here and
   * listed as invalid records.
   *
   * @returns {import("../types.js").StructuralOverlays}
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
   * First half of a UI choice (rule S1): which suppressions it creates. Reads
   * the mirror and changes nothing, so the state store can save the plan
   * together with the choice before anything is published.
   *
   * @param {string} device
   * @param {IsoTime} at time of the choice
   * @returns {SupersedePlan}
   */
  planSupersede(device, at) {
    return todo("OverlayService.planSupersede", device, at);
  }

  /**
   * Second half: put the plan into effect. The records are marked superseded
   * now; for a driven device the granular clear and, when needed, the blob
   * rewrite are sent with the plan's generation. Suppressions of an older
   * generation in the same layer end as "replaced".
   *
   * @param {SupersedePlan} plan
   * @returns {{superseded: string[], clearPending: boolean}} ids of the records it replaced
   */
  applySupersede(plan) {
    return todo("OverlayService.applySupersede", plan);
  }

  /**
   * Explicit clear of one overlay ("Clear", "Restore", "Return to …").
   *
   * @param {string} id
   * @returns {Promise<ClearResult>}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_overlay, 503 mqtt_offline, 409 shadow_output for a device that is not driven, and for the blob or a scene path when this instance drives nothing
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
   * until it is known that no outside caller uses the route. It is an own
   * write of a new command, not a clear: it ends the granular suppression of
   * the device as "replaced".
   *
   * @param {string} device
   * @param {string|null} scene null or "" clears
   * @returns {Promise<ClearResult>}
   * @throws {import("../core/errors.js").HttpError} 503 mqtt_offline, 409 shadow_output
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
   * @throws {import("../core/errors.js").HttpError} 503 mqtt_offline, 409 shadow_output
   */
  async publishControl(device, control) {
    return todo("OverlayService.publishControl", device, control);
  }
}
