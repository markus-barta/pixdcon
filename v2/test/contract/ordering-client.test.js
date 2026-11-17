/**
 * Test kind 2 of 3 (API and MQTT contract): the browser's fence and a device
 * that left and came back while the page was not listening.
 *
 * The fourth cross-read (R4-4) ran this against web/js/ordering.js: the page
 * holds device D at rev 20; it is disconnected; pixdcon removes D and adds a
 * device of the same name; the page reconnects and gets a snapshot that
 * lists D at rev 1. Neither the removal nor the return was delivered, so
 * the position of the removal, which round 4 relied on, does not exist for
 * the page. The view of the new device was dropped as "not newer", and so
 * was every later one up to rev 20.
 *
 * The lives of a device have names now (`incarnation`), and the name is the
 * order: a view is judged by its incarnation and, inside it, by its rev. A
 * removal names the incarnation that left, a snapshot says how far the
 * counter had come. Where nothing is named the position decides, as the
 * review proposed: a view inside a snapshot is taken by where it stands,
 * and no view replaces a copy that stands after it. The review's sequence
 * is run both ways.
 *
 * The random walk at the end runs the fence against a model of pixdcon's
 * live channel and API. With names, the answers of the model claim any
 * position they like; without, they say where they stand.
 *
 * Owner: UI worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createClientFence,
  decideEvent,
  decideSnapshot,
  decideView,
  deviceOf,
  forgetDevice,
  openSource,
} from "../../web/js/ordering.js";

const EPOCH = "aaaaaaaa";

test("R4-4: a device that left and came back while the page was disconnected. The snapshot of the new stream lists it at rev 1: its view is taken by where it stands, the revs that follow apply, and the late answer of the old device is dropped by where it stands (the review's sequence, no incarnation said)", () => {
  const fence = createClientFence();
  const first = openSource(fence, "stream");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: EPOCH, seq: 10, devices: ["D"] },
      { generation: first },
    ),
    { action: "apply", reason: "new_epoch", keep: [], gone: [] },
  );
  /** @param {number} rev @param {number} seq @param {boolean} [snapshot] */
  const view = (rev, seq, snapshot) =>
    decideView(fence, { key: "device:D", epoch: EPOCH, rev, seq, snapshot });
  assert.equal(view(1, 10, true).action, "apply");
  assert.equal(view(20, 18).action, "apply", "the device as the page knows it");

  // The page is disconnected. pixdcon removes D and adds a device of the
  // same name. The stream comes back with a snapshot; the removal and the
  // return were never delivered.
  const next = openSource(fence, "stream");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: EPOCH, seq: 30, devices: ["D"] },
      { generation: next },
    ),
    { action: "apply", reason: "current", keep: [], gone: [] },
  );
  assert.deepEqual(
    view(1, 30, true),
    { action: "apply", reason: "current" },
    "rev 1 after rev 20: a snapshot is a complete copy at its position",
  );
  assert.equal(fence.revs.get("device:D"), 1);

  // The answer of a write to the old device, built at seq 19, arrives now.
  // Its rev is higher than the one on screen. It stands before the copy.
  assert.deepEqual(view(21, 19), { action: "drop", reason: "stands_before" });

  // The new device goes on: every rev from 2 to 20 applies.
  for (let rev = 2; rev <= 20; rev++)
    assert.equal(view(rev, 30 + rev).action, "apply", `rev ${rev}`);
  assert.equal(fence.revs.get("device:D"), 20);
});

test("R4-4, exactly as the review ran it: no incarnation, and the caller does not say that a view came with a snapshot. The fence knows where the last snapshot stood: a copy from the snapshot on replaces what the page holds from before it, whatever the revs say, a settings state as well as a device view", () => {
  const fence = createClientFence();
  const first = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: EPOCH, seq: 10, devices: ["D"] },
    { generation: first },
  );
  assert.equal(
    decideView(fence, { key: "device:D", epoch: EPOCH, seq: 10, rev: 20 })
      .action,
    "apply",
  );
  assert.equal(
    decideView(fence, {
      key: "settings:D/clock",
      epoch: EPOCH,
      seq: 12,
      rev: 7,
    }).action,
    "apply",
  );

  // While the page is away D is removed and added again. The new stream
  // starts with a snapshot, so neither event is delivered.
  const next = openSource(fence, "stream");
  assert.equal(
    decideSnapshot(
      fence,
      { epoch: EPOCH, seq: 30, devices: ["D"] },
      { generation: next },
    ).action,
    "apply",
  );
  // The store hands the snapshot's view on with the snapshot's position,
  // and with nothing else.
  assert.deepEqual(
    decideView(fence, { key: "device:D", epoch: EPOCH, seq: 30, rev: 1 }),
    { action: "apply", reason: "current" },
    "rev 1 after rev 20: taken, it stands at the snapshot",
  );
  assert.equal(fence.revs.get("device:D"), 1);
  for (let rev = 2; rev <= 20; rev++)
    assert.equal(
      decideView(fence, {
        key: "device:D",
        epoch: EPOCH,
        seq: 30 + rev,
        rev,
      }).action,
      "apply",
      `rev ${rev}`,
    );
  // The settings state of the new device, asked for after the reconnect.
  assert.deepEqual(
    decideView(fence, {
      key: "settings:D/clock",
      epoch: EPOCH,
      seq: 52,
      rev: 1,
    }),
    { action: "apply", reason: "current" },
    "rev 1 after rev 7 of the device that is gone",
  );
  // The late answers of the old device, built before the snapshot.
  assert.equal(
    decideView(fence, { key: "device:D", epoch: EPOCH, seq: 19, rev: 21 })
      .reason,
    "stands_before",
  );
  assert.equal(
    decideView(fence, {
      key: "settings:D/clock",
      epoch: EPOCH,
      seq: 19,
      rev: 8,
    }).reason,
    "stands_before",
  );
  // Inside the time after the snapshot the rev decides, as before.
  assert.equal(
    decideView(fence, { key: "device:D", epoch: EPOCH, seq: 60, rev: 20 })
      .reason,
    "not_newer",
  );
});

