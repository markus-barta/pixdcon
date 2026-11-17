/**
 * Topic fence: the ordering rule (core/ordering.js) for the retained topics
 * that are not scene layers.
 *
 * The overlay service mirrors many retained topics: ip, enabled and scene
 * path overlays, setting overlays, the mode and brightness controls
 * (OVERRIDE_KINDS). Each message goes through `fenceTopic`, and the service
 * keeps all of them in one mirror (`reduceMirror`), which is this file as a
 * reducer. (The two scene layers have more to decide, suppressions and the
 * blob as a document, and their own reducer: scene-layers.js. It applies the
 * same rules.)
 *
 * ORDER OF MESSAGES (fenceTopic)
 *  1. A message of another connection than the current one is dropped.
 *  2. Live beats replay: after a live message on a connection, a replay on
 *     that connection is dropped.
 *  3. Own writes. The service applies its own writes in the process at once
 *     (a mode change from the UI, a cleared setting overlay) and remembers
 *     each payload until its echo comes back. While one is on its way,
 *     everything delivered on the topic was processed by the broker before
 *     it and is older than what the process already holds: the own echo is
 *     consumed and changes nothing, anything else does not change the value
 *     either. Without this an own "pause" that echoes back after the user
 *     already pressed "play" would pause the display again for a moment.
 *     What was delivered is still remembered as what the store holds
 *     (`stored`, with the connection that delivered it): when an own write
 *     turns out not to have been sent (`ownWriteFailed`), the value goes
 *     back to that, with the authority it had.
 *     An own write has a name in the mirror, its number, because a payload
 *     is not one: two writes of "pause" are two writes, and the outcome of
 *     one says nothing about the other. Its echo has no name on the wire:
 *     own writes come back in the order they were sent, so the oldest one
 *     on its way is the one a message with its payload is taken for.
 *
 * WHO DECIDES (overrideEffect; the rule the fourth cross-read asked for,
 * R4-5). A record is confirmed when the connection that delivered it is the
 * current one, or the last one while the broker is away. After a reconnect
 * a record that the new connection has not delivered again commands
 * nothing, and keeps holding back what it held back:
 *
 *   kind             what it commands (lapses)        what it holds back (kept)
 *   setting          the value; saved or default       -
 *                    applies instead
 *   brightness       the override; the scene's         -
 *                    brightness applies
 *   mode             pause, stop, play; default play   -
 *   scene-path       the path; config.json's path      -
 *                    applies, or the key is gone
 *   device-enabled   nothing: an overlay cannot        "off" while the value says
 *                    switch a device on                false
 *   device-ip        "talk to this address", only      "held" while a value is
 *                    while confirmed                   stored and not confirmed
 *
 * What only changes the content of a display that pixdcon drives anyway is
 * a command. Whether MQTT still holds it cannot be asked (there is no
 * message for "this topic is empty"), so a command of an earlier connection
 * waits, listed, until the current connection delivers it: a setting, a
 * mode or an address that was cleared while pixdcon was away would
 * otherwise go on deciding until the next restart. What decides whether
 * pixdcon touches a display at all is kept, because unknown is
 * conservative: a device that an overlay switched off stays off, and a
 * device whose address overlay is not confirmed is held. It is not started
 * on the address of config.json on the guess that the overlay is gone, and
 * it is not driven on the unconfirmed address either.
 *
 * A restriction ends only on evidence of what the store holds: a delivered
 * message of its topic (a clear, or another value), or the broker's
 * acknowledgement or echo of pixdcon's own clear. So an own write to
 * device-enabled or device-ip is not applied in the process at once, as a
 * mode change is (`reduceMirror` answers hold, reason "awaits_broker"): the
 * service publishes it, and the record follows when the broker has
 * acknowledged it or delivered it back. Until then it is on its way like
 * any own write: what arrives before its echo is older than it. A clear
 * that is lost with its connection has released nothing. Nothing ends a
 * restriction because a connection came up or went away.
 *
 * WHAT THIS CANNOT KNOW, stated plainly:
 *  - a restriction whose topic was cleared while pixdcon was not connected.
 *    Nothing arrives for it, so the device stays off, or held, and the
 *    record is listed as not confirmed, until the topic gets a message, the
 *    user clears it (the clear is published, acknowledged, and releases),
 *    or the process restarts. That is the conservative side, and the only
 *    place where a running process and one that has just started differ.
 *  - a message of somebody else with the payload of an own write, which
 *    the broker processed just before that write: it is taken for the echo.
 *    The store holds that payload either way.
 *  - a restriction that is stored and has not been delivered yet when the
 *    process starts cold. The device starts as config.json says and stops
 *    when the restriction arrives.
 *
 * NOTHING CHANGES WITHOUT A NOTICE (reduceMirror). The reducer has inputs
 * for a connect and a disconnect, because the connection decides who has a
 * say. It has none for the settle hint or a timer. Its only effect is
 * "changed", and no line of this file names the keys by hand: after every
 * step the view of every key (`topicView`: the resolved effect, origin and
 * connection) is compared with the one before the step. A reader that
 * computes again only for the keys a "changed" effect names therefore holds
 * what a reader of the whole state holds. `fenceTopic`'s own `changed`
 * flag says less (the value differs) and is not what a reader follows: a
 * replay of the same value on a new connection changes no value, and gives
 * the record its say back.
 *
 * Owner: core/state worker.
 */

