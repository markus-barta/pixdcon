/**
 * Topic fence: the ordering rule (core/ordering.js) for one retained topic.
 *
 * The overlay service mirrors many retained topics: ip, enabled and scene
 * path overlays, setting overlays, the mode and brightness controls. Each
 * goes through this one function, message by message. (The two scene layers
 * have more to decide, suppressions and the blob as a document, and their
 * own reducer: scene-layers.js. It applies the same three rules.)
 *
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
 *     (`stored`): when an own write turns out not to have been sent
 *     (`ownWriteFailed`), the value goes back to that.
 *
 * What is not in here is as much part of the contract: the function has no
 * input for a connect, a disconnect, the settle hint or a timer. A record
 * changes only when a message for its topic is delivered. After a
 * reconnect it stays as it was, in effect, until the new connection
 * delivers something for the topic; `delivered` is then lower than the
 * current connection, which is how a reader can tell (M4). Own writes that
 * were not echoed are forgotten at a disconnect by `forgetOwnWrites`.
 *
 * Owner: core/state worker.
 */

import { apply, drop } from "../core/ordering.js";

/**
 * @typedef {object} TopicRecord
 * @property {string|null} value payload held for the topic, own writes included as soon as they are made; null = nothing stored as far as known
 * @property {string|null} stored what the broker's store holds as far as delivered: the last delivered message or own echo
 * @property {number} delivered connection on which `value` was delivered, or applied by an own write; 0 = never
 * @property {"replay"|"live"|"own"|null} origin
 * @property {number} live connection on which a live message was last delivered; 0 = none
 * @property {string[]} outstanding payloads of own writes on the current connection whose echo has not arrived, oldest first
 */

/** @returns {TopicRecord} */
export function newTopicRecord() {
  return {
    value: null,
    stored: null,
    delivered: 0,
    origin: null,
    live: 0,
    outstanding: [],
  };
}

/**
 * @param {TopicRecord} record
 * @param {Pick<import("../mqtt/mqtt-gateway.js").MqttMessage, "payload"|"retain"|"connection">} message
 * @param {number} connection the current connection
 * @returns {{record: TopicRecord, decision: import("../core/ordering.js").Decision, changed: boolean}} changed: the value differs from before (M3: an unchanged value is not a change)
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
    if (record.outstanding.length > 0) return same("before_own_write");
    if (value === null) return same("empty_replay");
    return {
      record: {
        ...record,
        value,
        stored: value,
        delivered: connection,
        origin: "replay",
      },
      decision: apply(),
      changed: record.value !== value,
    };
  }

  if (record.outstanding.length > 0) {
    // Either way the store holds this payload now; the value the process
    // holds is newer and stays.
    const seen = { ...record, stored: value, live: connection };
    if (record.outstanding[0] !== message.payload)
      return {
        record: seen,
        decision: drop("before_own_write"),
        changed: false,
      };
    // The echo of the oldest own write.
    return {
      record: { ...seen, outstanding: record.outstanding.slice(1) },
      decision: apply("own_echo"),
      changed: false,
    };
  }

  return {
    record: {
      ...record,
      value,
      stored: value,
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
 * An own write was certainly not sent. It is no longer expected back; when
 * it was the last one on its way, the value is again what the store holds.
 *
 * @param {TopicRecord} record
 * @param {string} payload the payload of the write that failed
 * @returns {{record: TopicRecord, changed: boolean}}
 */
export function ownWriteFailed(record, payload) {
  const index = record.outstanding.lastIndexOf(payload);
  if (index < 0) return { record, changed: false };
  const outstanding = record.outstanding.filter((_, at) => at !== index);
  if (outstanding.length > 0)
    return { record: { ...record, outstanding }, changed: false };
  return {
    record: { ...record, outstanding, value: record.stored, origin: "live" },
    changed: record.value !== record.stored,
  };
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
    : { ...record, outstanding: [] };
}
