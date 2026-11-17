/**
 * Ordering in the browser: the one decision for everything that arrives.
 *
 * The page gets state from three places that are not ordered among each
 * other: the live stream (snapshot, then events), the answer of
 * GET /api/v2/bootstrap, and the answers of its own writes. Each can be
 * late: a bootstrap answer of a pixdcon that was restarted meanwhile, an
 * event of a stream the page already replaced, the answer of a write that
 * was overtaken by a live event. This file is the browser's twin of
 * src/core/ordering.js: every arrival carries the identity of its source
 * and its position, and gets one answer: apply, hold or drop.
 *
 * Identity and position of what arrives:
 *   live event     server epoch and seq (from the event id "<epoch>-<seq>",
 *                  whatever the payload holds), and the generation of the
 *                  stream it came on
 *   snapshot       epoch and seq, and the generation of its source: the
 *                  stream, or the bootstrap request
 *   HTTP answer    epoch and seq from the header X-Pixdcon-Position, and the
 *                  generation of the request for its resource
 *   view inside    its own epoch and rev (DeviceView, SettingsState)
 *
 * Generations are numbers the page hands out itself, from one counter:
 * `openSource()` for every new stream and every bootstrap request,
 * `beginRequest(resource)` for every other request. A higher number was
 * started later.
 *
 * The rules:
 *  - A snapshot is applied only when its source is not older than the
 *    source of the snapshot the page holds. A snapshot of another epoch then
 *    replaces everything; a snapshot of the same epoch is applied only when
 *    its seq is not lower than the page's. A late bootstrap answer of an
 *    earlier run therefore cannot replace the newer run's state.
 *  - An event is applied only when it comes on the newest stream, in the
 *    page's epoch, with a seq higher than the last one applied.
 *  - A view is applied only when it is of the page's epoch and its rev is
 *    higher than the one held for the same device or settings key.
 *  - Any other answer (overlay list, config state, scenes) is applied only
 *    when it is of the page's epoch, belongs to the newest request for its
 *    resource, and its position is not lower than the position the resource
 *    was last applied at.
 *
 * Pure: no DOM, no timers, no network. The store calls it before it changes
 * anything (store.js), and test/contract/ordering.test.js runs it in Node.
 *
 * Owner: UI worker.
 */

/** @typedef {"apply"|"hold"|"drop"} Action */
/** @typedef {{action: Action, reason: string}} Decision */

/**
 * @typedef {object} ClientFence
 * @property {string|null} epoch epoch of the snapshot the page holds; null before the first
 * @property {number} seq seq of the last snapshot or event applied
 * @property {number} generations the counter generations are taken from
 * @property {number} stream generation of the newest stream; 0 = none opened
 * @property {number} snapshotSource generation of the source of the snapshot the page holds; 0 = none
 * @property {Map<string, number>} revs "device:<name>" or "settings:<device>/<scene>" → rev applied
 * @property {Map<string, number>} requests resource → generation of its newest request
 * @property {Map<string, number>} applied resource → seq at which it was last applied
 * @property {Map<string, number>} removed view key → seq of the event that removed it
 */

/** @returns {ClientFence} */
export function createClientFence() {
  return {
    epoch: null,
    seq: 0,
    generations: 0,
    stream: 0,
    snapshotSource: 0,
    revs: new Map(),
    requests: new Map(),
    applied: new Map(),
    removed: new Map(),
  };
}

/** @type {(reason?: string) => Decision} */
const apply = (reason = "current") => ({ action: "apply", reason });
/** @type {(reason: string) => Decision} */
const drop = (reason) => ({ action: "drop", reason });

/**
 * "<epoch>-<seq>" of an event id, a cursor or the X-Pixdcon-Position header.
 *
 * @param {string|null|undefined} text
 * @returns {{epoch: string, seq: number}|null} null when it cannot be read
 */
export function parsePosition(text) {
  const match = /^([0-9a-f]{8})-(\d+)$/.exec(text ?? "");
  return match ? { epoch: match[1], seq: Number(match[2]) } : null;
}

/**
 * A new source of snapshots starts: a stream (every connect and reconnect
 * opens a new one) or a bootstrap request.
 *
 * @param {ClientFence} fence changed in place
 * @param {"stream"|"bootstrap"} kind
 * @returns {number} its generation
 */