import { apply, drop, hold } from "../core/ordering.js";

/**
 * @typedef {object} TopicRecord
 * @property {string|null} value payload held for the topic, own writes included as soon as they are made; null = nothing stored as far as known
 * @property {string|null} stored what the broker's store holds as far as delivered: the last delivered message or own echo
 * @property {number} storedOn connection on which `stored` was delivered; 0 = never
 * @property {number} delivered connection on which `value` was delivered, or applied by an own write; 0 = never
 * @property {"replay"|"live"|"own"|null} origin
 * @property {number} live connection on which a live message was last delivered; 0 = none
 * @property {string[]} outstanding payloads of own writes on the current connection whose echo has not arrived, oldest first
 * @property {number} landed how many of `outstanding`, from the oldest on, the broker has acknowledged: they are in the store, their echoes are still to come
 */

/** @returns {TopicRecord} */
export function newTopicRecord() {
  return {
    value: null,
    stored: null,
    storedOn: 0,
    delivered: 0,
    origin: null,
    live: 0,
    outstanding: [],
    landed: 0,
  };
}

/**
 * @param {TopicRecord} record
 * @param {Pick<import("../mqtt/mqtt-gateway.js").MqttMessage, "payload"|"retain"|"connection">} message
 * @param {number} connection the current connection
 * @returns {{record: TopicRecord, decision: import("../core/ordering.js").Decision, changed: boolean}} changed: the value differs from before (M3: an unchanged value is not a change). Whether the record's say changed is another question, answered by `overrideEffect`: a reader follows the "changed" effects of `reduceMirror`
 */
