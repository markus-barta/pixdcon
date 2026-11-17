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
 *   view inside    its own epoch and rev (DeviceView, SettingsState), and the
 *                  seq of what carried it: the event, the answer, the snapshot
 *
 * Generations are numbers the page hands out itself, from one counter:
 * `openSource()` for every new stream and every bootstrap request,
 * `beginRequest(resource)` for every other request. A higher number was
 * started later.
 *
 * POSITION IS THE ORDER. Everything pixdcon sends says where it stands in
 * the run: its seq. The page keeps, for every thing it shows, the position
 * of the copy on screen, and takes another copy only when that one does not
 * stand before it, whichever of the three places it comes from:
 *   - a whole resource (overlays, config, scenes, mqtt, controller,
 *     builtins): `applied`, the position of the copy shown. An event, an
 *     answer and a snapshot each carry a copy at their position. A snapshot
 *     carries one of every resource, so it sets the position of every
 *     resource it is taken for; an answer that was asked for before the
 *     snapshot and stands before it changes nothing.
 *   - a view (a device, a settings state): its `rev` inside the life of the
 *     device, and the device's life itself. When a device leaves, the
 *     position of its removal stays for the rest of the epoch, also when a
 *     device of the same name comes back: the new one counts its revs from
 *     1 again, so the rev alone cannot tell the late answer of the old one
 *     (rev 20, built before the removal) from news. The position can.
 *
 * The rules:
 *  - A snapshot is applied only when its source is not older than the
 *    source of the snapshot the page holds. A snapshot of another epoch then
 *    replaces everything; a snapshot of the same epoch is applied only when
 *    its seq is not lower than the page's. It answers which resources the
 *    page holds in a newer copy already (`keep`: an answer that stood after
 *    it) and which devices it does not list any more (`gone`).
 *  - An event is applied only when it comes on the newest stream, in the
 *    page's epoch, with a seq higher than the last one applied. It always
 *    moves the page's position; its content is taken only when the page
 *    does not hold a newer copy of that resource.
 *  - A view is applied only when it is of the page's epoch, was carried by
 *    something that stands after the last removal of its device, and its
 *    rev is higher than the one held for the same device or settings key. A
 *    device view that stands before the last snapshot and that the page does
 *    not hold is dropped: the snapshot did not list the device.
 *  - Any other answer is applied only when it is of the page's epoch,
 *    belongs to the newest request for its resource, and does not stand
 *    before the copy of the resource the page shows.
 *
 * Pure: no DOM, no timers, no network. The store calls it before it changes
 * anything (store.js), and test/contract/ordering.test.js runs it in Node.
 *
 * Owner: UI worker.
 */

/** @typedef {"apply"|"hold"|"drop"} Action */
/** @typedef {{action: Action, reason: string}} Decision */

/** The whole resources a snapshot carries (types.js Snapshot), beside its device views. */
export const SNAPSHOT_RESOURCES = Object.freeze(
  /** @type {const} */ ([
    "controller",
    "mqtt",
    "config",
    "scenes",
    "builtins",
    "overlays",
  ]),
);

/**
 * @typedef {object} ClientFence
 * @property {string|null} epoch epoch of the snapshot the page holds; null before the first
 * @property {number} seq seq of the last snapshot or event applied
 * @property {number} generations the counter generations are taken from
 * @property {number} stream generation of the newest stream; 0 = none opened
 * @property {number} snapshotSource generation of the source of the snapshot the page holds; 0 = none
 * @property {number} floor seq of the last snapshot applied; a device the page does not hold was not listed at this position
 * @property {Map<string, number>} revs "device:<name>" or "settings:<device>/<scene>" → rev applied
 * @property {Map<string, number>} carried view key → seq of what carried the view that is shown
 * @property {Map<string, number>} requests resource → generation of its newest request
 * @property {Map<string, number>} applied resource → seq at which the copy that is shown was built
 * @property {Map<string, number>} removed device name → seq of the last event (or snapshot) that removed it. Kept for the rest of the epoch, also when the device comes back
 */

