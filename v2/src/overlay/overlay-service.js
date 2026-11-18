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
import { randomBytes } from "node:crypto";
import { NAME_PATTERN, address, validateDevice } from "../config/schema.js";
import { HttpError } from "../core/errors.js";
import { decideStamp, mayCause } from "../core/ordering.js";
import { freeze, object } from "../core/values.js";
import { normalizeSettingValue } from "../state/precedence.js";
import { overlayDevicePatch } from "../state/runtime-config.js";
import {
  blobView,
  createLayers,
  layersView,
  planChoice,
  reduce,
  sceneInputs,
} from "./scene-layers.js";
import { createMirror, reduceMirror, topicView } from "./topic-fence.js";

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
    this.layers = createLayers({ blobWriter: deps.blobWriter });
    this.mirror = createMirror();
    this.active = false;
    this.started = false;
    this.writes = 0;
    /** @type {Map<string, {topic: string, device: string|null, scene: string|null, key: string|null, kind: import("../types.js").OverlayKind, receivedAt: string}>} */
    this.metadata = new Map();
    /** @type {Map<string, {requestedAt: string, attempts: number}>} */
    this.clears = new Map();
    /** @type {Set<string>} Only names supplied by the reducers' changed effects, accumulated for debounce. */
    this.changedDevices = new Set();
    /** @type {Set<string>} */
    this.changedScenes = new Set();
    this.notice = false;
    /** @type {AbortController|null} */
    this.debounce = null;
    /** @type {{cancel: () => void}|null} */
    this.tick = null;
    /** @type {Array<() => void>} */
    this.unwire = [];
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
    if (this.started)
      return { settled: this.deps.mqtt?.status().settled ?? true };
    this.started = true;
    this.active = true;
    this.layers = createLayers({
      saved: this.deps.savedSuppressions(),
      secret: randomBytes(16).toString("hex"),
      blobWriter: this.deps.blobWriter,
    });
    const mqtt = this.deps.mqtt;
    if (!mqtt) return { settled: true };
    /** @param {{connection: number}} event */
    const connect = ({ connection }) => {
      if (!this.active) return;
      this.feed({ type: "connect", connection });
      this.feedMirror({ type: "connect", connection });
    };
    /** @param {{connection: number}} event */
    const disconnect = ({ connection }) => {
      if (!this.active) return;
      this.feed({ type: "disconnect", connection });
      this.feedMirror({ type: "disconnect", connection });
    };
    /** @param {{connection: number, complete: boolean}} event */
    const settled = (event) => {
      if (!this.active) return;
      const decision = this.feed({ type: "settled", ...event });
      if (decision.action === "apply") this.emit("settled", event);
    };
    mqtt.on("connect", connect);
    mqtt.on("disconnect", disconnect);
    mqtt.on("settled", settled);
    this.unwire.push(
      () => mqtt.off("connect", connect),
      () => mqtt.off("disconnect", disconnect),
      () => mqtt.off("settled", settled),
    );
    if (mqtt.status().state === "connected")
      connect({ connection: mqtt.status().connection });
    for (const filter of [
      ...this.deps.topics.overlayFilters,
      this.deps.topics.settingsFilter,
      `${this.deps.topics.base}/+/mode`,
      `${this.deps.topics.base}/+/brightness_override`,
    ]) {
      this.unwire.push(
        mqtt.subscribe("overlays", filter, (message) => this.accept(message)),
      );
    }
    this.tick = this.deps.clock.every(() => {
      if (!this.active) return;
      this.feed({ type: "tick" });
    }, 1000);
    const hint = await mqtt.settle({ timeoutMs: options?.timeoutMs ?? 5000 });
    if (this.active) this.flushChanged();
    return { settled: hint.complete };
  }

  /** Unsubscribe and cancel timers. Pending clears are dropped; retained state on the broker is left as it is. */
  async stop() {
    this.active = false;
    this.tick?.cancel();
    this.debounce?.abort();
    for (const off of this.unwire.splice(0)) off();
    this.changedDevices.clear();
    this.changedScenes.clear();
    this.notice = false;
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
    if (!this.active) return;
    const outputs = new Map(
      devices.map((device) => [device.name, device.output]),
    );
    for (const name of this.layers.outputs.keys())
      if (!outputs.has(name)) this.feed({ type: "removed", device: name });
    for (const [device, output] of outputs)
      if (this.layers.outputs.get(device) !== output)
        this.feed({ type: "output", device, output });
  }

  // -------------------------------------------------------------------------
  // Reading the mirror
  // -------------------------------------------------------------------------

  /** @returns {OverlayRecord[]} every stored overlay, also invalid and superseded ones */
  list() {
    /** @type {OverlayRecord[]} */
    const records = [];
    for (const [device, topic] of this.layers.granular) {
      if (topic.value === null) continue;
      const id = `device-scene:${device}`;
      const view = layersView(this.layers, device);
      const value = view.granular;
      if (!value) continue;
      const valid = this.sceneKnown(value.scene);
      const suppression = view.suppressions.granular;
      records.push(
        this.record(
          id,
          "device-scene",
          this.deps.topics.overlayDeviceScene(device),
          value.scene,
          value.scene,
          valid,
          !valid
            ? "unknown scene"
            : suppression
              ? "replaced by your choice"
              : !value.confirmed
                ? "waiting for the broker"
                : null,
          value.confirmed,
          valid && value.inEffect,
          null,
          value.origin,
          value.connection,
          device,
          null,
          null,
          suppression
            ? { generation: suppression.generation, at: suppression.at }
            : null,
          view.writing.granular,
        ),
      );
    }
    const blob = blobView(this.layers);
    if (blob) {
      let value = null,
        valid = blob.valid,
        problem = valid ? null : "invalid blob JSON";
      if (valid) {
        value = JSON.parse(blob.text);
        const problems = this.blobProblems(value);
        if (problems.length) {
          valid = false;
          problem = problems.join("; ");
        } else {
          const ignored = Array.isArray(value?.devices)
            ? value.devices.flatMap((/** @type {unknown} */ entry) =>
                object(entry) ? overlayDevicePatch(entry).ignored : [],
              )
            : [];
          if (ignored.length)
            problem = `ignored keys: ${[...new Set(ignored)].join(", ")}`;
        }
      }
      const entries = Array.isArray(value?.devices) ? value.devices : [];
      const off = entries.some(
        (/** @type {unknown} */ entry) =>
          object(entry) &&
          overlayDevicePatch(entry, { confirmed: blob.confirmed }).patch
            .enabled === false,
      );
      const held =
        !blob.confirmed &&
        entries.some(
          (/** @type {unknown} */ entry) =>
            object(entry) && typeof entry.ip === "string" && entry.ip.trim(),
        );
      records.push(
        this.record(
          "blob",
          "blob",
          this.deps.topics.overlayBlob,
          blob.text,
          value,
          valid,
          problem ?? (!blob.confirmed ? "waiting for the broker" : null),
          blob.confirmed,
          valid && blob.confirmed,
          off ? "off" : held ? "held" : null,
          blob.origin,
          blob.connection,
          null,
          null,
          null,
          null,
          this.layers.blob.outstanding.length > 0,
        ),
      );
    }
    for (const [id, entry] of this.mirror.topics) {
      const view = topicView(this.mirror, id);
      if (!view || view.value === null) continue;
      const meta = this.metadata.get(id);
      if (!meta) continue;
      const parsed = this.parseValue(
        entry.kind,
        view.value,
        meta.scene,
        meta.key,
      );
      records.push(
        this.record(
          id,
          entry.kind,
          meta.topic,
          view.value,
          parsed.value,
          parsed.valid,
          parsed.problem ?? (!view.confirmed ? "waiting for the broker" : null),
          view.confirmed,
          parsed.valid && view.command !== null && view.confirmed,
          parsed.valid ? view.restriction : null,
          view.origin === "own" ? "live" : view.origin,
          view.connection,
          meta.device,
          meta.scene,
          meta.key,
          null,
          entry.record.outstanding.some((payload) => payload === ""),
        ),
      );
    }
    return freeze(records);
  }

  /**
   * @param {string} id
   * @returns {OverlayRecord|undefined}
   */
  get(id) {
    return this.list().find((record) => record.id === id);
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
    const inputs = sceneInputs(this.layers, device);
    /** @param {"granular"|"blob"} layer */
    const value = (layer) => {
      const entry = inputs[layer];
      if (!entry) return null;
      const id = layer === "granular" ? `device-scene:${device}` : "blob";
      return {
        scene: entry.scene,
        inEffect: entry.inEffect && this.sceneKnown(entry.scene),
        since:
          this.metadata.get(id)?.receivedAt ??
          new Date(this.deps.clock.now()).toISOString(),
        overlayId: id,
      };
    };
    return { granular: value("granular"), blob: value("blob") };
  }

  /**
   * Active suppressions of a device, also those that are confirmed and only
   * drain in memory (S3 c).
   *
   * @param {string} device
   * @returns {{granular: (SceneSuppression & {confirmed: boolean})|null, blob: (SceneSuppression & {confirmed: boolean})|null}}
   */
  suppressions(device) {
    return freeze(layersView(this.layers, device).suppressions);
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
   * leaves of it then (`enabled` false, and the hold). A disabled entry
   * also retains type and address as listing identity while held; enabled
   * false and deviceHeld prevent any runtime or command. `blobScenes` is empty.
   *
   * @returns {import("../types.js").StructuralOverlays}
   */
  structural() {
    /** @type {import("../types.js").StructuralOverlays} */
    const structural = {
      blobDevices: [],
      blobScenes: {},
      scenePaths: {},
      deviceIps: {},
      deviceEnabled: {},
      deviceHeld: [],
    };
    const blob = blobView(this.layers);
    if (blob?.valid) {
      const value = JSON.parse(blob.text);
      for (const entry of Array.isArray(value.devices) ? value.devices : []) {
        if (
          !object(entry) ||
          typeof entry.name !== "string" ||
          !NAME_PATTERN.test(entry.name)
        )
          continue;
        const allowed = overlayDevicePatch(entry, {
          confirmed: blob.confirmed,
        });
        if (allowed.held) structural.deviceHeld.push(entry.name);
        if (blob.confirmed)
          structural.blobDevices.push({ ...entry, name: entry.name });
        else if (allowed.patch.enabled === false)
          structural.blobDevices.push({
            name: entry.name,
            // Identity for a disabled blob-only device, never permission to
            // use its unconfirmed address: deviceHeld also keeps it stopped.
            ...(allowed.held ? { type: entry.type, ip: entry.ip } : {}),
            enabled: false,
          });
      }
      if (blob.confirmed && object(value.scenes))
        structural.blobScenes = value.scenes;
    }
    for (const [id, meta] of this.metadata) {
      const view = topicView(this.mirror, id);
      if (!view || view.value === null) continue;
      const parsed = this.parseValue(
        view.kind,
        view.value,
        meta.scene,
        meta.key,
      );
      if (!parsed.valid) continue;
      if (view.restriction === "off" && meta.device)
        structural.deviceEnabled[meta.device] = false;
      if (view.restriction === "held" && meta.device)
        structural.deviceHeld.push(meta.device);
      if (view.command !== null && view.kind === "device-ip" && meta.device)
        structural.deviceIps[meta.device] = /** @type {string} */ (
          parsed.value
        );
      if (view.command !== null && view.kind === "scene-path" && meta.scene)
        structural.scenePaths[meta.scene] = /** @type {string} */ (
          parsed.value
        );
    }
    return freeze(structural);
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
    return Object.fromEntries(
      this.list()
        .filter(
          (record) =>
            record.kind === "setting" &&
            record.device === device &&
            record.scene === scene &&
            record.inEffect,
        )
        .map((record) => [record.key, record.value]),
    );
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
    const mode = this.get(`mode:${device}`);
    const brightness = this.get(`brightness:${device}`);
    return {
      mode: mode?.inEffect
        ? { value: /** @type {PlaybackMode} */ (mode.value), record: mode }
        : null,
      brightness: brightness?.inEffect
        ? {
            percent: /** @type {number} */ (brightness.value),
            record: brightness,
          }
        : null,
    };
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
    if (!this.deps.mqtt)
      return {
        device,
        generation: (this.layers.generations.get(device) ?? 0) + 1,
        at,
        granular: null,
        blob: null,
      };
    return freeze(
      planChoice(this.layers, device, {
        at,
        output: this.deps.outputOf(device),
      }),
    );
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
    const superseded = this.list()
      .filter(
        (record) =>
          (record.device === plan.device && record.kind === "device-scene") ||
          (record.kind === "blob" && this.layers.blob.scenes.has(plan.device)),
      )
      .map((record) => record.id);
    this.feed({ type: "choice", plan });
    const writing = layersView(this.layers, plan.device).writing;
    return { superseded, clearPending: writing.granular || writing.blob };
  }

  /**
   * Explicit clear of one overlay ("Clear", "Restore", "Return to …").
   *
   * @param {string} id
   * @returns {Promise<ClearResult>}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_overlay, 503 mqtt_offline, 409 shadow_output for a device that is not driven and for a scene path when this instance drives nothing, 409 blob_not_writer for the blob when this instance is not its writer (W1)
   */
  async clear(id) {
    if (id === "blob" && !this.deps.blobWriter)
      throw new HttpError(
        409,
        "blob_not_writer",
        "This instance is not the blob writer",
      );
    const record = this.get(id);
    if (!record)
      throw new HttpError(404, "unknown_overlay", `Unknown overlay: ${id}`);
    this.requirePublish(record.device);
    if (record.kind === "blob" || record.kind === "device-scene") {
      const result = await this.deps.mqtt.publish(record.topic, "", {
        retain: true,
        qos: 1,
      });
      return { confirmed: result.outcome === "confirmed", pending: !result.ok };
    }
    const result = await this.writeMirror(record.topic, "");
    return { confirmed: result.outcome === "confirmed", pending: !result.ok };
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
    const selected =
      keys ??
      this.list()
        .filter(
          (record) =>
            record.kind === "setting" &&
            record.device === device &&
            record.scene === scene,
        )
        .map((record) => record.key)
        .filter((key) => key !== null);
    /** @type {string[]} */
    const cleared = [],
      failed = [];
    for (const key of selected) {
      const id = `setting:${device}:${scene}:${key}`;
      if (!this.get(id)) continue;
      try {
        (await this.clear(id)).confirmed ? cleared.push(key) : failed.push(key);
      } catch {
        failed.push(key);
      }
    }
    return { cleared, failed };
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
    this.requirePublish(device);
    const schema = this.deps.schemaOf(scene) ?? {};
    /** @type {string[]} */
    const applied = [];
    const rejected = Object.keys(values).filter(
      (key) => !Object.hasOwn(schema, key),
    );
    /** @type {string[]} */
    const failed = [];
    for (const [key, field] of Object.entries(schema)) {
      if (!Object.hasOwn(values, key)) continue;
      const value = normalizeSettingValue(values[key], field);
      if (value === undefined) {
        rejected.push(key);
        continue;
      }
      const result = await this.writeMirror(
        this.deps.topics.setting(device, scene, key),
        field.type === "json" ? JSON.stringify(value) : String(value),
      );
      (result.ok ? applied : failed).push(key);
    }
    return { applied, rejected, failed };
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
    this.requirePublish(device);
    if (scene && !this.sceneKnown(scene))
      throw new HttpError(400, "unknown_scene", `Unknown scene: ${scene}`);
    const result = await this.deps.mqtt.publish(
      this.deps.topics.overlayDeviceScene(device),
      scene ?? "",
      { retain: true, qos: 1 },
    );
    return { confirmed: result.outcome === "confirmed", pending: !result.ok };
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
    if (!this.deps.mqtt || this.deps.outputOf(device) === "shadow")
      return { confirmed: false };
    this.requirePublish(device);
    const topic =
      "mode" in control
        ? this.deps.topics.mode(device)
        : this.deps.topics.brightnessOverride(device);
    const payload =
      "mode" in control
        ? control.mode
        : control.brightness === null
          ? ""
          : String(control.brightness);
    const result = await this.writeMirror(topic, payload);
    if (result.outcome === "offline")
      throw new HttpError(503, "mqtt_offline", "MQTT is offline");
    return { confirmed: result.outcome === "confirmed" };
  }

  /** @param {import("../mqtt/mqtt-gateway.js").MqttMessage} message */
  accept(message) {
    if (!this.active) return;
    const parsed = this.deps.topics.parse(message.topic);
    if (!parsed) return;
    const id = recordId(parsed);
    const meta = {
      ...parsed,
      topic: message.topic,
      receivedAt: message.receivedAt,
    };
    if (parsed.kind === "blob" || parsed.kind === "device-scene") {
      const input =
        parsed.kind === "blob"
          ? { type: /** @type {const} */ ("blob"), ...message }
          : {
              type: /** @type {const} */ ("granular"),
              ...message,
              device: parsed.device ?? "",
            };
      const result = reduce(this.layers, input);
      this.layers = result.state;
      if (result.effects.some((effect) => effect.type === "changed"))
        this.metadata.set(id, meta);
      this.effects(result.effects);
    } else {
      // PIXD-93: use the frozen mirror unchanged; its M26 regression is a
      // separate coordinator ticket.
      const result = reduceMirror(this.mirror, {
        type: "message",
        key: id,
        kind: parsed.kind,
        ...message,
      });
      this.mirror = result.state;
      if (result.effects.length) this.metadata.set(id, meta);
      this.mirrorEffects(result.effects);
    }
  }

  /** @param {import("./scene-layers.js").LayersInput} input */
  feed(input) {
    const result = reduce(this.layers, input);
    this.layers = result.state;
    this.effects(result.effects);
    return result.decision;
  }

  /** @param {import("./topic-fence.js").MirrorInput} input */
  feedMirror(input) {
    const result = reduceMirror(this.mirror, input);
    this.mirror = result.state;
    this.mirrorEffects(result.effects);
    return result.decision;
  }

  /** @param {import("./scene-layers.js").LayersEffect[]} effects */
  effects(effects) {
    for (const effect of effects) {
      if (effect.type === "retire") {
        this.emit("suppression", effect);
        continue;
      }
      if (effect.type === "warn") {
        this.deps.logger.warn(`[Overlays] ${effect.message}`);
        continue;
      }
      if (effect.type === "changed") {
        const devices = [...effect.devices];
        const scenes = [];
        if (effect.blob) {
          devices.push(...this.layers.outputs.keys());
          const blob = blobView(this.layers);
          if (blob?.valid) {
            const value = JSON.parse(blob.text);
            for (const entry of Array.isArray(value.devices)
              ? value.devices
              : [])
              if (typeof entry?.name === "string") devices.push(entry.name);
            if (object(value.scenes)) scenes.push(...Object.keys(value.scenes));
          }
        }
        this.announce(devices, scenes);
        continue;
      }
      if (
        !this.active ||
        !mayCause("publish", effect.evidence, { repeatOf: "command" })
      )
        continue;
      const topic =
        effect.type === "publish-clear"
          ? this.deps.topics.overlayDeviceScene(effect.device)
          : this.deps.topics.overlayBlob;
      if (effect.type === "publish-blob" && !this.deps.blobWriter) continue;
      const payload = effect.type === "publish-clear" ? "" : effect.payload;
      this.clears.set(
        effect.type === "publish-clear"
          ? `device-scene:${effect.device}`
          : "blob",
        {
          requestedAt: new Date(this.deps.clock.now()).toISOString(),
          attempts:
            (this.clears.get(
              effect.type === "publish-clear"
                ? `device-scene:${effect.device}`
                : "blob",
            )?.attempts ?? 0) + 1,
        },
      );
      const connection = this.layers.connection;
      void this.deps.mqtt
        ?.publish(topic, payload, { retain: true, qos: 1 })
        .then((result) => {
          if (
            !this.active ||
            decideStamp(
              { source: this.layers.connection },
              { source: connection },
            ).action !== "apply" ||
            result.outcome === "offline"
          )
            return;
          this.feed({
            type: "published",
            write: effect.write,
            outcome:
              result.outcome === "confirmed"
                ? "confirmed"
                : result.outcome === "error"
                  ? "failed"
                  : "unknown",
          });
        });
    }
  }

  /** @param {import("./topic-fence.js").MirrorEffect[]} effects */
  mirrorEffects(effects) {
    for (const effect of effects) {
      const devices = [],
        scenes = [];
      for (const key of effect.keys) {
        const meta = this.metadata.get(key);
        if (meta?.device) devices.push(meta.device);
        if (meta?.scene) scenes.push(meta.scene);
      }
      this.announce(devices, scenes);
    }
  }

  /** @param {string[]} devices @param {string[]} scenes */
  announce(devices, scenes) {
    for (const name of devices) this.changedDevices.add(name);
    for (const key of scenes) this.changedScenes.add(key);
    this.notice = true;
    this.debounce?.abort();
    const mine = (this.debounce = new AbortController());
    void this.deps.clock.sleep(300, mine.signal).then((elapsed) => {
      if (!this.active || !elapsed || mine.signal.aborted) return;
      this.flushChanged();
    });
  }

  flushChanged() {
    if (!this.notice || !this.active) return;
    this.debounce?.abort();
    const devices = [...this.changedDevices].sort(),
      scenes = [...this.changedScenes].sort();
    this.changedDevices.clear();
    this.changedScenes.clear();
    this.notice = false;
    this.emit("changed", { records: this.list(), devices, scenes });
  }

  /** @param {string|null} device @returns {asserts this is this & {deps: OverlayServiceDeps & {mqtt: import("../mqtt/mqtt-gateway.js").MqttGateway}}} */
  requirePublish(device) {
    if (!this.active)
      throw new HttpError(503, "stopping", "Overlay service is stopped");
    if (this.deps.outputOf(device) !== "drive")
      throw new HttpError(
        409,
        "shadow_output",
        "This device is in shadow output",
      );
    if (!this.deps.mqtt || this.deps.mqtt.status().state !== "connected")
      throw new HttpError(503, "mqtt_offline", "MQTT is offline");
  }

  /** @param {string} topic @param {string} payload */
  async writeMirror(topic, payload) {
    const parsed = this.deps.topics.parse(topic);
    if (!parsed || parsed.kind === "blob" || parsed.kind === "device-scene")
      throw new Error("Expected a mirror topic");
    this.requirePublish(parsed.device);
    const id = recordId(parsed),
      write = ++this.writes;
    this.metadata.set(id, {
      ...parsed,
      topic,
      receivedAt: new Date(this.deps.clock.now()).toISOString(),
    });
    const decision = this.feedMirror({
      type: "own-write",
      key: id,
      kind: parsed.kind,
      payload,
      write,
    });
    if (decision.action === "drop")
      throw new HttpError(503, "mqtt_offline", "MQTT is offline");
    const connection = this.mirror.connection;
    const result = await this.deps.mqtt.publish(topic, payload, {
      retain: true,
      qos: 1,
    });
    if (
      this.active &&
      decideStamp({ source: this.mirror.connection }, { source: connection })
        .action === "apply" &&
      (result.outcome === "confirmed" || result.outcome === "error")
    )
      this.feedMirror({
        type: "published",
        key: id,
        write,
        outcome: result.outcome === "confirmed" ? "confirmed" : "failed",
      });
    return result;
  }

  /** @param {string} scene @returns {boolean} */
  sceneKnown(scene) {
    return scene.startsWith("builtin:") || this.deps.schemaOf(scene) !== null;
  }

  /** @param {import("./topic-fence.js").OverrideKind} kind @param {string} raw @param {string|null} scene @param {string|null} key @returns {{valid: boolean, value: unknown, problem: string|null}} */
  parseValue(kind, raw, scene, key) {
    try {
      let value;
      if (kind === "device-ip") value = address(raw);
      else if (kind === "device-enabled") {
        if (!["true", "false"].includes(raw.trim().toLowerCase()))
          throw new Error("expected true or false");
        value = raw.trim().toLowerCase() === "true";
      } else if (kind === "scene-path") {
        if (!raw.trim()) throw new Error("empty path");
        value = raw.trim();
      } else if (kind === "mode") {
        if (!["play", "pause", "stop"].includes(raw))
          throw new Error("invalid mode");
        value = raw;
      } else if (kind === "brightness") {
        value = Number(raw);
        if (!raw.trim() || !Number.isFinite(value) || value < 1 || value > 100)
          throw new Error("expected 1 to 100");
      } else {
        const schema = scene ? this.deps.schemaOf(scene) : null;
        const field =
          key && schema && Object.hasOwn(schema, key) ? schema[key] : null;
        if (!field) throw new Error("no schema for this key yet");
        value = normalizeSettingValue(raw, field);
        if (value === undefined) throw new Error("invalid setting value");
      }
      return { valid: true, value, problem: null };
    } catch (error) {
      return {
        valid: false,
        value: null,
        problem: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** @param {any} value @returns {string[]} */
  blobProblems(value) {
    const problems = [];
    if (value.devices !== undefined && !Array.isArray(value.devices))
      problems.push("devices must be an array");
    for (const entry of Array.isArray(value.devices) ? value.devices : []) {
      if (!object(entry)) {
        problems.push("invalid device entry");
        continue;
      }
      try {
        validateDevice({
          type: "pixoo",
          ip: "localhost",
          ...overlayDevicePatch(entry).patch,
          name: entry.name,
        });
      } catch (error) {
        problems.push(String(error));
      }
    }
    if (value.scenes !== undefined && !object(value.scenes))
      problems.push("scenes must be an object");
    return problems;
  }

  /** @param {string} id @param {OverlayRecord["kind"]} kind @param {string} topic @param {string} raw @param {unknown} value @param {boolean} valid @param {string|null} problem @param {boolean} confirmed @param {boolean} inEffect @param {OverlayRecord["restricts"]} restricts @param {"replay"|"live"|null} origin @param {number} connection @param {string|null} device @param {string|null} scene @param {string|null} key @param {OverlayRecord["supersededBy"]} supersededBy @param {boolean} pending @returns {OverlayRecord} */
  record(
    id,
    kind,
    topic,
    raw,
    value,
    valid,
    problem,
    confirmed,
    inEffect,
    restricts,
    origin,
    connection,
    device,
    scene,
    key,
    supersededBy,
    pending,
  ) {
    const clear = this.clears.get(id);
    return {
      id,
      kind,
      topic,
      raw,
      value,
      valid,
      problem,
      confirmed,
      inEffect,
      restricts,
      origin: origin ?? "live",
      connection,
      device,
      scene,
      key,
      supersededBy,
      receivedAt:
        this.metadata.get(id)?.receivedAt ??
        new Date(this.deps.clock.now()).toISOString(),
      clear: {
        pending,
        requestedAt: clear?.requestedAt ?? null,
        attempts: clear?.attempts ?? 0,
      },
    };
  }
}

/** @param {{kind: import("../types.js").OverlayKind, device: string|null, scene: string|null, key: string|null}} parsed @returns {string} */
function recordId(parsed) {
  if (parsed.kind === "blob") return "blob";
  if (parsed.kind === "setting")
    return `setting:${parsed.device}:${parsed.scene}:${parsed.key}`;
  if (parsed.kind === "scene-path") return `scene-path:${parsed.scene}`;
  return `${parsed.kind}:${parsed.device}`;
}
