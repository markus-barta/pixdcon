/**
 * Scene layers: the pure core of the overlay service for the two places a
 * scene overlay can be stored, the granular topic of a device and the
 * device's entry in the blob.
 *
 * It is the ordering rule (core/ordering.js) for these two layers, as a
 * reducer: `reduce(state, input)` answers with the next state, the decision
 * (apply, hold or drop) and the effects the service has to carry out. No
 * I/O, no clock: the overlay service feeds it the gateway's messages and
 * events and performs the effects. The rules M1 to M5, S1 to S5 and B1 to B4
 * in the header of overlay-service.js are what this file does; C1, G1 and
 * O1 to O3 below were added after the third cross-read.
 *
 * WHAT IS HELD PER TOPIC
 *  - what the broker's store holds as far as it was delivered, and on which
 *    connection it was delivered. Nothing is removed because the settle
 *    hint passed or because nothing arrived (M4).
 *  - whether a live message was seen on the current connection: after that a
 *    replay for the topic is dropped (M2).
 *  - own writes whose echo has not come back yet. The broker forwards a
 *    topic's messages to one subscriber in the order it processed them, so
 *    everything that arrives on a topic before the echo of an own write was
 *    processed before that write. It is older than the write and never a new
 *    command, live or not. It is still what the store holds until the write
 *    lands, so the mirror takes it, in the place of a replaced value.
 *  - for the blob: the content as it should be (`base`), what the store is
 *    known to hold (`store`), the own rewrites of this connection (`own`)
 *    and those of earlier connections that the store may hold or still get
 *    (`sent`).
 *
 * C1  WHO DECIDES. A scene value is in effect only when the connection that
 *     delivered it is the current one, or the last one while the broker is
 *     away. When a newer connection exists, a value of the connection
 *     before is a record that waits: it is still listed (`confirmed`
 *     false), it decides nothing, and it gets its say back the moment this
 *     connection delivers it, as a replay or live, however late. Whether the
 *     store still holds a value cannot be asked: MQTT has no message for
 *     "this topic is empty", so a topic that was cleared while pixdcon was
 *     away simply stays silent, and its record would otherwise override the
 *     user's choice until the next restart (matrix A-182). Nothing is
 *     concluded from that silence, from the settle hint or from time: the
 *     record is not removed, no suppression ends, nothing is published. The
 *     rule is about the command a record gives, and only that. What a
 *     record holds back is kept: a suppression does not depend on the
 *     connection at all, and the other retained topics (an `enabled`
 *     overlay that switches a device off, an address, a path, a setting, a
 *     control) stay in effect across a reconnect (topic-fence.js, M4).
 *
 * G1  GENERATIONS. The choice generation of a device only rises in one run
 *     of the process, also when the device leaves the effective config and
 *     comes back: its writes may still be on their way, and their
 *     acknowledgements and echoes name generations. A plan that does not
 *     carry a higher generation than the device's last choice is refused.
 *
 * OWN WRITES OF THE BLOB
 * O1  Every rewrite carries a mark of its own (WRITE_MARK, a top-level key
 *     of the blob that pixdcon v1 and the structural overlays ignore),
 *     derived from a secret of the process. Its bytes are therefore its
 *     identity: nobody else can publish them before the broker has stored
 *     the write. Own rewrites come back in the order they were sent, so
 *     only the oldest one on its way can be echoed: a message with its
 *     exact bytes is its echo. An acknowledgement says the write, and every
 *     rewrite sent before it, is in the store.
 * O2  A blob with the exact bytes of any other own rewrite (a later one on
 *     its way, one that was echoed already, one of an earlier connection)
 *     is that rewrite, whoever published it and when. It says what the
 *     store holds and is never a command: no suppression ends, and the blob
 *     as it should be stays. When the store then differs from the blob as
 *     it should be, the blob is published again. The document alone is not
 *     the identity: the same document without the mark, or with an older
 *     mark, is an outside message like any other.
 * O3  An echo or an acknowledgement confirms exactly the generations its own
 *     write carries. What else a blob shows (a device without a scene has
 *     nothing left to strip) counts only when no rewrite of pixdcon is on
 *     its way: a later one was built from other content and may carry a
 *     scene for the device into the store again.
 *     An empty payload has no identity. A clear of somebody else that the
 *     broker processes just before an own clear is taken for the echo; the
 *     store is empty either way.
 *
 * WHAT MQTT CANNOT ORDER. A live message that arrives while no own write is
 * on its way on its topic may have been published just before a UI choice
 * or just after it. It is taken as a new command. See overlay-service.js.
 *
 * test/contract/ordering.test.js runs the interleavings somebody thought
 * of; test/contract/ordering-model.test.js runs this file against a model
 * of a broker and of an outside client that copies pixdcon's own writes,
 * with random ones. Both must stay green when this file changes.
 *
 * WHEN SOMETHING IS PUBLISHED. Only on evidence (core/ordering.js mayCause):
 *  - the clear of a choice on the connection the choice was made on (the
 *    choice is the newest command at that moment). It is repeated on that
 *    connection until its outcome is known.
 *  - a clear, or a blob rewrite, when a value that a suppression hides was
 *    delivered on the current connection.
 *  - a blob rewrite when a delivered own rewrite shows that the store holds
 *    an older own write than the blob as it should be.
 * Never because a connection came up, the settle hint passed or a timer
 * fired without such evidence: a blind clear after a reconnect could delete
 * a command that was stored while pixdcon was away and has not been
 * delivered yet.
 *
 * WHEN A SUPPRESSION ENDS (S3), always with the evidence named:
 *   outside_command    an outside live message on the layer, with no own
 *                      write outstanding
 *   stored_while_away  a replay with a value the suppression does not hide,
 *                      in a blob that is not a rewrite of pixdcon itself
 *   confirmed          the broker acknowledged or echoed the clear or the
 *                      rewrite of the same generation
 *   nothing_to_strip   blob: a delivered blob has no scene for the device,
 *                      and no rewrite of pixdcon is on its way
 *   replaced           a newer choice
 *   dropped            an authoritative output change from shadow to drive
 *                      after a choice made in shadow; the device left the
 *                      effective config
 *
 * Owner: core/state worker.
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { apply, drop, hold } from "../core/ordering.js";
import { isSuperseded } from "../state/precedence.js";

/** @typedef {import("../types.js").SceneSuppression} SceneSuppression */
/** @typedef {import("../types.js").SceneLayer} SceneLayer */
/** @typedef {import("../types.js").OutputMode} OutputMode */
/** @typedef {import("../types.js").IsoTime} IsoTime */
/** @typedef {import("../core/ordering.js").Decision} Decision */
/** @typedef {import("../core/ordering.js").EvidenceKind} EvidenceKind */

