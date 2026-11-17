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
  blobScenes,
  savedSuppressions,
  sceneInputs,
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
  forgetView,
  openSource,
  parsePosition,
} from "../../web/js/ordering.js";

const RETIRING = ["retire"];
const PUBLISHING = ["publish-clear", "publish-blob"];

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
      assert.deepEqual(JSON.parse(/** @type {any} */ (rewrite).payload), {
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
  assert.deepEqual(JSON.parse(p1.payload), {
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
  assert.deepEqual(JSON.parse(p2.payload), {
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
  assert.deepEqual(JSON.parse(/** @type {any} */ (rewrite).payload), {
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
  assert.deepEqual(JSON.parse(/** @type {any} */ (repair).payload), {
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
    JSON.parse(/** @type {any} */ (rewrite).payload),
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
  assert.deepEqual(JSON.parse(rewrite.payload), { devices: [{ name: "D" }] });
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
    { action: "apply", reason: "new_epoch" },
  );
  // Now the old answer arrives.
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "aaaaaaaa", seq: 900 },
      { generation: bootstrap },
    ),
    { action: "drop", reason: "superseded_source" },
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
    { action: "drop", reason: "not_newer" },
  );
  assert.deepEqual(
    decideSnapshot(
      fence,
      { epoch: "bbbbbbbb", seq: 9 },
      { generation: reload },
    ),
    { action: "apply", reason: "current" },
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

  // Device views: epoch and rev.
  assert.equal(
    decideView(fence, { key: "device:pixoo-t", epoch: "aaaaaaaa", rev: 5 })
      .action,
    "apply",
  );
  assert.equal(
    decideView(fence, { key: "device:pixoo-t", epoch: "aaaaaaaa", rev: 5 })
      .reason,
    "not_newer",
  );
  assert.equal(
    decideView(fence, { key: "device:pixoo-t", epoch: "aaaaaaaa", rev: 4 })
      .reason,
    "not_newer",
    "the late answer of an earlier write",
  );
  assert.equal(
    decideView(fence, { key: "device:pixoo-t", epoch: "bbbbbbbb", rev: 99 })
      .reason,
    "other_epoch",
  );
  assert.equal(
    decideView(fence, { key: "device:ulanzi-t", epoch: "aaaaaaaa", rev: 1 })
      .action,
    "apply",
    "revs are per device",
  );

  // The device is removed at seq 20. The answer of a write that was built
  // before that does not bring it back; a later event does.
  decideEvent(fence, { epoch: "aaaaaaaa", seq: 20, stream });
  forgetView(fence, "device:pixoo-t", 20);
  assert.equal(
    decideView(fence, {
      key: "device:pixoo-t",
      epoch: "aaaaaaaa",
      rev: 6,
      seq: 19,
    }).reason,
    "removed",
  );
  assert.equal(
    decideView(fence, { key: "device:pixoo-t", epoch: "aaaaaaaa", rev: 6 })
      .reason,
    "removed",
  );
  assert.equal(
    decideView(fence, {
      key: "device:pixoo-t",
      epoch: "aaaaaaaa",
      rev: 1,
      seq: 21,
    }).action,
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
  assert.equal(
    decideView(fence, { key: "device:pixoo-t", epoch: "bbbbbbbb", rev: 1 })
      .action,
    "apply",
  );
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
