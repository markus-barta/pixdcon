/**
 * Test kind 2 of 3 (API and MQTT contract): the ordering rule.
 *
 * One rule for every asynchronous input (src/core/ordering.js): it carries
 * the identity of its source and its position, it gets one decision (apply,
 * hold or drop), and nothing acts outward without authoritative evidence.
 * The fences that carry the rule are pure functions, so the interleavings
 * that the cross-reads found by reading are run here instead: each test
 * feeds the inputs in the order that used to go wrong and checks what the
 * display would show, what is saved and what is published.
 *
 * F1, F2, F3 … name the findings of the second cross-read (knowledge entry,
 * section "Cross-read round 2"). ordering-model.test.js runs the scene
 * layers against a model of a broker with thousands of random interleavings.
 *
 * Owner: core/state worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { changeImpact } from "../../src/config/schema.js";
import {
  EVIDENCE,
  OUTWARD_EFFECTS,
  createLane,
  decideStamp,
  mayCause,
  whileCurrent,
} from "../../src/core/ordering.js";
import {
  BLOB_IN_FLIGHT,
  OWN_SCENES,
  WRITE_MARK,
  blobScenes,
  blobView,
  changedDevices,
  layersView,
  ownWriteOf,
  planChoice,
  savedSuppressions,
  sceneInputs,
  withoutMark,
} from "../../src/overlay/scene-layers.js";
import {
  fenceTopic,
  forgetOwnWrites,
  newTopicRecord,
  ownWrite,
  ownWriteFailed,
} from "../../src/overlay/topic-fence.js";
import {
  isSuperseded,
  resolveOutput,
  resolveScene,
} from "../../src/state/precedence.js";
import {
  diffEffectiveConfig,
  overlayDevicePatch,
} from "../../src/state/runtime-config.js";
import {
  V1Ownership,
  createOwnershipFeed,
  ownerOf,
  reduceOwnership,
} from "../../src/state/v1-ownership.js";
import { createTopics } from "../../src/mqtt/topics.js";
import { T0, world } from "./scene-world.js";
import {
  beginRequest,
  createClientFence,
  decideAnswer,
  decideEvent,
  decideSnapshot,
  decideView,
  deviceOf,
  forgetDevice,
  openSource,
  parsePosition,
} from "../../web/js/ordering.js";

const RETIRING = ["retire"];
const PUBLISHING = ["publish-clear", "publish-blob"];

/**
 * The document of a blob payload: what it says, without the mark every
 * rewrite of pixdcon carries (scene-layers.js O1).
 *
 * @param {string} payload
 */
const documentOf = (payload) => withoutMark(JSON.parse(payload));

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test("ordering: an input of another source instance, or one that is not newer, is dropped; a current one is applied", () => {
  assert.deepEqual(
    decideStamp({ source: 3, position: 10 }, { source: 3, position: 11 }),
    {
      action: "apply",
      reason: "current",
    },
  );
  assert.equal(
    decideStamp({ source: 3, position: 10 }, { source: 3, position: 10 })
      .reason,
    "not_newer",
  );
  assert.equal(
    decideStamp({ source: 3, position: 10 }, { source: 2, position: 99 })
      .reason,
    "superseded_source",
    "a higher position of an older source says nothing",
  );
  assert.equal(
    decideStamp(
      { source: "a1b2c3d4", position: 5 },
      { source: "ffffffff", position: 6 },
    ).reason,
    "superseded_source",
    "epochs are identities, not numbers",
  );
  assert.equal(
    decideStamp({ source: null }, { source: 1, position: 1 }).reason,
    "no_current_source",
    "a source is adopted by its own step, never by an input that claims it",
  );
  assert.equal(
    decideStamp({ source: 7 }, { source: 7 }).action,
    "apply",
    "a token alone is a fence",
  );
});

test("ordering: only authoritative evidence may cause an outward effect; a hint, a timer, a connect and the absence of a message never may", () => {
  const authoritative = [
    "message",
    "ack",
    "config",
    "environment",
    "command",
    "measurement",
  ];
  const not = ["hint", "timer", "connection", "absence"];
  assert.deepEqual(
    Object.keys(EVIDENCE).sort(),
    [...authoritative, ...not].sort(),
  );
  assert.deepEqual(
    [...OUTWARD_EFFECTS],
    ["drive", "release", "retire", "narrow", "publish"],
  );
  for (const effect of OUTWARD_EFFECTS) {
    for (const kind of authoritative)
      assert.equal(
        mayCause(effect, /** @type {any} */ (kind)),
        true,
        `${kind} may ${effect}`,
      );
    for (const kind of not)
      assert.equal(
        mayCause(effect, /** @type {any} */ (kind)),
        false,
        `${kind} may not ${effect}`,
      );
  }
  // The one exception, named in the rule: a timer repeats a publish that
  // evidence authorised. It repeats nothing else, and nothing a hint began.
  assert.equal(mayCause("publish", "timer", { repeatOf: "message" }), true);
  assert.equal(mayCause("publish", "timer", { repeatOf: "hint" }), false);
  assert.equal(mayCause("retire", "timer", { repeatOf: "message" }), false);
  assert.equal(mayCause("release", "timer", { repeatOf: "config" }), false);
  assert.equal(mayCause("drive", "timer", { repeatOf: "command" }), false);
});

test("ordering: a late call of something that was replaced reports into nothing", () => {
  /** @type {string[]} */
  const calls = [];
  const health = {
    /** @param {string} device */
    frameOk: (device) => calls.push(`frame ${device}`),
    /** @param {string} device */
    renderFailed: (device) => calls.push(`failed ${device}`),
    other: () => calls.push("other"),
  };
  let current = 1;
  const first = whileCurrent(() => current === 1, health, [
    "frameOk",
    "renderFailed",
  ]);
  first.frameOk("pixoo-t");
  current = 2; // the device runtime was rebuilt
  first.frameOk("pixoo-t");
  first.renderFailed("pixoo-t");
  assert.deepEqual(
    calls,
    ["frame pixoo-t"],
    "the replaced runtime's late frame is not a good frame",
  );
  assert.equal(
    "other" in first,
    false,
    "only the listed methods are handed out",
  );
});

// ---------------------------------------------------------------------------
// F1: a retained blob held past the settle hint
// ---------------------------------------------------------------------------

for (const output of /** @type {const} */ (["shadow", "drive"])) {
  test(`F1 reconnect, device in ${output}: a blob that is held past the settle hint keeps its place; no suppression is retired, nothing is published on the hint, the choice B still wins`, () => {
    const w = world({ outputs: { D: output }, choices: { D: "saved" } });
    w.connect(1);
    w.blob(
      { devices: [{ name: "D", scene: "A" }] },
      { retain: true, connection: 1 },
    );
    assert.equal(w.shows("D"), "A (blob)");

    w.choose("D", "B");
    assert.equal(w.shows("D"), "B (config)");
    assert.equal(w.saved.get("D/blob")?.value, "A");
    assert.equal(w.saved.get("D/blob")?.output, output);

    // The connection drops before anything was confirmed. On the new one
    // the broker holds the blob back past the settle hint.
    w.disconnect(1);
    let mark = w.effects.length;
    w.connect(2);
    w.settle(2);
    w.feed({ type: "tick" });
    assert.deepEqual(
      w.since(mark, ...RETIRING, ...PUBLISHING),
      [],
      "a connect, the hint and a tick cause nothing",
    );
    assert.equal(w.saved.size, 2, "both suppressions are still saved");
    assert.equal(w.state().outputs.get("D"), output, "the output did not move");
    const held = sceneInputs(w.state(), "D").blob;
    assert.deepEqual(
      held && {
        scene: held.scene,
        inEffect: held.inEffect,
        connection: held.connection,
      },
      { scene: "A", inEffect: false, connection: 1 },
      "the blob of the earlier connection is still there, replaced by the choice",
    );
    assert.equal(w.shows("D"), "B (config)");

    // The held blob arrives. It is the value the choice replaced.
    mark = w.effects.length;
    const late = w.blob(
      { devices: [{ name: "D", scene: "A" }] },
      { retain: true, connection: 2 },
    );
    assert.equal(late.decision.action, "apply");
    assert.equal(
      w.shows("D"),
      "B (config)",
      "the late blob does not beat the choice",
    );
    assert.deepEqual(w.since(mark, ...RETIRING), []);
    if (output === "shadow") {
      assert.deepEqual(
        w.since(mark, ...PUBLISHING),
        [],
        "a device in shadow never writes to the broker",
      );
    } else {
      const [rewrite] = w.since(mark, "publish-blob");
      assert.equal(
        rewrite.evidence,
        "message",
        "the delivered stale blob is the evidence for the rewrite",
      );
      assert.deepEqual(documentOf(/** @type {any} */ (rewrite).payload), {
        devices: [{ name: "D" }],
      });
    }
  });

  test(`F1 restart, device in ${output}: with the blob held past the settle hint the saved suppressions stay, and the choice B still wins when the blob arrives`, () => {
    const w = world({ outputs: { D: output }, choices: { D: "saved" } });
    w.connect(1);
    w.blob(
      { devices: [{ name: "D", scene: "A" }] },
      { retain: true, connection: 1 },
    );
    w.choose("D", "B");

    w.restart(); // a new process: config.json only
    const mark = w.effects.length;
    w.connect(1);
    w.settle(1);
    w.feed({ type: "tick" });
    assert.deepEqual(w.since(mark, ...RETIRING, ...PUBLISHING), []);
    assert.deepEqual(
      savedSuppressions(w.state()).map(({ layer, suppression }) => [
        layer,
        suppression.value,
      ]),
      [
        ["granular", null],
        ["blob", "A"],
      ],
      "S5: the suppressions of config.json are in place before the first message",
    );
    assert.equal(w.state().outputs.get("D"), output);
    assert.equal(w.shows("D"), "B (config)");

    w.blob(
      { devices: [{ name: "D", scene: "A" }] },
      { retain: true, connection: 1 },
    );
    assert.equal(w.shows("D"), "B (config)");
    assert.equal(
      w.saved.has("D/blob"),
      true,
      "still saved: the rewrite is not confirmed",
    );
  });
}

test("F1: an overlay cannot supply the output. A blob entry that asks for shadow, or for drive, changes nothing; the output is what config.json, the environment and v1's list say", () => {
  const { patch, ignored } = overlayDevicePatch({
    name: "D",
    output: "shadow",
    supersedes: { granular: {} },
    enabled: true,
    scene: "A",
    scenes: ["A"],
    ip: "127.0.0.1:1",
    minFrameMs: 250,
  });
  assert.deepEqual(patch, { ip: "127.0.0.1:1", minFrameMs: 250 });
  assert.deepEqual(ignored, ["output", "supersedes", "enabled"]);
  assert.deepEqual(
    overlayDevicePatch({ name: "D", enabled: false }).patch,
    { enabled: false },
    "an overlay can switch a device off",
  );
  assert.deepEqual(overlayDevicePatch({ name: "D", enabled: "false" }).patch, {
    enabled: false,
  });

  // The policy has no overlay input at all: these are all of its inputs.
  const inputs = {
    forceShadow: false,
    deviceOutput: null,
    configDefault: null,
    envDefault: /** @type {const} */ ("drive"),
    transition: false,
    owner: /** @type {const} */ ("free"),
  };
  assert.equal(resolveOutput(inputs).mode, "drive");
  assert.equal(
    resolveOutput({ ...inputs, deviceOutput: "shadow" }).reason,
    "config",
  );
});

test("F1: a choice made in shadow is dropped only by an authoritative change to drive, and then the stored overlay shows (rule 18)", () => {
  const w = world({ outputs: { D: "shadow" }, choices: { D: "saved" } });
  w.connect(1);
  w.granular("D", "A", { retain: true, connection: 1 });
  w.choose("D", "B");
  assert.equal(w.shows("D"), "B (config)");

  // Everything that is not evidence, and evidence about something else.
  const mark = w.effects.length;
  w.settle(1);
  w.feed({ type: "tick" });
  w.disconnect(1);
  w.connect(2);
  w.settle(2);
  w.granular("D", "A", { retain: true, connection: 2 });
  w.feed({ type: "output", device: "other", output: "drive" });
  assert.deepEqual(w.since(mark, ...RETIRING, ...PUBLISHING), []);
  assert.equal(w.shows("D"), "B (config)");

  // config.json now asks for drive (or v1 released the device).
  w.feed({ type: "output", device: "D", output: "drive" });
  const retired = w.since(mark, "retire");
  assert.deepEqual(
    retired.map((effect) => [
      /** @type {any} */ (effect).layer,
      /** @type {any} */ (effect).ended,
      effect.evidence,
    ]),
    [
      ["granular", "dropped", "config"],
      ["blob", "dropped", "config"],
    ],
  );
  assert.deepEqual(
    w.since(mark, ...PUBLISHING),
    [],
    "a choice made in shadow never deletes anything, not even later",
  );
  assert.equal(w.shows("D"), "A (overlay)");
});

test("F1 sibling: an overlay that holds a device back survives a reconnect. A record changes only when a message for its topic is delivered; the fence has no input for a hint", () => {
  // <base>/overlay/device/D/enabled = false, delivered on connection 1.
  let enabled = fenceTopic(
    newTopicRecord(),
    { payload: "false", retain: true, connection: 1 },
    1,
  ).record;
  assert.equal(enabled.value, "false");

  // Reconnect; the broker holds the replay back past the settle hint.
  // Nothing calls the fence, so nothing changes: the device stays off.
  enabled = forgetOwnWrites(enabled);
  assert.deepEqual(
    { value: enabled.value, delivered: enabled.delivered },
    { value: "false", delivered: 1 },
    "still held back; delivered on connection 1, the current one is 2",
  );
  assert.equal(
    fenceTopic.length,
    3,
    "inputs: the record, a delivered message, the current connection",
  );

  // A message of the old connection that is processed late is dropped.
  assert.equal(
    fenceTopic(enabled, { payload: "", retain: false, connection: 1 }, 2)
      .decision.reason,
    "superseded_source",
  );

  // The held replay arrives: confirmed on the new connection.
  enabled = fenceTopic(
    enabled,
    { payload: "false", retain: true, connection: 2 },
    2,
  ).record;
  assert.equal(enabled.delivered, 2);

  // Only a delivered clear releases the device.
  const cleared = fenceTopic(
    enabled,
    { payload: "", retain: false, connection: 2 },
    2,
  );
  assert.deepEqual([cleared.record.value, cleared.changed], [null, true]);
});

// ---------------------------------------------------------------------------
// F2: an own rewrite that echoes back after an outside change
// ---------------------------------------------------------------------------

/** The F2 sequence up to the delayed own echo. */
function f2() {
  const w = world({
    outputs: { D1: "drive", D2: "drive" },
    choices: { D1: "c1", D2: "c2" },
  });
  w.connect(1);
  w.blob(
    {
      devices: [
        { name: "D1", scene: "X" },
        { name: "D2", scene: "A" },
      ],
    },
    { retain: true, connection: 1 },
  );
  assert.equal(w.shows("D2"), "A (blob)");

  // Choice on D1: rewrite P1 strips D1's scene and still carries D2 = A.
  const first = w.choose("D1", "K");
  const p1 = /** @type {any} */ (
    first.effects.find((effect) => effect.type === "publish-blob")
  );
  assert.deepEqual(documentOf(p1.payload), {
    devices: [{ name: "D1" }, { name: "D2", scene: "A" }],
  });
  assert.deepEqual(p1.generations, [{ device: "D1", generation: 1 }]);

  // Before P1 echoes back, an outside client changes D2 to B.
  const outside = w.blob(
    { devices: [{ name: "D1" }, { name: "D2", scene: "B" }] },
    { retain: false, connection: 1 },
  );
  assert.equal(
    outside.decision.reason,
    "before_own_write",
    "processed by the broker before P1",
  );
  assert.equal(w.shows("D2"), "B (blob)");

  // The user chooses C for D2.
  const second = w.choose("D2", "C");
  assert.deepEqual(
    w.saved.get("D2/blob"),
    { generation: 1, at: T0, value: "B", alsoStale: ["A"], output: "drive" },
    "saved with the choice: B is what it replaced, A is what the own rewrite on its way can put back",
  );
  const p2 = /** @type {any} */ (
    second.effects.find((effect) => effect.type === "publish-blob")
  );
  assert.deepEqual(documentOf(p2.payload), {
    devices: [{ name: "D1" }, { name: "D2" }],
  });
  assert.equal(w.shows("D2"), "C (config)");
  return { w, p1, p2 };
}