/**
 * A suppression as it lives in memory.
 *
 * @typedef {SceneSuppression & {confirmed: boolean, owedOn: number}} ActiveSuppression
 * confirmed: the broker acknowledged the clear or rewrite of this generation. It is out of config.json and only waits for the own echo or the end of the connection.
 * owedOn: connection on which the choice's own clear is still owed (the connection the choice was made on); 0 = none
 */

/**
 * @typedef {object} GranularTopic `<base>/overlay/device/<device>/scene`
 * @property {string|null} value what the store holds as far as delivered; null = nothing stored as far as known
 * @property {number} delivered connection on which `value` was last delivered or confirmed; 0 = nothing delivered in this process
 * @property {"replay"|"live"|null} origin
 * @property {number} live connection on which a live message was last delivered; 0 = none
 * @property {Array<{write: number, generation: number}>} outstanding own clears sent on the current connection whose echo has not arrived, oldest first
 * @property {boolean} wait the last attempt failed: the next one waits for the retry tick
 */

/**
 * @typedef {object} BlobTopic `<base>/overlay/blob`
 * @property {string|null} base the blob as it should be: the last content an outside client stored (replay or outside live message), or an own rewrite once the store holds it; null = none known, or cleared
 * @property {boolean} valid false: `base` is not a JSON object. It is kept raw and decides nothing (M5)
 * @property {Map<string, string>} scenes device → the scene `base` names for it (`scene`, else the first of a legacy `scenes` array)
 * @property {string|null} store what the broker's store holds as far as delivered on the current connection; null = not known on this connection, "" = known to be empty
 * @property {boolean} storeOwn true: `store` is a rewrite of pixdcon itself (known by its acknowledgement or echo)
 * @property {number} delivered connection on which `base` was last delivered; 0 = never
 * @property {"replay"|"live"|null} origin
 * @property {number} live
 * @property {Array<{write: number, payload: string, generations: Array<{device: string, generation: number}>, landed: boolean}>} outstanding own rewrites sent on the current connection whose echo has not arrived, oldest first. landed: the broker acknowledged it
 * @property {string[]} own the rewrites pixdcon sent on the current connection, on their way or echoed already (the last OWN_MEMORY of them; an empty payload has no identity and is not kept). A blob with exactly these bytes is that rewrite, whoever published it (O2)
 * @property {string[]} sent own rewrites of earlier connections that the store may hold, or may still get: the one the store was last known to hold when a connection ended, and those that were on their way then (the last OWN_MEMORY of them). Kept across connections, for the life of the process
 * @property {boolean} wait
 */

/**
 * @typedef {object} LayersState
 * @property {number} connection current connection number; 0 = never connected
 * @property {boolean} connected
 * @property {string} secret what the write marks of this process are derived from (O1); random per run, never leaves the process
 * @property {number} writes number of the last own write
 * @property {Map<string, GranularTopic>} granular device → topic
 * @property {BlobTopic} blob
 * @property {Map<string, {granular?: ActiveSuppression, blob?: ActiveSuppression}>} suppressions
 * @property {Map<string, number>} generations device → generation of its last choice. Never taken back in a process, also when the device leaves the config (G1)
 * @property {Map<string, OutputMode>} outputs device → resolved output; a device that is not listed is in shadow
 */

/**
 * @typedef {object} ChoicePlan What a UI choice does to the two layers (overlay-service.js SupersedePlan).
 * @property {string} device
 * @property {number} generation
 * @property {IsoTime} at
 * @property {SceneSuppression|null} granular
 * @property {SceneSuppression|null} blob null: a blob delivered on this connection has no scene for the device
 */

/**
 * @typedef {{type: "connect", connection: number}
 *   | {type: "disconnect", connection: number}
 *   | {type: "settled", connection: number, complete: boolean}
 *   | {type: "tick"}
 *   | {type: "granular", device: string, payload: string, retain: boolean, connection: number}
 *   | {type: "blob", payload: string, retain: boolean, connection: number}
 *   | {type: "published", write: number, outcome: "confirmed"|"failed"|"unknown"}
 *   | {type: "choice", plan: ChoicePlan}
 *   | {type: "output", device: string, output: OutputMode}
 *   | {type: "removed", device: string}} LayersInput
 * published: outcome of an own publish. failed = it was certainly not sent; unknown = no acknowledgement in time on a connection that is still up.
 * output: an authoritative change of a device's resolved output (config.json, the environment, v1's device list).
 */

/**
 * @typedef {{type: "publish-clear", device: string, generation: number, write: number, evidence: EvidenceKind}
 *   | {type: "publish-blob", payload: string, generations: Array<{device: string, generation: number}>, write: number, evidence: EvidenceKind}
 *   | {type: "retire", device: string, layer: SceneLayer, generation: number, ended: "outside_command"|"stored_while_away"|"confirmed"|"nothing_to_strip"|"replaced"|"dropped", evidence: EvidenceKind}
 *   | {type: "changed", devices: string[]}
 *   | {type: "warn", message: string}} LayersEffect
 * publish-clear: retained empty payload to the device's granular topic. publish-blob: the whole blob, retained; "" clears it.
 * retire: the suppression ended; the state store removes it from config.json.
 */

/** @returns {GranularTopic} */
const newTopic = () => ({
  value: null,
  delivered: 0,
  origin: null,
  live: 0,
  outstanding: [],
  wait: false,
});

/**
 * @param {{saved?: Array<{device: string, layer: SceneLayer, suppression: SceneSuppression}>, outputs?: Record<string, OutputMode>, secret?: string}} [options]
 * saved: the suppressions config.json holds (S5): taken before the first message. outputs: the resolved output per device at start. secret: random bytes of this run of the process, as text (the overlay service passes 16 of them); the write marks are derived from it.
 * @returns {LayersState}
 */
export function createLayers(options = {}) {
  /** @type {LayersState} */
  const state = {
    connection: 0,
    connected: false,
    secret: options.secret ?? "",
    writes: 0,
    granular: new Map(),
    blob: {
      base: null,
      valid: true,
      scenes: new Map(),
      store: null,
      storeOwn: false,
      delivered: 0,
      origin: null,
      live: 0,
      outstanding: [],
      own: [],
      sent: [],
      wait: false,
    },
    suppressions: new Map(),
    generations: new Map(),
    outputs: new Map(Object.entries(options.outputs ?? {})),
  };
  for (const { device, layer, suppression } of options.saved ?? []) {
    const entry = state.suppressions.get(device) ?? {};
    entry[layer] = {
      ...suppression,
      alsoStale: [...(suppression.alsoStale ?? [])],
      confirmed: false,
      owedOn: 0,
    };
    state.suppressions.set(device, entry);
    state.generations.set(
      device,
      Math.max(state.generations.get(device) ?? 0, suppression.generation),
    );
  }
  return state;
}