export function openSource(fence, kind) {
  const generation = ++fence.generations;
  if (kind === "stream") fence.stream = generation;
  return generation;
}

/**
 * A request for a resource starts, e.g. "overlays", "config", "scenes".
 *
 * @param {ClientFence} fence changed in place
 * @param {string} resource
 * @returns {number} its generation
 */
export function beginRequest(fence, resource) {
  const generation = ++fence.generations;
  fence.requests.set(resource, generation);
  return generation;
}

/**
 * @param {ClientFence} fence changed in place when the answer is apply
 * @param {{epoch: string, seq: number}} snapshot
 * @param {{generation: number}} source the stream or bootstrap request it came from
 * @returns {Decision} apply with reason "new_epoch": the page throws away everything it holds
 */
export function decideSnapshot(fence, snapshot, source) {
  if (source.generation < fence.snapshotSource)
    return drop("superseded_source");
  const sameEpoch = fence.epoch === snapshot.epoch;
  if (sameEpoch && snapshot.seq < fence.seq) return drop("not_newer");
  fence.snapshotSource = source.generation;
  fence.epoch = snapshot.epoch;
  fence.seq = snapshot.seq;
  if (!sameEpoch) {
    fence.revs.clear();
    fence.applied.clear();
    fence.removed.clear();
    return apply("new_epoch");
  }
  return apply();
}

/**
 * @param {ClientFence} fence changed in place when the answer is apply
 * @param {{epoch: string, seq: number, stream: number, type?: string}} event the envelope of a live event; `type` names the resource it carries, if it is one (overlays, config, scenes, mqtt, controller)
 * @returns {Decision}
 */
export function decideEvent(fence, event) {
  if (event.stream !== fence.stream) return drop("superseded_source");
  if (fence.epoch === null) return drop("no_snapshot");
  if (event.epoch !== fence.epoch) return drop("other_epoch");
  if (!(event.seq > fence.seq)) return drop("not_newer");
  fence.seq = event.seq;
  if (event.type) fence.applied.set(event.type, event.seq);
  return apply();
}

/**
 * A DeviceView or SettingsState, inside an event or as the answer of a
 * write.
 *
 * @param {ClientFence} fence changed in place when the answer is apply
 * @param {{key: string, epoch: string, rev: number, seq?: number}} view key: "device:<name>" or "settings:<device>/<scene>"; seq: position of what carried it (the event's seq, or the seq of the answer's X-Pixdcon-Position)
 * @returns {Decision}
 */
export function decideView(fence, view) {
  if (fence.epoch === null) return drop("no_snapshot");
  if (view.epoch !== fence.epoch) return drop("other_epoch");
  const removedAt = fence.removed.get(view.key);
  if (removedAt !== undefined) {
    // Only something newer than the removal brings a device back: a late
    // answer of a write must not.
    if (view.seq === undefined || !(view.seq > removedAt))
      return drop("removed");
    fence.removed.delete(view.key);
  }
  const held = fence.revs.get(view.key);
  if (held !== undefined && !(view.rev > held)) return drop("not_newer");
  fence.revs.set(view.key, view.rev);
  return apply();
}

/**
 * An answer that carries a whole resource without a rev of its own.
 *
 * @param {ClientFence} fence changed in place when the answer is apply
 * @param {{resource: string, generation: number, epoch: string, seq: number}} answer generation: what beginRequest returned; epoch and seq: the X-Pixdcon-Position header
 * @returns {Decision}
 */
export function decideAnswer(fence, answer) {
  if (answer.generation !== fence.requests.get(answer.resource))
    return drop("superseded_source");
  if (fence.epoch === null) return drop("no_snapshot");
  if (answer.epoch !== fence.epoch) return drop("other_epoch");
  const held = fence.applied.get(answer.resource);
  if (held !== undefined && answer.seq < held) return drop("not_newer");
  fence.applied.set(answer.resource, answer.seq);
  return apply();
}

/**
 * A device left (event "device-removed"). Its rev is forgotten, so a device
 * of the same name that is added again starts fresh, and the removal is
 * remembered with its position, so a view that was built before it is not
 * taken for a new device.
 *
 * @param {ClientFence} fence changed in place
 * @param {string} key
 * @param {number} seq seq of the event that removed it
 */
export function forgetView(fence, key, seq) {
  fence.revs.delete(key);
  fence.removed.set(key, seq);
}