test("F2: the delayed echo of an older own rewrite, which still carries D2 = A, does not replace the newer blob; the choice C on D2 holds", () => {
  const { w, p1, p2 } = f2();

  const mark = w.effects.length;
  const echo = w.blob(p1.payload, { retain: false, connection: 1 });
  assert.deepEqual(echo.decision, { action: "drop", reason: "older_own_echo" });
  assert.equal(w.shows("D2"), "C (config)", "A is not shown");
  assert.equal(w.shows("D1"), "K (config)");
  assert.deepEqual(
    w.since(mark, ...PUBLISHING),
    [],
    "P2 is on its way already; nothing else is sent",
  );
  assert.equal(w.saved.has("D2/blob"), true);
  assert.equal(
    w.saved.has("D1/blob"),
    false,
    "P1's echo is the evidence that D1's scene is gone from the store",
  );

  // P2 lands: the store is the blob as it should be.
  const done = w.blob(p2.payload, { retain: false, connection: 1 });
  assert.equal(done.decision.reason, "own_echo");
  assert.equal(
    w.saved.has("D2/blob"),
    false,
    "confirmed by the echo of its generation",
  );
  assert.equal(sceneInputs(w.state(), "D2").blob, null);
  assert.equal(w.shows("D2"), "C (config)");
});

test("F2 reconnect: P2 never reached the broker, so the store holds P1 with D2 = A. Its replay is recognised as pixdcon's own older write, not as a new command", () => {
  const { w, p1 } = f2();
  w.blob(p1.payload, { retain: false, connection: 1 });
  w.disconnect(1);
  w.connect(2);
  w.settle(2);
  assert.equal(w.shows("D2"), "C (config)");

  const mark = w.effects.length;
  w.blob(p1.payload, { retain: true, connection: 2 });
  assert.deepEqual(
    w.since(mark, ...RETIRING),
    [],
    "A is in alsoStale: the suppression stays",
  );
  assert.equal(w.shows("D2"), "C (config)");
  const [rewrite] = w.since(mark, "publish-blob");
  assert.equal(rewrite.evidence, "message");
  assert.deepEqual(documentOf(/** @type {any} */ (rewrite).payload), {
    devices: [{ name: "D1" }, { name: "D2" }],
  });
});

test("F2 restart: the saved suppression knows A as well as B. A replay of A stays superseded; a replay of a value pixdcon never wrote is a new command", () => {
  for (const [stored, expected, retired] of /** @type {const} */ ([
    ["A", "C (config)", false],
    ["B", "C (config)", false],
    ["Z", "Z (blob)", true],
  ])) {
    const { w, p1 } = f2();
    w.blob(p1.payload, { retain: false, connection: 1 });
    w.restart();
    w.connect(1);
    w.settle(1);
    const mark = w.effects.length;
    w.blob(
      { devices: [{ name: "D1" }, { name: "D2", scene: stored }] },
      { retain: true, connection: 1 },
    );
    assert.equal(w.shows("D2"), expected, `replay of ${stored}`);
    const ended = w
      .since(mark, "retire")
      .map((effect) => /** @type {any} */ (effect).ended);
    assert.deepEqual(
      ended,
      retired ? ["stored_while_away"] : [],
      `replay of ${stored}`,
    );
  }
});

test("F2 sibling (B4): an outside blob that an own rewrite on its way overwrites is published again from the newer content, once the own echo shows it", () => {
  const w = world({
    outputs: { D1: "drive", D3: "drive" },
    choices: { D1: "c1" },
  });
  w.connect(1);
  w.blob(
    {
      devices: [
        { name: "D1", scene: "X" },
        { name: "D3", scene: "Q" },
      ],
    },
    { retain: true, connection: 1 },
  );
  const { effects } = w.choose("D1", "K");
  const p1 = /** @type {any} */ (
    effects.find((effect) => effect.type === "publish-blob")
  );

  // Outside: D3 moves to R. The broker processes it before P1, so P1, which
  // still carries Q, overwrites it in the store.
  let mark = w.effects.length;
  w.blob(
    { devices: [{ name: "D1" }, { name: "D3", scene: "R" }] },
    { retain: false, connection: 1 },
  );
  assert.equal(w.shows("D3"), "R (blob)");
  assert.deepEqual(
    w.since(mark, ...PUBLISHING),
    [],
    "the outside blob is as it should be: nothing to write yet",
  );

  mark = w.effects.length;
  const echo = w.blob(p1.payload, { retain: false, connection: 1 });
  assert.equal(echo.decision.reason, "older_own_echo");
  assert.equal(
    w.shows("D3"),
    "R (blob)",
    "the store holds Q again, the display does not go back to it",
  );
  const [repair] = w.since(mark, "publish-blob");
  assert.equal(
    repair.evidence,
    "message",
    "the own echo is the evidence of what the store holds",
  );
  assert.deepEqual(documentOf(/** @type {any} */ (repair).payload), {
    devices: [{ name: "D1" }, { name: "D3", scene: "R" }],
  });
  assert.equal(w.since(mark, "warn").length, 1);

  // The repair lands: store and mirror agree.
  mark = w.effects.length;
  assert.equal(
    w.blob(/** @type {any} */ (repair).payload, {
      retain: false,
      connection: 1,
    }).decision.reason,
    "own_echo",
  );
  assert.deepEqual(w.since(mark, ...PUBLISHING), []);
  assert.equal(w.shows("D3"), "R (blob)");
});

test("F2 sibling: an outside blob that arrives before the own echo and names the replaced scene again is older than the own strip; the scene is stripped again at once, on that evidence", () => {
  const w = world({ outputs: { D1: "drive" }, choices: { D1: "c1" } });
  w.connect(1);
  w.blob(
    { devices: [{ name: "D1", scene: "X" }] },
    { retain: true, connection: 1 },
  );
  w.choose("D1", "K");
  const mark = w.effects.length;
  w.blob(
    {
      devices: [{ name: "D1", scene: "X" }],
      scenes: { added: { path: "a.js" } },
    },
    { retain: false, connection: 1 },
  );
  assert.equal(
    w.shows("D1"),
    "K (config)",
    "X was processed before the own strip: not a new command",
  );
  assert.deepEqual(w.since(mark, ...RETIRING), []);
  const [rewrite] = w.since(mark, "publish-blob");
  assert.deepEqual(
    documentOf(/** @type {any} */ (rewrite).payload),
    { devices: [{ name: "D1" }], scenes: { added: { path: "a.js" } } },
    "the outside client's other change is kept",
  );
});

// ---------------------------------------------------------------------------
// F3: an empty ownership replay after a live list
// ---------------------------------------------------------------------------

const TRANSITION = createTopics({
  baseTopic: "home/hsb1/pixdcon",
  statusBaseTopic: "home/hsb1/pixdcon2",
});

/** @param {import("../../src/types.js").V1Owner} owner */
const outputFor = (owner) =>
  resolveOutput({
    forceShadow: false,
    deviceOutput: "drive",
    configDefault: null,
    envDefault: "drive",
    transition: true,
    owner,
  });

test("F3: v1's empty list is held back as a replay, a live list names D, then the empty replay arrives: D stays in shadow", () => {
  let feed = createOwnershipFeed();
  assert.equal(outputFor(ownerOf(feed, true, "D")).reason, "ownership_unknown");

  // The live list arrives first, although it was published later.
  let step = reduceOwnership(feed, {
    payload: JSON.stringify({ devices: [{ name: "D" }] }),
    retain: false,
    connection: 1,
    receivedAt: T0,
  });
  feed = step.feed;
  assert.equal(step.decision.action, "apply");
  assert.equal(outputFor(ownerOf(feed, true, "D")).reason, "v1_owner");

  // The held replay: what the store held when this connection subscribed.
  step = reduceOwnership(feed, {
    payload: JSON.stringify({ devices: [] }),
    retain: true,
    connection: 1,
    receivedAt: T0,
  });
  feed = step.feed;
  assert.deepEqual(step.decision, {
    action: "drop",
    reason: "replay_after_live",
  });
  assert.deepEqual(step.changed, []);
  assert.equal(ownerOf(feed, true, "D"), "v1");
  assert.deepEqual(outputFor(ownerOf(feed, true, "D")), {
    mode: "shadow",
    requested: "drive",
    reason: "v1_owner",
  });
});

test("F3 siblings: only a list that passed the fence releases a device. An older connection, an unreadable payload, a cleared topic and silence do not", () => {
  const list = (/** @type {string[]} */ names) =>
    JSON.stringify({ devices: names.map((name) => ({ name })) });
  let feed = createOwnershipFeed();
  const accept = (
    /** @type {{payload: string, retain: boolean, connection: number}} */ message,
  ) => {
    const step = reduceOwnership(feed, { ...message, receivedAt: T0 });
    feed = step.feed;
    return step;
  };

  accept({ payload: list(["D"]), retain: true, connection: 2 });
  assert.equal(ownerOf(feed, true, "D"), "v1");

  // A message of connection 1 that is processed late: dropped, also live.
  assert.equal(
    accept({ payload: list([]), retain: false, connection: 1 }).decision.reason,
    "superseded_source",
  );
  assert.equal(ownerOf(feed, true, "D"), "v1");

  // Unreadable payloads change nothing.
  for (const payload of [
    "{",
    "[]",
    "null",
    JSON.stringify({ devices: "none" }),
  ])
    assert.equal(
      accept({ payload, retain: false, connection: 2 }).decision.reason,
      "unreadable",
    );
  assert.equal(ownerOf(feed, true, "D"), "v1");

  // A list without D, live on the current connection: D is released, by evidence.
  const released = accept({
    payload: list(["E"]),
    retain: false,
    connection: 2,
  });
  assert.deepEqual(released.changed.sort(), ["D", "E"]);
  assert.equal(ownerOf(feed, true, "D"), "free");
  assert.equal(outputFor(ownerOf(feed, true, "D")).mode, "drive");

  // Somebody clears the topic: there is no list any more. Unknown means shadow.
  accept({ payload: "", retain: false, connection: 2 });
  assert.equal(ownerOf(feed, true, "D"), "unknown");
  assert.equal(outputFor(ownerOf(feed, true, "D")).reason, "ownership_unknown");

  // A new connection: its replay is the newest there is, and is applied.
  accept({ payload: list(["D"]), retain: true, connection: 3 });
  assert.equal(ownerOf(feed, true, "D"), "v1");
  // …and on that connection a second, late replay after a live list is dropped again.
  accept({ payload: list([]), retain: false, connection: 3 });
  assert.equal(
    accept({ payload: list(["D"]), retain: true, connection: 3 }).decision
      .reason,
    "replay_after_live",
  );
  assert.equal(ownerOf(feed, true, "D"), "free");

  // No transition configured: v1's list is not asked.
  assert.equal(ownerOf(createOwnershipFeed(), false, "D"), "free");
});

test("F3: the ownership module is the fence and nothing else: accept() takes a gateway message, changes are announced once", () => {
  /** @type {string[]} */
  const warnings = [];
  const ownership = new V1Ownership({
    mqtt: null,
    topics: TRANSITION,
    clock: /** @type {any} */ ({ now: () => 0 }),
    logger: /** @type {any} */ ({
      warn: (/** @type {string} */ line) => warnings.push(line),
    }),
  });
  /** @type {string[][]} */
  const changes = [];
  ownership.on("changed", ({ devices }) => changes.push(devices));
  ownership.start(); // no broker configured: nothing to subscribe to
  assert.equal(ownership.owner("D"), "unknown");
  assert.deepEqual(ownership.status(), {
    transition: true,
    known: false,
    receivedAt: null,
    connection: 0,
    devices: [],
  });

  const message = (
    /** @type {string} */ payload,
    /** @type {boolean} */ retain,
  ) => ({
    topic: TRANSITION.v1ConfigEffective,
    payload,
    retain,
    connection: 1,
    receivedAt: T0,
  });
  ownership.accept(
    message(JSON.stringify({ devices: [{ name: "D" }] }), false),
  );
  ownership.accept(
    message(JSON.stringify({ devices: [{ name: "D" }] }), false),
  ); // unchanged: no event
  ownership.accept(message(JSON.stringify({ devices: [] }), true)); // late replay: dropped
  ownership.accept(message("not json", false));
  assert.equal(ownership.owner("D"), "v1");
  assert.deepEqual(changes, [["*"]], "one change: from unknown to a list");
  assert.equal(warnings.length, 1);
  assert.deepEqual(ownership.status().devices, ["D"]);
});

test("R4-5 sibling, the one stated exception: v1's device list keeps its say across a reconnect until the new connection delivers a list. What it holds back stays, what it permits stays too, and its connection tells that it has not been delivered again", () => {
  /** v1's retained config/effective, with the devices it runs. @param {...string} names */
  const v1List = (...names) =>
    JSON.stringify({ devices: names.map((name) => ({ name })), scenes: {} });
  let feed = createOwnershipFeed();
  feed = reduceOwnership(feed, {
    payload: v1List("D-v1"),
    retain: true,
    connection: 1,
    receivedAt: T0,
  }).feed;
  assert.equal(ownerOf(feed, true, "D-v1"), "v1");
  assert.equal(ownerOf(feed, true, "D-v2"), "free");

  // Connection 2 is up and has delivered nothing for the topic: the feed
  // has no input for a connect, so nothing changes. Unlike an overlay
  // (overlay-service.js M4) the list is never cleared in operation, only
  // replaced, and its replay brings the newest one.
  assert.equal(reduceOwnership.length, 2, "inputs: the feed and a message");
  assert.equal(outputFor(ownerOf(feed, true, "D-v1")).reason, "v1_owner");
  assert.equal(outputFor(ownerOf(feed, true, "D-v2")).mode, "drive");
  assert.equal(
    feed.connection,
    1,
    "received on connection 1; the current one is 2",
  );

  // The replay of connection 2: v1 has taken D-v2 back meanwhile.
  const replay = reduceOwnership(feed, {
    payload: v1List("D-v1", "D-v2"),
    retain: true,
    connection: 2,
    receivedAt: T0,
  });
  assert.deepEqual(replay.changed, ["D-v2"]);
  assert.equal(
    outputFor(ownerOf(replay.feed, true, "D-v2")).reason,
    "v1_owner",
  );
  assert.equal(replay.feed.connection, 2);
});

// ---------------------------------------------------------------------------
// Siblings on the scene layers that the inventory names
// ---------------------------------------------------------------------------

test("scene layers: the suppression predicate hides replays by value only; a live value is a question of order, not of value", () => {
  const suppression = {
    generation: 1,
    at: T0,
    value: "A",
    alsoStale: ["P"],
    output: /** @type {const} */ ("drive"),
  };
  assert.equal(
    isSuperseded({ value: "A", origin: "replay" }, suppression),
    true,
  );
  assert.equal(
    isSuperseded({ value: "P", origin: "replay" }, suppression),
    true,
  );
  assert.equal(
    isSuperseded({ value: "Z", origin: "replay" }, suppression),
    false,
  );
  assert.equal(
    isSuperseded({ value: "A", origin: "live" }, suppression),
    false,
  );
  assert.equal(
    isSuperseded(
      { value: "Z", origin: "replay" },
      { ...suppression, value: null },
    ),
    true,
    "the choice did not know what was stored: any replay is stale",
  );
  assert.equal(
    isSuperseded({ value: null, origin: "replay" }, suppression),
    false,
  );
  assert.equal(isSuperseded({ value: "A", origin: "replay" }, null), false);
});