// ---------------------------------------------------------------------------
// The blob as a document
// ---------------------------------------------------------------------------

/**
 * @param {string|null} text
 * @returns {Record<string, any>|null} the blob as an object, or null when it is not a JSON object
 */
function parseBlob(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, any>} entry a device entry of the blob
 * @returns {string|null} the scene it names; a legacy `scenes` array is read as its first element (A-046)
 */
function sceneOfEntry(entry) {
  if (typeof entry.scene === "string" && entry.scene) return entry.scene;
  if (Array.isArray(entry.scenes) && typeof entry.scenes[0] === "string")
    return entry.scenes[0] || null;
  return null;
}

/**
 * @param {Record<string, any>|null} blob
 * @returns {Map<string, string>} device → scene
 */
export function blobScenes(blob) {
  /** @type {Map<string, Record<string, any>>} */
  const merged = new Map();
  for (const entry of Array.isArray(blob?.devices) ? blob.devices : []) {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string")
      continue;
    merged.set(entry.name, { ...merged.get(entry.name), ...entry });
  }
  /** @type {Map<string, string>} */
  const scenes = new Map();
  for (const [name, entry] of merged) {
    const scene = sceneOfEntry(entry);
    if (scene !== null) scenes.set(name, scene);
  }
  return scenes;
}

/**
 * The key a rewrite of pixdcon carries at the top level of the blob: its
 * write mark (O1). pixdcon v1 and the structural overlays ignore the key.
 */
export const WRITE_MARK = "_pixdcon";

/**
 * @param {Record<string, any>|null} blob
 * @returns {Record<string, any>|null} the blob without the write mark; what is compared when two blobs are asked to be the same document
 */
export function withoutMark(blob) {
  if (blob === null || !Object.hasOwn(blob, WRITE_MARK)) return blob;
  const document = { ...blob };
  delete document[WRITE_MARK];
  return document;
}

/**
 * The mark of an own rewrite: 16 hex characters that nobody outside the
 * process can know before the broker has stored the write. So a blob with
 * the exact bytes of a rewrite that is still on its way can only be that
 * rewrite's echo, and a byte-identical copy can only come after it.
 *
 * @param {LayersState} state
 * @param {number} write number of the own write
 * @returns {string}
 */
const markOf = (state, write) =>
  createHash("sha256")
    .update(`${state.secret}\n${write}`)
    .digest("hex")
    .slice(0, 16);

/**
 * The blob without `scene` and the legacy `scenes` array of the given
 * devices (B1). Every other key, every other device and the order stay.
 *
 * @param {Record<string, any>} blob
 * @param {Set<string>} devices
 * @returns {Record<string, any>} a copy
 */
