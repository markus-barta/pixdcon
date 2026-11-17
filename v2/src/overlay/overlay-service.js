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
 * ORDER (core/ordering.js). Every message, event and timer that reaches this
 * service goes through one decision, apply, hold or drop, before it changes
 * anything, and nothing leaves the service (a clear, a rewrite, the end of a
 * suppression) without authoritative evidence. For the two scene layers that
 * decision is code already: overlay/scene-layers.js, a pure reducer with the
 * tests of test/contract/ordering.test.js. This service feeds it the
 * gateway's messages and events and carries out the effects it answers
 * with; it adds no rule of its own for these layers. The other topics
 * (ip, enabled, scene path, settings, mode, brightness) follow M1 to M5 with
 * the same fence per topic.
 *
 * THE MIRROR
 *  M1  Per topic, the mirror is the last message delivered that passed the
 *      fence, in delivery order on the current connection. A message that
 *      names another connection than the current one is dropped.
 *  M2  Live beats replay: once a live message (retain flag clear) arrived for
 *      a topic on a connection, a replay (retain flag set) for that topic on
 *      the same connection is dropped. A replay shows what the store held
 *      when the subscribe was handled; a live message is newer by definition.
 *  M3  An unchanged value is not a change: no event, no restart (A-079).
 *  M4  A new connection replaces a record only by what it delivers. Until
 *      then the record stays as it was, in effect; its `connection` is lower
 *      than the current one, which is how the Overlays page can tell. No
 *      record is removed because the settle hint passed or because nothing
 *      arrived: MQTT has no message for "this topic is empty", so the
 *      absence of a replay proves nothing, and a record that goes missing on
 *      a guess can release what it held back (a device switched off by an
 *      overlay would start driving). What v2 cannot know is a retained topic
 *      that was deleted while pixdcon was disconnected (A-182): that record
 *      stays until the topic gets a message, the user clears it, or the
 *      process restarts.
 *  M5  A value that is not usable is kept, marked invalid with the reason,
 *      and never blocks config.json changes (A-077, A-BUG-06, B-C10). A
 *      setting overlay whose scene or key has no schema yet is held: kept
 *      raw and judged again when schemas change (A-100, B-C13).
 *  M6  An overlay never widens what config.json and the environment allow:
 *      it cannot set `output`, and it can set `enabled` only to false
 *      (state/runtime-config.js overlayDevicePatch).
 *
 * A UI CHOICE AND THE STORED SCENE OVERLAYS (PIXD-75, and why v1's fix is
 * not enough). There are two scene layers per device: the granular topic and
 * the device's entry in the blob. Each has its own suppression
 * (types.js SceneSuppression), with the generation of the choice.
 *  S1  Create. A choice with generation g creates
 *        granular: always. value = the payload delivered on this connection,
 *                  or null.
 *        blob:     unless a blob was delivered on this connection and has no
 *                  scene for the device. value = the device's scene in that
 *                  blob, or null when no blob is known on this connection.
 *                  alsoStale = what own rewrites that are still on their way
 *                  carry for the device (B2).
 *      The state store writes them into config.json in the same atomic write
 *      as the choice (planSupersede, then applySupersede).
 *  S2  Effect. While a suppression exists, the layer's value for the device
 *      is not in effect and is listed as "replaced by your choice". A
 *      replay is hidden by it when it carries `value`, a value in
 *      `alsoStale`, or anything when `value` is null. A live message is
 *      hidden by it when it was processed before an own write that is still
 *      on its way (see OWN WRITES).
 *  S3  End. Only on evidence:
 *        a. an outside live message on the layer while no own write is on
 *           its way: a new command. Non-empty: it wins again (the Home
 *           Assistant scene toggle). Empty: somebody else cleared it.
 *        b. a replay with a value the suppression does not hide: it was
 *           stored while pixdcon was not connected, so it is a new command.
 *        c. the broker acknowledged or echoed the clear, or the blob
 *           rewrite, that was sent for this generation. From the
 *           acknowledgement on the suppression is not in config.json any
 *           more; in memory it stays until the own echo arrived on that
 *           connection (then M2 takes over) or the connection ended (the
 *           store was clean after that write, so whatever a later
 *           connection replays was stored afterwards).
 *        d. blob only: a delivered blob has no scene for the device.
 *        e. a newer choice replaces it. Its outstanding acknowledgement then
 *           matches no suppression and is ignored.
 *        f. an authoritative output change (config.json, the environment,
 *           v1's device list) puts the device into drive after a choice made
 *           in shadow, or the device leaves the effective config.
 *      Never: the settle hint, a timeout, a connect or disconnect as such,
 *      or the fact that nothing arrived.
 *  S4  Publishing. Only for a driven device (outputOf), only while
 *      connected, QoS 1, tagged with the generation, and only on evidence:
 *        - the clear of a choice, on the connection the choice was made on:
 *          the choice is the newest command at that moment. It is repeated
 *          every second on that connection until its outcome is known.
 *        - a clear, or a rewrite, when a value that a suppression hides was
 *          delivered on the current connection.
 *      Nothing is sent because a connection came up. A clear sent blindly
 *      after a reconnect could delete a command that was stored while
 *      pixdcon was away and has not been delivered yet. A choice made while
 *      MQTT was offline therefore clears the stored overlay when the new
 *      connection replays it. Nothing is queued across a disconnect.
 *  S5  Restart. start() takes the suppressions that config.json holds before
 *      it reads the retained layer, so a stale overlay is superseded from the
 *      first message on.
 *
 * OWN WRITES. The broker forwards the messages of a topic to one subscriber
 * in the order it processed them. So whatever arrives on a topic before the
 * echo of an own write was processed before that write: it is older than
 * the write and never a new command, live or not. The service keeps, per
 * topic, the own writes whose echo has not arrived. What arrives before
 * the echo is still taken into the mirror as what the store holds, in the
 * place of a replaced value: should the own write turn out not to have been
 * sent, the value is there to be cleared again. The gateway's publish
 * outcome reaches the reducer as: confirmed, failed (outcome error: it was
 * certainly not sent) or unknown (timeout on a connection that is still up);
 * an outcome offline needs nothing, the disconnect has ended every own
 * write of that connection.
 *
 * The one order MQTT cannot give: a live message that arrives while no own
 * write is on its way on its topic. It may have been published a moment
 * before a UI choice and delivered a moment after it; nothing tells. It is
 * taken as a new command (S3 a). A choice on a driven device always clears
 * the granular topic, so there the order is exact; the gap is the blob
 * while no rewrite is on its way, and both layers for a device in shadow,
 * which never writes. Its width is the time one live message is in transit.
 *
 * THE BLOB IS SOMEBODY ELSE'S MESSAGE. To remove one device's scene from it,
 * pixdcon has to publish the whole blob again (v1 does this since PIXD-75,
 * lib/config-overlay.js:145-197 and 345-384). The safeguards, all of v1's
 * plus the generation:
 *  B1  A rewrite is built from the blob as it should be: the last content an
 *      outside client stored, as delivered on the current connection, minus
 *      `scene` and the legacy `scenes` array of every driven device with a
 *      blob suppression. (A `scenes` array is read as its first element,
 *      A-046, so leaving it would bring the scene back.) It is sent only
 *      when a delivered message shows that the store differs from that.
 *      What a rewrite strips stays stripped: a later rewrite never puts a
 *      scene back that an earlier one removed or is removing, also when the
 *      device has gone into shadow meanwhile.
 *  B2  Own writes are correlated: the exact payload is remembered until its
 *      echo arrived or the connection ended. An own echo says what the
 *      store holds and is never a command. When it is the blob as it should
 *      be, it is applied. When it is an older own write that came back after
 *      a newer blob was applied, it is dropped, and the blob is published
 *      again as it should be. Such an older write still carries the old
 *      scenes of other devices; a choice made for one of them meanwhile
 *      records those values (`alsoStale`), so they are recognised as
 *      pixdcon's own doing when they are delivered, also after a restart.
 *  B3  At a disconnect no rewrite is kept to be sent again. After the next
 *      connect the rewrite is built again from the blob the broker replays,
 *      so fields that another publisher changed meanwhile are kept. The
 *      payloads of the rewrites that may have reached the store are
 *      remembered for one purpose: when the next connection replays exactly
 *      one of them, it is pixdcon's own, older write and not a command.
 *  B4  An outside blob that arrives while an own rewrite is on its way was
 *      processed before that rewrite. Its content becomes the blob as it
 *      should be; the scenes of superseded devices stay hidden; and when the
 *      own echo shows that the older rewrite has overwritten it, the blob is
 *      published again from the newer content. v1 lost the outside change
 *      here.
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
 *  - "settled"      ({connection, complete})  pacing hint passed on from the gateway; nothing in the mirror changes with it
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
 * @property {SceneSuppression|null} blob null: a blob delivered on this connection has no scene for the device and no own rewrite on its way carries one, or MQTT is not configured
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
   * Scene inputs for the precedence of one device: what each layer holds
   * and whether it is in effect (scene-layers.js sceneInputs, with the
   * record's id and receipt time).
   *
   * @param {string} device
   * @returns {{granular: import("../state/precedence.js").LayerScene|null, blob: import("../state/precedence.js").LayerScene|null}}
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
   * First half of a UI choice (rule S1): which suppressions it creates
   * (scene-layers.js planChoice). Reads the mirror and changes nothing, so
   * the state store can save the plan together with the choice before
   * anything is published.
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