test("scene layers: after a reconnect no clear is sent blindly. A command stored while pixdcon was away is not deleted; the old value is cleared when it is delivered", () => {
  for (const [stored, expected] of /** @type {const} */ ([
    ["HA-new", "HA-new (overlay)"],
    ["old", "B (config)"],
  ])) {
    const w = world({ outputs: { D: "drive" }, choices: { D: "saved" } });
    w.connect(1);
    w.granular("D", "old", { retain: true, connection: 1 });
    const { effects } = w.choose("D", "B");
    assert.equal(
      effects.filter((effect) => effect.type === "publish-clear").length,
      1,
      "the choice's own clear",
    );
    w.disconnect(1); // before the broker answered

    const mark = w.effects.length;
    w.connect(2);
    w.settle(2);
    w.feed({ type: "tick" });
    w.feed({ type: "tick" });
    assert.deepEqual(
      w.since(mark, ...PUBLISHING),
      [],
      "nothing is published because a connection came up",
    );

    w.granular("D", stored, { retain: true, connection: 2 });
    assert.equal(w.shows("D"), expected, `replay of ${stored}`);
    assert.equal(
      w.since(mark, "publish-clear").length,
      stored === "old" ? 1 : 0,
      `replay of ${stored}`,
    );
  }
});

test("scene layers: a live overlay that the broker processed before the choice's clear is older than the choice; one that comes after the clear's echo wins again (the Home Assistant toggle)", () => {
  const w = world({ outputs: { D: "drive" }, choices: { D: "saved" } });
  w.connect(1);
  w.granular("D", "tv", { retain: false, connection: 1 });
  assert.equal(w.shows("D"), "tv (overlay)");
  w.choose("D", "B");

  // Arrives before the echo of the clear: the broker had it first, and the
  // clear that follows removes it from the store.
  const early = w.granular("D", "radio", { retain: false, connection: 1 });
  assert.deepEqual(
    early.decision,
    { action: "apply", reason: "before_own_write" },
    "taken as what the store holds, not as a command",
  );
  assert.equal(w.shows("D"), "B (config)");
  assert.equal(w.saved.has("D/granular"), true);
  assert.deepEqual(
    sceneInputs(w.state(), "D").granular?.inEffect,
    false,
    "in the mirror, replaced by the choice",
  );

  // The echo of the clear: confirmed.
  w.granular("D", "", { retain: false, connection: 1 });
  assert.equal(w.saved.has("D/granular"), false);
  assert.equal(w.shows("D"), "B (config)");

  // A late replay of the old value after the echo: dropped (rule 11).
  assert.equal(
    w.granular("D", "tv", { retain: true, connection: 1 }).decision.reason,
    "replay_after_live",
  );

  // The toggle is pressed again: a new command.
  w.granular("D", "radio", { retain: false, connection: 1 });
  assert.equal(w.shows("D"), "radio (overlay)");
});

test("scene layers: the acknowledgement of an older choice's clear does not end the newer choice's suppression (rule 13), and a failed clear is repeated by the tick, on the same connection only", () => {
  const w = world({ outputs: { D: "drive" }, choices: { D: "saved" } });
  w.connect(1);
  w.granular("D", "tv", { retain: true, connection: 1 });
  const first = /** @type {any} */ (
    w.choose("D", "B").effects.find((effect) => effect.type === "publish-clear")
  );
  const second = /** @type {any} */ (
    w.choose("D", "C").effects.find((effect) => effect.type === "publish-clear")
  );
  assert.deepEqual([first.generation, second.generation], [1, 2]);

  w.feed({ type: "published", write: first.write, outcome: "confirmed" });
  assert.equal(
    w.saved.get("D/granular")?.generation,
    2,
    "generation 2 is still saved",
  );

  // The second clear was certainly not sent: repeated on the next tick.
  let mark = w.effects.length;
  w.feed({ type: "published", write: second.write, outcome: "failed" });
  assert.deepEqual(w.since(mark, ...PUBLISHING), [], "not at once");
  w.feed({ type: "tick" });
  const [again] = w.since(mark, "publish-clear");
  assert.deepEqual(
    [/** @type {any} */ (again).generation, again.evidence],
    [2, "timer"],
  );
  assert.equal(mayCause("publish", "timer", { repeatOf: "command" }), true);

  // It fails again, and the connection ends: on the next one nothing is
  // repeated by time.
  w.feed({
    type: "published",
    write: /** @type {any} */ (again).write,
    outcome: "failed",
  });
  w.disconnect(1);
  w.connect(2);
  mark = w.effects.length;
  w.feed({ type: "tick" });
  assert.deepEqual(w.since(mark, ...PUBLISHING), []);
});

test("scene layers: a message of a connection that is gone is dropped; a message of a newer connection makes it the current one", () => {
  const w = world({ outputs: { D: "drive" } });
  w.connect(2);
  assert.equal(
    w.granular("D", "x", { retain: false, connection: 1 }).decision.reason,
    "superseded_source",
  );
  assert.equal(
    w.blob({ devices: [] }, { retain: true, connection: 1 }).decision.reason,
    "superseded_source",
  );
  assert.equal(
    w.connect(2).decision.reason,
    "superseded_source",
    "the same connection twice",
  );
  assert.equal(w.settle(1).decision.reason, "superseded_source");
  assert.equal(
    w.granular("D", "y", { retain: true, connection: 3 }).decision.action,
    "apply",
  );
  assert.equal(w.state().connection, 3);
  assert.equal(w.shows("D"), "y (overlay)");
});

test("scene layers: an unusable blob is held: it names no scene and ends no suppression; the legacy scenes array counts as a scene and is stripped with it", () => {
  const w = world({ outputs: { D: "drive" }, choices: { D: "saved" } });
  w.connect(1);
  w.blob(
    { devices: [{ name: "D", scenes: ["legacy", "more"] }] },
    { retain: true, connection: 1 },
  );
  assert.equal(w.shows("D"), "legacy (blob)");
  const { effects } = w.choose("D", "B");
  const rewrite = /** @type {any} */ (
    effects.find((effect) => effect.type === "publish-blob")
  );
  assert.deepEqual(documentOf(rewrite.payload), { devices: [{ name: "D" }] });
  assert.deepEqual(
    [...blobScenes({ devices: [{ name: "D", scene: "", scenes: ["x"] }] })],
    [["D", "x"]],
  );

  w.disconnect(1);
  w.connect(2);
  const held = w.blob("this is not json", { retain: true, connection: 2 });
  assert.deepEqual(held.decision, { action: "hold", reason: "invalid_blob" });
  assert.equal(w.saved.has("D/blob"), true);
  assert.equal(w.shows("D"), "B (config)");
});

// ---------------------------------------------------------------------------
// Cross-read round 3: N1, N2, N3 on the scene layers. Each test is the
// sequence the review ran, then its siblings.
// ---------------------------------------------------------------------------

/** @param {{effects: any[]}} result @param {string} type */
const effectOf = (result, type) =>
  result.effects.find((effect) => effect.type === type);

test("N1: a device that leaves the config and comes back is never handed a choice generation again. The acknowledgement of the old device's clear does not end the new choice's suppression, and the new choice sends its own clear", () => {
  const w = world({ outputs: { D: "drive" }, choices: { D: "saved" } });
  w.connect(1);
  w.granular("D", "A", { retain: true, connection: 1 });

  // 1. Choose B: generation 1, clear W1 on its way.
  const first = w.choose("D", "B");
  const w1 = effectOf(first, "publish-clear");
  assert.deepEqual([first.plan.generation, w1.generation], [1, 1]);

  // 2. Remove D and add it again. Its entry is gone, with the choice and
  //    the saved suppressions; W1 is still on its way.
  const removed = w.remove("D");
  assert.deepEqual(
    removed.effects
      .filter((effect) => effect.type === "retire")
      .map((effect) => /** @type {any} */ (effect).ended),
    ["dropped", "dropped"],
  );
  assert.equal(w.saved.size, 0);
  w.add("D", "drive", "saved");
  assert.equal(w.state().generations.get("D"), 1, "the counter stayed");

  // 3. The broker processes W1; an outside publisher stores A again. The
  //    echo, the live A and the acknowledgement are all held back.
  // 4. Choose C.
  const mark = w.effects.length;
  const second = w.choose("D", "C");
  assert.equal(second.plan.generation, 2, "not 1 again");
  const [w2] = w.since(mark, "publish-clear");
  assert.deepEqual(
    [w2.generation, w2.evidence],
    [2, "command"],
    "the new choice sends its own clear; W1 does not stand in for it",
  );

  // 5. W1's acknowledgement arrives: it names generation 1 and ends nothing.
  w.feed({ type: "published", write: w1.write, outcome: "confirmed" });
  assert.equal(w.saved.get("D/granular")?.generation, 2);
  assert.equal(w.saved.get("D/granular")?.value, "A");

  // W1's echo, then the A that was stored after it: processed before W2,
  // so older than the choice C.
  w.granular("D", "", { retain: false, connection: 1 });
  assert.deepEqual(
    w.granular("D", "A", { retain: false, connection: 1 }).decision,
    { action: "apply", reason: "before_own_write" },
  );
  assert.equal(w.shows("D"), "C (config)");

  // 6. Restart before W2 reached the broker: the retained A is replayed.
  w.restart();
  w.connect(1);
  const replay = w.effects.length;
  w.granular("D", "A", { retain: true, connection: 1 });
  assert.equal(w.shows("D"), "C (config)", "A does not win over C");
  assert.equal(w.since(replay, "publish-clear").length, 1, "and is cleared");
});

test("N1 siblings: a plan that carries no higher generation than the device's last choice is refused; a blob rewrite on its way for a device that left strips it, and confirms nothing for the device that came back", () => {
  const w = world({
    outputs: { D1: "drive", D2: "shadow" },
    choices: { D1: "s1", D2: "s2" },
  });
  w.connect(1);
  w.blob(
    {
      devices: [
        { name: "D1", scene: "A1" },
        { name: "D2", scene: "A2" },
      ],
    },
    { retain: true, connection: 1 },
  );

  // Two plans for one device, made before either took effect: the state
  // store never does that (one command of a device at a time). The second
  // is refused instead of sharing a generation.
  const one = planChoice(w.state(), "D2", { at: T0, output: "shadow" });
  const two = planChoice(w.state(), "D2", { at: T0, output: "shadow" });
  assert.equal(one.generation, two.generation);
  assert.equal(w.feed({ type: "choice", plan: one }).decision.action, "apply");
  assert.deepEqual(w.feed({ type: "choice", plan: two }).decision, {
    action: "drop",
    reason: "not_newer",
  });
  // …also after the device left and came back.
  w.remove("D2");
  w.add("D2", "shadow", "s2");
  assert.equal(
    w.feed({ type: "choice", plan: two }).decision.reason,
    "not_newer",
  );
  assert.equal(
    planChoice(w.state(), "D2", { at: T0, output: "shadow" }).generation,
    2,
  );

  // Choice on D1: rewrite P1 strips D1, generation 1. D1 leaves and comes
  // back while P1 is on its way, and the user chooses again.
  const p1 = effectOf(w.choose("D1", "C1"), "publish-blob");
  assert.deepEqual(p1.generations, [{ device: "D1", generation: 1 }]);
  w.remove("D1");
  w.add("D1", "drive", "s1");
  const again = w.choose("D1", "C1b");
  assert.equal(again.plan.generation, 2);
  assert.equal(w.saved.get("D1/blob")?.generation, 2);

  // The broker acknowledges P1. It carries generation 1: the suppression
  // of the new choice, generation 2, stays saved.
  let mark = w.effects.length;
  w.feed({ type: "published", write: p1.write, outcome: "confirmed" });
  assert.deepEqual(w.since(mark, ...RETIRING), []);
  assert.equal(w.saved.get("D1/blob")?.generation, 2);

  // P1's echo is delivered, and nothing else of pixdcon is on its way: the
  // store holds no scene for D1. That, not P1's generation, ends it.
  mark = w.effects.length;
  const echo = w.blob(p1.payload, { retain: false, connection: 1 });
  assert.equal(echo.decision.reason, "own_echo");
  assert.deepEqual(
    w
      .since(mark, "retire")
      .map((effect) => [effect.device, effect.generation, effect.ended]),
    [["D1", 2, "confirmed"]],
  );
  assert.equal(sceneInputs(w.state(), "D1").blob, null);
  assert.equal(w.shows("D1"), "C1b (config)");
});

/** N2 up to the two rewrites on their way. */
function n2() {
  const w = world({
    outputs: { D1: "drive", D2: "drive" },
    choices: { D1: "s1", D2: "s2" },
  });
  w.connect(1);
  // 1. The blob holds D1 = A1 and D2 = A2.
  w.blob(
    {
      devices: [
        { name: "D1", scene: "A1" },
        { name: "D2", scene: "A2" },
      ],
    },
    { retain: true, connection: 1 },
  );
  // 2. Choose C1 on D1: P1 has D1 without a scene and still D2 = A2.
  const p1 = effectOf(w.choose("D1", "C1"), "publish-blob");
  assert.deepEqual(documentOf(p1.payload), {
    devices: [{ name: "D1" }, { name: "D2", scene: "A2" }],
  });
  // 3. Choose C2 on D2: P2 has both devices without a scene.
  const p2 = effectOf(w.choose("D2", "C2"), "publish-blob");
  assert.deepEqual(documentOf(p2.payload), {
    devices: [{ name: "D1" }, { name: "D2" }],
  });
  assert.deepEqual([...w.saved.keys()].sort(), [
    "D1/blob",
    "D1/granular",
    "D2/blob",
    "D2/granular",
  ]);
  return { w, p1, p2 };
}

for (const [what, reason, twinOf] of /** @type {const} */ ([
  [
    "the same document, as the review's outside publisher sent it",
    "before_own_write",
    (/** @type {any} */ p2) => JSON.stringify(documentOf(p2.payload)),
  ],
  [
    "byte for byte the later rewrite, mark included",
    "own_twin",
    (/** @type {any} */ p2) => p2.payload,
  ],
])) {
  test(`N2, ${what}: a payload that looks like the later of two own rewrites, delivered before either echo, is not that rewrite's echo. D2's suppression stays saved, and after a restart with only the earlier rewrite in the store, A2 does not replace C2`, () => {
    const { w, p1, p2 } = n2();

    // 4. Before either rewrite reaches the broker, an outside publisher
    //    sends what P2 says.
    let mark = w.effects.length;
    const twin = w.blob(twinOf(p2), { retain: false, connection: 1 });
    // 5. It is not the echo that is due: P1's is.
    assert.deepEqual(twin.decision, { action: "apply", reason });
    assert.deepEqual(w.since(mark, ...RETIRING, ...PUBLISHING), []);
    assert.equal(w.saved.has("D2/blob"), true, "D2 keeps its protection");
    assert.equal(w.saved.has("D1/blob"), true);
    assert.equal(
      w.state().blob.outstanding.length,
      2,
      "both rewrites are still on their way",
    );
    assert.equal(w.shows("D2"), "C2 (config)");

    // 6. P1 reaches the broker and echoes back; P2 never does.
    mark = w.effects.length;
    const echo = w.blob(p1.payload, { retain: false, connection: 1 });
    assert.deepEqual(echo.decision, {
      action: "drop",
      reason: "older_own_echo",
    });
    assert.equal(
      w.saved.has("D1/blob"),
      false,
      "P1's echo confirms what P1 stripped: D1",
    );
    assert.equal(w.saved.has("D2/blob"), true, "and nothing of P2");
    assert.equal(w.shows("D2"), "C2 (config)");

    //    Restart; the broker replays P1, with D2 = A2.
    w.restart();
    w.connect(1);
    mark = w.effects.length;
    w.blob(p1.payload, { retain: true, connection: 1 });
    assert.equal(w.shows("D2"), "C2 (config)", "A2 does not replace C2");
    assert.equal(w.shows("D1"), "C1 (config)");
    assert.deepEqual(w.since(mark, ...RETIRING), []);
    const [rewrite] = w.since(mark, "publish-blob");
    assert.deepEqual(documentOf(rewrite.payload), {
      devices: [{ name: "D1" }, { name: "D2" }],
    });
  });
}