test("R4-4: every view names the incarnation of its device, and the name is the order. The review's sequence: the new device's view is taken as a new device, what the page held of the old one goes, settings states too, and a view of the old one is dropped whatever position it claims", () => {
  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: EPOCH, seq: 10, devices: ["D"], incarnations: 1 },
    { generation: stream },
  );
  /**
   * @param {string} key
   * @param {number|undefined} incarnation
   * @param {number} rev
   * @param {number} seq
   * @param {boolean} [snapshot]
   */
  const view = (key, incarnation, rev, seq, snapshot) =>
    decideView(fence, { key, epoch: EPOCH, rev, seq, incarnation, snapshot });
  assert.equal(view("device:D", 1, 20, 10, true).action, "apply");
  assert.equal(view("settings:D/clock", 1, 4, 12).action, "apply");
  assert.equal(view("settings:D/home", 1, 2, 13).action, "apply");
  assert.equal(fence.lives.get("D"), 1);

  // Disconnected; D leaves and comes back as incarnation 2.
  const next = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: EPOCH, seq: 30, devices: ["D"], incarnations: 2 },
    { generation: next },
  );
  assert.deepEqual(view("device:D", 2, 1, 30, true), {
    action: "apply",
    reason: "new_incarnation",
  });
  assert.deepEqual(
    [...fence.revs.keys()],
    ["device:D"],
    "what the page held of incarnation 1 is forgotten, settings states too",
  );
  assert.equal(fence.lives.get("D"), 2);

  // Answers of writes to the old device: one that names a position after
  // the snapshot, and a settings state. Both are of a device that is gone.
  assert.deepEqual(view("device:D", 1, 21, 45), {
    action: "drop",
    reason: "older_incarnation",
  });
  assert.deepEqual(view("settings:D/clock", 1, 5, 46), {
    action: "drop",
    reason: "older_incarnation",
  });
  // The new device's settings state counts from 1, and is taken; the revs
  // of the new device apply from 2 on.
  assert.equal(view("settings:D/clock", 2, 1, 31).action, "apply");
  for (let rev = 2; rev <= 20; rev++)
    assert.equal(view("device:D", 2, rev, 30 + rev).action, "apply");

  // A view that does not say its incarnation is not taken for a device
  // whose incarnation is known: it counts as 0.
  assert.equal(view("device:D", undefined, 99, 60).reason, "older_incarnation");

  // A new run of pixdcon counts its incarnations from 1 again. A count of
  // 0 is a count: a snapshot taken before any device entered counted none,
  // so the first device, known from an answer, is not over.
  const restarted = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: "cccccccc", seq: 0, devices: [], incarnations: 0 },
    { generation: restarted },
  );
  assert.deepEqual([fence.lives.size, fence.ended.size], [0, 0]);
  assert.equal(
    decideView(fence, {
      key: "device:D",
      epoch: "cccccccc",
      rev: 2,
      seq: 0,
      incarnation: 1,
    }).action,
    "apply",
  );
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "cccccccc", seq: 0, devices: [], incarnations: 0 },
      { generation: openSource(fence, "stream") },
    ).gone,
    [],
  );
  decideSnapshot(
    fence,
    { epoch: "bbbbbbbb", seq: 1, devices: ["D"], incarnations: 1 },
    { generation: openSource(fence, "stream") },
  );
  assert.deepEqual([fence.lives.size, fence.ended.size], [0, 0]);
  assert.equal(
    decideView(fence, {
      key: "device:D",
      epoch: "bbbbbbbb",
      rev: 1,
      seq: 1,
      incarnation: 1,
      snapshot: true,
    }).action,
    "apply",
  );
});

test("R4-4: inside one incarnation the rev is the order, and the position an answer claims is not asked. An answer that names a later position than the state it shows does not hold back the event that follows it; a snapshot does not put an older rev over a newer one, wherever the two say they stand", () => {
  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: EPOCH, seq: 10, devices: ["D"], incarnations: 1 },
    { generation: stream },
  );
  /** @param {number} rev @param {number} seq @param {boolean} [snapshot] */
  const view = (rev, seq, snapshot) =>
    decideView(fence, {
      key: "device:D",
      epoch: EPOCH,
      rev,
      seq,
      incarnation: 1,
      snapshot,
    });
  assert.equal(view(5, 10, true).action, "apply");

  // Two commands for D, right after one another. The first one's answer
  // shows rev 6, the state after event 11. Its position header is read a
  // moment later, after the second command published events 12 (D, rev 7)
  // and 13: it says 13.
  assert.equal(view(6, 13).action, "apply");
  // The stream delivers event 12. It stands before the position the answer
  // claimed, and it is the newer copy.
  assert.deepEqual(view(7, 12), { action: "apply", reason: "current" });
  assert.equal(fence.revs.get("device:D"), 7);
  // What really is older is dropped, wherever it says it stands.
  assert.equal(view(6, 40).reason, "not_newer");
  assert.equal(view(7, 41).reason, "not_newer", "the same copy again");

  // An answer that names an earlier position than it has (the header was
  // read before the handler ran): rev 9, built after event 20, claims 14.
  assert.equal(view(9, 14).action, "apply");
  // A snapshot that was taken at 18 lists rev 8. It stands "after" the copy
  // on screen and is older: not taken.
  const reload = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: EPOCH, seq: 18, devices: ["D"], incarnations: 1 },
    { generation: reload },
  );
  assert.deepEqual(view(8, 18, true), { action: "drop", reason: "not_newer" });
  // The same rev from a snapshot is the same copy: taken, nothing changes.
  assert.equal(view(9, 18, true).action, "apply");
  assert.equal(view(10, 18, true).action, "apply");
  assert.equal(fence.revs.get("device:D"), 10);
});

