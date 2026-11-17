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
 *   view inside    its own epoch, incarnation and rev (DeviceView,
 *                  SettingsState), and the seq of what carried it: the
 *                  event, the answer, the snapshot
 *
 * Generations are numbers the page hands out itself, from one counter:
 * `openSource()` for every new stream and every bootstrap request,
 * `beginRequest(resource)` for every other request. A higher number was
 * started later.
 *
 * POSITION IS THE ORDER of what has no name of its own. Everything pixdcon
 * sends says where it stands in the run: its seq. For a whole resource
 * (overlays, config, scenes, mqtt, controller, builtins) the page keeps the
 * position of the copy on screen (`applied`) and takes another copy only
 * when that one does not stand before it, whichever of the three places it
 * comes from. A snapshot carries one of every resource, so it sets the
 * position of every resource it is taken for; an answer that was asked for
 * before the snapshot and stands before it changes nothing.
 *
 * A VIEW HAS A NAME, and the name is the order (round 5, the fourth
 * cross-read's R4-4). A view (a device, a settings state) is a copy of one
 * device in one of its lives. A device that leaves and comes back is
 * another device with the same name: it counts its revs from 1 again. A
 * page that was disconnected meanwhile has seen neither event: it holds rev
 * 20 of the device that is gone, the snapshot lists the new one at rev 1,
 * and by the rev alone the new device's views would be dropped until they
 * pass 20. So pixdcon names the lives:
 *   - every view carries the `incarnation` of its device: a number pixdcon
 *     hands out when a device enters the effective config, from one counter
 *     for all devices, rising inside one epoch. Inside one incarnation the
 *     `rev` only rises. (incarnation, rev) is therefore the order of the
 *     copies of a view, and nothing else is asked: a lower incarnation than
 *     the one the page holds is a device that is gone; a higher one is a new
 *     device, and what the page holds of the old one (its view, its
 *     settings states) is thrown away first; inside one incarnation the
 *     higher rev is the newer copy.
 *   - a "device-removed" event names the incarnation that left, and a
 *     snapshot says how far the counter had come when it was taken
 *     (`Snapshot.incarnations`). An incarnation that a removal named, or
 *     that a snapshot counted and did not list, is over: no view of it is
 *     taken again.
 * Where the name decides, the position that an answer claims decides
 * nothing. That is on purpose: an answer's position is read from a header,
 * and a header that is read a moment after the view was built names a later
 * position than the view has. If positions ordered views, such an answer
 * would hold back the event that follows it.
 *
 * WITHOUT THE NAME (a view that does not say its incarnation; a removal or
 * a snapshot that does not) the position is all there is, and it decides,
 * as in round 4 and one step further:
 *   - when a device leaves, the position of its removal stays for the rest
 *     of the epoch, also when a device of the same name comes back: nothing
 *     that stands at or before it is taken. A removal forgets what stands
 *     at or before it, and leaves a view that stands after it.
 *   - no view replaces a copy that stands after it, whatever its rev. A
 *     view inside a snapshot replaces a copy that stands before it,
 *     whatever its rev: a snapshot is a complete copy at its position. That
 *     is the review's sequence, and it needs no incarnation.
 * This rests on how pixdcon stamps, and so does the order of the whole
 * resources, which have no name: an answer must never name a later position
 * than the state it was built from. An earlier one is harmless: the answer
 * then waits for the stream. So the position of an answer is read before
 * its handler runs, or in the very step that builds its body
 * (api/http-server.js).
 *
 * WHAT A POSITION CAN STILL DO TO A NAMED VIEW: make it wait. A view that
 * says it stands at or before the last removal of its device, or before the
 * last snapshot when the page does not hold its device, is dropped also
 * when it names a new incarnation. The stream brings the device again: an
 * event says where it stands by its id, exactly. A position never lets an
 * older named view in, and never keeps a newer one out for good.
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
 *  - A view is applied only when it is of the page's epoch; its incarnation
 *    is not over and not older than the one the page holds for its device;
 *    it does not stand at or before the last removal of its device, nor
 *    before the last snapshot when the page does not hold its device. Then,
 *    with a name: its rev is higher than the one held for the same device
 *    or settings key (a view inside a snapshot: not lower). Without a name:
 *    it does not stand before the copy on screen, and it is part of a
 *    snapshot that stands after that copy, or its rev is higher.
 *  - Any other answer is applied only when it is of the page's epoch,
 *    belongs to the newest request for its resource, and does not stand
 *    before the copy of the resource the page shows.
 *
 * Pure: no DOM, no timers, no network. The store calls it before it changes
 * anything (store.js), and the contract tests run it in Node
 * (test/contract/ordering.test.js), by hand and against a model of the live
 * channel and the API.
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
 * @property {Map<string, number>} lives device name → the highest incarnation of the device the page has applied a view of; 0 = its views did not say. Kept for the rest of the epoch, also when the device is removed: a view of an older incarnation is never taken again
 * @property {Map<string, number>} ended device name → the highest incarnation of the device that is known to be over: a removal named it, or a snapshot counted it and did not list the device. Kept for the rest of the epoch. Set on that evidence only, never on where a copy stands
 * @property {number|null} census how far pixdcon's incarnation counter had come when the snapshot the page holds was taken (`Snapshot.incarnations`: the highest incarnation handed out so far, 0 before the first); null = the snapshot did not say
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
    lives: new Map(),
    ended: new Map(),
    census: null,
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
 * The store then removes the devices in `gone`, with their settings states,
 * takes every resource that is not in `keep`, and puts every device view of
 * the snapshot through `decideView` with the snapshot's seq, the view's
 * `incarnation` and `snapshot: true`.
 *
 * @param {ClientFence} fence changed in place when the answer is apply
 * @param {{epoch: string, seq: number, devices?: string[], resources?: readonly string[], incarnations?: number}} snapshot devices: the names the snapshot lists (`Snapshot.devices`); resources: the whole resources it carries, default SNAPSHOT_RESOURCES; incarnations: `Snapshot.incarnations`, how far the incarnation counter had come
 * @param {{generation: number}} source the stream or bootstrap request it came from
 * @returns {Decision & {keep: string[], gone: string[]}} apply with reason "new_epoch": the page throws away everything it holds. keep: resources the page holds in a newer copy than the snapshot's; it keeps them. gone: devices of which the page holds a view (the device's, or a settings state) and which were not there any more when the snapshot was taken
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
  fence.census = snapshot.incarnations ?? null;
  if (!sameEpoch) {
    fence.revs.clear();
    fence.carried.clear();
    fence.applied.clear();
    fence.removed.clear();
    fence.lives.clear();
    fence.ended.clear();
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
    /** Device name → the latest position of a view the page holds of it. @type {Map<string, number>} */
    const held = new Map();
    for (const key of fence.revs.keys()) {
      const name = deviceOf(key);
      held.set(
        name,
        Math.max(held.get(name) ?? -1, fence.carried.get(key) ?? -1),
      );
    }
    for (const [name, latest] of held) {
      if (listed.has(name)) continue;
      const life = fence.lives.get(name) ?? 0;
      if (life > 0 && fence.census !== null) {
        // By name. The snapshot counted this incarnation and does not list
        // its device: it is over. One it did not count entered after the
        // snapshot was taken, and stays.
        if (life > fence.census) continue;
        forgetDevice(fence, name, snapshot.seq, life);
      } else {
        // By position. Nothing the page shows of it stands after the
        // snapshot: it left before the snapshot was taken. That holds for a
        // device of which the page has a settings state and no view, too.
        if (latest > snapshot.seq) continue;
        forgetDevice(fence, name, snapshot.seq);
      }
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
 * @param {ClientFence} fence changed in place when the answer is apply, and only then
 * @param {{key: string, epoch: string, rev: number, seq: number, incarnation?: number, snapshot?: boolean}} view key: "device:<name>" or "settings:<device>/<scene>"; seq: position of what carried it (the event's seq, the snapshot's seq, or the seq of the answer's X-Pixdcon-Position); incarnation: `DeviceView.incarnation` or `SettingsState.incarnation`, the life of its device; absent or 0 = not said; snapshot: the view is part of a snapshot
 * @returns {Decision} apply with reason "new_incarnation": a newer device of that name. The page throws away what it holds of the device (its view and its settings states) before it takes this view
 */
export function decideView(fence, view) {
  if (fence.epoch === null) return drop("no_snapshot");
  if (view.epoch !== fence.epoch) return drop("other_epoch");
  if (!Number.isFinite(view.seq)) return drop("no_position");
  const device = deviceOf(view.key);
  const life = view.incarnation ?? 0;
  const holdsDevice = fence.revs.has(`device:${device}`);

  // What is over, by its name: an incarnation that a removal named, or that
  // the snapshot the page holds counted without listing its device (the
  // page holds every device that snapshot listed, or a newer one).
  if (life > 0) {
    if (life <= (fence.ended.get(device) ?? 0)) return drop("removed");
    if (
      view.snapshot !== true &&
      fence.census !== null &&
      life <= fence.census &&
      !holdsDevice
    )
      return drop("removed");
  }
  // What is over, by where it stands: nothing at or before the last removal
  // of its device belongs to the device that is there now. The mark stays
  // when the device comes back.
  const removedAt = fence.removed.get(device);
  if (removedAt !== undefined && !(view.seq > removedAt))
    return drop("removed");
  // An older incarnation than the page holds is a device that is gone, also
  // when the page never heard of its removal and whatever position the view
  // claims. A newer one meets nothing of its own on the page.
  const heldLife = fence.lives.get(device);
  if (heldLife !== undefined && life < heldLife)
    return drop("older_incarnation");
  const reborn = heldLife !== undefined && life > heldLife;
  // A device the page does not hold, in a copy that stands before the last
  // snapshot: the snapshot did not list it, so it had left by then. That
  // holds for its settings states as well as for its view.
  if (!holdsDevice && view.seq < fence.floor) return drop("removed");

  const held = reborn ? undefined : fence.revs.get(view.key);
  if (held !== undefined) {
    const older = view.snapshot === true ? view.rev < held : !(view.rev > held);
    if (life > 0) {
      // Inside one incarnation the rev is the order. Where the two copies
      // stand is not asked: an answer may name a later position than it has.
      if (older) return drop("not_newer");
    } else {
      // No name: where the copies stand has to tell lives apart. No copy
      // replaces one that stands after it, and a snapshot's copy replaces
      // one that stands before it, whatever the revs say (a device that
      // left and came back while the page was away counts from 1 again).
      const carried = fence.carried.get(view.key) ?? -1;
      if (view.seq < carried) return drop("stands_before");
      const byPosition = view.snapshot === true && view.seq > carried;
      if (older && !byPosition) return drop("not_newer");
    }
  }
  if (reborn) {
    for (const key of [...fence.revs.keys()]) {
      if (deviceOf(key) !== device) continue;
      fence.revs.delete(key);
      fence.carried.delete(key);
    }
  }
  fence.lives.set(device, life);
  fence.revs.set(view.key, view.rev);
  fence.carried.set(view.key, view.seq);
  return apply(reborn ? "new_incarnation" : "current");
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
 * it. Which views those are is a question of which device left:
 *  - the removal names the incarnation that left: that incarnation is over
 *    for the rest of the epoch. When the page holds a newer incarnation of
 *    the name (the answer of a write to the device that came back, which
 *    arrived before the stream had caught up to the removal), nothing is
 *    forgotten: the removal is of the device before.
 *  - the removal names none: a view that stands after the removal is kept,
 *    for the same reason, and everything else of the device is forgotten.
 * The position of the removal is kept for the rest of the epoch either way,
 * so a view that was built before it is never taken for the device of the
 * same name that may come back.
 *
 * @param {ClientFence} fence changed in place
 * @param {string} name device name
 * @param {number} seq seq of the event, or of the snapshot, that removed it
 * @param {number} [incarnation] the incarnation that left (`device-removed`: `data.incarnation`); absent or 0 = not said
 * @returns {string[]} the view keys that were forgotten; the page removes exactly these
 */
export function forgetDevice(fence, name, seq, incarnation = 0) {
  const named = incarnation > 0;
  if (named)
    fence.ended.set(name, Math.max(incarnation, fence.ended.get(name) ?? 0));
  const newer = named && (fence.lives.get(name) ?? 0) > incarnation;
  /** @type {string[]} */
  const forgotten = [];
  for (const key of [...fence.revs.keys()]) {
    if (deviceOf(key) !== name) continue;
    if (named ? newer : (fence.carried.get(key) ?? -1) > seq) continue;
    fence.revs.delete(key);
    fence.carried.delete(key);
    forgotten.push(key);
  }
  fence.removed.set(name, Math.max(seq, fence.removed.get(name) ?? -1));
  return forgotten;
}
