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
 * in the header of overlay-service.js are what this file does.
 *
 * WHAT IS HELD PER TOPIC
 *  - what the broker's store holds as far as it was delivered, and on which
 *    connection it was delivered. A record of an earlier connection stays in
 *    effect until the current connection delivers something for the topic.
 *    Nothing is removed because the settle hint passed or because nothing
 *    arrived (M4).
 *  - whether a live message was seen on the current connection: after that a
 *    replay for the topic is dropped (M2).
 *  - own writes whose echo has not come back yet. The broker forwards a
 *    topic's messages to one subscriber in the order it processed them, so
 *    everything that arrives on a topic before the echo of an own write was
 *    processed before that write. It is older than the write and never a new
 *    command, live or not. It is still what the store holds until the write
 *    lands, so the mirror takes it, in the place of a replaced value.
 *  - for the blob: the content as it should be (`base`), what the store is
 *    known to hold (`store`), and the own rewrites that may be in the store
 *    when the next connection subscribes (`sent`). An own rewrite that comes
 *    back, as an echo or in a replay, says what the store holds and is never
 *    a command; when it is older than the blob as it should be, the blob is
 *    published again.
 *
 * WHAT MQTT CANNOT ORDER. A live message that arrives while no own write is
 * on its way on its topic may have been published just before a UI choice
 * or just after it. It is taken as a new command. See overlay-service.js.
 *
 * test/contract/ordering.test.js runs the interleavings somebody thought
 * of; test/contract/ordering-model.test.js runs this file against a model
 * of a broker with random ones. Both must stay green when this file changes.
 *
 * WHEN SOMETHING IS PUBLISHED. Only on evidence (core/ordering.js mayCause):
 *  - the clear of a choice on the connection the choice was made on (the
 *    choice is the newest command at that moment). It is repeated on that
 *    connection until its outcome is known.
 *  - a clear, or a blob rewrite, when a value that a suppression hides was
 *    delivered on the current connection.
 *  - a blob rewrite when a delivered own echo shows that the store holds an
 *    older own write than the blob as it should be.
 * Never because a connection came up, the settle hint passed or a timer
 * fired without such evidence: a blind clear after a reconnect could delete
 * a command that was stored while pixdcon was away and has not been
 * delivered yet.
 *
 * WHEN A SUPPRESSION ENDS (S3), always with the evidence named:
 *   outside_command    an outside live message on the layer, with no own
 *                      write outstanding
 *   stored_while_away  a replay with a value the suppression does not hide
 *   confirmed          the broker acknowledged or echoed the clear or the
 *                      rewrite of the same generation
 *   nothing_to_strip   blob: a delivered blob has no scene for the device
 *   replaced           a newer choice
 *   dropped            an authoritative output change from shadow to drive
 *                      after a choice made in shadow; the device left the
 *                      effective config
 *
 * Owner: core/state worker.
 */

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
 * @property {Array<{write: number, payload: string, generations: Array<{device: string, generation: number}>}>} outstanding own rewrites sent on the current connection whose echo has not arrived
 * @property {string[]} sent own rewrites the store may hold when the next connection subscribes: the one the store was last known to hold, and those that were on their way when the connection ended. If the next connection replays exactly one of these payloads, it is recognised as pixdcon's own write
 * @property {boolean} wait
 */

/**
 * @typedef {object} LayersState
 * @property {number} connection current connection number; 0 = never connected
 * @property {boolean} connected
 * @property {number} writes number of the last own write
 * @property {Map<string, GranularTopic>} granular device → topic
 * @property {BlobTopic} blob
 * @property {Map<string, {granular?: ActiveSuppression, blob?: ActiveSuppression}>} suppressions
 * @property {Map<string, number>} generations device → generation of its last choice
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
 * @param {{saved?: Array<{device: string, layer: SceneLayer, suppression: SceneSuppression}>, outputs?: Record<string, OutputMode>}} [options]
 * saved: the suppressions config.json holds (S5): taken before the first message. outputs: the resolved output per device at start.
 * @returns {LayersState}
 */