test("R4-4: what is over is over by its name. A removal names the incarnation that left: it does not remove the device that came back, and no view of the one that left is taken again, whatever position it claims. A snapshot says how far the counter had come: an incarnation it counted and did not list is over, one it did not count stays", () => {
  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: EPOCH, seq: 10, devices: ["D", "B"], incarnations: 2 },
    { generation: stream },
  );
  /**
   * @param {string} key
   * @param {number} incarnation
   * @param {number} rev
   * @param {number} seq
   * @param {boolean} [snapshot]
   */
  const view = (key, incarnation, rev, seq, snapshot) =>
    decideView(fence, { key, epoch: EPOCH, rev, seq, incarnation, snapshot });
  assert.equal(view("device:D", 1, 20, 10, true).action, "apply");
  assert.equal(view("device:B", 2, 3, 10, true).action, "apply");

  // D is removed (event 20) and comes back as incarnation 3 (event 21).
  // The answer of a write to the new D arrives before the stream has
  // delivered either event.
  assert.equal(view("device:D", 3, 2, 22).reason, "new_incarnation");
  // Now the removal arrives. It names incarnation 1: the page holds 3.
  decideEvent(fence, { epoch: EPOCH, seq: 20, stream });
  assert.deepEqual(forgetDevice(fence, "D", 20, 1), []);
  assert.equal(fence.revs.get("device:D"), 2, "the new device is untouched");
  assert.equal(fence.ended.get("D"), 1);
  // The late answer of a write to the first D says it stands at 99.
  assert.deepEqual(view("device:D", 1, 21, 99), {
    action: "drop",
    reason: "removed",
  });
  // Event 21 brings the new device at rev 1: older than the copy on screen.
  decideEvent(fence, { epoch: EPOCH, seq: 21, stream });
  assert.equal(view("device:D", 3, 1, 21).reason, "not_newer");

  // The removal of the device the page holds forgets all of it.
  assert.equal(view("settings:D/clock", 3, 1, 23).action, "apply");
  decideEvent(fence, { epoch: EPOCH, seq: 30, stream });
  assert.deepEqual(forgetDevice(fence, "D", 30, 3).sort(), [
    "device:D",
    "settings:D/clock",
  ]);
  assert.equal(view("device:D", 3, 9, 99).reason, "removed");
  assert.equal(view("settings:D/clock", 3, 9, 99).reason, "removed");

  // The page is disconnected. B (incarnation 2) leaves; C enters as 4 and
  // E as 5; the answer of a write to E arrives, with a position from
  // before the snapshot that follows (it was read early); the page also
  // holds a late answer about B that names a position after that snapshot.
  assert.equal(view("device:B", 2, 4, 60).action, "apply");
  assert.equal(view("device:E", 5, 2, 31).action, "apply");
  const reload = openSource(fence, "stream");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: EPOCH, seq: 40, devices: ["C"], incarnations: 4 },
      { generation: reload },
    ),
    { action: "apply", reason: "current", keep: [], gone: ["B"] },
    "B was counted and is not listed: over, although its copy says 60. E was not counted: it entered after the snapshot, although its copy says 31",
  );
  assert.equal(view("device:C", 4, 1, 40, true).action, "apply");
  assert.deepEqual([...fence.revs.keys()].sort(), ["device:C", "device:E"]);
  assert.equal(fence.ended.get("B"), 2);
  assert.equal(view("device:B", 2, 5, 99).reason, "removed");
  // A device the page never held, of an incarnation the snapshot counted:
  // it was not listed, so it is over.
  assert.equal(view("device:Z", 2, 7, 99).reason, "removed");
  // One the snapshot did not count is news.
  assert.equal(view("device:N", 6, 1, 41).action, "apply");
  // …unless it says it stands before the snapshot: then it waits for the
  // stream, which brings it with its true position.
  assert.equal(view("device:M", 7, 1, 39).reason, "removed");
  assert.equal(view("device:M", 7, 1, 42).action, "apply");
});