export function fenceTopic(record, message, connection) {
  const same = (/** @type {string} */ reason) => ({
    record,
    decision: drop(reason),
    changed: false,
  });
  if (message.connection !== connection) return same("superseded_source");
  const value = message.payload === "" ? null : message.payload;

  if (message.retain) {
    if (record.live === connection) return same("replay_after_live");
    if (record.outstanding.length > 0) {
      // Older than the own write that is on its way, like everything that
      // arrives before its echo: the value the process holds stays. It is
      // still what the store held, and that is remembered: should the own
      // write turn out not to have been sent, the value goes back to it.
      // (Not when the broker has acknowledged an own write: the store holds
      // that one, and it came after what the replay shows.)
      if (value === null || record.landed > 0) return same("before_own_write");
      return {
        record: { ...record, stored: value, storedOn: connection },
        decision: drop("before_own_write"),
        changed: false,
      };
    }
    if (value === null) return same("empty_replay");
    return {
      record: {
        ...record,
        value,
        stored: value,
        storedOn: connection,
        delivered: connection,
        origin: "replay",
      },
      decision: apply(),
      changed: record.value !== value,
    };
  }

  if (record.outstanding.length > 0) {
    const echo = record.outstanding[0] === message.payload;
    // The value the process holds is newer and stays. The store holds this
    // payload now, unless the broker has acknowledged an own write that it
    // processed after this message: then the store holds that one.
    const covered = record.landed > (echo ? 1 : 0);
    const seen = covered
      ? { ...record, live: connection }
      : { ...record, stored: value, storedOn: connection, live: connection };
    if (!echo)
      return {
        record: seen,
        decision: drop("before_own_write"),
        changed: false,
      };
    // The echo of the oldest own write.
    return {
      record: {
        ...seen,
        outstanding: record.outstanding.slice(1),
        landed: Math.max(0, record.landed - 1),
      },
      decision: apply("own_echo"),
      changed: false,
    };
  }

  return {
    record: {
      ...record,
      value,
      stored: value,
      storedOn: connection,
      delivered: connection,
      origin: "live",
      live: connection,
    },
    decision: apply(),
    changed: record.value !== value,
  };
}

/**
 * An own write: applied in the process at once, expected back as an echo.
 *
 * @param {TopicRecord} record
 * @param {string} payload "" clears
 * @param {number} connection the connection it is published on
 * @returns {TopicRecord}
 */
export function ownWrite(record, payload, connection) {
  return {
    ...record,
    value: payload === "" ? null : payload,
    delivered: connection,
    origin: "own",
    outstanding: [...record.outstanding, payload],
  };
}

/**
 * The record without one of its own writes, which was certainly not sent.
 * While other own writes are on their way, the value is the newest of those
 * (`deferred`: unchanged, the writes were not applied when they were made).
 * When it was the last one, the value is again what the store holds, with
 * the authority of the connection that delivered that: what arrived
 * meanwhile is no longer older than an own write.
 *
 * @param {TopicRecord} record
 * @param {number} index in `outstanding`
 * @param {boolean} deferred
 * @returns {TopicRecord}
 */
function withoutWrite(record, index, deferred) {
  const outstanding = record.outstanding.filter((_, at) => at !== index);
  if (outstanding.length > 0) {
    if (deferred) return { ...record, outstanding };
    const newest = outstanding[outstanding.length - 1];
    return { ...record, outstanding, value: newest === "" ? null : newest };
  }
  return {
    ...record,
    outstanding,
    value: record.stored,
    delivered: record.storedOn,
    origin: "live",
  };
}

/**
 * An own write was certainly not sent. It is no longer expected back. While
 * other own writes are on their way, the value is the newest of those; when
 * it was the last one, the value is again what the store holds, with the
 * authority of the connection that delivered that.
 *
 * @param {TopicRecord} record
 * @param {string} payload the payload of the write that failed
 * @returns {{record: TopicRecord, changed: boolean}}
 */
export function ownWriteFailed(record, payload) {
  const index = record.outstanding.lastIndexOf(payload);
  // Not on its way, or acknowledged by the broker: then it was sent.
  if (index < record.landed) return { record, changed: false };
  const next = withoutWrite(record, index, false);
  return { record: next, changed: record.value !== next.value };
}

/**
 * The connection ended: own writes that were not echoed are no longer
 * expected. What the store holds is told by the next connection's replay.
 *
 * @param {TopicRecord} record
 * @returns {TopicRecord}
 */
export function forgetOwnWrites(record) {
  return record.outstanding.length === 0
    ? record
    : { ...record, outstanding: [], landed: 0 };
}

// ---------------------------------------------------------------------------
// Who decides: what a record commands, and what it holds back
// ---------------------------------------------------------------------------

