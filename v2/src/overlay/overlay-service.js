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
 * the same fence per topic, and are kept in the second reducer,
 * overlay/topic-fence.js (`reduceMirror`): it says for every record what it
 * commands and what it holds back at this moment (`overrideEffect`), and
 * which records changed in a step. The service adds no rule there either.
 *
 * THE MIRROR
 *  M1  Per topic, the mirror is the last message delivered that passed the
 *      fence, in delivery order on the current connection. A message that
 *      names another connection than the current one is dropped.
 *  M2  Live beats replay: once a live message (retain flag clear) arrived for
 *      a topic on a connection, a replay (retain flag set) for that topic on
 *      the same connection is dropped. A replay shows what the store held
 *      when the subscribe was handled; a live message is newer by definition.
 *  M3  An unchanged record is not a change (A-079): a message that changes
 *      nothing a reader of the mirror is told causes no event, and one that
 *      changes nothing a display does causes no restart. A replay that
 *      confirms a record again after a reconnect, or a live message with
 *      the value that is stored already, changes what the record says of
 *      itself (`confirmed`, `connection`, `origin`): one event for the
 *      list, nothing on the display.
 *  M4  A new connection replaces a record only by what it delivers. Until
 *      then the record stays as it was; its `connection` is lower than the
 *      current one and `confirmed` is false, which is how the Overlays page
 *      can tell. No record is removed because the settle hint passed or
 *      because nothing arrived: MQTT has no message for "this topic is
 *      empty", so the absence of a replay proves nothing, and a record that
 *      goes missing on a guess can release what it held back (a device
 *      switched off by an overlay would start driving). What v2 cannot know
 *      is a retained topic that was deleted while pixdcon was disconnected
 *      (A-182). What follows from that is one rule for every kind of
 *      record (the fourth cross-read's decision e): after a reconnect, a
 *      record that the current connection has not delivered again commands
 *      nothing and keeps holding back what it held back.
 *        - What a record commands lapses until it is delivered again: a
 *          scene (the granular topic, the device's scene in the blob; rule
 *          C1 below), a setting value, mode, brightness, a scene path, the
 *          address an ip overlay names, and every key a blob entry patches
 *          or adds. The saved value, the default or config.json decides
 *          meanwhile, as in a process that has just started. A record that
 *          was cleared while pixdcon was away therefore stops at the
 *          reconnect; one that is still stored is back when its replay
 *          arrives, however late.
 *        - What a record holds back stays, delivered again or not, because
 *          lifting it on a guess would let pixdcon touch a display it was
 *          told to leave alone: `enabled` false keeps the device off, in
 *          the granular topic and in a blob entry; and a device whose
 *          address rests on an overlay that is not confirmed is held: it
 *          is listed and not started, neither on the unconfirmed address
 *          nor on the one in config.json (a routing guard). It ends by a
 *          delivered message for its topic, by the user's Clear, or with
 *          the process.
 *      While the broker is away nothing lapses: the records of the last
 *      connection stay as they were until a newer connection exists.
 *      Suppressions are untouched by a reconnect either way.
 *  M5  A value that is not usable is kept, marked invalid with the reason,
 *      and never blocks config.json changes (A-077, A-BUG-06, B-C10). A
 *      setting overlay whose scene or key has no schema yet is held: kept
 *      raw and judged again when schemas change (A-100, B-C13).
 *  M6  An overlay never widens what config.json and the environment allow:
 *      it cannot set `output`, and it can set `enabled` only to false
 *      (state/runtime-config.js overlayDevicePatch).
 *  C1  A scene overlay decides only when the current connection delivered
 *      it, or the last one while the broker is away (scene-layers.js C1,
 *      sceneInputs `confirmed`). At a connect the service announces the
 *      devices whose records now wait ("changed"); the state store computes
 *      again, and the 300 ms debounce of that event means that a replay
 *      which arrives at once changes nothing on the display.
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
 *        d. blob only: a delivered blob has no scene for the device, and no
 *           rewrite of pixdcon is on its way (O3).
 *        e. a newer choice replaces it. Its outstanding acknowledgement then
 *           matches no suppression and is ignored: generations of a device
 *           only rise in one run of the process, also across a removal and
 *           a return of the device (G1).
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
 *  B2  Own writes are correlated, and by something that is their own:
 *      every rewrite carries a mark (the top-level key `_pixdcon`: the
 *      number of the write and a keyed hash, made with a secret of the
 *      process, over that number and the document; v1 ignores the key and
 *      keeps it when it rewrites the blob) that nobody else can make before
 *      the broker has stored the write, and that fits no other document.
 *      The process can check it at any later time without having kept
 *      anything, so an own rewrite is known for the life of the process,
 *      however many followed it. Rewrites come back in the order they were
 *      sent, so only the oldest one on its way is ever taken for an echo
 *      (O1). An own echo
 *      says what the store holds and is never a command. When it is the
 *      blob as it should be, it is applied. When it is an older own write
 *      that came back after a newer blob was applied, it is dropped, and
 *      the blob is published again as it should be. Such an older write
 *      still carries the old scenes of other devices; a choice made for one
 *      of them meanwhile records those values (`alsoStale`), so they are
 *      recognised as pixdcon's own doing when they are delivered, also after
 *      a restart. A blob that carries a mark of this process which fits
 *      its document, be the rewrite on its way, echoed already or of an
 *      earlier connection, is that rewrite come back, whoever published it:
 *      never a command (O2). The same document without the mark, or a
 *      changed document with it, is an outside message. An echo
 *      confirms the generations its own write carries, and nothing else
 *      while a later rewrite is on its way (O3). The service makes the
 *      secret at start (16 random bytes) and hands it to createLayers.
 *  B3  At a disconnect no rewrite is kept to be sent again. After the next
 *      connect the rewrite is built again from the blob the broker replays,
 *      so fields that another publisher changed meanwhile are kept. When a
 *      later connection delivers a rewrite of the connection that ended, as
 *      a replay or as a live message the broker got to late, it is known by
 *      its mark: pixdcon's own, older write and not a command.
 *  B4  An outside blob that arrives while an own rewrite is on its way was
 *      processed before that rewrite. Its content becomes the blob as it
 *      should be; the scenes of superseded devices stay hidden; and when the
 *      own echo shows that the older rewrite has overwritten it, the blob is
 *      published again from the newer content. v1 lost the outside change
 *      here.
 *  W1  One writer. All of the above is for the one instance that may write
 *      the blob (`deps.blobWriter`, fixed for the run by main.js): the
 *      instance that owns the controller topics under the base topic. That
 *      is pixdcon v1 while the transition is on (`topics.transition`), this
 *      instance after it, and never an instance that is forced into shadow
 *      (the edge lane). Two controllers that rewrite one document lose each
 *      other's changes, and each takes the other's rewrite for a scene
 *      command; that the two drive different displays does not help. An
 *      instance that is not the writer publishes nothing to the blob topic,
 *      neither a rewrite nor a clear (clear() answers 409 blob_not_writer),
 *      and nothing that is delivered there ends one of its blob
 *      suppressions: a UI choice holds against the blob, also when the blob
 *      names no scene for the device at that moment, until a newer choice
 *      replaces it, rule S3 f drops it or the device leaves. The writer
 *      rewrites from what it last saw, so its rewrite can carry any older
 *      scene of the device, and nothing tells it from a command. The
 *      suppression is saved; the run that is the writer strips what the
 *      choice replaced. The granular topic of a device has one writer by
 *      the interlock already: the instance that drives the device.
 *
 * WHAT IS ANNOUNCED (E1). "changed" is not decided by a rule. Both reducers
 * compare what their readers answer before and after every step and name
 * what differs; the service passes that on. A record that waits after a
 * connect, one that the new connection delivers again unchanged, a
 * suppression the broker confirmed: each is a difference, so each is
 * announced, and a consumer that computes again only when it is told holds
 * what the mirror says.
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
 * @property {(device: string|null) => import("../types.js").OutputMode} outputOf the one resolved output policy (RuntimeConfig.outputOf): "shadow" for an unknown device, for an interlocked one, and before the runtime config is started. null asks for an overlay that belongs to no single device (a scene path): "drive" only when this instance drives at least one device. Asked for the writes of the other kinds (controls, setting and path clears). The two scene layers do not ask: they are told (applyOutputs), and the blob has its own answer (blobWriter)
 * @property {boolean} blobWriter this instance is the one writer of `<base>/overlay/blob` in this run (W1): the transition is off and the instance is not forced into shadow. main.js decides it once; the service hands it to createLayers
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

  /**
   * The devices of the effective config with their resolved output, as the
   * runtime config has them now. main.js calls it once the runtime config
   * is started and with every "changed" event of it; this is the only way
   * the scene layers learn who is driven (scene-layers.js inputs `output`
   * and `removed`). Until the first call every device is in shadow, so a
   * choice publishes nothing and no clear is sent at start on a guess.
   *
   * The service compares with what the layers hold and feeds one `output`
   * input per device whose output is new or changed, and one `removed`
   * input per device that is no longer listed. That is authoritative
   * evidence (config.json, the environment, v1's device list): a choice
   * made in shadow on a device that is driven now is dropped (S3 f), also
   * when the output changed while the process was down, and the
   * suppressions of a device that left go with it.
   *
   * @param {Array<{name: string, output: import("../types.js").OutputMode}>} devices every device of the effective config, also disabled ones
   */
  applyOutputs(devices) {
    return todo("OverlayService.applyOutputs", devices);
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
   * record's id and receipt time). In effect means: delivered on the
   * current connection (C1) and not replaced by a choice (S2).
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
   * Only what is confirmed commands (M4): a scene path, an ip overlay and
   * the blob count here when the current connection delivered them. What a
   * record holds back is in here whether confirmed or not: `deviceEnabled`
   * false, and `deviceHeld` for a device whose address rests on an overlay
   * that is not confirmed. For a blob that is not confirmed, `blobDevices`
   * holds per entry only what state/runtime-config.js overlayDevicePatch
   * leaves of it then (`enabled` false, and the hold), and `blobScenes` is
   * empty.
   *
   * @returns {import("../types.js").StructuralOverlays}
   */
  structural() {
    return todo("OverlayService.structural");
  }

  /**
   * Valid setting overlay values of one device and scene, as far as the
   * current connection delivered them (M4): a value that is not confirmed
   * is listed by list() and is not in here.
   *
   * @param {string} device
   * @param {string} scene
   * @returns {Record<string, unknown>}
   */
  settingValues(device, scene) {
    return todo("OverlayService.settingValues", device, scene);
  }

  /**
   * Retained controls of one device, as far as the current connection
   * delivered them (M4). A control this process published itself counts as
   * delivered on the connection it was published on.
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
   * @throws {import("../core/errors.js").HttpError} 404 unknown_overlay, 503 mqtt_offline, 409 shadow_output for a device that is not driven and for a scene path when this instance drives nothing, 409 blob_not_writer for the blob when this instance is not its writer (W1)
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