test("N2 siblings (O1): every rewrite carries its own mark, so its bytes are its identity. Echoes are taken oldest first, also when the acknowledgements arrive the other way round", () => {
  const { w, p1, p2 } = n2();
  const marks = [p1, p2].map((write) => JSON.parse(write.payload)[WRITE_MARK]);
  assert.match(
    marks[0],
    /^[0-9a-z]+\.[0-9a-f]{16}$/,
    "the number of the write, and a keyed hash over it and the document",
  );
  assert.notEqual(marks[0], marks[1]);

  // The broker acknowledges P2 first: P2 is in the store, so P1 is too,
  // underneath. Both are still expected back, P1 first.
  w.feed({ type: "published", write: p2.write, outcome: "confirmed" });
  assert.deepEqual(
    w.state().blob.outstanding.map((write) => write.landed),
    [true, true],
  );
  assert.equal(w.saved.has("D2/blob"), false, "confirmed by its own write");
  assert.equal(
    w.blob(p1.payload, { retain: false, connection: 1 }).decision.reason,
    "older_own_echo",
  );
  assert.equal(
    w.state().blob.store,
    p2.payload,
    "the store holds P2, which landed on top of P1",
  );
  assert.equal(
    w.blob(p2.payload, { retain: false, connection: 1 }).decision.reason,
    "own_echo",
  );
  assert.equal(w.state().blob.outstanding.length, 0);

  // Another run of the process writes the same document with another mark:
  // nobody can know the bytes of a rewrite before the broker has stored it.
  const other = n2();
  other.w.restart();
  other.w.connect(1);
  const replayed = other.w.blob(
    {
      devices: [
        { name: "D1", scene: "A1" },
        { name: "D2", scene: "A2" },
      ],
    },
    { retain: true, connection: 1 },
  );
  const rewritten = effectOf(replayed, "publish-blob");
  assert.deepEqual(documentOf(rewritten.payload), documentOf(p2.payload));
  assert.notEqual(rewritten.payload, p2.payload);
});

test("N2 siblings (O2): a blob with the exact bytes of an own rewrite is that rewrite, whoever published it: never a command. As a copy after a newer outside blob it is published over again; as the store's content after a reconnect it is not taken for something stored while pixdcon was away", () => {
  const w = world({
    outputs: { D1: "drive", D3: "shadow" },
    choices: { D1: "s1", D3: "s3" },
  });
  w.connect(1);
  w.blob(
    {
      devices: [
        { name: "D1", scene: "X" },
        { name: "D3", scene: "Q" },
      ],
    },
    { retain: true, connection: 1 },
  );
  // P1 strips D1 and still carries D3 = Q. It lands and echoes.
  const p1 = effectOf(w.choose("D1", "K"), "publish-blob");
  assert.equal(
    w.blob(p1.payload, { retain: false, connection: 1 }).decision.reason,
    "own_echo",
  );

  // An outside client moves D3 to R: a new command, no own write on its way.
  w.blob(
    { devices: [{ name: "D1" }, { name: "D3", scene: "R" }] },
    { retain: false, connection: 1 },
  );
  assert.equal(w.shows("D3"), "R (blob)");
  // The user chooses for D3, which is in shadow: nothing is written.
  w.choose("D3", "c3");
  assert.deepEqual(w.saved.get("D3/blob"), {
    generation: 1,
    at: T0,
    value: "R",
    alsoStale: ["Q"],
    output: "shadow",
  });

  // Somebody publishes P1's exact bytes again (a tool that restores the
  // blob it read a moment ago). D3 = Q is in it.
  let mark = w.effects.length;
  const copy = w.blob(p1.payload, { retain: false, connection: 1 });
  assert.deepEqual(copy.decision, {
    action: "drop",
    reason: "older_own_write",
  });
  assert.deepEqual(w.since(mark, ...RETIRING), [], "no new command for D3");
  assert.equal(w.shows("D3"), "c3 (config)");
  const [repair] = w.since(mark, "publish-blob");
  assert.deepEqual(
    documentOf(repair.payload),
    { devices: [{ name: "D1" }, { name: "D3", scene: "R" }] },
    "the blob is published again as it should be",
  );
  // The same copy once more while the repair is on its way: nothing new.
  mark = w.effects.length;
  assert.deepEqual(
    w.blob(p1.payload, { retain: false, connection: 1 }).decision,
    { action: "apply", reason: "own_twin" },
  );
  assert.deepEqual(w.since(mark, ...RETIRING, ...PUBLISHING), []);

  // The connection ends before the repair lands. The next one replays P1:
  // known as pixdcon's own write, whatever it names.
  w.disconnect(1);
  w.connect(2);
  mark = w.effects.length;
  assert.deepEqual(
    w.blob(p1.payload, { retain: true, connection: 2 }).decision,
    { action: "drop", reason: "older_own_write" },
  );
  assert.deepEqual(w.since(mark, ...RETIRING), []);
  assert.equal(w.shows("D3"), "c3 (config)");
  assert.equal(w.since(mark, "publish-blob").length, 1);

  // An empty payload has no identity: a clear is anybody's clear.
  assert.equal(ownWriteOf(w.state(), ""), 0);
});

test("N2 siblings (O2): an own rewrite of a connection that ended, which the broker gets to only after the next connection has subscribed, arrives there as a live message. It is known by its bytes: no command, no suppression ends, and the blob is published again as it should be", () => {
  const w = world({
    outputs: { D1: "drive", D3: "shadow" },
    choices: { D1: "s1", D3: "s3" },
  });
  w.connect(1);
  w.blob(
    {
      devices: [
        { name: "D1", scene: "X" },
        { name: "D3", scene: "Q" },
      ],
    },
    { retain: true, connection: 1 },
  );
  w.choose("D3", "c3"); // in shadow: nothing is written, Q is replaced
  const p1 = effectOf(w.choose("D1", "K"), "publish-blob");
  assert.equal(blobScenes(JSON.parse(p1.payload)).get("D3"), "Q");
  // The connection ends with P1 still in the broker's hands.
  w.disconnect(1);

  // The next connection replays the blob as an outside client left it
  // meanwhile: D3 = R, stored while pixdcon was away, a new command.
  w.connect(2);
  w.blob(
    {
      devices: [
        { name: "D1", scene: "X" },
        { name: "D3", scene: "R" },
      ],
    },
    { retain: true, connection: 2 },
  );
  assert.equal(w.shows("D3"), "R (blob)");
  assert.equal(w.saved.has("D3/blob"), false);
  // The user chooses again for D3.
  w.choose("D3", "c4");
  assert.deepEqual(w.saved.get("D3/blob")?.alsoStale, ["Q"]);

  // Now the broker gets to P1. It arrives as a live message of somebody,
  // with D3 = Q in it, while nothing of this connection is on its way
  // (the rewrite for D1 has echoed back).
  const rewrite = w
    .state()
    .blob.outstanding.map((write) => write.payload)
    .at(-1);
  w.blob(/** @type {string} */ (rewrite), { retain: false, connection: 2 });
  const mark = w.effects.length;
  const late = w.blob(p1.payload, { retain: false, connection: 2 });
  assert.deepEqual(late.decision, {
    action: "drop",
    reason: "older_own_write",
  });
  assert.deepEqual(w.since(mark, ...RETIRING), []);
  assert.equal(w.shows("D3"), "c4 (config)", "Q is not a new command");
  const [repair] = w.since(mark, "publish-blob");
  assert.equal(blobScenes(JSON.parse(repair.payload)).get("D3"), "R");
  assert.equal(blobScenes(JSON.parse(repair.payload)).has("D1"), false);
});

test("N2 siblings (O3): an own echo confirms what its own write stripped, and nothing else while a later rewrite is on its way. A suppression is not ended by a blob without a scene when a later own rewrite, built from older content, still carries one", () => {
  const w = world({
    outputs: { D1: "drive", D2: "drive" },
    choices: { D1: "s1", D2: "s2" },
  });
  w.connect(1);
  // The user chooses for D1 before the blob is known.
  w.choose("D1", "C1");
  // The stored blob is replayed: D1 = b5, nothing for D2. P2 strips D1.
  const p2 = effectOf(
    w.blob(
      { devices: [{ name: "D1", scene: "b5" }, { name: "D2" }], note: "n6" },
      { retain: true, connection: 1 },
    ),
    "publish-blob",
  );
  // An outside blob that the broker had before P2: D2 = b9. P3 is built
  // from it; D2 has no suppression yet, so P3 carries D2 = b9.
  const p3 = effectOf(
    w.blob(
      {
        devices: [
          { name: "D1", scene: "b5" },
          { name: "D2", scene: "b9" },
        ],
        note: "n11",
      },
      { retain: false, connection: 1 },
    ),
    "publish-blob",
  );
  assert.equal(blobScenes(JSON.parse(p3.payload)).get("D2"), "b9");
  assert.equal(w.shows("D2"), "b9 (blob)");

  // The user chooses for D2, then D2 goes into shadow: its suppression
  // stays, and no further rewrite strips it.
  w.choose("D2", "C2");
  w.feed({ type: "output", device: "D2", output: "shadow" });
  assert.equal(w.saved.get("D2/blob")?.value, "b9");

  // Still before P2: an outside client publishes the blob without any
  // scene for D2 (the document P2 carries).
  w.blob(JSON.stringify(documentOf(p2.payload)), {
    retain: false,
    connection: 1,
  });
  // P2 echoes back. It is the blob as it should be, and it names no scene
  // for D2; but P3, which does, is still on its way.
  const mark = w.effects.length;
  assert.equal(
    w.blob(p2.payload, { retain: false, connection: 1 }).decision.reason,
    "own_echo",
  );
  assert.deepEqual(
    w
      .since(mark, "retire")
      .map((effect) => [effect.device, effect.layer, effect.ended]),
    [["D1", "blob", "confirmed"]],
    "P2 confirms D1, which it stripped; D2's suppression is not touched",
  );
  assert.equal(w.saved.has("D2/blob"), true);

  // P3 lands with D2 = b9; then the process restarts before anything else
  // reaches the broker. The replay of P3 does not bring b9 back.
  w.blob(p3.payload, { retain: false, connection: 1 });
  w.restart();
  w.connect(1);
  w.blob(p3.payload, { retain: true, connection: 1 });
  assert.equal(w.shows("D2"), "C2 (config)");
});

test("N3 (A-182): a scene overlay that was cleared while pixdcon was disconnected stops deciding when the next connection is up. Its record stays, visibly not confirmed; nothing is retired or published on the way; a restart gives the same answer", () => {
  const w = world({ outputs: { D: "drive" }, choices: { D: "home3" } });
  w.connect(1);
  // The Home Assistant toggle: a retained overlay, delivered live.
  w.granular("D", "tv", { retain: false, connection: 1 });
  assert.equal(w.shows("D"), "tv (overlay)");

  // The broker goes away. That alone changes nothing on the display.
  w.disconnect(1);
  assert.equal(w.shows("D"), "tv (overlay)");
  assert.equal(sceneInputs(w.state(), "D").granular?.confirmed, true);

  // Home Assistant clears the retained topic meanwhile. The reconnect
  // replays nothing for it: MQTT has no message for "this topic is empty".
  const mark = w.effects.length;
  const connected = w.connect(2);
  assert.deepEqual(
    connected.effects,
    [{ type: "changed", devices: ["D"], blob: false }],
    "the state store is told to compute again",
  );
  assert.equal(w.shows("D"), "home3 (config)", "at once, on no hint");
  w.settle(2);
  for (let tick = 0; tick < 5; tick++) w.feed({ type: "tick" });
  assert.equal(w.shows("D"), "home3 (config)");
  assert.deepEqual(w.since(mark, ...RETIRING, ...PUBLISHING), []);
  assert.deepEqual(
    sceneInputs(w.state(), "D").granular,
    {
      scene: "tv",
      confirmed: false,
      inEffect: false,
      origin: "live",
      connection: 1,
    },
    "the record is still listed, as of connection 1",
  );

  // A restart against the same empty store: the same answer.
  w.restart();
  w.connect(1);
  w.settle(1);
  assert.equal(w.shows("D"), "home3 (config)");
  assert.equal(sceneInputs(w.state(), "D").granular, null);
});

test("N3 siblings: an overlay that is still stored wins again the moment it is delivered, however late; the blob layer follows the same rule; and a suppression does not depend on the connection at all", () => {
  // Granular, and the blob's scene for a device: still stored, replayed
  // after the settle hint.
  const w = world({
    outputs: { D: "drive", E: "drive" },
    choices: { D: "home3", E: "clock" },
  });
  w.connect(1);
  w.granular("D", "tv", { retain: false, connection: 1 });
  w.blob(
    { devices: [{ name: "E", scene: "radio" }] },
    { retain: true, connection: 1 },
  );
  assert.deepEqual(
    [w.shows("D"), w.shows("E")],
    ["tv (overlay)", "radio (blob)"],
  );
  w.disconnect(1);
  w.connect(2);
  w.settle(2);
  assert.deepEqual(
    [w.shows("D"), w.shows("E")],
    ["home3 (config)", "clock (config)"],
    "neither decides before this connection has delivered it",
  );
  assert.deepEqual(
    sceneInputs(w.state(), "E").blob && {
      scene: sceneInputs(w.state(), "E").blob?.scene,
      confirmed: sceneInputs(w.state(), "E").blob?.confirmed,
    },
    { scene: "radio", confirmed: false },
  );
  w.granular("D", "tv", { retain: true, connection: 2 });
  assert.equal(w.shows("D"), "tv (overlay)");
  w.blob(
    { devices: [{ name: "E", scene: "radio" }] },
    { retain: true, connection: 2 },
  );
  assert.equal(w.shows("E"), "radio (blob)");
  assert.equal(sceneInputs(w.state(), "E").blob?.confirmed, true);
  // A live message confirms as well as a replay does.
  w.disconnect(2);
  w.connect(3);
  w.granular("D", "news", { retain: false, connection: 3 });
  assert.equal(w.shows("D"), "news (overlay)");

  // A suppression is kept across the reconnect whatever is delivered, and
  // a choice made while the record waits hides whatever the replay brings.
  const s = world({ outputs: { D: "shadow" }, choices: { D: "home3" } });
  s.connect(1);
  s.granular("D", "tv", { retain: true, connection: 1 });
  s.choose("D", "B");
  s.disconnect(1);
  const mark = s.effects.length;
  s.connect(2);
  s.settle(2);
  assert.equal(s.saved.size, 2, "both suppressions are still saved");
  assert.deepEqual(s.since(mark, ...RETIRING), []);
  const waiting = planChoice(s.state(), "D", { at: T0, output: "shadow" });
  assert.equal(
    waiting.granular?.value,
    null,
    "what the record of connection 1 holds is not what is stored now",
  );
  s.granular("D", "tv", { retain: true, connection: 2 });
  assert.equal(s.shows("D"), "B (config)", "delivered, and still replaced");
  assert.deepEqual(
    [
      sceneInputs(s.state(), "D").granular?.confirmed,
      sceneInputs(s.state(), "D").granular?.inEffect,
    ],
    [true, false],
  );
});

// ---------------------------------------------------------------------------
// Cross-read round 4: R4-1, R4-2, R4-3 on the scene layers. Each test is the
// sequence the review ran against the round-4 commit, and the sequences next
// to it.
// ---------------------------------------------------------------------------