test("R4-4: without names, where a copy stands decides. A snapshot does not put an older copy over an answer that stood after it; at one and the same position the rev decides; an equal rev at a later position is nothing new from an event and is taken from a snapshot; a removal leaves a view that stands after it", () => {
  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: EPOCH, seq: 10, devices: ["D"] },
    { generation: stream },
  );
  /** @param {number} rev @param {number} seq @param {boolean} [snapshot] */
  const view = (rev, seq, snapshot) =>
    decideView(fence, { key: "device:D", epoch: EPOCH, rev, seq, snapshot });
  assert.equal(view(5, 10, true).action, "apply");

  // The answer of a write stands at seq 35, ahead of the stream.
  assert.equal(view(7, 35).action, "apply");
  // The stream reconnects; its snapshot was taken at seq 30, with rev 6.
  const reload = openSource(fence, "stream");
  assert.equal(
    decideSnapshot(
      fence,
      { epoch: EPOCH, seq: 30, devices: ["D"] },
      { generation: reload },
    ).action,
    "apply",
  );
  assert.deepEqual(view(6, 30, true), {
    action: "drop",
    reason: "stands_before",
  });
  assert.deepEqual(
    [fence.revs.get("device:D"), fence.carried.get("device:D")],
    [7, 35],
  );

  // A snapshot at the very position of the answer: both were built after
  // event 35 and before event 36, so only the rev can tell which is newer.
  assert.equal(view(6, 35, true).reason, "not_newer");
  assert.equal(view(7, 35, true).action, "apply", "the same copy");
  assert.equal(view(8, 35, true).action, "apply");

  // Later positions, the same rev: an event brings nothing new; a snapshot
  // is the copy at its position.
  assert.equal(view(8, 40).reason, "not_newer");
  assert.equal(fence.carried.get("device:D"), 35);
  assert.equal(view(8, 41, true).action, "apply");
  assert.equal(fence.carried.get("device:D"), 41);
  // An event with a lower rev at a later position is not a snapshot: it is
  // not taken.
  assert.equal(view(3, 50).reason, "not_newer");

  // D leaves at 60 and comes back at 61. The answer of a write to the new
  // D (rev 2, at 62) arrives before the stream delivers the removal.
  // Without a name it is not news to the page: rev 2 after rev 8.
  assert.equal(view(2, 62).reason, "not_newer");
  // An answer of the new D with a higher rev than the old one's is taken.
  assert.equal(view(9, 70).action, "apply");
  // The removal arrives: it stands before that copy, and leaves it.
  decideEvent(fence, { epoch: EPOCH, seq: 60, stream: reload });
  assert.deepEqual(forgetDevice(fence, "D", 60), []);
  assert.equal(fence.revs.get("device:D"), 9);
  // The events of the new device that stand before the copy change nothing.
  assert.equal(view(1, 61).reason, "stands_before");
  // A removal that stands after the copy forgets it.
  decideEvent(fence, { epoch: EPOCH, seq: 80, stream: reload });
  assert.deepEqual(forgetDevice(fence, "D", 80), ["device:D"]);
});

test("R4-4 sibling: a snapshot that does not list a device removes everything the page holds of it, also when that is a settings state and no device view", () => {
  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: EPOCH, seq: 10, devices: [] },
    { generation: stream },
  );
  // D is added at seq 11. The answer of a settings request arrives; the
  // event with the device view is still on its way when the stream breaks.
  decideEvent(fence, { epoch: EPOCH, seq: 11, stream });
  assert.equal(
    decideView(fence, {
      key: "settings:D/clock",
      epoch: EPOCH,
      rev: 1,
      seq: 11,
      incarnation: 1,
    }).action,
    "apply",
  );
  assert.equal(deviceOf("settings:D/clock"), "D");

  // D is removed while the page is away. The snapshot does not list it.
  const reload = openSource(fence, "stream");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: EPOCH, seq: 30, devices: [] },
      { generation: reload },
    ),
    { action: "apply", reason: "current", keep: [], gone: ["D"] },
  );
  assert.equal(fence.revs.size, 0);
  assert.equal(fence.removed.get("D"), 30);
  // A settings state of a device the page never held, in an answer that
  // stands before the snapshot: the snapshot did not list that device.
  assert.equal(
    decideView(fence, {
      key: "settings:Z/clock",
      epoch: EPOCH,
      rev: 1,
      seq: 20,
    }).reason,
    "removed",
  );
  // A settings state that stands after the snapshot stays: the device was
  // added again after it.
  decideView(fence, {
    key: "settings:E/clock",
    epoch: EPOCH,
    rev: 1,
    seq: 44,
    incarnation: 2,
  });
  const again = openSource(fence, "stream");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: EPOCH, seq: 40, devices: [] },
      { generation: again },
    ).gone,
    [],
  );
  assert.equal(fence.revs.has("settings:E/clock"), true);
});

// ---------------------------------------------------------------------------
// The model: random walks of a page against pixdcon's live channel and API
// ---------------------------------------------------------------------------

// PIXDCON2_MODEL_WALKS and PIXDCON2_MODEL_FIRST_SEED change the size and the
// start of the run, for a longer soak by hand; the gate runs the default.
const WALKS = Number(process.env.PIXDCON2_MODEL_WALKS) || 400;
const FIRST_SEED = Number(process.env.PIXDCON2_MODEL_FIRST_SEED) || 1;
const STEPS = 150;
const NAMES = ["A", "B", "C"];