/** The kinds of retained topics that go through this file. */
export const OVERRIDE_KINDS = Object.freeze(
  /** @type {const} */ ([
    "setting",
    "mode",
    "brightness",
    "scene-path",
    "device-enabled",
    "device-ip",
  ]),
);

/** @typedef {typeof OVERRIDE_KINDS[number]} OverrideKind */

/**
 * The kinds that decide whether pixdcon touches a display at all. What they
 * hold back is kept while the record is not confirmed, and is released only
 * on evidence of what the store holds: a delivered message of the topic, or
 * the acknowledgement or echo of an own write.
 */
export const PROTECTIVE_KINDS = Object.freeze(
  /** @type {const} */ (["device-enabled", "device-ip"]),
);

/**
 * @param {OverrideKind} kind
 * @returns {boolean}
 */
const isProtective = (kind) =>
  PROTECTIVE_KINDS.some((protective) => protective === kind);

/**
 * Does a payload of an `enabled` overlay switch the device off? Only "false"
 * does, in any case and with blanks around it (matrix C-051).
 *
 * @param {string|null} value
 * @returns {boolean}
 */
export const saysOff = (value) =>
  value !== null && value.trim().toLowerCase() === "false";

/**
 * What a record does, resolved: what it commands and what it holds back.
 *
 * @typedef {object} OverrideEffect
 * @property {string|null} value the payload the record holds; null = nothing stored as far as known
 * @property {boolean} confirmed a value is held, and the connection that delivered it is the current one, or the last one while the broker is away
 * @property {string|null} command the value while it decides: only when confirmed, and never for device-enabled (an overlay cannot switch a device on). null: the next source decides (the saved setting, the scene's brightness, play, config.json's path or address)
 * @property {"off"|"held"|null} restriction what the record holds back, confirmed or not. off: the device is not started (device-enabled says false). held: the device is not started while its address overlay is stored and not confirmed
 */

/**
 * Pure and total: every kind, every record, every connection has an answer.
 *
 * @param {OverrideKind} kind
 * @param {TopicRecord} record
 * @param {number} connection the current connection, or the last one while the broker is away
 * @returns {OverrideEffect}
 */
export function overrideEffect(kind, record, connection) {
  const { value } = record;
  const confirmed = value !== null && record.delivered === connection;
  if (kind === "device-enabled")
    return {
      value,
      confirmed,
      command: null,
      restriction: saysOff(value) ? "off" : null,
    };
  if (kind === "device-ip")
    return {
      value,
      confirmed,
      command: confirmed ? value : null,
      restriction: value !== null && !confirmed ? "held" : null,
    };
  return {
    value,
    confirmed,
    command: confirmed ? value : null,
    restriction: null,
  };
}

// ---------------------------------------------------------------------------
// The mirror of all these topics, as a reducer
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MirrorTopic
 * @property {OverrideKind} kind
 * @property {TopicRecord} record
 * @property {number[]} writes the numbers of the own writes in `record.outstanding`, in the same order
 */

/**
 * @typedef {object} MirrorState
 * @property {number} connection current connection, or the last one while the broker is away; 0 = never connected
 * @property {boolean} connected
 * @property {Map<string, MirrorTopic>} topics overlay record id → what is held for its topic, e.g. "device-ip:pixoo-189", "setting:ulanzi-56:clock:night_start_hour", "mode:ulanzi-57"
 */