for (const layer of /** @type {const} */ (["granular", "blob"])) {
  test(`R4-1, ${layer} layer: an overlay that the new connection delivers again, after the connect was announced, is announced too. A consumer that computes a device only when a "changed" effect names it shows tv again, as the precedence over the whole state does`, () => {
    const w = world({ outputs: { D: "drive" }, choices: { D: "home3" } });
    const deliver = (
      /** @type {{retain: boolean, connection: number}} */ meta,
    ) =>
      layer === "granular"
        ? w.granular("D", "tv", meta)
        : w.blob({ devices: [{ name: "D", scene: "tv" }] }, meta);
    const tv = layer === "granular" ? "tv (overlay)" : "tv (blob)";
    w.connect(1);
    deliver({ retain: false, connection: 1 });
    assert.equal(w.follows("D"), tv);

    // The reconnect. Its "changed" effect is consumed at once: this is the
    // 300 ms debounce running out before the broker replays anything.
    const connect = w.connect(2);
    assert.deepEqual(
      connect.effects.filter((effect) => effect.type === "changed"),
      [{ type: "changed", devices: ["D"], blob: layer === "blob" }],
      "the record waits from now on: announced",
    );
    assert.equal(w.follows("D"), "home3 (config)");

    // The late replay of the very same value. Nothing about the value
    // changed; who may decide did.
    const replay = deliver({ retain: true, connection: 2 });
    assert.equal(replay.decision.action, "apply");
    assert.deepEqual(
      replay.effects.filter((effect) => effect.type === "changed"),
      [{ type: "changed", devices: ["D"], blob: layer === "blob" }],
      "delivered on the current connection: it decides again, and that is announced",
    );
    assert.equal(w.shows("D"), tv);
    assert.equal(w.follows("D"), tv, "the consumer follows");
    assert.deepEqual(w.stale(["D"]), []);

    // The same value once more, live. How a record arrived is part of what
    // the Overlays page lists, so that is announced, once, and changes
    // nothing a display does. The same message again changes nothing at
    // all, and announces nothing (M3).
    const live = deliver({ retain: false, connection: 2 });
    assert.deepEqual(live.effects, [
      { type: "changed", devices: ["D"], blob: layer === "blob" },
    ]);
    assert.equal(w.shows("D"), tv);
    const again = deliver({ retain: false, connection: 2 });
    assert.deepEqual(again.effects, [], "the same message again: no effect");
    assert.deepEqual(w.stale(["D"]), []);
  });
}

test("R4-1 sibling, the blob as a document: a blob that names no scene and only patches a device is not confirmed after a reconnect and is confirmed again by its replay. Both are announced, although no scene layer of any device changed and the text is the same", () => {
  const w = world({ outputs: { D: "drive" }, choices: { D: "home3" } });
  const patchOnly = { devices: [{ name: "D", minFrameMs: 250 }] };
  const announced = [{ type: "changed", devices: [], blob: true }];
  w.connect(1);
  assert.deepEqual(
    w.blob(patchOnly, { retain: true, connection: 1 }).effects,
    announced,
  );
  assert.equal(blobView(w.state())?.confirmed, true);

  // The reconnect: what the blob patches waits, like a scene it names.
  assert.deepEqual(w.connect(2).effects, announced);
  assert.equal(blobView(w.state())?.confirmed, false);
  assert.deepEqual(
    w.blob(patchOnly, { retain: true, connection: 2 }).effects,
    announced,
    "the same text again: its standing changed, and that is said",
  );
  assert.deepEqual(blobView(w.state()), {
    text: JSON.stringify(patchOnly),
    valid: true,
    confirmed: true,
    origin: "replay",
    connection: 2,
  });
  assert.deepEqual(w.stale(["D"]), []);

  // A blob that cannot be read is listed and says nothing; a cleared one
  // is gone. Both are announced.
  const unreadable = w.blob("not json", { retain: false, connection: 2 });
  assert.equal(unreadable.decision.action, "hold");
  assert.deepEqual(unreadable.effects, announced);
  assert.equal(blobView(w.state())?.valid, false);
  assert.deepEqual(
    w.blob("", { retain: false, connection: 2 }).effects,
    announced,
  );
  assert.equal(blobView(w.state()), null);
  assert.deepEqual(w.stale(["D"]), []);
});

test("R4-1 siblings: every way a layer's say can change without its value changing is announced: a suppression that ends on an acknowledgement, a choice in shadow that is dropped, a device that leaves, a disconnect followed by a newer connection. The consumer that is driven by effects never goes stale", () => {
  const w = world({
    outputs: { D1: "drive", D2: "shadow" },
    choices: { D1: "saved1", D2: "saved2" },
  });
  const devices = ["D1", "D2"];
  /** @param {string} step */
  const followed = (step) =>
    assert.deepEqual(w.stale(devices), [], `after: ${step}`);
  const live = { retain: false, connection: 1 };
  w.connect(1);
  followed("connect");
  w.blob(
    {
      devices: [
        { name: "D1", scene: "A1" },
        { name: "D2", scene: "A2" },
      ],
    },
    { retain: true, connection: 1 },
  );
  w.granular("D2", "G2", { retain: true, connection: 1 });
  followed("replays");
  assert.equal(w.follows("D1"), "A1 (blob)");
  assert.equal(w.follows("D2"), "G2 (overlay)");

  // A choice on each: the layers lose their say, the values stay.
  const chosen = w.choose("D1", "C1");
  followed("choice on the driven device");
  w.choose("D2", "C2");
  followed("choice on the device in shadow");
  assert.equal(w.follows("D2"), "C2 (config)");

  // The rewrite lands: by its acknowledgement first, then by its echo.
  const rewrite = chosen.effects.find(
    (effect) => effect.type === "publish-blob",
  );
  assert.ok(rewrite && rewrite.type === "publish-blob");
  w.feed({ type: "published", write: rewrite.write, outcome: "confirmed" });
  followed("acknowledgement of the rewrite");
  w.blob(rewrite.payload, live);
  followed("echo of the rewrite");
  w.granular("D1", "", live);
  followed("echo of the clear");

  // The device in shadow becomes driven: its choice made in shadow is
  // dropped, and what is stored shows again (rule 18).
  w.feed({ type: "output", device: "D2", output: "drive" });
  followed("shadow to drive");
  assert.equal(w.follows("D2"), "G2 (overlay)");

  // The broker goes away and comes back; nothing is delivered again.
  w.disconnect(1);
  followed("disconnect");
  assert.equal(w.follows("D2"), "G2 (overlay)", "still in effect while away");
  w.connect(2);
  followed("a newer connection");
  assert.equal(w.follows("D2"), "C2 (config)", "the record waits");
  w.settle(2);
  w.feed({ type: "tick" });
  followed("hint and tick");

  // The device leaves and comes back.
  w.remove("D2");
  followed("removed");
  w.add("D2", "drive", "again2");
  followed("added again");
  assert.equal(w.follows("D2"), "again2 (config)");
  w.granular("D2", "G2", { retain: true, connection: 2 });
  followed("late replay");
  assert.equal(w.follows("D2"), "G2 (overlay)");
});

/**
 * R4-2 as the review ran it, for any number of rewrites: every round an
 * outside blob, a choice on D1 that strips it, and the echoes. The first
 * rewrite carries D2 = A2, the others D2 = B2. Then a choice on D2.
 *
 * @param {number} rounds
 */
function manyRewrites(rounds) {
  const live = { retain: false, connection: 1 };
  const w = world({
    outputs: { D1: "drive", D2: "drive" },
    choices: { D1: "C1", D2: "C2" },
  });
  w.connect(1);
  /** @type {string[]} */
  const rewrites = [];
  for (let round = 0; round < rounds; round++) {
    w.blob(
      {
        devices: [
          { name: "D1", scene: "A1" },
          { name: "D2", scene: round === 0 ? "A2" : "B2" },
        ],
        note: round,
      },
      live,
    );
    const [rewrite] = w
      .choose("D1", "C1")
      .effects.filter((effect) => effect.type === "publish-blob");
    assert.ok(rewrite && rewrite.type === "publish-blob");
    rewrites.push(rewrite.payload);
    w.blob(rewrite.payload, live);
    w.granular("D1", "", live);
  }
  const [last] = w
    .choose("D2", "C2")
    .effects.filter((effect) => effect.type === "publish-blob");
  assert.ok(last && last.type === "publish-blob");
  rewrites.push(last.payload);
  w.blob(last.payload, live);
  w.granular("D2", "", live);
  assert.equal(w.shows("D2"), "C2 (config)");
  assert.equal(w.saved.size, 0, "every clear and rewrite is confirmed");
  return { w, rewrites, live };
}

test("R4-2: the bytes of the first own rewrite, published again by somebody after 33 more rewrites, are still that rewrite. D2 keeps C2, the blob is published over, and nothing about the 34 rewrites is kept to know it", () => {
  const { w, rewrites, live } = manyRewrites(33);
  assert.equal(rewrites.length, 34);
  assert.equal(ownWriteOf(w.state(), rewrites[0]) > 0, true);

  const mark = w.effects.length;
  const copy = w.blob(rewrites[0], live);
  assert.deepEqual(copy.decision, {
    action: "drop",
    reason: "older_own_write",
  });
  assert.equal(w.shows("D2"), "C2 (config)", "A2 does not come back");
  assert.deepEqual(w.since(mark, ...RETIRING), []);
  const [repair] = w.since(mark, "publish-blob");
  assert.equal(repair.evidence, "message");
  assert.deepEqual(blobScenes(JSON.parse(repair.payload)), new Map());
  assert.deepEqual(w.stale(["D1", "D2"]), []);

  // What the state holds of its own writes does not grow with them.
  const blob = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (w.state().blob)
  );
  assert.deepEqual(
    Object.keys(blob).filter((key) => Array.isArray(blob[key])),
    ["outstanding"],
    "no list of past rewrites",
  );
  assert.equal(w.state().blob.outstanding.length, 1, "the repair");
  assert.deepEqual(
    [...w.state().ownScenes],
    [["D2", ["A2", "B2"]]],
    "per device, the scene names own rewrites carried",
  );
});

test("R4-2 siblings: 150 rewrites, and every one of them is known again, on the same connection, as a replay after a reconnect, and as a late live message. None of them is ever a command", () => {
  const { w, rewrites, live } = manyRewrites(149);
  assert.equal(rewrites.length, 150);
  // On the same connection, oldest first and newest first.
  for (const payload of [...rewrites, ...rewrites.toReversed()]) {
    const { decision } = w.blob(payload, live);
    assert.equal(
      ["older_own_write", "own_twin"].includes(decision.reason),
      true,
      `not a command: ${decision.reason}`,
    );
    assert.equal(w.shows("D2"), "C2 (config)");
    assert.equal(w.shows("D1"), "C1 (config)");
    assert.equal(w.state().blob.outstanding.length <= BLOB_IN_FLIGHT, true);
  }
  // After a reconnect the store holds the very first one.
  w.disconnect(1);
  w.connect(2);
  assert.deepEqual(
    w.blob(rewrites[0], { retain: true, connection: 2 }).decision,
    { action: "drop", reason: "older_own_write" },
  );
  assert.equal(w.shows("D2"), "C2 (config)");
  // And the broker gets to another one of the old connection only now.
  const late = w.blob(rewrites[75], { retain: false, connection: 2 });
  assert.equal(
    ["older_own_write", "own_twin"].includes(late.decision.reason),
    true,
  );
  assert.equal(w.shows("D2"), "C2 (config)");
  assert.deepEqual(
    w.since(0, "retire").filter((e) => e.ended === "outside_command"),
    [],
  );
  assert.deepEqual(w.stale(["D1", "D2"]), []);
});

test("R4-2 siblings (O1, O2): the mark is bound to the document. The same document written down another way is still that rewrite; a changed document with the old mark, the document without a mark, a mark of another write, of another process or one that is no mark at all are outside messages: that is how somebody gives a command", () => {
  /** @param {(blob: Record<string, any>, other: Record<string, any>) => unknown} edit */
  const variant = (edit) => {
    const { w, rewrites, live } = manyRewrites(3);
    const blob = JSON.parse(rewrites[0]);
    const payload = edit(blob, JSON.parse(rewrites[1]));
    const result = w.blob(
      typeof payload === "string" ? payload : JSON.stringify(payload),
      live,
    );
    return { w, result, shows: w.shows("D2") };
  };

  // Keys in another order, indented: the same document, the same mark.
  const again = variant((blob) =>
    JSON.stringify(
      {
        [WRITE_MARK]: blob[WRITE_MARK],
        note: blob.note,
        devices: blob.devices,
      },
      null,
      2,
    ),
  );
  assert.equal(again.result.decision.reason, "older_own_write");
  assert.equal(again.shows, "C2 (config)");

  /** @type {Array<[string, (blob: Record<string, any>, other: Record<string, any>) => unknown]>} */
  const outside = [
    ["the mark removed", (blob) => withoutMark(blob)],
    [
      "the mark of another own rewrite",
      (blob, other) => ({ ...blob, [WRITE_MARK]: other[WRITE_MARK] }),
    ],
    [
      "a mark of another process",
      (blob) => ({ ...blob, [WRITE_MARK]: "1.0123456789abcdef" }),
    ],
    ["a mark that is none", (blob) => ({ ...blob, [WRITE_MARK]: { w: 1 } })],
    [
      "a number no write of this process has",
      (blob) => ({
        ...blob,
        [WRITE_MARK]: `zzzz.${blob[WRITE_MARK].split(".")[1]}`,
      }),
    ],
    [
      "the old mark on a changed document",
      (blob) => ({ ...blob, note: "edited" }),
    ],
  ];
  for (const [what, edit] of outside) {
    const { result, shows, w } = variant(edit);
    assert.deepEqual(
      result.decision,
      { action: "apply", reason: "current" },
      `${what}: an outside message`,
    );
    assert.equal(shows, "A2 (blob)", `${what}: a command, it wins`);
    assert.deepEqual(w.stale(["D1", "D2"]), []);
  }
});

test("R4-2 siblings (restart): a choice records every scene own rewrites of this process ever carried for its device, also the one of 40 rewrites ago. A new process knows the old rewrite by that value; with more names than are kept, every stored value is stale", () => {
  const live = { retain: false, connection: 1 };
  const { w, rewrites } = manyRewrites(40);
  // A new outside blob, and a choice on D2 whose rewrite does not land.
  w.blob({ devices: [{ name: "D1" }, { name: "D2", scene: "N2" }] }, live);
  const { plan } = w.choose("D2", "C3");
  assert.deepEqual(
    [plan.blob?.value, plan.blob?.alsoStale],
    ["N2", ["A2", "B2"]],
    "A2 is of the very first rewrite",
  );
  // Somebody restores the first rewrite; pixdcon restarts before its repair.
  w.restart();
  w.connect(1);
  w.blob(rewrites[0], { retain: true, connection: 1 });
  assert.equal(w.shows("D2"), "C3 (config)", "A2 is known as pixdcon's own");
  assert.equal(w.saved.has("D2/blob"), true);

  // More scene names than are kept per device.
  const many = world({
    outputs: { D1: "drive", D2: "drive" },
    choices: { D1: "C1", D2: "C2" },
  });
  many.connect(1);
  /** @type {string[]} */
  const sent = [];
  for (let round = 0; round <= OWN_SCENES; round++) {
    many.blob(
      {
        devices: [
          { name: "D1", scene: "A1" },
          { name: "D2", scene: `S${round}` },
        ],
      },
      live,
    );
    const [rewrite] = many
      .choose("D1", "C1")
      .effects.filter((effect) => effect.type === "publish-blob");
    sent.push(rewrite.payload);
    many.blob(rewrite.payload, live);
    many.granular("D1", "", live);
  }
  assert.equal(many.state().ownScenesFull.has("D2"), true);
  assert.equal(many.state().ownScenes.has("D2"), false);
  const full = many.choose("D2", "C2").plan;
  assert.deepEqual(
    [full.blob?.value, full.blob?.alsoStale],
    [null, []],
    "anything stored is stale",
  );
  many.restart();
  many.connect(1);
  many.blob(sent[3], { retain: true, connection: 1 });
  assert.equal(many.shows("D2"), "C2 (config)");
});