/** What a run of either kind must have met to count. */
const MUST_SEE = [
  "view:current",
  "view:not_newer",
  "view:removed",
  "view:no_snapshot",
  "snapshot:new_epoch",
  "snapshot:current",
  "snapshot:not_newer",
  "snapshot:superseded_source",
  "event:current",
  "event:not_newer",
  "event:superseded_source",
  "missed:removal",
  "missed:removal_and_return",
  "late:answer_of_a_device_that_is_gone",
  "late:answer_of_the_life_before",
  "ahead:answer_of_the_device_that_came_back_before_its_removal",
  "ahead:removal_left_the_device_that_came_back",
];
/** With names: the decisions by name, and the positions the answers made up. */
const MUST_SEE_NAMED = [
  "view:new_incarnation",
  "view:older_incarnation",
  "missed:removal_and_return_of_a_device_with_a_settings_state",
  "adversary:answer_names_a_later_position",
  "adversary:answer_names_an_earlier_position",
  "adversary:later_position_across_the_removal_of_its_device",
  "adversary:later_position_than_an_event_of_its_device",
  "census:counted_and_not_listed",
  "census:not_counted_and_kept",
];
/** Without names: the decisions by position. */
const MUST_SEE_UNNAMED = ["view:stands_before"];

/**
 * A small seeded generator (mulberry32): the same seed, the same walk.
 *
 * @param {number} seed
 * @returns {() => number} numbers in [0, 1)
 */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {{key: string, life: number, rev: number}} ModelView a DeviceView or SettingsState as the model needs it
 * @typedef {{kind: "snapshot", seq: number, counter: number, views: ModelView[]}} SnapshotItem counter: how far the incarnation counter had come
 * @typedef {SnapshotItem
 *   | {kind: "event", seq: number, type: "device"|"settings", view: ModelView}
 *   | {kind: "event", seq: number, type: "device-removed", name: string, life: number}
 *   | {kind: "event", seq: number, type: "ping"}} StreamItem
 */

/**
 * One random walk.
 *
 * The model of pixdcon: devices enter and leave the effective config; a
 * device that enters gets the next incarnation, from one counter, and
 * counts its revs from 1; every change is published as a live event the
 * moment it happens, with the next seq; a snapshot is the state at the seq
 * it names, with the counter as it stands.
 *
 * The page: one stream at a time. A stream delivers its snapshot, then its
 * events, in order. It breaks at any time: what it had not delivered may
 * still be handed over later, in its order, and what is published while no
 * stream is attached is never delivered. Answers of reads and writes, and
 * of bootstrap requests, arrive in any order and at any time, also after
 * the device they are about has left or come back.
 *
 * With names, every view says its incarnation, every removal the one that
 * left, every snapshot the counter, and settings states are part of the
 * walk. An answer then claims any position: where it stands, an earlier
 * one, or a later one up to pixdcon's position at the moment it arrives.
 * Without names nothing of that is said, an answer names the last event
 * published before it was built, and only what a snapshot carries is in
 * the walk (a settings state of a device that came back unseen cannot be
 * told from the new device's without a name).
 *
 * @param {number} seed
 * @param {boolean} named
 * @param {Map<string, number>} seen counts of what the walks met (MUST_SEE)
 * @returns {number} steps taken
 */