/** @returns {ClientFence} */
export function createClientFence() {
  return {
    epoch: null,
    seq: 0,
    generations: 0,
    stream: 0,
    snapshotSource: 0,
    floor: 0,
    revs: new Map(),
    carried: new Map(),
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
 * The device a view key belongs to. Device names hold neither ":" nor "/".
 *
 * @param {string} key "device:<name>" or "settings:<device>/<scene>"
 * @returns {string}
 */
export function deviceOf(key) {
  const name = key.slice(key.indexOf(":") + 1);
  const slash = name.indexOf("/");
  return slash < 0 ? name : name.slice(0, slash);
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
 * A snapshot arrives. When it is applied, it is the copy of every resource
 * it carries, at its position, except where the page holds a newer copy.
 *
 * The store then puts every device view of the snapshot through
 * `decideView` with the snapshot's seq, takes every resource that is not in
 * `keep`, and removes the devices in `gone`.
 *
 * @param {ClientFence} fence changed in place when the answer is apply
 * @param {{epoch: string, seq: number, devices?: string[], resources?: readonly string[]}} snapshot devices: the names the snapshot lists (`Snapshot.devices`); resources: the whole resources it carries, default SNAPSHOT_RESOURCES
 * @param {{generation: number}} source the stream or bootstrap request it came from
 * @returns {Decision & {keep: string[], gone: string[]}} apply with reason "new_epoch": the page throws away everything it holds. keep: resources the page holds in a newer copy than the snapshot's; it keeps them. gone: devices the page holds and the snapshot does not list; they were removed before it
 */
export function decideSnapshot(fence, snapshot, source) {
  const none = { keep: [], gone: [] };
  if (source.generation < fence.snapshotSource)
    return { ...drop("superseded_source"), ...none };
  const sameEpoch = fence.epoch === snapshot.epoch;
  if (sameEpoch && snapshot.seq < fence.seq)
    return { ...drop("not_newer"), ...none };
  const resources = snapshot.resources ?? SNAPSHOT_RESOURCES;
  fence.snapshotSource = source.generation;
  fence.epoch = snapshot.epoch;
  fence.seq = snapshot.seq;
  fence.floor = snapshot.seq;
  if (!sameEpoch) {
    fence.revs.clear();
    fence.carried.clear();
    fence.applied.clear();
    fence.removed.clear();
    for (const resource of resources) fence.applied.set(resource, snapshot.seq);
    return { ...apply("new_epoch"), ...none };
  }
  /** @type {string[]} */
  const keep = [];
  for (const resource of resources) {
    // An answer that stood after this snapshot was applied before it
    // arrived: that copy is the newer one.
    if ((fence.applied.get(resource) ?? -1) > snapshot.seq) keep.push(resource);
    else fence.applied.set(resource, snapshot.seq);
  }
  /** @type {string[]} */
  const gone = [];
  if (snapshot.devices) {
    const listed = new Set(snapshot.devices);
    for (const key of [...fence.revs.keys()]) {
      if (!key.startsWith("device:")) continue;
      const name = deviceOf(key);
      // Not listed, and what the page shows of it does not stand after the
      // snapshot: it left before the snapshot was taken.
      if (listed.has(name) || (fence.carried.get(key) ?? -1) > snapshot.seq)
        continue;
      forgetDevice(fence, name, snapshot.seq);
      gone.push(name);
    }
  }
  return { ...apply(), keep, gone };
}

/**
 * A live event. On the newest stream, in the page's epoch and with a higher
 * seq it always moves the page's position. Its content is taken unless the
 * page holds a newer copy of the resource it carries (the answer of a
 * request that stood after it).
 *
 * @param {ClientFence} fence changed in place
 * @param {{epoch: string, seq: number, stream: number, type?: string}} event the envelope of a live event; `type` names the resource it carries, if it is one (overlays, config, scenes, mqtt, controller)
 * @returns {Decision} drop with reason "newer_copy": the position moved, the content is not taken
 */
export function decideEvent(fence, event) {
  if (event.stream !== fence.stream) return drop("superseded_source");
  if (fence.epoch === null) return drop("no_snapshot");
  if (event.epoch !== fence.epoch) return drop("other_epoch");
  if (!(event.seq > fence.seq)) return drop("not_newer");
  fence.seq = event.seq;
  if (event.type) {
    if ((fence.applied.get(event.type) ?? -1) > event.seq)
      return drop("newer_copy");
    fence.applied.set(event.type, event.seq);
  }
  return apply();
}

/**
 * A DeviceView or SettingsState: inside an event, inside a snapshot, or as
 * the answer of a write.
 *
 * @param {ClientFence} fence changed in place when the answer is apply
 * @param {{key: string, epoch: string, rev: number, seq: number}} view key: "device:<name>" or "settings:<device>/<scene>"; seq: position of what carried it (the event's seq, the snapshot's seq, or the seq of the answer's X-Pixdcon-Position)
 * @returns {Decision}
 */
export function decideView(fence, view) {
  if (fence.epoch === null) return drop("no_snapshot");
  if (view.epoch !== fence.epoch) return drop("other_epoch");
  if (!Number.isFinite(view.seq)) return drop("no_position");
  // The life of the device comes first: nothing that stands at or before
  // its last removal belongs to the device that is there now, whatever rev
  // it carries. The mark stays when the device comes back.
  const removedAt = fence.removed.get(deviceOf(view.key));
  if (removedAt !== undefined && !(view.seq > removedAt))
    return drop("removed");
  const held = fence.revs.get(view.key);
  // A device the page does not hold, in a copy that stands before the last
  // snapshot: the snapshot did not list it, so it had left by then.
  if (
    held === undefined &&
    view.key.startsWith("device:") &&
    view.seq < fence.floor
  )
    return drop("removed");
  if (held !== undefined && !(view.rev > held)) return drop("not_newer");
  fence.revs.set(view.key, view.rev);
  fence.carried.set(view.key, view.seq);
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
 * A device left (event "device-removed", or a snapshot that does not list
 * it). Its views are forgotten: the device view and every settings state of
 * it. The position of the removal is kept for the rest of the epoch, so a
 * view that was built before it is never taken for the device of the same
 * name that may come back.
 *
 * @param {ClientFence} fence changed in place
 * @param {string} name device name
 * @param {number} seq seq of the event, or of the snapshot, that removed it
 */
export function forgetDevice(fence, name, seq) {
  for (const key of [...fence.revs.keys()]) {
    if (deviceOf(key) !== name) continue;
    fence.revs.delete(key);
    fence.carried.delete(key);
  }
  fence.removed.set(name, Math.max(seq, fence.removed.get(name) ?? -1));
}