export function stripBlobScenes(blob, devices) {
  const copy = structuredClone(blob);
  for (const entry of Array.isArray(copy.devices) ? copy.devices : []) {
    if (!entry || typeof entry !== "object" || !devices.has(entry.name))
      continue;
    delete entry.scene;
    delete entry.scenes;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Reading the state
// ---------------------------------------------------------------------------

/**
 * @param {LayersState} state
 * @param {string} device
 * @param {SceneLayer} layer
 * @returns {ActiveSuppression|undefined}
 */
const suppressionOf = (state, device, layer) =>
  state.suppressions.get(device)?.[layer];

/**
 * What one scene layer holds for a device.
 *
 * @typedef {object} LayerValue
 * @property {string} scene the value the record holds
 * @property {boolean} confirmed the connection that delivered it is the current one, or the last one while the broker is away. false: a newer connection exists and has not delivered the value (again)
 * @property {boolean} inEffect confirmed, and no suppression of the layer exists. Only then the value decides what the display shows
 * @property {"replay"|"live"|null} origin
 * @property {number} connection connection on which the value was delivered
 */

/**
 * What the two layers hold for a device, for the scene precedence
 * (state/precedence.js resolveScene). A value is in effect when it was
 * delivered on the current connection (C1) and no suppression of its layer
 * exists (S2). The record itself stays either way: the Overlays page lists
 * it, with the reason.
 *
 * @param {LayersState} state
 * @param {string} device
 * @returns {{granular: LayerValue|null, blob: LayerValue|null}}
 */
export function sceneInputs(state, device) {
  const topic = state.granular.get(device);
  const blobScene = state.blob.valid
    ? state.blob.scenes.get(device)
    : undefined;
  /** @param {string} scene @param {SceneLayer} layer @param {"replay"|"live"|null} origin @param {number} delivered */
  const value = (scene, layer, origin, delivered) => {
    const confirmed = delivered === state.connection;
    return {
      scene,
      confirmed,
      inEffect: confirmed && !suppressionOf(state, device, layer),
      origin,
      connection: delivered,
    };
  };
  return {
    granular:
      topic && topic.value !== null
        ? value(topic.value, "granular", topic.origin, topic.delivered)
        : null,
    blob:
      blobScene !== undefined
        ? value(blobScene, "blob", state.blob.origin, state.blob.delivered)
        : null,
  };
}

/**
 * The suppressions config.json has to hold: those whose clear or rewrite the
 * broker has not confirmed.
 *
 * @param {LayersState} state
 * @returns {Array<{device: string, layer: SceneLayer, suppression: SceneSuppression}>}
 */
export function savedSuppressions(state) {
  /** @type {Array<{device: string, layer: SceneLayer, suppression: SceneSuppression}>} */
  const saved = [];
  for (const [device, entry] of state.suppressions) {
    for (const layer of /** @type {const} */ (["granular", "blob"])) {
      const active = entry[layer];
      if (!active || active.confirmed) continue;
      // What config.json holds: the suppression without what only lives in
      // memory.
      saved.push({
        device,
        layer,
        suppression: {
          generation: active.generation,
          at: active.at,
          value: active.value,
          alsoStale: [...active.alsoStale],
          output: active.output,
        },
      });
    }
  }
  return saved;
}

/**
 * First half of a UI choice (S1): which suppressions it creates. Reads the
 * state and changes nothing, so the state store can save the plan together
 * with the choice before anything is published.
 *
 * @param {LayersState} state
 * @param {string} device
 * @param {{at: IsoTime, output: OutputMode}} choice output: the resolved output of the device now
 * @returns {ChoicePlan}
 */
export function planChoice(state, device, choice) {
  const generation = (state.generations.get(device) ?? 0) + 1;
  const current = state.connected ? state.connection : -1;
  const topic = state.granular.get(device);
  const blob = state.blob;
  const blobKnown = blob.delivered === current && blob.valid;
  /** @type {string|null} */
  const blobValue = blobKnown ? (blob.scenes.get(device) ?? null) : null;
  // Values a rewrite of pixdcon itself can put back into the store for this
  // device, or has put back already: the rewrites that are on their way,
  // the one the store is known to hold, and those of an earlier connection
  // that may have reached the store. If one of these values is delivered
  // later it is that own, older write, never a new command.
  const ownPayloads = [
    ...blob.own,
    ...(blob.storeOwn && blob.store ? [blob.store] : []),
    ...blob.sent,
  ].filter((payload) => payload !== "");
  const alsoStale = [
    ...new Set(
      ownPayloads
        .map((payload) => blobScenes(parseBlob(payload)).get(device))
        .filter(
          /** @returns {scene is string} */ (scene) =>
            scene !== undefined && scene !== blobValue,
        ),
    ),
  ];
  return {
    device,
    generation,
    at: choice.at,
    granular: {
      generation,
      at: choice.at,
      value: topic && topic.delivered === current ? topic.value : null,
      alsoStale: [],
      output: choice.output,
    },
    blob: blobSuppression(),
  };

  /** @returns {SceneSuppression|null} */
  function blobSuppression() {
    const base = { generation, at: choice.at, output: choice.output };
    // No blob known on this connection: whatever is stored is stale.
    if (!blobKnown) return { ...base, value: null, alsoStale };
    if (blobValue !== null) return { ...base, value: blobValue, alsoStale };
    // The blob is known and names no scene for the device: nothing to
    // replace, unless an own rewrite still carries one.
    if (alsoStale.length === 0) return null;
    return { ...base, value: alsoStale[0], alsoStale: alsoStale.slice(1) };
  }
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * @param {LayersState} state
 * @param {LayersInput} input
 * @returns {{state: LayersState, decision: Decision, effects: LayersEffect[]}}
 */
export function reduce(state, input) {
  const next = structuredClone(state);
  /** @type {LayersEffect[]} */
  const effects = [];
  const decision = step(next, input, effects);
  return { state: next, decision, effects };
}

/**
 * @param {LayersState} state mutated
 * @param {LayersInput} input
 * @param {LayersEffect[]} effects
 * @returns {Decision}
 */
function step(state, input, effects) {
  switch (input.type) {
    case "connect":
      if (input.connection <= state.connection)
        return drop("superseded_source");
      newConnection(state, input.connection, effects);
      // Nothing is published, nothing is forgotten and no suppression ends
      // because a connection came up. What changes is who may decide: a
      // scene value counts on the connection that delivered it (C1), so
      // every record waits for what this connection delivers.
      return apply();

    case "disconnect":
      if (input.connection !== state.connection || !state.connected)
        return drop("superseded_source");
      endConnection(state);
      return apply();

    case "settled":
      // A pacing hint. It is taken note of and changes nothing here: no
      // record goes, no suppression ends, nothing is published.
      return input.connection === state.connection
        ? apply("hint")
        : drop("superseded_source");

    case "tick":
      for (const topic of state.granular.values()) topic.wait = false;
      state.blob.wait = false;
      publishOwed(state, effects, "timer");
      return apply();

    case "granular":
    case "blob": {
      const stale = adoptConnection(state, input.connection, effects);
      if (stale) return stale;
      const decision =
        input.type === "granular"
          ? granularMessage(state, input, effects)
          : blobMessage(state, input, effects);
      // Also after a drop: an older own echo is dropped as a value and is
      // still evidence of what the store holds now.
      publishOwed(state, effects, "message");
      return decision;
    }

    case "published": {
      const decision = published(state, input, effects);
      if (decision.action === "apply") publishOwed(state, effects, "ack");
      return decision;
    }

    case "choice":
      // G1: a plan that does not carry a higher generation than the device's
      // last choice was made before that choice took effect. The state
      // store plans, saves and applies the choices of one device one at a
      // time, so this is a contract error; it is refused, not guessed at.
      if (
        input.plan.generation <= (state.generations.get(input.plan.device) ?? 0)
      )
        return drop("not_newer");
      choice(state, input.plan, effects);
      publishOwed(state, effects, "command");
      return apply();

    case "output": {
      if (state.outputs.get(input.device) === input.output)
        return drop("unchanged");
      state.outputs.set(input.device, input.output);
      if (input.output === "drive") {
        // S3 f: a choice made in shadow never deletes anything on the broker,
        // not even later. Its suppressions go, the stored overlay shows.
        for (const layer of /** @type {const} */ (["granular", "blob"])) {
          const suppression = suppressionOf(state, input.device, layer);
          if (suppression?.output === "shadow")
            retire(state, effects, input.device, layer, "dropped", "config");
        }
      }
      publishOwed(state, effects, "config");
      effects.push({ type: "changed", devices: [input.device] });
      return apply();
    }

    case "removed":
      for (const layer of /** @type {const} */ (["granular", "blob"]))
        if (suppressionOf(state, input.device, layer))
          retire(state, effects, input.device, layer, "dropped", "config");
      state.outputs.delete(input.device);
      // G1: the generation counter of the device stays. Its writes may
      // still be on their way, and their acknowledgements and echoes name
      // generations: a device of the same name that comes back must never
      // be handed one of them again. (The topic records stay as well: they
      // say what the store holds, whoever is configured.)
      // Without the device's suppression the blob as it should be may be
      // what the store holds already. That is settled here, on the change
      // that made it so, and not left for the next tick to find.
      adoptStore(state, effects);
      return apply();
  }
}

/**
 * A message names its connection. A lower number than the current one is a
 * connection that is gone: dropped. A higher one means the connect event
 * has not been seen yet: the connection is adopted first.
 *
 * @param {LayersState} state
 * @param {number} connection
 * @param {LayersEffect[]} effects
 * @returns {Decision|null} a drop, or null to go on
 */
function adoptConnection(state, connection, effects) {
  if (connection < state.connection) return drop("superseded_source");
  if (connection > state.connection) newConnection(state, connection, effects);
  else if (!state.connected) return drop("superseded_source");
  return null;
}

/**
 * A newer connection exists. C1: a scene value decides on the connection
 * that delivered it. From now on the values of the connection before are
 * records that wait: listed, not in effect, until this connection delivers
 * their topic. Whether the store still holds them cannot be asked (MQTT has
 * no message for "this topic is empty"), so they get their say back by
 * being delivered and by nothing else: no hint, no time. Suppressions are
 * not touched; they do not depend on the connection.
 *
 * @param {LayersState} state
 * @param {number} connection
 * @param {LayersEffect[]} effects
 */
function newConnection(state, connection, effects) {
  if (state.connected) endConnection(state);
  state.connection = connection;
  state.connected = true;
  const waiting = new Set(state.blob.valid ? state.blob.scenes.keys() : []);
  for (const [device, topic] of state.granular)
    if (topic.value !== null) waiting.add(device);
  if (waiting.size > 0)
    effects.push({ type: "changed", devices: [...waiting] });
}

/**
 * The connection is gone. Own writes that were not echoed are no longer
 * expected; whether they reached the store is told by the next replay (B3).
 * A suppression the broker had confirmed is done: the store was clean after
 * that write, so whatever a later connection replays was stored afterwards.
 *
 * @param {LayersState} state
 */
function endConnection(state) {
  state.connected = false;
  for (const topic of state.granular.values()) {
    topic.outstanding = [];
    topic.wait = false;
  }
  // B3: nothing is sent again. The payloads are kept for one purpose: to
  // recognise one of them when the next connection delivers it, as a replay
  // or, should the broker get to it that late, as a live message.
  // What earlier connections left stays as well, up to OWN_MEMORY payloads:
  // a connection that ends before it delivered the blob has told nothing,
  // and the broker may get to a write of any connection that has ended.
  state.blob.sent = [
    ...new Set(
      [
        ...state.blob.sent,
        ...(state.blob.storeOwn && state.blob.store !== null
          ? [state.blob.store]
          : []),
        ...state.blob.own,
      ].filter((payload) => payload !== ""),
    ),
  ].slice(-OWN_MEMORY);
  state.blob.outstanding = [];
  state.blob.own = [];
  state.blob.wait = false;
  state.blob.store = null;
  state.blob.storeOwn = false;
  for (const [device, entry] of state.suppressions) {
    for (const layer of /** @type {const} */ (["granular", "blob"])) {
      const suppression = entry[layer];
      if (!suppression) continue;
      suppression.owedOn = 0;
      if (!suppression.confirmed) continue;
      if (layer === "granular") {
        // The broker confirmed the clear and its echo never came. Whatever
        // was delivered on the topic since was processed before the clear
        // and went with it: the store was empty after that write.
        const topic = state.granular.get(device);
        if (topic) topic.value = null;
        delete entry[layer];
      } else if (!state.blob.scenes.has(device)) {
        delete entry[layer];
      }
      // Blob: while the mirror still names a scene for the device (a blob
      // that was delivered before the own echo, so the rewrite on top of
      // it is not confirmed), the suppression keeps hiding it until the
      // next connection delivers the blob.
    }
    if (!entry.granular && !entry.blob) state.suppressions.delete(device);
  }
}

/**
 * @param {LayersState} state
 * @param {LayersEffect[]} effects
 * @param {string} device
 * @param {SceneLayer} layer
 * @param {Extract<LayersEffect, {type: "retire"}>["ended"]} ended
 * @param {EvidenceKind} evidence
 */
function retire(state, effects, device, layer, ended, evidence) {
  const entry = state.suppressions.get(device);
  const suppression = entry?.[layer];
  if (!entry || !suppression) return;
  delete entry[layer];
  if (!entry.granular && !entry.blob) state.suppressions.delete(device);
  // Once confirmed it is out of config.json already: nothing to report.
  if (!suppression.confirmed)
    effects.push({
      type: "retire",
      device,
      layer,
      generation: suppression.generation,
      ended,
      evidence,
    });
  effects.push({ type: "changed", devices: [device] });
}

/**
 * The broker confirmed the write of this generation (S3 c): out of
 * config.json, kept in memory until the echo or the end of the connection.
 *
 * @param {LayersState} state
 * @param {LayersEffect[]} effects
 * @param {string} device
 * @param {SceneLayer} layer
 * @param {number} generation
 */
function confirm(state, effects, device, layer, generation) {
  const suppression = suppressionOf(state, device, layer);
  if (!suppression || suppression.generation !== generation) return;
  if (suppression.confirmed) return;
  suppression.confirmed = true;
  effects.push({
    type: "retire",
    device,
    layer,
    generation,
    ended: "confirmed",
    evidence: "ack",
  });
}

/**
 * @param {LayersState} state
 * @param {Extract<LayersInput, {type: "granular"}>} message
 * @param {LayersEffect[]} effects
 * @returns {Decision}
 */
function granularMessage(state, message, effects) {
  const { device, payload } = message;
  let topic = state.granular.get(device);
  if (!topic) {
    topic = newTopic();
    state.granular.set(device, topic);
  }
  const suppression = suppressionOf(state, device, "granular");
  const before = topic.value;

  if (message.retain) {
    if (topic.live === state.connection) return drop("replay_after_live"); // M2
    if (payload === "") return drop("empty_replay");
    topic.value = payload;
    topic.delivered = state.connection;
    topic.origin = "replay";
    // Older than an own clear that is on its way, like everything that
    // arrives before its echo: taken as what the store holds, and as
    // nothing else. No suppression is judged by it.
    if (topic.outstanding.length > 0) return apply("before_own_write");
    if (
      suppression &&
      !isSuperseded({ value: payload, origin: "replay" }, suppression)
    )
      retire(
        state,
        effects,
        device,
        "granular",
        "stored_while_away",
        "message",
      ); // S3 b
    if (before !== payload)
      effects.push({ type: "changed", devices: [device] });
    return apply(
      suppressionOf(state, device, "granular") ? "superseded" : "current",
    );
  }

  topic.live = state.connection;
  if (payload === "") {
    const own = topic.outstanding.shift();
    topic.value = null;
    topic.delivered = state.connection;
    topic.origin = "live";
    if (own) {
      // The echo of an own clear: the store is clean as of that write.
      if (suppression && suppression.generation === own.generation) {
        confirm(state, effects, device, "granular", own.generation);
        retire(state, effects, device, "granular", "confirmed", "ack");
      }
    } else if (suppression) {
      // Somebody else cleared the topic (S3 a).
      retire(state, effects, device, "granular", "outside_command", "message");
    }
    if (before !== null) effects.push({ type: "changed", devices: [device] });
    return apply(own ? "own_echo" : "current");
  }

  // Processed by the broker before an own clear that is still on its way:
  // older than that write, and gone from the store once the write lands.
  // It is what the store holds until then, so the mirror takes it, as a
  // value the choice replaced: no suppression ends. Should the clear turn
  // out not to have been sent, the value is still there to be cleared.
  if (topic.outstanding.length > 0) {
    topic.value = payload;
    topic.delivered = state.connection;
    topic.origin = "live";
    return apply("before_own_write");
  }

  topic.value = payload;
  topic.delivered = state.connection;
  topic.origin = "live";
  if (suppression)
    retire(state, effects, device, "granular", "outside_command", "message"); // S3 a
  if (before !== payload) effects.push({ type: "changed", devices: [device] });
  return apply();
}

/**
 * The devices whose scene the blob may be rewritten without: an active
 * suppression of the blob layer, made while the device was driven, on a
 * device that is driven now (S4).
 *
 * @param {LayersState} state
 * @returns {Set<string>}
 */
function strippable(state) {
  /** @type {Set<string>} */
  const devices = new Set();
  for (const [device, entry] of state.suppressions) {
    if (
      entry.blob &&
      entry.blob.output === "drive" &&
      state.outputs.get(device) === "drive"
    )
      devices.add(device);
  }
  return devices;
}

/**
 * @param {LayersState} state
 * @param {string|null} text the new `base`
 * @param {"replay"|"live"} origin
 * @returns {string[]} devices whose scene in the blob changed
 */
function setBase(state, text, origin) {
  const blob = state.blob;
  const previous = blob.scenes;
  const parsed = parseBlob(text);
  blob.base = text;
  blob.valid = text === null || parsed !== null;
  blob.scenes = blobScenes(parsed);
  blob.delivered = state.connection;
  blob.origin = origin;
  return [...new Set([...previous.keys(), ...blob.scenes.keys()])].filter(
    (device) => previous.get(device) !== blob.scenes.get(device),
  );
}

/** How many of its own rewrites of the current connection the service remembers (O2). */
const OWN_MEMORY = 32;

/**
 * Is this payload, byte for byte, a rewrite pixdcon sent itself: on the
 * current connection (on its way, or echoed already), or on an earlier one
 * (it may have reached the store, or may still reach it)? An empty payload
 * has no identity: anybody's clear looks the same.
 *
 * @param {BlobTopic} blob
 * @param {string} payload
 * @returns {boolean}
 */
const isOwnRewrite = (blob, payload) =>
  payload !== "" && (blob.own.includes(payload) || blob.sent.includes(payload));

/**
 * @param {LayersState} state
 * @param {Extract<LayersInput, {type: "blob"}>} message
 * @param {LayersEffect[]} effects
 * @returns {Decision}
 */
function blobMessage(state, message, effects) {
  const blob = state.blob;
  const { payload } = message;

  if (message.retain) {
    if (blob.live === state.connection) return drop("replay_after_live"); // M2
    if (blob.outstanding.length > 0) return drop("before_own_write");
    if (payload === "") return drop("empty_replay");
    const own = isOwnRewrite(blob, payload);
    if (own && !isBlobAsItShouldBe(state, payload)) {
      // The store holds a rewrite of pixdcon itself that is older than the
      // blob as it should be (B4 across a reconnect). It is evidence of what
      // the store holds and never a command: the newer content stays, and
      // the blob is published again.
      blob.store = payload;
      blob.storeOwn = true;
      effects.push({
        type: "warn",
        message:
          "the broker replays an older blob rewrite of pixdcon; the blob is published again as it should be",
      });
      return drop("older_own_write");
    }
    const changed = setBase(state, payload, "replay");
    blob.store = payload;
    blob.storeOwn = own;
    if (!blob.valid) {
      // M5: kept raw. It names no scene and ends no suppression.
      if (changed.length > 0)
        effects.push({ type: "changed", devices: changed });
      return hold("invalid_blob");
    }
    for (const [device, entry] of [...state.suppressions]) {
      if (!entry.blob) continue;
      const scene = blob.scenes.get(device);
      if (scene === undefined)
        retire(state, effects, device, "blob", "nothing_to_strip", "message"); // S3 d
      // O2: what pixdcon wrote itself is never a command, whatever it names.
      else if (
        !own &&
        !isSuperseded({ value: scene, origin: "replay" }, entry.blob)
      )
        retire(state, effects, device, "blob", "stored_while_away", "message"); // S3 b
    }
    if (changed.length > 0) effects.push({ type: "changed", devices: changed });
    return apply();
  }

  blob.live = state.connection;
  const head = blob.outstanding[0];
  if (head && head.payload === payload) {
    // O1: own rewrites come back in the order they were sent, so only the
    // oldest one on its way can be echoed. This is its echo. It says what
    // the store holds now and is never a command (B2).
    blob.outstanding.shift();
    const landed = ownBlobLanded(state, effects, head);
    // A later rewrite that the broker has acknowledged already is in the
    // store on top of this one.
    const later = blob.outstanding.findLast((write) => write.landed);
    if (later) blob.store = later.payload;
    if (landed) {
      // O3: the echo has confirmed the generations its own write carries
      // (ownBlobLanded). What else it shows, a device without a scene has
      // nothing left to strip, counts only when no rewrite of pixdcon is
      // still on its way: a later one was built from another content and
      // may carry a scene for the device into the store again.
      if (blob.outstanding.length === 0)
        for (const [device, entry] of [...state.suppressions]) {
          if (entry.blob && !blob.scenes.has(device))
            retire(state, effects, device, "blob", "confirmed", "ack");
        }
      return apply("own_echo");
    }
    // An older own write came back after something newer was applied. It
    // does not replace that: the store is brought back to what it should be.
    effects.push({
      type: "warn",
      message:
        "an older blob rewrite of pixdcon reached the broker after a newer blob; the blob is published again as it should be",
    });
    return drop("older_own_echo");
  }

  const older = blob.outstanding.length > 0;
  if (isOwnRewrite(blob, payload)) {
    // O2: byte for byte a rewrite of pixdcon itself, and not the echo that
    // is due: a later one that is still on its way, one that was echoed
    // already, or one of the connection before. Whoever published these
    // bytes, and when: they are what the store holds at this moment, and
    // they are never a command. No suppression ends, and the blob as it
    // should be stays what it is.
    blob.store = payload;
    blob.storeOwn = true;
    // Own rewrites on their way will overwrite it; their echoes tell.
    if (older) return apply("own_twin");
    if (!isBlobAsItShouldBe(state, payload)) {
      effects.push({
        type: "warn",
        message:
          "an older blob rewrite of pixdcon is in the store again; the blob is published again as it should be",
      });
      return drop("older_own_write");
    }
    // The store holds the blob as it should be, delivered on this connection.
    const changed = setBase(state, payload, "live");
    for (const [device, entry] of [...state.suppressions]) {
      if (entry.blob && !blob.scenes.has(device))
        retire(state, effects, device, "blob", "nothing_to_strip", "message"); // S3 d
    }
    if (changed.length > 0) effects.push({ type: "changed", devices: changed });
    return apply("own_twin");
  }

  if (payload === "") {
    // Somebody cleared the blob.
    const changed = setBase(state, null, "live");
    blob.store = "";
    blob.storeOwn = false;
    // Nothing is left to strip, unless an own rewrite is still on its way:
    // the broker processed this clear before it, so the rewrite puts a blob
    // back, with the scenes it carries. The suppressions stay to hide them,
    // and the blob is cleared again once the own echo shows it.
    if (!older)
      for (const [device, entry] of [...state.suppressions])
        if (entry.blob)
          retire(state, effects, device, "blob", "nothing_to_strip", "message");
    if (changed.length > 0) effects.push({ type: "changed", devices: changed });
    return apply(older ? "before_own_write" : "current");
  }

  const changed = setBase(state, payload, "live");
  blob.store = payload;
  blob.storeOwn = false;
  if (!blob.valid) {
    if (changed.length > 0) effects.push({ type: "changed", devices: changed });
    return hold("invalid_blob");
  }
  if (!older) {
    // S3 a: a new command for every device it names a scene for.
    for (const [device, entry] of [...state.suppressions]) {
      if (!entry.blob) continue;
      retire(
        state,
        effects,
        device,
        "blob",
        blob.scenes.has(device) ? "outside_command" : "nothing_to_strip",
        "message",
      );
    }
  }
  // else B4: processed by the broker before an own rewrite that is still on
  // its way. Its content is the new base; the scenes of superseded devices
  // stay hidden, and the rewrite is built again from this content.
  if (changed.length > 0) effects.push({ type: "changed", devices: changed });
  return apply(older ? "before_own_write" : "current");
}

/**
 * An own rewrite is known to be in the store: the broker acknowledged it,
 * or its echo arrived. Until its echo arrives nothing that the broker
 * processed after it can have been delivered (one topic, one order), so at
 * this moment the store holds exactly this payload. The suppressions it
 * carries are confirmed. When the payload is the blob as it should be, it
 * becomes the base: the scenes it stripped are gone from the mirror, too.
 *
 * @param {LayersState} state
 * @param {LayersEffect[]} effects
 * @param {BlobTopic["outstanding"][number]} own
 * @returns {boolean} false: it is an older write than the blob as it should be
 */
function ownBlobLanded(state, effects, own) {
  state.blob.store = own.payload;
  state.blob.storeOwn = true;
  for (const { device, generation } of own.generations)
    confirm(state, effects, device, "blob", generation);
  if (!isBlobAsItShouldBe(state, own.payload)) {
    // An older write than the blob as it should be. What it stripped is
    // still gone from the store for good: those scenes leave the base too,
    // so no later rewrite can put them back (a device that goes into shadow
    // meanwhile is no longer stripped, and must not be restored either).
    const base = state.blob.valid ? parseBlob(state.blob.base) : null;
    if (base !== null && own.generations.length > 0) {
      const folded = stripBlobScenes(
        base,
        new Set(own.generations.map(({ device }) => device)),
      );
      if (!isDeepStrictEqual(base, folded)) {
        state.blob.base = JSON.stringify(folded);
        state.blob.scenes = blobScenes(folded);
      }
    }
    // With its strips folded in, the blob as it should be may be exactly
    // what this write put into the store. Then there is nothing to repair,
    // and the store's content is the base, delivered on this connection.
    if (!isBlobAsItShouldBe(state, own.payload)) return false;
  }
  const changed = setBase(
    state,
    own.payload === "" ? null : own.payload,
    "live",
  );
  if (changed.length > 0) effects.push({ type: "changed", devices: changed });
  return true;
}

/**
 * Is this payload the blob as it should be now: the base without the scenes
 * of the devices that may be stripped?
 *
 * @param {LayersState} state
 * @param {string} payload
 * @returns {boolean}
 */
function isBlobAsItShouldBe(state, payload) {
  const wanted = wantedBlob(state);
  if (wanted === null) return payload === "";
  return isDeepStrictEqual(
    withoutMark(parseBlob(payload)),
    withoutMark(wanted),
  );
}

/**
 * @param {LayersState} state
 * @returns {Record<string, any>|null} null: there should be no blob
 */
function wantedBlob(state) {
  const base = state.blob.valid ? parseBlob(state.blob.base) : null;
  if (base === null) return null;
  // What an own rewrite on its way strips stays stripped: a later rewrite
  // never puts a scene back that an earlier one is removing, also when the
  // device has gone into shadow meanwhile and is no longer stripped anew.
  const devices = strippable(state);
  for (const write of state.blob.outstanding)
    for (const { device } of write.generations) devices.add(device);
  return stripBlobScenes(base, devices);
}

/**
 * @param {LayersState} state
 * @param {Extract<LayersInput, {type: "published"}>} result
 * @param {LayersEffect[]} effects
 * @returns {Decision}
 */
function published(state, result, effects) {
  for (const [device, topic] of state.granular) {
    const index = topic.outstanding.findIndex(
      (write) => write.write === result.write,
    );
    if (index < 0) continue;
    const { generation } = topic.outstanding[index];
    if (result.outcome === "confirmed") {
      // The store is clean as of this write. A replay that still arrives on
      // this connection is older and is dropped while the echo is awaited.
      topic.value = null;
      topic.delivered = state.connection;
      confirm(state, effects, device, "granular", generation);
      effects.push({ type: "changed", devices: [device] });
    } else if (result.outcome === "failed") {
      topic.outstanding.splice(index, 1);
      topic.wait = true;
      const suppression = suppressionOf(state, device, "granular");
      if (suppression && suppression.generation === generation)
        suppression.owedOn = state.connection;
    }
    return apply();
  }
  const blob = state.blob;
  const index = blob.outstanding.findIndex(
    (write) => write.write === result.write,
  );
  if (index < 0) return drop("unknown_write"); // of a connection that is gone
  if (result.outcome === "confirmed") {
    // The write stays outstanding until its echo: what arrives before that
    // was processed before it. The rewrites sent before it have landed too
    // (one connection, one order); their echoes are still to come.
    for (const write of blob.outstanding.slice(0, index + 1))
      write.landed = true;
    ownBlobLanded(state, effects, blob.outstanding[index]);
  } else if (result.outcome === "failed") {
    blob.outstanding.splice(index, 1);
    blob.wait = true;
  }
  return apply();
}

/**
 * Second half of a UI choice: the plan takes effect (S1, S3 e).
 *
 * @param {LayersState} state
 * @param {ChoicePlan} plan
 * @param {LayersEffect[]} effects
 */
function choice(state, plan, effects) {
  const { device } = plan;
  for (const layer of /** @type {const} */ (["granular", "blob"]))
    if (suppressionOf(state, device, layer))
      retire(state, effects, device, layer, "replaced", "command");
  state.generations.set(device, plan.generation);
  /** @type {{granular?: ActiveSuppression, blob?: ActiveSuppression}} */
  const entry = {};
  for (const layer of /** @type {const} */ (["granular", "blob"])) {
    const suppression = plan[layer];
    if (!suppression) continue;
    entry[layer] = {
      ...suppression,
      alsoStale: [...suppression.alsoStale],
      confirmed: false,
      // The choice's own clear: owed on the connection the choice is made on.
      owedOn: layer === "granular" && state.connected ? state.connection : 0,
    };
  }
  if (!entry.blob && state.blob.outstanding.length > 0) {
    // The blob names no scene for the device, so the plan has nothing to
    // save. But an own rewrite is still on its way, and a blob that the
    // broker processed before it can arrive before its echo and name one:
    // older than the rewrite, and so older than this choice. A guard hides
    // it for exactly that time. It is not saved (it counts as confirmed)
    // and goes with the echo or with the connection.
    entry.blob = {
      generation: plan.generation,
      at: plan.at,
      value: null,
      alsoStale: [],
      output: plan.granular?.output ?? state.outputs.get(device) ?? "shadow",
      confirmed: true,
      owedOn: 0,
    };
  }
  if (entry.granular || entry.blob) state.suppressions.set(device, entry);
  effects.push({ type: "changed", devices: [device] });
}

/**
 * The store, as delivered on this connection, holds the blob as it should
 * be, and no rewrite of pixdcon is on its way to change that: then the
 * store's content is the base, delivered on this connection, whichever way
 * the two came to agree (an own echo, a copy of an own rewrite, a rewrite
 * that turned out not to have been sent). A device the store names no scene
 * for has nothing left to strip (S3 d).
 *
 * @param {LayersState} state
 * @param {LayersEffect[]} effects
 */
function adoptStore(state, effects) {
  const blob = state.blob;
  if (blob.store === null || !blob.valid || blob.outstanding.length > 0) return;
  const content = blob.store === "" ? null : blob.store;
  if (blob.delivered === state.connection && blob.base === content) return;
  if (!isBlobAsItShouldBe(state, blob.store)) return;
  const changed = setBase(state, content, blob.origin ?? "live");
  for (const [device, entry] of [...state.suppressions]) {
    if (entry.blob && !blob.scenes.has(device))
      retire(state, effects, device, "blob", "nothing_to_strip", "message");
  }
  if (changed.length > 0) effects.push({ type: "changed", devices: changed });
}

/**
 * Publish what evidence authorises and nothing else (see the header).
 *
 * @param {LayersState} state
 * @param {LayersEffect[]} effects
 * @param {EvidenceKind} evidence what led here; a tick repeats what a message, a command or an acknowledgement authorised before
 */
function publishOwed(state, effects, evidence) {
  if (!state.connected) return;

  for (const [device, entry] of state.suppressions) {
    const suppression = entry.granular;
    if (!suppression || suppression.confirmed) continue;
    if (suppression.output !== "drive") continue;
    if (state.outputs.get(device) !== "drive") continue;
    const topic = state.granular.get(device) ?? newTopic();
    if (topic.wait) continue;
    if (
      topic.outstanding.some(
        (write) => write.generation === suppression.generation,
      )
    )
      continue;
    const hiddenValueDelivered =
      topic.delivered === state.connection && topic.value !== null;
    const ownClearOwed = suppression.owedOn === state.connection;
    if (!hiddenValueDelivered && !ownClearOwed) continue;
    const write = ++state.writes;
    topic.outstanding.push({ write, generation: suppression.generation });
    suppression.owedOn = 0;
    state.granular.set(device, topic);
    effects.push({
      type: "publish-clear",
      device,
      generation: suppression.generation,
      write,
      evidence,
    });
  }

  const blob = state.blob;
  adoptStore(state, effects);
  // Without the store's content as delivered on this connection there is no
  // evidence that anything has to be written.
  if (blob.wait || blob.store === null || !blob.valid) return;
  const wanted = wantedBlob(state);
  const stored = parseBlob(blob.store);
  if (wanted === null) {
    // The blob was cleared by somebody else, and the store holds an older own
    // rewrite again: clear it.
    if (blob.store === "" || blob.base !== null) return;
    if (blob.outstanding.some((write) => write.payload === "")) return;
    const write = ++state.writes;
    blob.outstanding.push({
      write,
      payload: "",
      generations: [],
      landed: false,
    });
    effects.push({
      type: "publish-blob",
      payload: "",
      generations: [],
      write,
      evidence,
    });
    return;
  }
  // The same document, whatever mark it carries: nothing to write.
  if (isDeepStrictEqual(withoutMark(stored), withoutMark(wanted))) return;
  if (
    blob.outstanding.some((write) =>
      isDeepStrictEqual(
        withoutMark(parseBlob(write.payload)),
        withoutMark(wanted),
      ),
    )
  )
    return;
  const stripped = strippable(state);
  const generations = [...state.suppressions]
    .filter(([device, entry]) => entry.blob && stripped.has(device))
    .map(([device, entry]) => ({
      device,
      generation: /** @type {ActiveSuppression} */ (entry.blob).generation,
    }));
  const write = ++state.writes;
  // O1: every rewrite carries its own mark, so its bytes are its identity.
  const payload = JSON.stringify({
    ...wanted,
    [WRITE_MARK]: markOf(state, write),
  });
  blob.outstanding.push({ write, payload, generations, landed: false });
  // O2: remembered beyond its echo, so these bytes are known as pixdcon's
  // own for as long as the connection lives.
  blob.own = [...blob.own.filter((sent) => sent !== payload), payload].slice(
    -OWN_MEMORY,
  );
  effects.push({ type: "publish-blob", payload, generations, write, evidence });
}