function walk(seed, named, seen) {
  const count = (/** @type {string} */ what) =>
    seen.set(what, (seen.get(what) ?? 0) + 1);
  const random = generator(seed);
  const pick = (/** @type {number} */ n) => Math.floor(random() * n);
  const chance = (/** @type {number} */ p) => random() < p;
  /** @type {string[]} */
  const trace = [];
  /** @type {(message: string) => never} */
  const fail = (message) => {
    throw new Error(
      `${message}\n  seed ${seed}${named ? "" : " (no names)"}, after ${trace.length} steps:\n  ${trace.slice(-(Number(process.env.PIXDCON2_MODEL_TRACE) || 25)).join("\n  ")}`,
    );
  };

  // --- pixdcon -------------------------------------------------------------
  let seq = 0;
  let incarnations = 0;
  /** The effective config: name → the device's life, its rev and the rev of its one settings state (0: none yet). @type {Map<string, {life: number, rev: number, settings: number}>} */
  const devices = new Map();
  /** Per name: where each of its lives ended. @type {Map<string, Array<{life: number, at: number}>>} */
  const endings = new Map();
  /** Per view key: where each of its revs was published. @type {Map<string, Array<{life: number, rev: number, at: number}>>} */
  const published = new Map();
  /** The stream pixdcon serves; null while the page has none. */
  let stream = /** @type {{generation: number, queue: StreamItem[]}|null} */ (
    null
  );
  /** What broken streams had not delivered, each in its order. @type {Array<{generation: number, item: StreamItem}>} */
  const lateItems = [];
  /** Answers on their way. claim: what position the answer will name. @type {Array<{view: ModelView, position: number, claim: "exact"|"early"|"late"}>} */
  const answers = [];
  /** Bootstrap answers on their way. @type {Array<{generation: number, item: SnapshotItem}>} */
  const bootstraps = [];

  /** @param {string} name @returns {ModelView} */
  const deviceView = (name) => {
    const device = /** @type {{life: number, rev: number}} */ (
      devices.get(name)
    );
    return { key: `device:${name}`, life: device.life, rev: device.rev };
  };
  /** @param {string} name @returns {ModelView} */
  const settingsView = (name) => {
    const device = /** @type {{life: number, settings: number}} */ (
      devices.get(name)
    );
    return {
      key: `settings:${name}/clock`,
      life: device.life,
      rev: device.settings,
    };
  };
  /** Publish a live event: it gets the next seq, and reaches the stream if there is one. @param {Record<string, any>} event */
  const publish = (event) => {
    seq += 1;
    if (event.view) {
      const { key, life, rev } = /** @type {ModelView} */ (event.view);
      if (!published.has(key)) published.set(key, []);
      published.get(key)?.push({ life, rev, at: seq });
    }
    stream?.queue.push(
      /** @type {StreamItem} */ ({ kind: "event", seq, ...event }),
    );
  };
  /** @returns {SnapshotItem} */
  const snapshot = () => ({
    kind: "snapshot",
    seq,
    counter: incarnations,
    views: [...devices.keys()].map(deviceView),
  });

  // --- the page ------------------------------------------------------------
  const fence = createClientFence();
  /** What the page shows: view key → the view. @type {Map<string, ModelView>} */
  const shown = new Map();
  /** Per device: the highest life the page has shown a view of. @type {Map<string, number>} */
  const highestLife = new Map();
  /** Per view key: the newest (life, rev) the page has shown. @type {Map<string, ModelView>} */
  const newest = new Map();
  /** Per device: the highest life the page was told is over, by a removal that named it or by a snapshot that counted it. @type {Map<string, number>} */
  const toldOver = new Map();

  /** @param {string} name */
  const dropDevice = (name) => {
    for (const key of [...shown.keys()])
      if (deviceOf(key) === name) shown.delete(key);
  };
  /**
   * @param {ModelView} view
   * @param {number} position the position its carrier names
   * @param {boolean} inSnapshot
   */
  const takeView = (view, position, inSnapshot) => {
    const name = deviceOf(view.key);
    const held = shown.get(`device:${name}`);
    const hadSettings = shown.has(`settings:${name}/clock`);
    const decision = decideView(fence, {
      key: view.key,
      epoch: EPOCH,
      rev: view.rev,
      seq: position,
      incarnation: named ? view.life : undefined,
      snapshot: inSnapshot,
    });
    count(`view:${decision.reason}`);
    if (decision.action !== "apply") return;
    if (decision.reason === "new_incarnation") dropDevice(name);
    if (inSnapshot && held && held.life < view.life) {
      count("missed:removal_and_return");
      if (hadSettings)
        count("missed:removal_and_return_of_a_device_with_a_settings_state");
    }
    if (!inSnapshot && held && held.life < view.life)
      count("ahead:answer_of_the_device_that_came_back_before_its_removal");
    shown.set(view.key, view);
  };
  /**
   * @param {SnapshotItem} item
   * @param {number} generation
   */
  const takeSnapshot = (item, generation) => {
    const listed = new Map(
      item.views.map((view) => [deviceOf(view.key), view.life]),
    );
    const decision = decideSnapshot(
      fence,
      {
        epoch: EPOCH,
        seq: item.seq,
        devices: [...listed.keys()],
        incarnations: named ? item.counter : undefined,
      },
      { generation },
    );
    count(`snapshot:${decision.reason}`);
    if (decision.action !== "apply") return;
    if (decision.reason === "new_epoch") shown.clear();
    if (named) {
      // Every life the snapshot counted and did not list is over.
      for (const name of NAMES)
        toldOver.set(
          name,
          Math.max(
            toldOver.get(name) ?? 0,
            listed.has(name)
              ? /** @type {number} */ (listed.get(name)) - 1
              : item.counter,
          ),
        );
      for (const [key, view] of shown) {
        const name = deviceOf(key);
        if (listed.has(name)) continue;
        count(
          view.life <= item.counter
            ? "census:counted_and_not_listed"
            : "census:not_counted_and_kept",
        );
      }
    }
    for (const name of decision.gone) {
      count("missed:removal");
      dropDevice(name);
    }
    for (const view of item.views) takeView(view, item.seq, true);
  };
  /**
   * @param {StreamItem} item
   * @param {number} generation
   */
  const takeItem = (item, generation) => {
    if (item.kind === "snapshot") return takeSnapshot(item, generation);
    const decision = decideEvent(fence, {
      epoch: EPOCH,
      seq: item.seq,
      stream: generation,
    });
    count(`event:${decision.reason}`);
    if (decision.action !== "apply") return;
    if (item.type === "device-removed") {
      // The page removes exactly what the fence forgot: a view of the
      // device that came back stays.
      const before = [...shown.keys()].filter(
        (key) => deviceOf(key) === item.name,
      );
      const forgotten = forgetDevice(
        fence,
        item.name,
        item.seq,
        named ? item.life : undefined,
      );
      for (const key of forgotten) shown.delete(key);
      if (before.length > forgotten.length)
        count("ahead:removal_left_the_device_that_came_back");
      if (named)
        toldOver.set(
          item.name,
          Math.max(toldOver.get(item.name) ?? 0, item.life),
        );
    } else if (item.type !== "ping") takeView(item.view, item.seq, false);
  };

  /** What must hold after every step. */
  const check = () => {
    if (
      shown.size !== fence.revs.size ||
      [...shown].some(([key, view]) => fence.revs.get(key) !== view.rev)
    )
      fail("the page and its fence hold different views");
    for (const [key, view] of shown) {
      const name = deviceOf(key);
      // The page never shows a view of an older life of a device than one
      // it has shown before.
      const highest = highestLife.get(name) ?? 0;
      if (view.life < highest)
        fail(
          `${key}: the page shows life ${view.life} after it has shown life ${highest} of ${name}`,
        );
      highestLife.set(name, view.life);
      // …and never goes back to an older copy of a view.
      const best = newest.get(key);
      if (
        best &&
        (view.life < best.life ||
          (view.life === best.life && view.rev < best.rev))
      )
        fail(
          `${key}: the page went back to life ${view.life} rev ${view.rev} after life ${best.life} rev ${best.rev}`,
        );
      newest.set(key, view);
      if (!named) continue;
      // One life at a time: what the page shows of a device is of one life.
      const device = shown.get(`device:${name}`);
      if (device && device.life !== view.life)
        fail(
          `${key}: life ${view.life} is shown beside the device's life ${device.life}`,
        );
      // Nothing is shown of a life the page was told is over.
      if (view.life <= (toldOver.get(name) ?? 0))
        fail(
          `${key}: the page shows life ${view.life}; it was told that life ${toldOver.get(name)} of ${name} is over`,
        );
    }
  };

  const actions = {
    change() {
      const name = NAMES[pick(NAMES.length)];
      const device = devices.get(name);
      if (!device) return;
      device.rev += 1;
      trace.push(`${name}: rev ${device.rev}`);
      publish({ type: "device", view: deviceView(name) });
    },
    settings() {
      if (!named) return;
      const name = NAMES[pick(NAMES.length)];
      const device = devices.get(name);
      if (!device) return;
      device.settings += 1;
      trace.push(`${name}: settings rev ${device.settings}`);
      publish({ type: "settings", view: settingsView(name) });
    },
    /** @param {string} [name] */
    remove(name = NAMES[pick(NAMES.length)]) {
      const device = devices.get(name);
      if (!device) return;
      devices.delete(name);
      trace.push(`${name} leaves (incarnation ${device.life})`);
      publish({ type: "device-removed", name, life: device.life });
      if (!endings.has(name)) endings.set(name, []);
      endings.get(name)?.push({ life: device.life, at: seq });
    },
    /** @param {string} [name] */
    add(name = NAMES[pick(NAMES.length)]) {
      if (devices.has(name)) return;
      devices.set(name, { life: ++incarnations, rev: 1, settings: 0 });
      trace.push(`${name} enters as incarnation ${incarnations}`);
      publish({ type: "device", view: deviceView(name) });
    },
    replace() {
      // A device leaves and one of the same name enters at once (an edit of
      // config.json that changes its type), is changed a few times, and the
      // answer of a write to it is on its way: it can arrive before the
      // stream has delivered the removal.
      const name = NAMES[pick(NAMES.length)];
      if (!devices.has(name)) return;
      actions.remove(name);
      actions.add(name);
      const device = /** @type {{rev: number}} */ (devices.get(name));
      for (let changes = pick(8); changes > 0; changes--) {
        device.rev += 1;
        publish({ type: "device", view: deviceView(name) });
      }
      const view = deviceView(name);
      trace.push(
        `answer on its way: ${view.key} life ${view.life} rev ${view.rev} at ${seq}`,
      );
      answers.push({ view, position: seq, claim: "exact" });
      if (chance(0.6)) actions.answer(answers.length - 1);
    },
    ping() {
      publish({ type: "ping" });
    },
    ask() {
      // A read, or a write: the write changes the device first, and its
      // event is published before the answer is built.
      const name = NAMES[pick(NAMES.length)];
      const device = devices.get(name);
      if (!device) return;
      const settings = named && chance(0.3);
      if (chance(0.6)) {
        if (settings) device.settings += 1;
        else device.rev += 1;
        publish(
          settings
            ? { type: "settings", view: settingsView(name) }
            : { type: "device", view: deviceView(name) },
        );
      }
      if (settings && device.settings === 0) return;
      const view = settings ? settingsView(name) : deviceView(name);
      const roll = random();
      /** @type {"exact"|"early"|"late"} */
      const claim =
        !named || roll < 0.4 ? "exact" : roll < 0.6 ? "early" : "late";
      trace.push(
        `answer on its way: ${view.key} life ${view.life} rev ${view.rev} at ${seq}`,
      );
      answers.push({ view, position: seq, claim });
    },
    /** @param {number} [index] which of the answers on their way; default: any */
    answer(index = pick(answers.length)) {
      if (answers.length === 0) return;
      const [{ view, position, claim }] = answers.splice(index, 1);
      const name = deviceOf(view.key);
      const now = devices.get(name);
      if (!now) count("late:answer_of_a_device_that_is_gone");
      else if (now.life !== view.life) count("late:answer_of_the_life_before");
      // The position the answer names.
      const claimed =
        claim === "late"
          ? position + pick(seq - position + 1)
          : claim === "early"
            ? pick(position + 1)
            : position;
      if (claimed > position) {
        count("adversary:answer_names_a_later_position");
        if (
          endings
            .get(name)
            ?.some(({ life, at }) => life === view.life && at <= claimed)
        )
          count("adversary:later_position_across_the_removal_of_its_device");
        if (
          published
            .get(view.key)
            ?.some(
              ({ life, rev, at }) =>
                life === view.life && rev > view.rev && at < claimed,
            )
        )
          count("adversary:later_position_than_an_event_of_its_device");
      }
      if (claimed < position)
        count("adversary:answer_names_an_earlier_position");
      trace.push(
        `answer: ${view.key} life ${view.life} rev ${view.rev}, built at ${position}, says ${claimed}`,
      );
      takeView(view, claimed, false);
    },
    connect() {
      // A new stream, also when one is open: the page reloads its stream.
      actions.disconnect();
      const generation = openSource(fence, "stream");
      stream = { generation, queue: [snapshot()] };
      trace.push(`stream ${generation}: snapshot at ${seq}`);
    },
    disconnect() {
      if (!stream) return;
      const { generation, queue } = stream;
      // Some of what it had not delivered is still handed over later.
      lateItems.push(
        ...queue
          .slice(0, pick(queue.length + 1))
          .map((item) => ({ generation, item })),
      );
      stream = null;
      trace.push(`stream ${generation} breaks`);
    },
    deliver() {
      const item = stream?.queue.shift();
      if (!stream || !item) return;
      trace.push(
        `stream ${stream.generation}: ${item.kind === "snapshot" ? "snapshot" : item.type} at ${item.seq}`,
      );
      takeItem(item, stream.generation);
    },
    late() {
      // In the order of its stream, as a connection hands things over.
      const next = lateItems.shift();
      if (!next) return;
      const { generation, item } = next;
      trace.push(
        `late, of stream ${generation}: ${item.kind === "snapshot" ? "snapshot" : item.type} at ${item.seq}`,
      );
      takeItem(item, generation);
    },
    bootstrap() {
      const generation = openSource(fence, "bootstrap");
      bootstraps.push({ generation, item: snapshot() });
      trace.push(`bootstrap ${generation}: snapshot at ${seq} on its way`);
    },
    bootstrapAnswer() {
      if (bootstraps.length === 0) return;
      const [{ generation, item }] = bootstraps.splice(
        pick(bootstraps.length),
        1,
      );
      trace.push(`bootstrap ${generation}: snapshot at ${item.seq} arrives`);
      takeSnapshot(item, generation);
    },
  };

  /** @type {Array<[keyof typeof actions, number]>} */
  const weights = [
    ["change", 12],
    ["settings", 4],
    ["remove", 4],
    ["add", 7],
    ["replace", 2],
    ["ping", 3],
    ["ask", 12],
    ["answer", 10],
    ["connect", 6],
    ["disconnect", 3],
    ["deliver", 30],
    ["late", 4],
    ["bootstrap", 3],
    ["bootstrapAnswer", 4],
  ];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (let step = 0; step < STEPS; step++) {
    let roll = random() * total;
    for (const [name, weight] of weights) {
      roll -= weight;
      if (roll < 0) {
        actions[name]();
        break;
      }
    }
    check();
  }

  // --- the end of the walk: a new stream, and everything arrives -----------
  trace.push("— quiesce —");
  actions.connect();
  for (;;) {
    /** @type {Array<keyof typeof actions>} */
    const waiting = [];
    if ((stream?.queue.length ?? 0) > 0) waiting.push("deliver");
    if (answers.length > 0) waiting.push("answer");
    if (lateItems.length > 0) waiting.push("late");
    if (bootstraps.length > 0) waiting.push("bootstrapAnswer");
    if (waiting.length === 0) break;
    actions[waiting[pick(waiting.length)]]();
    check();
  }

  // The page holds exactly what pixdcon holds: every device at its life and
  // rev, and nothing of a device that is not there.
  for (const [name, device] of devices) {
    const view = shown.get(`device:${name}`);
    if (!view || view.life !== device.life || view.rev !== device.rev)
      fail(
        `${name}: pixdcon holds life ${device.life} rev ${device.rev}, the page ${view ? `life ${view.life} rev ${view.rev}` : "nothing"}`,
      );
  }
  for (const [key, view] of shown) {
    const device = devices.get(deviceOf(key));
    if (!device)
      fail(`${key}: the page shows a view of a device that is not there`);
    else if (view.life !== device.life)
      fail(
        `${key}: the page shows life ${view.life}, the device is life ${device.life}`,
      );
    // A settings state is not part of a snapshot: the page may hold an
    // older one, never one of another life and never a newer one.
    else if (key.startsWith("settings:") && view.rev > device.settings)
      fail(`${key}: the page shows rev ${view.rev} of ${device.settings}`);
  }
  return trace.length;
}