test(`R4-2 siblings (payloads): at most ${BLOB_IN_FLIGHT} own rewrites are on their way. One more waits, is not lost, and is sent, built from the content of that moment, when an echo has made room`, () => {
  const live = { retain: false, connection: 1 };
  const w = world({ outputs: { D1: "drive" }, choices: { D1: "s1" } });
  w.connect(1);
  w.blob({ devices: [{ name: "D1", scene: "A1" }], note: 0 }, live);
  /** @type {string[]} */
  const sent = w
    .choose("D1", "C1")
    .effects.filter((effect) => effect.type === "publish-blob")
    .map((effect) => /** @type {any} */ (effect).payload);
  // Outside blobs that the broker processed before the first echo: each is
  // new content, and each time the rewrite is built again.
  for (let note = 1; sent.length < BLOB_IN_FLIGHT; note++) {
    const more = w.blob({ devices: [{ name: "D1", scene: "A1" }], note }, live);
    assert.equal(more.decision.reason, "before_own_write");
    sent.push(
      ...more.effects
        .filter((effect) => effect.type === "publish-blob")
        .map((effect) => /** @type {any} */ (effect).payload),
    );
  }
  assert.equal(w.state().blob.outstanding.length, BLOB_IN_FLIGHT);
  const waiting = w.blob(
    { devices: [{ name: "D1", scene: "A1" }], note: "one more" },
    live,
  );
  assert.deepEqual(
    waiting.effects.filter((effect) => effect.type === "publish-blob"),
    [],
    "no room: nothing is sent",
  );
  w.feed({ type: "tick" });
  assert.equal(w.state().blob.outstanding.length, BLOB_IN_FLIGHT);
  assert.equal(w.shows("D1"), "C1 (config)", "and nothing shows meanwhile");

  // The first echo makes room.
  const echo = w.blob(sent[0], live);
  assert.equal(echo.decision.reason, "older_own_echo");
  const [next] = echo.effects.filter(
    (effect) => effect.type === "publish-blob",
  );
  assert.ok(next && next.type === "publish-blob");
  assert.deepEqual(documentOf(next.payload), {
    devices: [{ name: "D1" }],
    note: "one more",
  });
  assert.equal(w.state().blob.outstanding.length, BLOB_IN_FLIGHT);
  // Everything comes back; the store ends as it should be.
  for (const payload of [...sent.slice(1), next.payload]) w.blob(payload, live);
  assert.equal(w.state().blob.outstanding.length, 0);
  assert.equal(w.state().blob.store, next.payload);
  assert.equal(w.saved.has("D1/blob"), false);
  assert.deepEqual(w.stale(["D1"]), []);
});

// --- R4-3: one blob, several controllers -----------------------------------

const TWO_SCENES = {
  devices: [
    { name: "D1", scene: "A1" },
    { name: "D2", scene: "A2" },
  ],
};

for (const [roles, iWrites] of /** @type {const} */ ([
  ["I is the blob's writer, J is not", true],
  ["neither is the writer (pixdcon v1 is)", false],
])) {
  test(`R4-3, two controllers with their own secrets, ${roles}: concurrent choices on D1 (driven by I) and D2 (driven by J). Only the writer rewrites the blob; no rewrite is a scene command for the other one's device, on the connection, after a reconnect or after a restart`, () => {
    const i = world({
      name: "controller I",
      blobWriter: iWrites,
      outputs: { D1: "drive", D2: "shadow" },
      choices: { D1: "saved1", D2: "saved2" },
    });
    const j = world({
      name: "controller J",
      blobWriter: false,
      outputs: { D1: "shadow", D2: "drive" },
      choices: { D1: "saved1", D2: "saved2" },
    });
    for (const w of [i, j]) {
      w.connect(1);
      w.blob(TWO_SCENES, { retain: true, connection: 1 });
    }
    // Both choose before either has heard of the other's choice.
    const p1 = i
      .choose("D1", "C1")
      .effects.find((effect) => effect.type === "publish-blob");
    const p2 = j
      .choose("D2", "C2")
      .effects.find((effect) => effect.type === "publish-blob");
    assert.equal(Boolean(p1), iWrites, "I rewrites only as the writer");
    assert.equal(p2, undefined, "J never publishes to the blob topic");
    // Each still clears the granular topic of the device it drives.
    assert.deepEqual(
      [i, j].map((w) => w.since(0, "publish-clear").map((e) => e.device)),
      [["D1"], ["D2"]],
    );

    // The broker stores what was published; both receive it in order.
    const stored =
      p1 && p1.type === "publish-blob"
        ? p1.payload
        : JSON.stringify(TWO_SCENES);
    if (iWrites) {
      i.blob(stored, { retain: false, connection: 1 });
      const seen = j.blob(stored, { retain: false, connection: 1 });
      assert.deepEqual(seen.decision, { action: "apply", reason: "current" });
      assert.deepEqual(
        seen.effects.filter((effect) => effect.type !== "changed"),
        [],
        "I's rewrite retires and publishes nothing at J",
      );
    }
    i.granular("D1", "", { retain: false, connection: 1 });
    j.granular("D2", "", { retain: false, connection: 1 });
    assert.equal(i.shows("D1"), "C1 (config)");
    assert.equal(
      j.shows("D2"),
      "C2 (config)",
      "A2 is still in the blob, hidden",
    );
    assert.deepEqual(
      [j.saved.has("D2/blob"), j.saved.get("D2/blob")?.value],
      [true, null],
      "saved, against anything the blob holds",
    );

    // J misses what follows, reconnects and gets the store's content.
    j.disconnect(1);
    j.connect(2);
    const replay = j.blob(stored, { retain: true, connection: 2 });
    assert.deepEqual(
      replay.effects.filter((effect) => effect.type !== "changed"),
      [],
    );
    assert.equal(j.shows("D2"), "C2 (config)");

    // Both restart on the same store.
    for (const [w, device, choice] of /** @type {const} */ ([
      [i, "D1", "C1 (config)"],
      [j, "D2", "C2 (config)"],
    ])) {
      w.restart();
      w.connect(1);
      w.settle(1);
      w.blob(stored, { retain: true, connection: 1 });
      w.feed({ type: "tick" });
      assert.equal(w.shows(device), choice);
      assert.deepEqual(w.stale(["D1", "D2"]), []);
    }
    assert.deepEqual(
      j.since(0, "publish-blob"),
      [],
      "J published nothing to the blob topic, start to end",
    );
    assert.equal(i.since(0, "publish-blob").length > 0, iWrites);
  });
}

/**
 * pixdcon v1's own overlay module (lib/config-overlay.js, unchanged), with a
 * stand-in for its MQTT service that keeps what it publishes.
 */
async function v1Overlay() {
  /** @type {any} */
  const { ConfigOverlay } = await import(
    new URL("../../../lib/config-overlay.js", import.meta.url).href
  );
  /** @type {Array<{topic: string, payload: string}>} */
  const writes = [];
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const mqtt = {
    connected: true,
    /** @param {string} topic @param {string} payload @param {boolean} _retain @param {(error?: Error|null) => void} [done] */
    publish(topic, payload, _retain, done) {
      writes.push({ topic, payload });
      done?.(null);
      return true;
    },
    unsubscribeWildcard() {},
  };
  const overlay = new ConfigOverlay(mqtt, "home/hsb1/pixdcon", async () => {}, {
    logger: quiet,
  });
  return {
    overlay,
    writes,
    /** The blob rewrites v1 published. */
    rewrites: () =>
      writes
        .filter((write) => write.topic === "overlay/blob")
        .map((write) => write.payload),
  };
}

test("R4-3, pixdcon v1 and v2 on one blob, with v1's real ConfigOverlay: v2 chooses C1 for D1 while v1 chooses for D2. v1 rewrites the blob and still carries D1 = A1; for v2 that is no command, live or after a restart, and v2 has published nothing to the blob topic", async () => {
  const marked = { ...TWO_SCENES, _pixdcon: "previous-process" };
  const live = { retain: false, connection: 1 };
  // The transition: v1 is the blob's writer, v2 is not.
  const w = world({
    blobWriter: false,
    outputs: { D1: "drive", D2: "shadow" },
    choices: { D1: "saved1" },
  });
  w.connect(1);
  w.blob(marked, { retain: true, connection: 1 });
  const v1 = await v1Overlay();
  try {
    v1.overlay._handleBlob(JSON.stringify(marked), { retain: true });

    const chosen = w.choose("D1", "C1");
    assert.deepEqual(
      chosen.effects.filter((effect) => effect.type === "publish-blob"),
      [],
      "v2 leaves the blob to v1",
    );
    assert.deepEqual(
      w.since(0, "publish-clear").map((effect) => effect.device),
      ["D1"],
      "and clears the topic of the device it drives",
    );
    v1.overlay.clearDeviceScene("D2", "C2");
    const [old] = v1.rewrites();
    assert.deepEqual(JSON.parse(old), {
      devices: [{ name: "D1", scene: "A1" }, { name: "D2" }],
      _pixdcon: "previous-process",
    });

    w.granular("D1", "", live);
    const mark = w.effects.length;
    const seen = w.blob(old, live);
    assert.deepEqual(seen.decision, { action: "apply", reason: "current" });
    assert.equal(w.shows("D1"), "C1 (config)", "v1's rewrite is no command");
    assert.deepEqual(w.since(mark, ...RETIRING, ...PUBLISHING), []);
    assert.deepEqual(
      [w.saved.has("D1/blob"), w.saved.get("D1/blob")?.value],
      [true, null],
      "still saved, against anything the blob holds",
    );
    assert.deepEqual(w.stale(["D1", "D2"]), []);

    // v2 restarts; the store holds v1's rewrite.
    w.restart();
    w.connect(1);
    w.blob(old, { retain: true, connection: 1 });
    w.settle(1);
    w.feed({ type: "tick" });
    assert.equal(w.shows("D1"), "C1 (config)");
    assert.deepEqual(w.since(0, "publish-blob"), []);

    // What still works on a device v2 drives: the Home Assistant toggle.
    w.granular("D1", "tv", live);
    assert.equal(w.shows("D1"), "tv (overlay)");
  } finally {
    v1.overlay.unsubscribe();
  }
});

test("R4-3 sibling, why a value is not enough: v1 rewrites from the blob it last saw. Its rewrite carries a scene for D1 that is older than the one v2's choice replaced. Nothing that is delivered on the blob topic ends the suppression of an instance that is not the writer", async () => {
  const live = { retain: false, connection: 1 };
  const before = {
    devices: [
      { name: "D1", scene: "Z1" },
      { name: "D2", scene: "A2" },
    ],
  };
  const w = world({
    blobWriter: false,
    outputs: { D1: "drive", D2: "shadow" },
    choices: { D1: "saved1" },
  });
  w.connect(1);
  w.blob(before, { retain: true, connection: 1 });
  const v1 = await v1Overlay();
  try {
    v1.overlay._handleBlob(JSON.stringify(before), { retain: true });
    // An outside client sets D1 to A1. v2 has it; v1 has not received it yet.
    w.blob(TWO_SCENES, live);
    assert.equal(w.shows("D1"), "A1 (blob)");
    w.choose("D1", "C1");
    w.granular("D1", "", live);
    assert.equal(w.saved.get("D1/blob")?.value, null);
    // v1's choice for D2, built from the blob v1 holds: D1 = Z1.
    v1.overlay.clearDeviceScene("D2", "C2");
    const [rewrite] = v1.rewrites();
    assert.equal(blobScenes(JSON.parse(rewrite)).get("D1"), "Z1");

    const mark = w.effects.length;
    w.blob(rewrite, live);
    assert.equal(
      w.shows("D1"),
      "C1 (config)",
      "Z1 is not the value the choice replaced, and it is no command",
    );
    assert.deepEqual(w.since(mark, ...RETIRING, ...PUBLISHING), []);

    // Whatever else arrives there: another scene, none, a clear, a replay.
    w.blob({ devices: [{ name: "D1", scene: "X1" }] }, live);
    w.blob({ devices: [{ name: "D1" }] }, live);
    w.blob("", live);
    w.disconnect(1);
    w.connect(2);
    w.blob(
      { devices: [{ name: "D1", scene: "Y1" }] },
      { retain: true, connection: 2 },
    );
    assert.deepEqual(w.since(mark, ...RETIRING, ...PUBLISHING), []);
    assert.equal(w.shows("D1"), "C1 (config)");
    assert.equal(w.saved.has("D1/blob"), true);
    assert.deepEqual(w.stale(["D1", "D2"]), []);
  } finally {
    v1.overlay.unsubscribe();
  }
});

test("R4-3 siblings: a choice made by an instance that is not the writer holds against the blob also when the blob names no scene for the device then; it ends by a newer choice, by rule 18 and when the device leaves; and the next run, as the writer, strips whatever the blob then holds for the device, also an older scene that the other writer's rewrite put back", () => {
  const live = { retain: false, connection: 1 };
  const w = world({
    blobWriter: false,
    outputs: { D1: "drive", D3: "shadow", D4: "shadow" },
    choices: { D1: "s1", D3: "s3", D4: "s4" },
  });
  w.connect(1);
  w.blob({ devices: [{ name: "D1" }, { name: "D3", scene: "A3" }] }, live);
  const { plan } = w.choose("D1", "C1");
  assert.deepEqual(
    plan.blob && [plan.blob.value, plan.blob.output],
    [null, "drive"],
    "nothing to replace now, and still a suppression",
  );
  w.granular("D1", "", live);
  // The writer publishes a blob with a scene for D1.
  w.blob(
    {
      devices: [
        { name: "D1", scene: "X1" },
        { name: "D3", scene: "A3" },
      ],
    },
    live,
  );
  assert.equal(w.shows("D1"), "C1 (config)");
  assert.equal(
    w.shows("D3"),
    "A3 (blob)",
    "a device without a choice follows the blob",
  );

  // A newer choice replaces the suppression; it is still one.
  let mark = w.effects.length;
  w.choose("D1", "C1b");
  assert.deepEqual(
    w.since(mark, "retire").map((effect) => [effect.layer, effect.ended]),
    [["blob", "replaced"]],
    "the granular one ended with the echo of its clear",
  );
  assert.equal(w.saved.get("D1/blob")?.value, null);
  // Rule 18 for the device in shadow.
  w.choose("D3", "C3");
  assert.equal(w.shows("D3"), "C3 (config)");
  mark = w.effects.length;
  w.feed({ type: "output", device: "D3", output: "drive" });
  assert.deepEqual(
    w.since(mark, "retire").map((effect) => [effect.layer, effect.ended]),
    [
      ["granular", "dropped"],
      ["blob", "dropped"],
    ],
  );
  assert.equal(w.shows("D3"), "A3 (blob)");
  // A choice in shadow that is still saved when the run ends.
  w.choose("D4", "C4");
  assert.equal(w.saved.get("D4/blob")?.output, "shadow");
  assert.deepEqual(w.since(0, "publish-blob"), []);

  // The transition ends: the next run is the writer, on the same file, and
  // drives D4 too. Meanwhile the other writer has put an older scene of D1
  // back into the blob, Z1, which is not what any choice here replaced.
  const next = world({
    blobWriter: true,
    outputs: { D1: "drive", D3: "drive", D4: "drive" },
    choices: { D1: "C1b", D3: "C3", D4: "C4" },
    saved: Object.fromEntries(w.saved),
  });
  // The process is told who is driven. D4's choice was made in shadow: it
  // is dropped by that, although the output changed while nothing ran.
  assert.deepEqual(
    next
      .since(0, "retire")
      .map((effect) => [effect.device, effect.layer, effect.ended]),
    [
      ["D4", "granular", "dropped"],
      ["D4", "blob", "dropped"],
    ],
  );
  assert.equal(next.saved.has("D4/blob"), false);
  next.connect(1);
  const replay = next.blob(
    {
      devices: [
        { name: "D1", scene: "Z1" },
        { name: "D3", scene: "A3" },
        { name: "D4", scene: "A4" },
      ],
    },
    { retain: true, connection: 1 },
  );
  assert.equal(next.shows("D1"), "C1b (config)", "Z1 is stale like anything");
  assert.equal(
    next.shows("D4"),
    "A4 (blob)",
    "rule 18: the stored overlay shows",
  );
  const [strip] = replay.effects.filter(
    (effect) => effect.type === "publish-blob",
  );
  assert.ok(strip && strip.type === "publish-blob");
  assert.deepEqual(documentOf(strip.payload), {
    devices: [
      { name: "D1" },
      { name: "D3", scene: "A3" },
      { name: "D4", scene: "A4" },
    ],
  });
  next.blob(strip.payload, live);
  assert.equal(next.saved.has("D1/blob"), false);
  // From here on a blob scene for D1 is a new command again.
  next.blob({ devices: [{ name: "D1", scene: "N1" }] }, live);
  assert.equal(next.shows("D1"), "N1 (blob)");
});