/**
 * @typedef {{type: "connect", connection: number}
 *   | {type: "disconnect", connection: number}
 *   | {type: "message", key: string, kind: OverrideKind, payload: string, retain: boolean, connection: number}
 *   | {type: "own-write", key: string, kind: OverrideKind, payload: string, write: number}
 *   | {type: "published", key: string, write: number, outcome: "confirmed"|"failed"}} MirrorInput
 * own-write: the service is about to publish `payload` to the topic ("" clears). `write` is a number of the service's own, never used twice in a process: the name of this write, because a payload is not one (two writes of "pause" are two writes). Answer apply: applied in the process at once and expected back as an echo. Answer hold (reason "awaits_broker", the protective kinds): on its way, and not applied; the service publishes it, and the record follows at its acknowledgement or its echo. Answer drop (reason "offline"): no connection, nothing is published.
 * published: the outcome of an own write. confirmed: the broker acknowledged it; it, and every own write of the topic sent before it, is in the store. failed: it was certainly not sent. An outcome for a write that is not on its way any more (echoed already, of a connection that has ended, told twice) is dropped. No acknowledgement in time needs no input: the echo, or the end of the connection, tells.
 */

/**
 * @typedef {{type: "changed", keys: string[]}} MirrorEffect
 * keys: the records whose view (`topicView`) differs from before the step.
 */

/**
 * What a reader can see of one key: its resolved effect, and how and on
 * which connection its value arrived.
 *
 * @typedef {OverrideEffect & {kind: OverrideKind, origin: TopicRecord["origin"], connection: number}} TopicView
 */

/** @returns {MirrorState} */
export function createMirror() {
  return { connection: 0, connected: false, topics: new Map() };
}

/**
 * @param {MirrorState} state
 * @param {string} key
 * @returns {TopicView|null} null: nothing is held for the key
 */
export function topicView(state, key) {
  const entry = state.topics.get(key);
  // A record without a value holds nothing: it only keeps the order of its
  // topic (live beats replay, own writes on their way).
  if (!entry || entry.record.value === null) return null;
  return {
    kind: entry.kind,
    ...overrideEffect(entry.kind, entry.record, state.connection),
    origin: entry.record.origin,
    connection: entry.record.delivered,
  };
}

/**
 * Field by field, whatever fields a view has: a field that is added to the
 * view later is compared without anybody having to remember it here.
 *
 * @param {TopicView|null} a
 * @param {TopicView|null} b
 * @returns {boolean}
 */
function sameView(a, b) {
  if (a === null || b === null) return a === b;
  const left = /** @type {Record<string, unknown>} */ (a);
  const right = /** @type {Record<string, unknown>} */ (b);
  for (const field of new Set([...Object.keys(left), ...Object.keys(right)]))
    if (left[field] !== right[field]) return false;
  return true;
}

/**
 * One input through the mirror. The state is not changed in place.
 *
 * @param {MirrorState} state
 * @param {MirrorInput} input
 * @returns {{state: MirrorState, decision: import("../core/ordering.js").Decision, effects: MirrorEffect[]}}
 */
export function reduceMirror(state, input) {
  /** @type {MirrorState} */
  const next = {
    connection: state.connection,
    connected: state.connected,
    topics: new Map(state.topics),
  };
  const decision = stepMirror(next, input);
  // The effect is derived, never listed: every key whose view differs.
  const keys = [...new Set([...state.topics.keys(), ...next.topics.keys()])];
  const changed = keys.filter(
    (key) => !sameView(topicView(state, key), topicView(next, key)),
  );
  return {
    state: next,
    decision,
    effects: changed.length > 0 ? [{ type: "changed", keys: changed }] : [],
  };
}

/**
 * A newer connection exists. Nothing is removed and nothing is concluded
 * about the store: what changes is who has a say, and `topicView` answers
 * that from the connection number alone.
 *
 * @param {MirrorState} state mutated
 * @param {number} connection
 */
function newConnection(state, connection) {
  if (state.connected) endConnection(state);
  state.connection = connection;
  state.connected = true;
}

/**
 * The connection is gone: own writes that were not echoed are no longer
 * expected. The connection number stays, so the values of the connection
 * that ended keep their say while the broker is away.
 *
 * @param {MirrorState} state mutated
 */
function endConnection(state) {
  state.connected = false;
  for (const [key, entry] of state.topics) {
    const record = forgetOwnWrites(entry.record);
    if (record !== entry.record)
      state.topics.set(key, { ...entry, record, writes: [] });
  }
}