for (const named of [true, false]) {
  test(`R4-4 client model, ${named ? "with names (every view says its incarnation, every removal the one that left, every snapshot the counter; an answer claims any position)" : "without names (an answer says where it stands)"}: ${WALKS} random walks of up to ${STEPS} steps of a page against pixdcon's live channel and API, with devices that leave and come back, streams that break and miss events, and answers and snapshots that arrive late and in any order; the page never shows an older life of a device than before, never goes back to an older copy, shows nothing of a life it was told is over, and with the newest snapshot and everything after it delivered it holds exactly what pixdcon holds`, () => {
    /** @type {Map<string, number>} */
    const seen = new Map();
    let steps = 0;
    for (let seed = FIRST_SEED; seed < FIRST_SEED + WALKS; seed++)
      steps += walk(seed, named, seen);
    assert.ok(steps > WALKS * 40, `the walks really walked (${steps} steps)`);
    const expected = [
      ...MUST_SEE,
      ...(named ? MUST_SEE_NAMED : MUST_SEE_UNNAMED),
    ];
    // A short run by hand (a single seed to replay) cannot meet everything.
    if (WALKS >= 400)
      assert.deepEqual(
        expected.filter((what) => !seen.has(what)),
        [],
        "every decision and every late, missed or made-up order was met at least once",
      );
    assert.deepEqual(
      [...seen.keys()].filter((what) => !expected.includes(what)).sort(),
      [],
      "nothing was met that this test does not know about",
    );
    if (process.env.PIXDCON2_MODEL_STATS)
      console.log(`${steps} steps`, Object.fromEntries([...seen].sort()));
  });
}