test("R4-3 siblings: the edge instance, with every device in shadow and not the writer, publishes nothing whatever happens; and no input can make an instance the writer during a run", () => {
  const live = { retain: false, connection: 1 };
  const edge = world({
    blobWriter: false,
    outputs: { D1: "shadow", D2: "shadow" },
  });
  edge.connect(1);
  edge.blob(TWO_SCENES, { retain: true, connection: 1 });
  edge.granular("D1", "G1", { retain: true, connection: 1 });
  edge.choose("D1", "preview");
  edge.choose("D2", "preview");
  edge.blob({ devices: [{ name: "D1", scene: "B1" }] }, live);
  edge.granular("D1", "", live);
  edge.feed({ type: "tick" });
  edge.disconnect(1);
  edge.connect(2);
  edge.blob(TWO_SCENES, { retain: true, connection: 2 });
  edge.feed({ type: "tick" });
  assert.deepEqual(edge.since(0, ...PUBLISHING), []);
  assert.equal(edge.shows("D1"), "preview (config)");
  assert.equal(edge.state().blobWriter, false);
  // Becoming driven does not make it the writer either.
  edge.feed({ type: "output", device: "D1", output: "drive" });
  edge.choose("D1", "again");
  edge.blob(TWO_SCENES, live);
  assert.deepEqual(edge.since(0, "publish-blob"), []);
  assert.equal(edge.state().blobWriter, false);
});

test("E1: what `reduce` announces is the difference between the two states and nothing else: `changedDevices` over the readers' answers. A step that changes no answer announces nothing; one that changes an answer no rule thought of is announced", () => {
  const w = world({ outputs: { D: "drive", E: "drive" }, choices: {} });
  w.connect(1);
  const before = w.state();
  const delivered = w.granular("D", "A", { retain: true, connection: 1 });
  assert.deepEqual(changedDevices(before, delivered.state), ["D"]);
  assert.deepEqual(delivered.effects, [
    { type: "changed", devices: ["D"], blob: false },
  ]);
  assert.deepEqual(layersView(w.state(), "D"), {
    granular: {
      scene: "A",
      confirmed: true,
      inEffect: true,
      origin: "replay",
      connection: 1,
    },
    blob: null,
    suppressions: { granular: null, blob: null },
    generation: 0,
    output: "drive",
    decides: { layer: "granular", scene: "A" },
    writing: { granular: false, blob: false },
  });
  // Nothing a reader answers changes: a hint, a tick, an unknown publish.
  for (const input of /** @type {const} */ ([
    { type: "settled", connection: 1, complete: true },
    { type: "tick" },
    { type: "published", write: 99, outcome: "confirmed" },
  ]))
    assert.deepEqual(w.feed(input).effects, []);
  // Two devices in one step, named once, sorted.
  const both = w.blob(
    {
      devices: [
        { name: "E", scene: "B" },
        { name: "D", scene: "B" },
      ],
    },
    { retain: true, connection: 1 },
  );
  assert.deepEqual(both.effects, [
    { type: "changed", devices: ["D", "E"], blob: true },
  ]);
  // An answer that is not a scene: the generation of a choice.
  const again = w.choose("E", "B");
  assert.deepEqual(
    again.effects.at(-1),
    { type: "changed", devices: ["E"], blob: false },
    "the last effect of a step",
  );
  assert.deepEqual(layersView(w.state(), "E").writing, {
    granular: true,
    blob: true,
  });
  // A clear that was certainly not sent: nothing a display shows changes,
  // and it is still said, because the clear is no longer on its way.
  const [clear] = again.effects.filter(
    (effect) => effect.type === "publish-clear",
  );
  assert.ok(clear && clear.type === "publish-clear");
  assert.deepEqual(
    w.feed({ type: "published", write: clear.write, outcome: "failed" })
      .effects,
    [{ type: "changed", devices: ["E"], blob: false }],
  );
  assert.equal(layersView(w.state(), "E").writing.granular, false);
});

// ---------------------------------------------------------------------------
// Own writes on a plain topic (mode, brightness, a cleared setting)
// ---------------------------------------------------------------------------

test("topic fence: an own write that echoes back after a newer own write does not undo it, and a late replay does not undo a live value", () => {
  // The UI sets pause, then play. Both are applied at once and published.
  let mode = newTopicRecord();
  mode = ownWrite(mode, "pause", 1);
  mode = ownWrite(mode, "play", 1);
  assert.equal(mode.value, "play");

  // Another client's "stop" was processed before both: older than them.
  let step = fenceTopic(
    mode,
    { payload: "stop", retain: false, connection: 1 },
    1,
  );
  assert.equal(step.decision.reason, "before_own_write");
  mode = step.record;

  // The echoes arrive in order; neither changes what the process holds.
  for (const payload of ["pause", "play"]) {
    step = fenceTopic(mode, { payload, retain: false, connection: 1 }, 1);
    assert.deepEqual([step.decision.reason, step.changed], ["own_echo", false]);
    mode = step.record;
  }
  assert.equal(mode.value, "play");

  // The held replay of the value from before: dropped.
  step = fenceTopic(mode, { payload: "stop", retain: true, connection: 1 }, 1);
  assert.equal(step.decision.reason, "replay_after_live");

  // An own write that was certainly not sent: the value is again what the
  // store holds.
  let failing = ownWrite(mode, "pause", 1);
  failing = fenceTopic(
    failing,
    { payload: "stop", retain: false, connection: 1 },
    1,
  ).record;
  assert.equal(
    failing.value,
    "pause",
    "the own write is newer than what arrives before its echo",
  );
  assert.deepEqual(ownWriteFailed(failing, "pause"), {
    record: { ...failing, outstanding: [], value: "stop", origin: "live" },
    changed: true,
  });

  // Afterwards another client's command is a command.
  step = fenceTopic(mode, { payload: "stop", retain: false, connection: 1 }, 1);
  assert.deepEqual([step.record.value, step.changed], ["stop", true]);
  // …and the same value again is not a change (M3).
  assert.equal(
    fenceTopic(
      step.record,
      { payload: "stop", retain: false, connection: 1 },
      1,
    ).changed,
    false,
  );
});

// ---------------------------------------------------------------------------
// F4: the saved choice has a typed feed
// ---------------------------------------------------------------------------

/** @returns {import("../../src/types.js").EffectiveDevice} */
const effectiveDevice = (
  /** @type {Partial<import("../../src/types.js").EffectiveDevice>} */ patch = {},
) => ({
  name: "pixoo-t",
  type: "pixoo",
  origin: "config",
  address: "127.0.0.1:1",
  addressSource: "config",
  enabled: true,
  enabledSource: "config",
  held: false,
  savedScene: "clock",
  output: { mode: "drive", requested: "drive", reason: null },
  displayName: "",
  comment: "",
  preview: { showGrid: false, pollMs: 2000 },
  minFrameMs: 500,
  maxPowerCycles: 10,
  powerCyclePlugin: null,
  cleanupLegacyApps: false,
  sceneSettings: {},
  blobKeys: [],
  ...patch,
});

/** @returns {Omit<import("../../src/types.js").EffectiveConfig, "rev">} */
const effectiveConfig = (
  /** @type {import("../../src/types.js").EffectiveDevice[]} */ devices,
  scenes = {},
) => ({
  savedAt: T0,
  devices,
  scenes,
  telemetryIntervalMs: 60000,
  mqtt: /** @type {any} */ ({}),
  health: /** @type {any} */ ({}),
});

test("F4: a process that starts with a saved scene shows it: the saved choice is an input of the precedence, from the effective device", () => {
  const device = effectiveDevice({ savedScene: "clock" });
  const inputs = {
    configScene: device.savedScene,
    configSince: T0,
    uiChoice: null,
    granular: null,
    blob: null,
    check: () => null,
  };
  assert.deepEqual(resolveScene(inputs), {
    scene: "clock",
    source: "config",
    since: T0,
    overlayId: null,
    problem: null,
  });
  assert.equal(
    resolveScene({ ...inputs, configScene: null }).source,
    "fallback",
    "nothing saved, nothing stored: the display idles",
  );
  assert.deepEqual(
    resolveScene({ ...inputs, check: () => "unknown scene" }),
    {
      scene: "clock",
      source: "config",
      since: T0,
      overlayId: null,
      problem: "unknown scene",
    },
    "a choice that cannot run stays the answer, with its problem",
  );
  const overlay = {
    scene: "tv",
    inEffect: true,
    since: T0,
    overlayId: "device-scene:pixoo-t",
  };
  assert.equal(
    resolveScene({ ...inputs, granular: overlay }).source,
    "overlay",
  );
  assert.equal(
    resolveScene({ ...inputs, granular: { ...overlay, inEffect: false } })
      .source,
    "config",
  );
  assert.equal(
    resolveScene({
      ...inputs,
      granular: overlay,
      check: (scene) => (scene === "tv" ? "unknown scene" : null),
    }).source,
    "config",
    "an overlay that cannot run is skipped",
  );
  assert.equal(
    resolveScene({ ...inputs, blob: { ...overlay, overlayId: "blob" } }).source,
    "blob",
  );
  assert.deepEqual(
    resolveScene({
      ...inputs,
      uiChoice: { scene: null, at: T0, persisted: false },
    }),
    { scene: null, source: "ui", since: T0, overlayId: null, problem: null },
    "choosing no scene is a choice",
  );
});

test("F4: an edit of config.json from outside that changes nothing but a scene is in the diff, as savedScene, and restarts nothing", () => {
  const before = effectiveConfig([
    effectiveDevice({ savedScene: "clock" }),
    effectiveDevice({ name: "ulanzi-t" }),
  ]);
  const after = effectiveConfig([
    effectiveDevice({ savedScene: "funkeykid" }),
    effectiveDevice({ name: "ulanzi-t" }),
  ]);
  const diff = diffEffectiveConfig(before, after);
  assert.deepEqual(diff, {
    devicesAdded: [],
    devicesRemoved: [],
    devicesChanged: { "pixoo-t": ["savedScene"] },
    scenesAdded: [],
    scenesRemoved: [],
    scenesChanged: [],
    globalChanged: [],
  });
  assert.equal(
    changeImpact("savedScene"),
    "view",
    "the scene reaches the loop through the state store's desired event",
  );
});

test("F6: what a changed key of an effective device needs, as the scheduler gets it from the factories; an unknown key is a restart", () => {
  const before = effectiveConfig(
    [effectiveDevice(), effectiveDevice({ name: "gone" })],
    {
      clock: { path: "a.js", source: "config" },
      old: { path: "o.js", source: "config" },
    },
  );
  const after = effectiveConfig(
    [
      effectiveDevice({
        address: "127.0.0.1:2",
        addressSource: "overlay",
        output: { mode: "shadow", requested: "drive", reason: "v1_owner" },
        preview: { showGrid: true, pollMs: 1000 },
        sceneSettings: { clock: { hour: 7 } },
        displayName: "Hall",
      }),
      effectiveDevice({ name: "new" }),
    ],
    {
      clock: { path: "b.js", source: "overlay" },
      added: { path: "n.js", source: "blob" },
    },
  );
  const diff = diffEffectiveConfig(before, {
    ...after,
    telemetryIntervalMs: 30000,
  });
  assert.deepEqual(diff.devicesAdded, ["new"]);
  assert.deepEqual(diff.devicesRemoved, ["gone"]);
  assert.deepEqual(diff.devicesChanged["pixoo-t"].sort(), [
    "address",
    "addressSource",
    "displayName",
    "output",
    "preview.pollMs",
    "preview.showGrid",
    "sceneSettings",
  ]);
  assert.deepEqual(
    [diff.scenesAdded, diff.scenesRemoved, diff.scenesChanged],
    [["added"], ["old"], ["clock"]],
  );
  assert.deepEqual(diff.globalChanged, ["telemetryIntervalMs"]);
  assert.deepEqual(
    Object.fromEntries(
      diff.devicesChanged["pixoo-t"].map((key) => [key, changeImpact(key)]),
    ),
    {
      address: "restart",
      addressSource: "view",
      displayName: "view",
      output: "restart",
      "preview.pollMs": "preview",
      "preview.showGrid": "view",
      sceneSettings: "apply",
    },
  );
  for (const key of [
    "type",
    "enabled",
    "held",
    "minFrameMs",
    "maxPowerCycles",
    "powerCyclePlugin",
    "cleanupLegacyApps",
    "something-new",
  ])
    assert.equal(changeImpact(key), "restart", key);
});

// ---------------------------------------------------------------------------
// F5: the browser
// ---------------------------------------------------------------------------

test("F5: a snapshot that a newer source has overtaken is dropped: the late bootstrap answer of the earlier run does not replace the new run's state", () => {
  const fence = createClientFence();
  // The page asks for the bootstrap of run aaaaaaaa; the answer is slow.
  const bootstrap = openSource(fence, "bootstrap");
  // pixdcon restarts. The stream reconnects and delivers the new snapshot.
  const stream = openSource(fence, "stream");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "bbbbbbbb", seq: 4 },
      { generation: stream },
    ),
    { action: "apply", reason: "new_epoch", keep: [], gone: [] },
  );
  // Now the old answer arrives.
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "aaaaaaaa", seq: 900 },
      { generation: bootstrap },
    ),
    { action: "drop", reason: "superseded_source", keep: [], gone: [] },
  );
  assert.deepEqual([fence.epoch, fence.seq], ["bbbbbbbb", 4]);

  // A newer bootstrap request of the same run with an older position than
  // the events already applied is dropped too; a newer one is applied.
  assert.equal(
    decideEvent(fence, { epoch: "bbbbbbbb", seq: 9, stream }).action,
    "apply",
  );
  const reload = openSource(fence, "bootstrap");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "bbbbbbbb", seq: 7 },
      { generation: reload },
    ),
    { action: "drop", reason: "not_newer", keep: [], gone: [] },
  );
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "bbbbbbbb", seq: 9 },
      { generation: reload },
    ),
    { action: "apply", reason: "current", keep: [], gone: [] },
  );
});

test("F5: an event is applied only on the newest stream, in the page's epoch, with a higher seq; epoch and seq come from the event id", () => {
  assert.deepEqual(parsePosition("0a1b2c3d-17"), {
    epoch: "0a1b2c3d",
    seq: 17,
  });
  for (const unreadable of [
    "17",
    "0a1b2c3d-",
    "0a1b2c3d-x",
    "",
    null,
    undefined,
    "0A1B2C3D-17",
  ])
    assert.equal(parsePosition(unreadable), null, String(unreadable));

  const fence = createClientFence();
  const first = openSource(fence, "stream");
  assert.equal(
    decideEvent(fence, { epoch: "aaaaaaaa", seq: 1, stream: first }).reason,
    "no_snapshot",
  );
  decideSnapshot(fence, { epoch: "aaaaaaaa", seq: 10 }, { generation: first });

  assert.equal(
    decideEvent(fence, {
      epoch: "aaaaaaaa",
      seq: 11,
      stream: first,
      type: "overlays",
    }).action,
    "apply",
  );
  assert.equal(
    decideEvent(fence, { epoch: "aaaaaaaa", seq: 11, stream: first }).reason,
    "not_newer",
    "the same position twice",
  );
  assert.equal(
    decideEvent(fence, { epoch: "aaaaaaaa", seq: 9, stream: first }).reason,
    "not_newer",
    "a position before the snapshot",
  );
  assert.equal(
    decideEvent(fence, { epoch: "cccccccc", seq: 12, stream: first }).reason,
    "other_epoch",
  );

  // The page reconnects. An event of the old stream that was still queued
  // is dropped, whatever its seq.
  const second = openSource(fence, "stream");
  assert.equal(
    decideEvent(fence, { epoch: "aaaaaaaa", seq: 12, stream: first }).reason,
    "superseded_source",
  );
  assert.equal(
    decideEvent(fence, { epoch: "aaaaaaaa", seq: 12, stream: second }).action,
    "apply",
  );
  assert.equal(fence.seq, 12);
});