/**
 * @param {MirrorState} state mutated
 * @param {MirrorInput} input
 * @returns {import("../core/ordering.js").Decision}
 */
function stepMirror(state, input) {
  switch (input.type) {
    case "connect":
      if (input.connection <= state.connection)
        return drop("superseded_source");
      newConnection(state, input.connection);
      return apply();

    case "disconnect":
      if (
        input.connection < state.connection ||
        (input.connection === state.connection && !state.connected)
      )
        return drop("superseded_source");
      // The end of a connection of which nothing was seen yet: it existed
      // all the same, and it is over. Without this a message of it that is
      // handed over late would be taken for the start of a connection.
      if (input.connection > state.connection)
        newConnection(state, input.connection);
      endConnection(state);
      return apply();

    case "message": {
      // A message names its connection. A lower number than the current one
      // is a connection that is gone; a higher one means the connect event
      // has not been seen yet, and the connection is adopted first.
      if (input.connection < state.connection) return drop("superseded_source");
      if (input.connection > state.connection)
        newConnection(state, input.connection);
      else if (!state.connected) return drop("superseded_source");
      const entry = state.topics.get(input.key);
      const kind = entry?.kind ?? input.kind;
      const before = entry?.record ?? newTopicRecord();
      const fenced = fenceTopic(before, input, state.connection);
      const echo = fenced.decision.reason === "own_echo";
      let { record } = fenced;
      // The echo of an own write that was not applied when it was made (a
      // protective kind) and that no acknowledgement has applied since: the
      // store holds it now, and the record follows.
      if (echo && isProtective(kind) && before.landed === 0)
        record = {
          ...record,
          value: record.stored,
          delivered: state.connection,
          origin: "live",
        };
      if (record !== before)
        state.topics.set(input.key, {
          kind,
          record,
          writes: (entry?.writes ?? []).slice(echo ? 1 : 0),
        });
      return fenced.decision;
    }

    case "own-write": {
      if (!state.connected) return drop("offline");
      const entry = state.topics.get(input.key);
      const kind = entry?.kind ?? input.kind;
      const before = entry?.record ?? newTopicRecord();
      const writes = [...(entry?.writes ?? []), input.write];
      // What decides whether a display is touched follows evidence of what
      // the store holds, and nothing else: the write is on its way, and the
      // record changes at its acknowledgement or its echo.
      if (isProtective(kind)) {
        state.topics.set(input.key, {
          kind,
          record: {
            ...before,
            outstanding: [...before.outstanding, input.payload],
          },
          writes,
        });
        return hold("awaits_broker");
      }
      state.topics.set(input.key, {
        kind,
        record: ownWrite(before, input.payload, state.connection),
        writes,
      });
      return apply();
    }

    case "published": {
      const entry = state.topics.get(input.key);
      const index = entry ? entry.writes.indexOf(input.write) : -1;
      // Echoed already, of a connection that has ended, or told twice.
      if (!entry || index < 0) return drop("unknown_write");
      const { record } = entry;
      // What the broker acknowledged was sent, and stays acknowledged.
      if (index < record.landed) return drop("unknown_write");
      if (input.outcome === "failed") {
        state.topics.set(input.key, {
          ...entry,
          record: withoutWrite(record, index, isProtective(entry.kind)),
          writes: entry.writes.filter((_, at) => at !== index),
        });
        return apply();
      }
      const payload = record.outstanding[index];
      const stored = payload === "" ? null : payload;
      /** @type {TopicRecord} */
      let next = {
        ...record,
        // It is in the store, and so is every own write sent before it.
        landed: index + 1,
        stored,
        storedOn: state.connection,
      };
      if (isProtective(entry.kind))
        next = {
          ...next,
          value: stored,
          delivered: state.connection,
          origin: "own",
        };
      state.topics.set(input.key, { ...entry, record: next });
      return apply("own_ack");
    }
  }
}