export function createLayers(options = {}) {
  /** @type {LayersState} */
  const state = {
    connection: 0,
    connected: false,
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
 * What the two layers hold for a device, for the scene precedence
 * (state/precedence.js resolveScene). A value is in effect unless a
 * suppression of its layer exists.
 *
 * @param {LayersState} state
 * @param {string} device
 * @returns {{granular: {scene: string, inEffect: boolean, origin: "replay"|"live"|null, connection: number}|null, blob: {scene: string, inEffect: boolean, origin: "replay"|"live"|null, connection: number}|null}}
 */
export function sceneInputs(state, device) {
  const topic = state.granular.get(device);
  const blobScene = state.blob.valid
    ? state.blob.scenes.get(device)
    : undefined;
  return {
    granular:
      topic && topic.value !== null
        ? {
            scene: topic.value,
            inEffect: !suppressionOf(state, device, "granular"),
            origin: topic.origin,
            connection: topic.delivered,
          }
        : null,
    blob:
      blobScene !== undefined
        ? {
            scene: blobScene,
            inEffect: !suppressionOf(state, device, "blob"),
            origin: state.blob.origin,
            connection: state.blob.delivered,
          }
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
    ...blob.outstanding.map(({ payload }) => payload),
    ...(blob.storeOwn && blob.store ? [blob.store] : []),
    ...blob.sent,
  ];
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
      if (state.connected) endConnection(state);
      state.connection = input.connection;
      state.connected = true;
      // Nothing is published and nothing is forgotten because a connection
      // came up: every record waits for what this connection delivers.
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
      const stale = adoptConnection(state, input.connection);
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
      state.generations.delete(input.device);
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
 * @returns {Decision|null} a drop, or null to go on
 */
function adoptConnection(state, connection) {
  if (connection < state.connection) return drop("superseded_source");
  if (connection > state.connection) {
    if (state.connected) endConnection(state);
    state.connection = connection;
    state.connected = true;
  } else if (!state.connected) return drop("superseded_source");
  return null;
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
  // recognise one of them in the next connection's replay.
  // They stay until a connection delivers the blob: a connection that ends
  // before its replay arrived has told nothing.
  state.blob.sent = [
    ...new Set([
      ...state.blob.sent,
      ...(state.blob.storeOwn && state.blob.store !== null
        ? [state.blob.store]
        : []),
      ...state.blob.outstanding.map((write) => write.payload),
    ]),
  ];
  state.blob.outstanding = [];
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
    const ownEarlier = blob.sent.includes(payload);
    blob.sent = [];
    if (ownEarlier && !isBlobAsItShouldBe(state, payload)) {
      // The store holds a rewrite of pixdcon itself, sent on the connection
      // before, that is older than the blob as it should be (B4 across a
      // reconnect). It is evidence of what the store holds and never a
      // command: the newer content stays, and the blob is published again.
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
    blob.storeOwn = false;
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
      else if (!isSuperseded({ value: scene, origin: "replay" }, entry.blob))
        retire(state, effects, device, "blob", "stored_while_away", "message"); // S3 b
    }
    if (changed.length > 0) effects.push({ type: "changed", devices: changed });
    return apply();
  }

  blob.live = state.connection;
  blob.sent = [];
  const ownIndex = blob.outstanding.findIndex(
    (write) => write.payload === payload,
  );
  if (ownIndex >= 0) {
    // B2: the echo of an own rewrite. It says what the store holds now and
    // is never a command.
    const [own] = blob.outstanding.splice(ownIndex, 1);
    if (ownBlobLanded(state, effects, own)) {
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
    return false;
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
  return isDeepStrictEqual(parseBlob(payload), wanted);
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
    // was processed before it.
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
    blob.outstanding.push({ write, payload: "", generations: [] });
    effects.push({
      type: "publish-blob",
      payload: "",
      generations: [],
      write,
      evidence,
    });
    return;
  }
  if (isDeepStrictEqual(stored, wanted)) return;
  if (
    blob.outstanding.some((write) =>
      isDeepStrictEqual(parseBlob(write.payload), wanted),
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
  const payload = JSON.stringify(wanted);
  const write = ++state.writes;
  blob.outstanding.push({ write, payload, generations });
  effects.push({ type: "publish-blob", payload, generations, write, evidence });
}