test("F5: views and answers. An older rev, an answer of an overtaken request, an answer that stands before what is shown, and a view of a removed device are dropped", () => {
  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(fence, { epoch: "aaaaaaaa", seq: 10 }, { generation: stream });
  /** @param {string} key @param {number} rev @param {number} seq @param {string} [epoch] */
  const view = (key, rev, seq, epoch = "aaaaaaaa") =>
    decideView(fence, { key, epoch, rev, seq });

  // Device views: epoch and rev.
  assert.equal(view("device:pixoo-t", 5, 11).action, "apply");
  assert.equal(view("device:pixoo-t", 5, 12).reason, "not_newer");
  assert.equal(
    view("device:pixoo-t", 4, 12).reason,
    "not_newer",
    "the late answer of an earlier write",
  );
  assert.equal(
    view("device:pixoo-t", 99, 12, "bbbbbbbb").reason,
    "other_epoch",
  );
  assert.equal(
    view("device:ulanzi-t", 1, 12).action,
    "apply",
    "revs are per device",
  );
  assert.equal(
    decideView(
      fence,
      /** @type {any} */ ({ key: "device:pixoo-t", epoch: "aaaaaaaa", rev: 9 }),
    ).reason,
    "no_position",
    "a view always says where it stands",
  );

  // The device is removed at seq 20. The answer of a write that was built
  // before that does not bring it back; a later event does.
  decideEvent(fence, { epoch: "aaaaaaaa", seq: 20, stream });
  forgetDevice(fence, "pixoo-t", 20);
  assert.equal(view("device:pixoo-t", 6, 19).reason, "removed");
  assert.equal(view("device:pixoo-t", 6, 20).reason, "removed");
  assert.equal(
    view("device:pixoo-t", 1, 21).action,
    "apply",
    "added again: it starts fresh",
  );

  // Whole resources: the newest request, and not before what is shown.
  const slow = beginRequest(fence, "overlays");
  const fast = beginRequest(fence, "overlays");
  assert.equal(
    decideAnswer(fence, {
      resource: "overlays",
      generation: fast,
      epoch: "aaaaaaaa",
      seq: 20,
    }).action,
    "apply",
  );
  assert.equal(
    decideAnswer(fence, {
      resource: "overlays",
      generation: slow,
      epoch: "aaaaaaaa",
      seq: 20,
    }).reason,
    "superseded_source",
  );
  decideEvent(fence, { epoch: "aaaaaaaa", seq: 25, stream, type: "overlays" });
  const late = beginRequest(fence, "overlays");
  assert.equal(
    decideAnswer(fence, {
      resource: "overlays",
      generation: late,
      epoch: "aaaaaaaa",
      seq: 22,
    }).reason,
    "not_newer",
    "built before the event that is shown",
  );
  assert.equal(
    decideAnswer(fence, {
      resource: "overlays",
      generation: late,
      epoch: "bbbbbbbb",
      seq: 30,
    }).reason,
    "other_epoch",
  );
  assert.equal(
    decideAnswer(fence, {
      resource: "config",
      generation: beginRequest(fence, "config"),
      epoch: "aaaaaaaa",
      seq: 25,
    }).action,
    "apply",
  );

  // A snapshot of a new run forgets all of it.
  const next = openSource(fence, "stream");
  decideSnapshot(fence, { epoch: "bbbbbbbb", seq: 1 }, { generation: next });
  assert.equal(view("device:pixoo-t", 1, 1, "bbbbbbbb").action, "apply");
});

// ---------------------------------------------------------------------------
// Cross-read round 3: N4, the browser
// ---------------------------------------------------------------------------

test("N4 a: a snapshot is a copy of every resource at its position. The answer of an overlay request that was started before a newer snapshot, and stands before it, changes nothing", () => {
  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(fence, { epoch: "aaaaaaaa", seq: 10 }, { generation: stream });

  // The page asks for the overlay list. Before the answer arrives the
  // stream reconnects and delivers a snapshot at seq 30.
  const request = beginRequest(fence, "overlays");
  const reload = openSource(fence, "stream");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "aaaaaaaa", seq: 30 },
      { generation: reload },
    ),
    { action: "apply", reason: "current", keep: [], gone: [] },
  );
  assert.equal(fence.applied.get("overlays"), 30);

  // The pending answer was built at seq 15.
  assert.deepEqual(
    decideAnswer(fence, {
      resource: "overlays",
      generation: request,
      epoch: "aaaaaaaa",
      seq: 15,
    }),
    { action: "drop", reason: "not_newer" },
    "it stands before the copy the snapshot brought",
  );
  // Every resource a snapshot carries has that floor, also one that was
  // never asked for or changed by an event.
  for (const resource of ["controller", "mqtt", "config", "scenes", "builtins"])
    assert.equal(
      decideAnswer(fence, {
        resource,
        generation: beginRequest(fence, resource),
        epoch: "aaaaaaaa",
        seq: 29,
      }).reason,
      "not_newer",
      resource,
    );
  // An answer at the snapshot's position, or after it, is taken.
  assert.equal(
    decideAnswer(fence, {
      resource: "overlays",
      generation: beginRequest(fence, "overlays"),
      epoch: "aaaaaaaa",
      seq: 30,
    }).action,
    "apply",
  );
  // What a snapshot does not carry has no floor from it (a settings state,
  // the log): its own request and its own position decide.
  assert.equal(
    decideAnswer(fence, {
      resource: "log",
      generation: beginRequest(fence, "log"),
      epoch: "aaaaaaaa",
      seq: 12,
    }).action,
    "apply",
  );
});

test("N4 a siblings: an answer that stands after what the stream has delivered is the newer copy. Neither a later event with a lower position nor a snapshot with a lower position puts the older copy back", () => {
  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(fence, { epoch: "aaaaaaaa", seq: 30 }, { generation: stream });

  // A write's answer carries the overlay list as of seq 40. The stream is
  // behind: its last event was 30.
  assert.equal(
    decideAnswer(fence, {
      resource: "overlays",
      generation: beginRequest(fence, "overlays"),
      epoch: "aaaaaaaa",
      seq: 40,
    }).action,
    "apply",
  );

  // The stream catches up. Event 38 carries the list as of 38: the page's
  // position moves, the older list is not taken.
  assert.deepEqual(
    decideEvent(fence, {
      epoch: "aaaaaaaa",
      seq: 38,
      stream,
      type: "overlays",
    }),
    { action: "drop", reason: "newer_copy" },
  );
  assert.equal(fence.seq, 38, "the position moved");
  assert.equal(fence.applied.get("overlays"), 40);
  // Event 39 of another resource is applied as ever.
  assert.equal(
    decideEvent(fence, { epoch: "aaaaaaaa", seq: 39, stream, type: "config" })
      .action,
    "apply",
  );

  // The stream reconnects and delivers a snapshot at 39: applied, except
  // for the overlay list, of which the page holds the copy of 40.
  const reload = openSource(fence, "stream");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "aaaaaaaa", seq: 39 },
      { generation: reload },
    ),
    { action: "apply", reason: "current", keep: ["overlays"], gone: [] },
  );
  // From 40 on the stream is the newer copy again.
  assert.equal(
    decideEvent(fence, {
      epoch: "aaaaaaaa",
      seq: 41,
      stream: reload,
      type: "overlays",
    }).action,
    "apply",
  );
});

test("N4 b: a device that left and came back counts its revs from 1 again. The late answer of a write to the old device (rev 20, built before the removal) is dropped by the position of the removal, which stays after the re-add", () => {
  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(fence, { epoch: "aaaaaaaa", seq: 10 }, { generation: stream });
  /** @param {number} rev @param {number} seq */
  const view = (rev, seq) =>
    decideView(fence, { key: "device:D", epoch: "aaaaaaaa", rev, seq });
  assert.equal(view(19, 18).action, "apply");

  // Removed at seq 20, added again at seq 21 with rev 1.
  decideEvent(fence, { epoch: "aaaaaaaa", seq: 20, stream });
  forgetDevice(fence, "D", 20);
  decideEvent(fence, { epoch: "aaaaaaaa", seq: 21, stream });
  assert.equal(view(1, 21).action, "apply");

  // The answer of a write to the old device arrives now.
  assert.deepEqual(view(20, 19), { action: "drop", reason: "removed" });
  assert.equal(fence.revs.get("device:D"), 1, "the new device is untouched");
  assert.equal(fence.removed.get("D"), 20, "the mark stays for the epoch");

  // The new device goes on; a second life works the same way.
  assert.equal(view(2, 22).action, "apply");
  decideEvent(fence, { epoch: "aaaaaaaa", seq: 30, stream });
  forgetDevice(fence, "D", 30);
  assert.equal(view(3, 25).reason, "removed", "a view of the second life");
  assert.equal(view(1, 31).action, "apply");
  assert.equal(fence.removed.get("D"), 30);
  forgetDevice(fence, "D", 12);
  assert.equal(fence.removed.get("D"), 30, "the mark never moves back");
});

test("N4 b siblings: the settings states of a removed device go with it, a snapshot that does not list a device removes it with the snapshot's position, and a device the page never held is not brought in by a copy that stands before the snapshot", () => {
  assert.equal(deviceOf("device:pixoo-t"), "pixoo-t");
  assert.equal(deviceOf("settings:pixoo-t/home3"), "pixoo-t");

  const fence = createClientFence();
  const stream = openSource(fence, "stream");
  decideSnapshot(
    fence,
    { epoch: "aaaaaaaa", seq: 10, devices: ["A", "B"] },
    { generation: stream },
  );
  /** @param {string} key @param {number} rev @param {number} seq */
  const view = (key, rev, seq) =>
    decideView(fence, { key, epoch: "aaaaaaaa", rev, seq });
  assert.equal(view("device:A", 3, 10).action, "apply");
  assert.equal(view("device:B", 7, 10).action, "apply");
  assert.equal(view("settings:B/clock", 4, 12).action, "apply");

  // A write's answer adds device C at seq 26, ahead of the stream.
  assert.equal(view("device:C", 1, 26).action, "apply");

  // The stream reconnects; its snapshot at seq 25 lists A only. B left
  // before it. C was added after it, so the page keeps C.
  const reload = openSource(fence, "stream");
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "aaaaaaaa", seq: 25, devices: ["A"] },
      { generation: reload },
    ),
    { action: "apply", reason: "current", keep: [], gone: ["B"] },
  );
  assert.equal(fence.revs.has("device:B"), false);
  assert.equal(fence.revs.has("settings:B/clock"), false);
  assert.equal(fence.revs.has("device:C"), true);

  // Late answers about B, built before the snapshot: dropped, the device
  // view and the settings state alike.
  assert.equal(view("device:B", 8, 24).reason, "removed");
  assert.equal(view("settings:B/clock", 5, 24).reason, "removed");
  // A device the page never held, in a copy older than the snapshot: the
  // snapshot did not list it.
  assert.equal(view("device:Z", 2, 20).reason, "removed");
  // A settings state is not part of a snapshot: its late answer for a
  // device that is there is taken.
  assert.equal(view("settings:A/clock", 2, 20).action, "apply");
  // B comes back after the snapshot.
  assert.equal(view("device:B", 1, 27).action, "apply");
});

// ---------------------------------------------------------------------------
// F9: scene registry work in one lane
// ---------------------------------------------------------------------------

/** A promise with its resolver. */
function gate() {
  /** @type {() => void} */
  let open = () => {};
  const passed = new Promise((resolvePassed) => {
    open = () => resolvePassed(undefined);
  });
  return { open, passed };
}

test("F9: a slow import that was asked for first does not finish on top of a newer one; the lane runs them in the order they were asked for", async () => {
  const lane = createLane();
  /** @type {string[]} */
  const registry = [];
  const slow = gate();

  // Path overlay A arrives; its import takes long. Then B for the same key.
  const a = lane.run("sync A", async (position) => {
    await slow.passed;
    registry.push(`A@${position}`);
    return "a";
  });
  const b = lane.run("sync B", async (position) => {
    registry.push(`B@${position}`);
    return "b";
  });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(registry, [], "B waits for A, although it would be faster");
  assert.equal(lane.pending(), 2);

  slow.open();
  assert.deepEqual(await a, { ran: true, value: "a" });
  assert.deepEqual(await b, { ran: true, value: "b" });
  assert.deepEqual(registry, ["A@1", "B@2"], "the newer one is applied last");
  assert.equal(lane.pending(), 0);
});

test("F9: a scene map change that arrives during the first load is applied after it, the start waits for both, and a failing piece does not stop the lane", async () => {
  /** @type {Array<[string, string]>} */
  const errors = [];
  const lane = createLane({
    onError: (name, error) => errors.push([name, String(error)]),
  });
  /** @type {string[]} */
  const done = [];
  const loading = gate();

  void lane.run("first load", async () => {
    await loading.passed;
    done.push("load");
  });
  // While the load runs: a path overlay arrives, then a file changes.
  void lane.run("scene map changed", () => {
    done.push("sync");
    throw new Error("import failed");
  });
  let started = false;
  const start = lane.drain().then(() => {
    started = true;
  });
  void lane.run("scene file changed", () => {
    done.push("refresh");
  });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(
    started,
    false,
    "nothing that reads scenes starts while the lane is busy",
  );

  loading.open();
  await start;
  assert.deepEqual(done, ["load", "sync", "refresh"]);
  assert.deepEqual(errors, [["scene map changed", "Error: import failed"]]);
});

test("F9: at shutdown the lane is closed: the piece that runs finishes, pieces that have not started are skipped, and drain waits for exactly that", async () => {
  const lane = createLane();
  /** @type {string[]} */
  const done = [];
  const running = gate();
  const first = lane.run("running", async () => {
    await running.passed;
    done.push("running");
  });
  const second = lane.run("queued", () => {
    done.push("queued");
  });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  lane.close();
  assert.equal(lane.closed(), true);
  const drained = lane.drain();
  running.open();
  await drained;
  assert.deepEqual(done, ["running"]);
  assert.deepEqual(await first, { ran: true, value: undefined });
  assert.deepEqual(await second, { ran: false });
  assert.deepEqual(await lane.run("after close", () => done.push("late")), {
    ran: false,
  });
  assert.deepEqual(done, ["running"]);
});

// ---------------------------------------------------------------------------
// Cross-read round 3: N7, work that is running when the lane is closed
// ---------------------------------------------------------------------------

test("N7: closing the lane aborts its signal. The piece that is running cannot be stopped, so it is told: what it awaited commits nothing once the signal is aborted, and its next step does not happen, however long after the close it comes back", async () => {
  const lane = createLane();
  /** @type {string[]} */
  const done = [];
  const importing = gate();
  let committed = 0;

  /** A stand-in for the registry: it imports, then commits unless told not to. @param {AbortSignal} signal */
  const sync = async (signal) => {
    done.push("import started");
    await importing.passed;
    if (signal.aborted) return { keys: [] };
    committed += 1;
    return { keys: ["clock"] };
  };
  // main.js runs its scene work in exactly this shape.
  const running = lane.runThen(
    "scene map changed",
    (signal) => sync(signal),
    ({ keys }) => {
      done.push(`invalidate ${keys}`);
    },
  );
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(lane.signal.aborted, false);

  // Shutdown: the lane is closed, the wait for it runs out, scenes are
  // released, stop returns. The import is still running.
  lane.close();
  assert.equal(lane.signal.aborted, true);
  done.push("released");
  assert.equal(lane.pending(), 1, "waiting for it would not have ended");

  // Now the import comes back.
  importing.open();
  assert.deepEqual(await running, { ran: true, value: undefined });
  assert.deepEqual(done, ["import started", "released"]);
  assert.equal(committed, 0, "nothing was committed");
  assert.equal(lane.pending(), 0);

  // A lane that is open hands its pieces a signal that is not aborted, and
  // the second step follows the first.
  const open = createLane();
  assert.deepEqual(
    await open.run("piece", (position, signal) => [position, signal.aborted]),
    { ran: true, value: [1, false] },
  );
  assert.deepEqual(
    await open.runThen(
      "work, then",
      (signal, position) => [position, signal.aborted],
      (result) => ["then", ...result],
    ),
    { ran: true, value: ["then", 2, false] },
  );
});
