/**
 * Test kind 2 of 3 (API and MQTT contract): the retained topics that are not
 * scene layers, after a reconnect.
 *
 * The fourth cross-read (R4-5) ran one sequence for six kinds of record: a
 * value is delivered, the connection drops, the topic is cleared on the
 * broker while pixdcon is away, the connection comes back. MQTT has no
 * message for "this topic is empty", so nothing arrives, and in round 4
 * every one of the six went on deciding until the next restart: a setting,
 * a mode, a brightness override, an address, a switch-off, a scene path.
 *
 * The rule now (src/overlay/topic-fence.js): after a reconnect a record
 * that the current connection has not delivered again commands nothing and
 * keeps holding back what it held back. What only changes the content of a
 * display is a command and waits; what decides whether pixdcon touches a
 * display at all is kept (`enabled` false, an address that is not
 * confirmed).
 *
 * The same file closes the R4-1 class for these topics: the mirror names
 * the keys that changed by comparing every key before and after a step. So
 * every sequence here runs with a reader that computes again only when a
 * "changed" effect names a key, and compares it with a reader of the whole
 * state after every step.
 *
 * The random walk at the end does for these topics what
 * ordering-model.test.js does for the scene layers.
 *
 * Owner: core/state worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  OVERRIDE_KINDS,
  PROTECTIVE_KINDS,
  createMirror,
  overrideEffect,
  ownWrite,
  ownWriteFailed,
  fenceTopic,
  newTopicRecord,
  reduceMirror,
  saysOff,
  topicView,
} from "../../src/overlay/topic-fence.js";
import { overlayDevicePatch } from "../../src/state/runtime-config.js";

/** @typedef {import("../../src/overlay/topic-fence.js").MirrorInput} MirrorInput */
/** @typedef {import("../../src/overlay/topic-fence.js").OverrideKind} OverrideKind */
/** @typedef {import("../../src/overlay/topic-fence.js").TopicView} TopicView */

/**
 * The mirror with the reader that follows its effects: `feed` puts an input
 * through the reducer, lets the reader compute again for exactly the keys a
 * "changed" effect names, and then compares the reader with the whole
 * state. That comparison is the R4-1 invariant; every test below runs it
 * after every step.
 */
function mirrorWorld() {
  let state = createMirror();
  /** What the reader holds. @type {Map<string, TopicView|null>} */
  const reader = new Map();
  /** @type {Array<{keys: string[], on: string}>} */
  const effects = [];

  /** @param {MirrorInput} input */
  const feed = (input) => {
    const result = reduceMirror(state, input);
    state = result.state;
    for (const effect of result.effects) {
      effects.push({ keys: effect.keys, on: input.type });
      for (const key of effect.keys) reader.set(key, topicView(state, key));
    }
    for (const key of new Set([...state.topics.keys(), ...reader.keys()]))
      assert.deepEqual(
        reader.get(key) ?? null,
        topicView(state, key),
        `a reader that follows the effects holds another view of ${key} than the state after ${input.type}`,
      );
    return result;
  };

  /** The service numbers its own writes. */
  let writes = 0;

  return {
    feed,
    state: () => state,
    effects,
    /** @param {string} key */
    view: (key) => topicView(state, key),
    /**
     * An own write of the service: numbered, and handed to the mirror
     * before it is published.
     *
     * @param {string} key
     * @param {OverrideKind} kind
     * @param {string} payload "" clears
     */
    write(key, kind, payload) {
      const write = ++writes;
      return {
        write,
        ...feed({ type: "own-write", key, kind, payload, write }),
      };
    },
    /**
     * The outcome of an own write.
     *
     * @param {string} key
     * @param {number} write
     * @param {"confirmed"|"failed"} outcome
     */
    published: (key, write, outcome) =>
      feed({ type: "published", key, write, outcome }),
    /** @param {number} connection */
    connect: (connection) => feed({ type: "connect", connection }),
    /** @param {number} connection */
    disconnect: (connection) => feed({ type: "disconnect", connection }),
    /**
     * @param {string} key
     * @param {OverrideKind} kind
     * @param {string} payload
     * @param {{retain: boolean, connection: number}} meta
     */
    message: (key, kind, payload, meta) =>
      feed({ type: "message", key, kind, payload, ...meta }),
    /** The keys the effects named since the mark. @param {number} mark */
    changedSince: (mark) => effects.slice(mark).flatMap(({ keys }) => keys),
  };
}

/**
 * What runs, given the record's view and what applies without it.
 *
 * @param {TopicView|null} view
 * @param {string} fallback the saved value, the default, config.json's value
 * @returns {string} "off" and "held" name a device that is not started
 */
function runs(view, fallback) {
  if (view?.restriction) return view.restriction;
  return view?.command ?? fallback;
}

/** The six kinds as the fourth cross-read ran them. */
const CASES = /** @type {const} */ ([
  {
    kind: "setting",
    key: "setting:D:clock:night_start_hour",
    value: "77",
    fallback: "10",
    whatFallsBack: "the saved value",
    after: "10",
  },
  {
    kind: "mode",
    key: "mode:D",
    value: "pause",
    fallback: "play",
    whatFallsBack: "play",
    after: "play",
  },
  {
    kind: "brightness",
    key: "brightness:D",
    value: '{"enabled":true,"value":100}',
    fallback: "automatic",
    whatFallsBack: "the scene's own brightness",
    after: "automatic",
  },
  {
    kind: "scene-path",
    key: "scene-path:clock",
    value: "./temporary.js",
    fallback: "./saved.js",
    whatFallsBack: "the path of config.json",
    after: "./saved.js",
  },
  {
    kind: "device-ip",
    key: "device-ip:D",
    value: "192.0.2.22",
    fallback: "192.0.2.11",
    whatFallsBack: "nothing: the device is held",
    after: "held",
  },
  {
    kind: "device-enabled",
    key: "device-enabled:D",
    value: "false",
    fallback: "started",
    whatFallsBack: "nothing: the device stays off",
    after: "off",
  },
]);

test("R4-5: the six kinds are the six kinds of retained topic that are not scene layers, and two of them are protective", () => {
  assert.deepEqual(
    [...OVERRIDE_KINDS].sort(),
    CASES.map(({ kind }) => kind).sort(),
  );
  assert.deepEqual([...PROTECTIVE_KINDS], ["device-enabled", "device-ip"]);
});

for (const { kind, key, value, fallback, whatFallsBack, after } of CASES) {
  test(`R4-5 ${kind}: a value that was cleared on the broker while pixdcon was away commands nothing after the reconnect; what applies is ${whatFallsBack}. Nothing changes at the disconnect itself, and the record stays, listed as not confirmed`, () => {
    const w = mirrorWorld();
    w.connect(1);
    w.message(key, kind, value, { retain: false, connection: 1 });
    const live = w.view(key);
    assert.equal(live?.confirmed, true);
    assert.equal(
      runs(live, fallback),
      kind === "device-enabled" ? "off" : value,
    );

    // The connection drops. While the broker is away the values of the
    // last connection keep their say.
    let mark = w.effects.length;
    w.disconnect(1);
    assert.deepEqual(w.changedSince(mark), [], "a disconnect changes nothing");
    assert.deepEqual(w.view(key), live);

    // Somebody clears the topic on the broker. The next connection has
    // nothing to deliver for it: there is no message for "this is empty".
    mark = w.effects.length;
    w.connect(2);
    assert.deepEqual(
      w.changedSince(mark),
      [key],
      "the connect itself is announced: who has a say changed",
    );
    const waiting = w.view(key);
    assert.deepEqual(
      waiting && {
        value: waiting.value,
        confirmed: waiting.confirmed,
        command: waiting.command,
        connection: waiting.connection,
      },
      { value, confirmed: false, command: null, connection: 1 },
      "the record is still there, of connection 1, and commands nothing",
    );
    assert.equal(runs(waiting, fallback), after);

    // A process that starts now holds nothing for the topic. For what a
    // record commands, the process that was running holds the same.
    const cold = mirrorWorld();
    cold.connect(1);
    assert.equal(
      waiting?.command ?? null,
      cold.view(key)?.command ?? null,
      "warm equals cold for commands",
    );
    assert.equal(
      waiting?.restriction ?? null,
      PROTECTIVE_KINDS.some((protective) => protective === kind) ? after : null,
      "only what decides whether a display is touched is kept",
    );

    // Nothing else moves it: another reconnect, a message of the
    // connection that is gone.
    mark = w.effects.length;
    w.disconnect(2);
    w.connect(3);
    const stale = w.message(key, kind, value, { retain: true, connection: 2 });
    assert.equal(stale.decision.reason, "superseded_source");
    assert.deepEqual(w.changedSince(mark), []);
    assert.equal(runs(w.view(key), fallback), after);
  });

  test(`R4-5 ${kind}: a value that is still stored gets its say back the moment the new connection delivers it, however late, as a replay or as a live message. The replay changes no value, and is announced`, () => {
    for (const retain of [true, false]) {
      const w = mirrorWorld();
      w.connect(1);
      w.message(key, kind, value, { retain: true, connection: 1 });
      const before = w.view(key);
      w.disconnect(1);
      w.connect(2);
      assert.equal(w.view(key)?.confirmed, false);

      // Other topics are delivered first; this one is held back.
      w.message("mode:other", "mode", "stop", { retain: true, connection: 2 });
      assert.equal(w.view(key)?.confirmed, false);

      const mark = w.effects.length;
      const late = w.message(key, kind, value, { retain, connection: 2 });
      assert.equal(late.decision.action, "apply");
      assert.deepEqual(
        w.changedSince(mark),
        [key],
        "the value is the same as before; the record's say is not",
      );
      const back = w.view(key);
      assert.deepEqual(
        back && [back.confirmed, back.command, back.restriction],
        before && [true, before.command, before.restriction],
      );
      assert.equal(back?.connection, 2);
      assert.equal(
        runs(back, fallback),
        kind === "device-enabled" ? "off" : value,
      );
    }
  });
}

test("R4-5: a restriction ends only by a delivered message of its topic. A connect, a disconnect and a message of a connection that is gone leave a switched-off device off and a held device held; a clear, or another value, on the current connection releases it", () => {
  const off = "device-enabled:D";
  const ip = "device-ip:D";
  const w = mirrorWorld();
  w.connect(1);
  w.message(off, "device-enabled", "false", { retain: true, connection: 1 });
  w.message(ip, "device-ip", "192.0.2.22", { retain: true, connection: 1 });
  assert.equal(w.view(off)?.restriction, "off");
  assert.equal(
    w.view(ip)?.restriction,
    null,
    "a confirmed address is a command",
  );
  assert.equal(w.view(ip)?.command, "192.0.2.22");

  // Three reconnects without a replay, and what a gone connection still
  // hands over.
  for (const connection of [2, 3, 4]) {
    w.disconnect(connection - 1);
    w.connect(connection);
    assert.equal(
      w.message(off, "device-enabled", "", {
        retain: false,
        connection: connection - 1,
      }).decision.reason,
      "superseded_source",
    );
    assert.equal(w.view(off)?.restriction, "off");
    assert.equal(w.view(ip)?.restriction, "held");
    assert.equal(
      w.view(ip)?.command,
      null,
      "held: neither the overlay's address nor config.json's is driven",
    );
  }

  // The address: the replay of another value is a confirmed command.
  let mark = w.effects.length;
  w.message(ip, "device-ip", "192.0.2.33", { retain: true, connection: 4 });
  assert.deepEqual(w.changedSince(mark), [ip]);
  assert.deepEqual(
    [w.view(ip)?.command, w.view(ip)?.restriction],
    ["192.0.2.33", null],
  );
  // …and a live clear ends it: config.json's address applies.
  w.message(ip, "device-ip", "", { retain: false, connection: 4 });
  assert.equal(w.view(ip), null);

  // The switch-off: only "false" switches off, in any case; another value
  // releases, and so does a clear.
  assert.equal(saysOff(" False "), true);
  assert.equal(saysOff("0"), false);
  mark = w.effects.length;
  w.message(off, "device-enabled", "true", { retain: true, connection: 4 });
  assert.deepEqual(w.changedSince(mark), [off]);
  assert.deepEqual(
    [w.view(off)?.restriction, w.view(off)?.command],
    [null, null],
    "released, and an overlay never switches a device on: no command",
  );
  w.message(off, "device-enabled", " FALSE", { retain: false, connection: 4 });
  assert.equal(w.view(off)?.restriction, "off");
  w.message(off, "device-enabled", "", { retain: false, connection: 4 });
  assert.equal(w.view(off), null);
});

test("R4-5: pixdcon's own clear of a restriction is not applied in the process, as a mode change is. It is published, and the device is released on evidence: the broker's acknowledgement, or the clear delivered back. What arrives before its echo is older than it; a clear that was not sent, or that is lost with its connection, releases nothing", () => {
  const off = "device-enabled:D";
  const w = mirrorWorld();
  w.connect(1);
  w.message(off, "device-enabled", "false", { retain: true, connection: 1 });

  // "Clear" on the Overlays page.
  let mark = w.effects.length;
  let clear = w.write(off, "device-enabled", "");
  assert.deepEqual(clear.decision, { action: "hold", reason: "awaits_broker" });
  assert.deepEqual(w.changedSince(mark), []);
  assert.equal(w.view(off)?.restriction, "off", "still off: nothing is known");

  // Somebody's "false" that the broker processed before the clear arrives
  // first: older than the clear, the device stays off. Then the
  // acknowledgement: the store is empty as of the clear. Released.
  assert.equal(
    w.message(off, "device-enabled", "false", { retain: false, connection: 1 })
      .decision.reason,
    "before_own_write",
  );
  mark = w.effects.length;
  assert.deepEqual(w.published(off, clear.write, "confirmed").decision, {
    action: "apply",
    reason: "own_ack",
  });
  assert.deepEqual(w.changedSince(mark), [off]);
  assert.equal(w.view(off), null);
  // Another "false" from before the clear, delivered after the
  // acknowledgement and before the echo: it does not switch the device off
  // again for a moment.
  mark = w.effects.length;
  w.message(off, "device-enabled", "false", { retain: false, connection: 1 });
  assert.deepEqual(w.changedSince(mark), []);
  assert.equal(w.view(off), null);
  // The echo: nothing left to do. Told again, the outcome is of a write
  // that is not on its way any more.
  assert.equal(
    w.message(off, "device-enabled", "", { retain: false, connection: 1 })
      .decision.reason,
    "own_echo",
  );
  for (const again of /** @type {const} */ (["confirmed", "failed"]))
    assert.equal(
      w.published(off, clear.write, again).decision.reason,
      "unknown_write",
    );
  // After the echo a "false" is a new command.
  w.message(off, "device-enabled", "false", { retain: false, connection: 1 });
  assert.equal(w.view(off)?.restriction, "off");

  // The echo without an acknowledgement before it releases as well.
  w.write(off, "device-enabled", "");
  mark = w.effects.length;
  assert.equal(
    w.message(off, "device-enabled", "", { retain: false, connection: 1 })
      .decision.reason,
    "own_echo",
  );
  assert.deepEqual(w.changedSince(mark), [off]);
  assert.equal(w.view(off), null);

  // A clear that was certainly not sent releases nothing.
  w.message(off, "device-enabled", "false", { retain: false, connection: 1 });
  clear = w.write(off, "device-enabled", "");
  mark = w.effects.length;
  assert.equal(
    w.published(off, clear.write, "failed").decision.action,
    "apply",
  );
  assert.deepEqual(w.changedSince(mark), []);
  assert.equal(w.view(off)?.restriction, "off");
  // …unless a message that was delivered meanwhile did: with no own write
  // on its way any more, it is no longer older than one.
  clear = w.write(off, "device-enabled", "");
  w.message(off, "device-enabled", "true", { retain: false, connection: 1 });
  assert.equal(w.view(off)?.restriction, "off", "older than the clear");
  w.published(off, clear.write, "failed");
  assert.deepEqual(
    [w.view(off)?.value, w.view(off)?.restriction],
    ["true", null],
    "the store holds the other client's value",
  );

  // The same for an address, lost with its connection: the device stays
  // held on every later connection, and the outcome of the lost write says
  // nothing there. A second clear, acknowledged, releases it.
  const ip = "device-ip:D";
  w.message(ip, "device-ip", "192.0.2.22", { retain: false, connection: 1 });
  const lost = w.write(ip, "device-ip", "");
  assert.equal(lost.decision.action, "hold");
  w.disconnect(1);
  w.connect(2);
  assert.equal(w.view(ip)?.restriction, "held");
  assert.equal(
    w.published(ip, lost.write, "confirmed").decision.reason,
    "unknown_write",
  );
  assert.equal(w.view(ip)?.restriction, "held");
  w.published(ip, w.write(ip, "device-ip", "").write, "confirmed");
  assert.equal(w.view(ip), null);

  // Without a connection nothing is written at all.
  w.disconnect(2);
  assert.deepEqual(w.write("mode:D", "mode", "pause").decision, {
    action: "drop",
    reason: "offline",
  });
  assert.equal(w.view("mode:D"), null);
  assert.equal(w.write(off, "device-enabled", "").decision.reason, "offline");
});

test("R4-5: an own write is a command like any other. A pause from the UI holds while its connection is the current one, lapses at the reconnect, and is back when the broker replays it; one that never reached the broker stays gone", () => {
  const key = "mode:D";
  const w = mirrorWorld();
  w.connect(1);
  assert.equal(w.write(key, "mode", "pause").decision.action, "apply");
  assert.deepEqual(
    [w.view(key)?.command, w.view(key)?.origin, w.view(key)?.connection],
    ["pause", "own", 1],
    "applied at once, before the broker has answered",
  );
  assert.equal(
    w.message(key, "mode", "pause", { retain: false, connection: 1 }).decision
      .reason,
    "own_echo",
  );
  assert.equal(runs(w.view(key), "play"), "pause");

  // Broker restart. Until the replay arrives the display plays: the
  // debounce of the overlay service covers a replay that comes at once.
  w.disconnect(1);
  assert.equal(runs(w.view(key), "play"), "pause", "kept while away");
  w.connect(2);
  assert.equal(runs(w.view(key), "play"), "play");
  w.message(key, "mode", "pause", { retain: true, connection: 2 });
  assert.equal(runs(w.view(key), "play"), "pause");

  // A second pause-then-stop: "stop" is on its way when the connection
  // drops, and the broker never gets it. The store holds "pause".
  w.write(key, "mode", "stop");
  assert.equal(runs(w.view(key), "play"), "stop");
  w.disconnect(2);
  w.connect(3);
  assert.equal(
    runs(w.view(key), "play"),
    "play",
    "nothing is in effect that this connection has not delivered",
  );
  w.message(key, "mode", "pause", { retain: true, connection: 3 });
  assert.equal(
    runs(w.view(key), "play"),
    "pause",
    "what the store holds, not what the process last wrote",
  );
});

test("R4-5 sibling: an own write that was not sent falls back to what the store held, with the authority of the connection that delivered that. A value of the connection before does not come back confirmed through a failed write, and a write has a name: the outcome of one says nothing about another with the same payload", () => {
  const key = "mode:D";
  const w = mirrorWorld();
  w.connect(1);
  w.message(key, "mode", "stop", { retain: false, connection: 1 });
  w.disconnect(1);
  w.connect(2);
  assert.equal(
    runs(w.view(key), "play"),
    "play",
    "stop waits for connection 2",
  );

  // The user presses pause; the publish fails at once.
  let pause = w.write(key, "mode", "pause");
  assert.equal(runs(w.view(key), "play"), "pause");
  const mark = w.effects.length;
  assert.equal(
    w.published(key, pause.write, "failed").decision.action,
    "apply",
  );
  assert.deepEqual(w.changedSince(mark), [key]);
  assert.deepEqual(
    [w.view(key)?.value, w.view(key)?.confirmed, w.view(key)?.connection],
    ["stop", false, 1],
    "back to the record of connection 1, which still waits",
  );
  assert.equal(runs(w.view(key), "play"), "play");

  // The same on the connection that delivered the value: it is confirmed.
  w.message(key, "mode", "stop", { retain: true, connection: 2 });
  pause = w.write(key, "mode", "pause");
  w.published(key, pause.write, "failed");
  assert.deepEqual(
    [w.view(key)?.command, w.view(key)?.connection],
    ["stop", 2],
  );

  // An own write that the broker acknowledged is what the store holds: when
  // the next one was not sent, the value goes back to it, not further.
  const play = w.write(key, "mode", "play");
  pause = w.write(key, "mode", "pause");
  assert.equal(
    w.published(key, play.write, "confirmed").decision.reason,
    "own_ack",
  );
  assert.equal(runs(w.view(key), "play"), "pause", "the newest own write");
  assert.equal(
    w.published(key, play.write, "failed").decision.reason,
    "unknown_write",
    "an acknowledged write was sent",
  );
  w.published(key, pause.write, "failed");
  assert.equal(runs(w.view(key), "stop"), "play");
  assert.equal(
    w.message(key, "mode", "play", { retain: false, connection: 2 }).decision
      .reason,
    "own_echo",
  );

  // Two writes of the same payload are two writes. The first was not sent;
  // the second is still on its way, and its echo is taken for what it is.
  const first = w.write(key, "mode", "pause");
  const second = w.write(key, "mode", "pause");
  w.published(key, first.write, "failed");
  assert.equal(runs(w.view(key), "play"), "pause");
  assert.equal(
    w.message(key, "mode", "pause", { retain: false, connection: 2 }).decision
      .reason,
    "own_echo",
  );
  assert.equal(
    w.published(key, second.write, "confirmed").decision.reason,
    "unknown_write",
    "echoed already",
  );

  // The outcome of a write of a connection that is gone says nothing about
  // a newer write with the same payload.
  const old = w.write(key, "mode", "stop");
  w.disconnect(2);
  w.connect(3);
  w.write(key, "mode", "stop");
  assert.equal(
    w.published(key, old.write, "failed").decision.reason,
    "unknown_write",
  );
  assert.equal(runs(w.view(key), "play"), "stop", "the write of connection 3");
  assert.equal(
    w.message(key, "mode", "stop", { retain: false, connection: 3 }).decision
      .reason,
    "own_echo",
  );

  // The plain functions say the same.
  let record = fenceTopic(
    newTopicRecord(),
    { payload: "stop", retain: true, connection: 1 },
    1,
  ).record;
  record = ownWrite(record, "pause", 2);
  assert.equal(overrideEffect("mode", record, 2).command, "pause");
  record = ownWriteFailed(record, "pause").record;
  assert.deepEqual(overrideEffect("mode", record, 2), {
    value: "stop",
    confirmed: false,
    command: null,
    restriction: null,
  });
});

test("R4-5: the mirror takes a message of a connection it has not been told about as the start of that connection, drops what a gone connection hands over, and holds nothing for a topic that only ever got a clear", () => {
  const w = mirrorWorld();
  w.connect(1);
  w.message("mode:D", "mode", "pause", { retain: true, connection: 1 });

  // The first message of connection 2 arrives before its connect event.
  const mark = w.effects.length;
  const first = w.message("brightness:D", "brightness", "40", {
    retain: true,
    connection: 2,
  });
  assert.equal(first.decision.action, "apply");
  assert.deepEqual(
    w.changedSince(mark).sort(),
    ["brightness:D", "mode:D"],
    "the new record, and the record that now waits",
  );
  assert.deepEqual([w.state().connection, w.state().connected], [2, true]);
  assert.equal(w.connect(2).decision.reason, "superseded_source");
  assert.equal(w.disconnect(1).decision.reason, "superseded_source");

  // A clear of a topic nothing is held for: no record, no notice. (A store
  // never replays an empty payload; one that claims to be a replay is
  // dropped.)
  const before = w.effects.length;
  w.message("setting:D:clock:x", "setting", "", {
    retain: false,
    connection: 2,
  });
  assert.equal(w.view("setting:D:clock:x"), null);
  assert.equal(
    w.message("setting:D:clock:y", "setting", "", {
      retain: true,
      connection: 2,
    }).decision.reason,
    "empty_replay",
  );
  assert.deepEqual(w.changedSince(before), []);

  // After the disconnect a message that names connection 2 is of a
  // connection that is gone.
  w.disconnect(2);
  assert.equal(
    w.message("mode:D", "mode", "stop", { retain: false, connection: 2 })
      .decision.reason,
    "superseded_source",
  );
});

test("R4-5 sibling, the blob: an entry of a blob that the connection has not delivered again patches nothing. `enabled` false stays, an entry with an address makes its device held, every other key waits; `output` and `supersedes` are never taken either way", () => {
  const entry = {
    name: "D",
    output: "drive",
    supersedes: { granular: {} },
    enabled: "false",
    scene: "A",
    scenes: ["A"],
    ip: "192.0.2.22",
    minFrameMs: 250,
    sceneSettings: { clock: { hour: 3 } },
  };
  assert.deepEqual(overlayDevicePatch(entry), {
    patch: {
      enabled: false,
      ip: "192.0.2.22",
      minFrameMs: 250,
      sceneSettings: { clock: { hour: 3 } },
    },
    ignored: ["output", "supersedes"],
    held: false,
    lapsed: [],
  });
  assert.deepEqual(
    overlayDevicePatch(entry, { confirmed: true }),
    overlayDevicePatch(entry),
  );
  assert.deepEqual(overlayDevicePatch(entry, { confirmed: false }), {
    patch: { enabled: false },
    ignored: ["output", "supersedes"],
    held: true,
    lapsed: ["ip", "minFrameMs", "sceneSettings"],
  });

  // An entry without an address holds nothing back: its other keys wait,
  // and the device runs as config.json says.
  assert.deepEqual(
    overlayDevicePatch({ name: "D", minFrameMs: 250 }, { confirmed: false }),
    { patch: {}, ignored: [], held: false, lapsed: ["minFrameMs"] },
  );
  // An address that is not usable is no reason to hold a device.
  for (const ip of ["", "   ", 7, null])
    assert.equal(
      overlayDevicePatch({ name: "D", ip }, { confirmed: false }).held,
      false,
      JSON.stringify(ip),
    );
  // An overlay can switch a device off, never on, confirmed or not.
  for (const confirmed of [true, false]) {
    assert.deepEqual(
      overlayDevicePatch({ name: "D", enabled: true }, { confirmed }),
      { patch: {}, ignored: ["enabled"], held: false, lapsed: [] },
    );
    assert.deepEqual(
      overlayDevicePatch({ name: "D", enabled: " False " }, { confirmed })
        .patch,
      { enabled: false },
    );
    assert.deepEqual(
      overlayDevicePatch({ name: "D", enabled: false }, { confirmed }).patch,
      { enabled: false },
    );
  }
});

// ---------------------------------------------------------------------------
// The model: random walks over the six kinds
// ---------------------------------------------------------------------------

// PIXDCON2_MODEL_WALKS and PIXDCON2_MODEL_FIRST_SEED change the size and the
// start of the run, for a longer soak by hand; the gate runs the default.
const WALKS = Number(process.env.PIXDCON2_MODEL_WALKS) || 1500;
const FIRST_SEED = Number(process.env.PIXDCON2_MODEL_FIRST_SEED) || 1;
const STEPS = 120;

const DEVICES = ["D1", "D2"];
/** Every topic of the model: the six kinds, for two devices and two scenes. @type {Array<{key: string, kind: OverrideKind}>} */
const KEYS = [
  ...DEVICES.flatMap(
    (device) =>
      /** @type {Array<{key: string, kind: OverrideKind}>} */ ([
        { key: `setting:${device}:clock:hour`, kind: "setting" },
        { key: `mode:${device}`, kind: "mode" },
        { key: `brightness:${device}`, kind: "brightness" },
        { key: `device-ip:${device}`, kind: "device-ip" },
        { key: `device-enabled:${device}`, kind: "device-enabled" },
      ]),
  ),
  { key: "scene-path:clock", kind: "scene-path" },
  { key: "scene-path:home", kind: "scene-path" },
];
const KIND_OF = new Map(KEYS.map(({ key, kind }) => [key, kind]));
const COMMAND_KINDS = OVERRIDE_KINDS.filter(
  (kind) => kind !== "device-enabled",
);

/**
 * What a run must have met to count: every decision of the fence and the
 * mirror, every kind in every situation the rule is about, the worst the
 * outside client can do, and the stated limits. A model that never reaches
 * a path proves nothing about it.
 */
const MUST_SEE = [
  "decision:current",
  "decision:own_echo",
  "decision:own_ack",
  "decision:awaits_broker",
  "decision:before_own_write",
  "decision:replay_after_live",
  "decision:superseded_source",
  "decision:unknown_write",
  "decision:offline",
  ...OVERRIDE_KINDS.map((kind) => `cleared_while_disconnected:${kind}`),
  ...COMMAND_KINDS.map((kind) => `lapsed_at_connect:${kind}`),
  ...COMMAND_KINDS.map((kind) => `restored_by_replay:${kind}`),
  ...COMMAND_KINDS.map((kind) => `waits_at_rest:${kind}`),
  "restriction:off_kept_at_connect",
  "restriction:held_at_connect",
  "restriction:released_by_own_clear_ack",
  "restriction:released_by_own_clear_echo",
  "restriction:released_by_outside_message",
  "restriction:released_after_a_failed_own_clear",
  "own_write:ack_before_echo",
  "own_write:echo_before_ack",
  "own_write:stored_and_its_echo_lost",
  "own_write:lost_with_the_connection",
  "own_write:not_sent",
  "own_write:not_sent_with_another_on_its_way",
  "own_write:outcome_of_a_connection_that_is_gone",
  "own_write:outcome_told_twice",
  "own_write:replay_before_its_echo",
  "own_write:same_payload_twice_on_its_way",
  "connect:first_message_before_the_connect_event",
  "adversary:payload_of_an_own_write_on_its_way",
  "adversary:outside_message_before_an_own_clear_of_a_restriction",
  "limit:restriction_cleared_while_away:device-enabled",
  "limit:restriction_cleared_while_away:device-ip",
  "limit:same_payload_taken_for_the_own_echo",
];

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
 * @param {TopicView|null} a
 * @param {TopicView|null} b
 * @returns {boolean}
 */
const sameView = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One random walk.
 *
 * The model:
 *  - a broker with a retained store, one topic per key. An outside client
 *    publishes and clears at any time, also while pixdcon is not connected,
 *    and publishes the payload of an own write of pixdcon that is still on
 *    its way.
 *  - a connection delivers the live messages of a topic in the order the
 *    broker processed them; a replay may be held back for any time, also
 *    past later live messages and past own echoes. The connect event may
 *    come after the first message of its connection.
 *  - pixdcon's own writes (a mode, a brightness, a clear of any kind) reach
 *    the broker later or never. The acknowledgement and the echo arrive in
 *    either order. A write may be reported as not sent, and any outcome may
 *    be told twice, or after its connection has ended.
 *  - the connection drops at any time: some of the own writes on their way
 *    reach the store, their acknowledgements and echoes are lost. A message
 *    of the old connection may still be handed over after it ended.
 *  - the process restarts at any time: nothing of the mirror survives.
 *
 * @param {number} seed
 * @param {Map<string, number>} seen counts of what the walks met (MUST_SEE)
 * @returns {number} steps taken
 */
function walk(seed, seen) {
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
      `${message}\n  seed ${seed}, after ${trace.length} steps:\n  ${trace.slice(-(Number(process.env.PIXDCON2_MODEL_TRACE) || 25)).join("\n  ")}`,
    );
  };

  /** @typedef {{key: string, payload: string, write: number}} Publish an own write on the wire */

  let mirror = createMirror();
  /** The reader that follows the effects. @type {Map<string, TopicView|null>} */
  let reader = new Map();
  /** The broker's retained store. @type {Map<string, string>} */
  const store = new Map();
  let names = 0;
  /** The service numbers its own writes; the numbers go on across restarts here, so that no two are alike in a walk. */
  let writes = 0;
  let connection = 0;
  let connected = false;
  /** Messages on their way to pixdcon; write = the echo of that own write. @type {Array<{key: string, payload: string, retain: boolean, write?: number}>} */
  let downlink = [];
  /** Own publishes on their way to the broker, in order. @type {Publish[]} */
  let uplink = [];
  /** Acknowledgements on their way to pixdcon. @type {Publish[]} */
  let acks = [];
  /** Messages of a connection that has ended, still to be handed over. @type {Array<{key: string, payload: string, retain: boolean, connection: number}>} */
  let late = [];
  /** Outcomes of own writes that are over (told already, or of a connection that has ended), to be told again. @type {Array<{key: string, write: number, outcome: "confirmed"|"failed", why: "twice"|"gone"}>} */
  let staleOutcomes = [];
  /** Per key: the payloads handed to the mirror on the connection it holds as the current one, delivered or written. @type {Map<string, Set<string>>} */
  const handed = new Map();
  /** Own writes whose echo the mirror has taken, by number. @type {Set<number>} */
  const echoed = new Set();

  /** @param {string} key */
  const kindOf = (key) => /** @type {OverrideKind} */ (KIND_OF.get(key));
  /** @returns {Map<string, TopicView|null>} */
  const views = () =>
    new Map(KEYS.map(({ key }) => [key, topicView(mirror, key)]));
  /** @param {string} key @param {string} payload */
  const storeApply = (key, payload) => {
    if (payload === "") store.delete(key);
    else store.set(key, payload);
  };
  /** Is this own write still on its way for the mirror? @param {string} key @param {number} write */
  const onItsWay = (key, write) =>
    mirror.topics.get(key)?.writes.includes(write) === true;

  /** A fresh value of a kind. @param {OverrideKind} kind @returns {string} */
  const fresh = (kind) => {
    names += 1;
    switch (kind) {
      case "mode":
        return ["play", "pause", "stop"][pick(3)];
      case "brightness":
        return `{"enabled":true,"value":${1 + (names % 100)}}`;
      case "setting":
        return String(names);
      case "scene-path":
        return `./scene-${names}.js`;
      case "device-ip":
        return `192.0.2.${1 + (names % 250)}`;
      case "device-enabled":
        return ["false", "false", "false", " False ", "true", "0"][pick(6)];
    }
  };

  /** Invariants (a) and (c). */
  const check = () => {
    for (const { key } of KEYS) {
      const view = topicView(mirror, key);
      // (a) What counts as confirmed, and so what is in effect, was handed
      // to the mirror on the connection it holds as the current one.
      if (view?.confirmed && !handed.get(key)?.has(String(view.value)))
        fail(
          `${key}: ${view.value} counts as confirmed on connection ${mirror.connection}, which never delivered it`,
        );
      if (view && view.command !== null && !view.confirmed)
        fail(`${key}: ${view.command} is in effect and not confirmed`);
      // (c) The reader that follows the effects holds what the state holds.
      if (!sameView(reader.get(key) ?? null, view))
        fail(
          `${key}: a reader that follows the effects holds ${JSON.stringify(reader.get(key) ?? null)}, the state says ${JSON.stringify(view)}`,
        );
    }
  };

  /**
   * Feed an input, let the reader follow, check what must hold for every
   * step.
   *
   * @param {MirrorInput} input
   * @param {{ownClear?: boolean}} [about] ownClear: the message is the echo of an own clear
   */
  const feed = (input, about = {}) => {
    const before = views();
    const previous = mirror.connection;
    const result = reduceMirror(mirror, input);
    mirror = result.state;
    const newer = mirror.connection !== previous;
    if (newer) handed.clear();
    count(`decision:${result.decision.reason}`);
    for (const effect of result.effects)
      for (const key of effect.keys) reader.set(key, topicView(mirror, key));
    const applied = result.decision.action === "apply";
    const subject =
      input.type === "connect" || input.type === "disconnect"
        ? null
        : input.key;
    // What was handed over on the current connection: a delivered message,
    // and an own write that was taken.
    if (
      (input.type === "message" &&
        input.connection === mirror.connection &&
        mirror.connected) ||
      (input.type === "own-write" && result.decision.action !== "drop")
    ) {
      if (!handed.has(input.key)) handed.set(input.key, new Set());
      handed.get(input.key)?.add(input.payload);
    }

    // (b) What a hint may do, and what ends a restriction.
    for (const { key, kind } of KEYS) {
      const was = before.get(key) ?? null;
      const now = topicView(mirror, key);
      const mine = subject === key;
      if (was?.restriction && !now?.restriction) {
        // Only evidence of what the store holds: a message of the topic
        // that was taken, or the outcome of an own write of the topic.
        const evidence =
          mine &&
          applied &&
          (input.type === "message" || input.type === "published");
        if (!evidence)
          fail(
            `${key}: the restriction "${was.restriction}" ended on ${input.type}${subject ? ` of ${subject}` : ""} (${result.decision.reason})`,
          );
        count(
          input.type === "published"
            ? input.outcome === "confirmed"
              ? "restriction:released_by_own_clear_ack"
              : "restriction:released_after_a_failed_own_clear"
            : about.ownClear
              ? "restriction:released_by_own_clear_echo"
              : "restriction:released_by_outside_message",
        );
      }
      const command = now?.command ?? null;
      if (command !== null && command !== (was?.command ?? null) && !mine)
        fail(
          `${key}: the command ${command} came into effect on ${input.type}${subject ? ` of ${subject}` : ""}`,
        );
      // The end of the connection the mirror holds changes nothing. (The
      // end of one it was never told about makes that one known: below.)
      if (input.type === "disconnect" && !newer && !sameView(was, now))
        fail(`${key}: a disconnect changed ${JSON.stringify(was)}`);
      // A newer connection: commands wait, restrictions stay.
      if (!newer || was === null || mine) continue;
      if (was.command !== null && command === null)
        count(`lapsed_at_connect:${kind}`);
      if (was.restriction === "off" && now?.restriction === "off")
        count("restriction:off_kept_at_connect");
      if (was.restriction !== "held" && now?.restriction === "held")
        count("restriction:held_at_connect");
    }
    if (
      input.type === "message" &&
      input.retain &&
      applied &&
      before.get(input.key)?.confirmed === false &&
      (topicView(mirror, input.key)?.command ?? null) !== null
    )
      count(`restored_by_replay:${kindOf(input.key)}`);
    check();
    return result;
  };

  const actions = {
    outside() {
      let { key, kind } = KEYS[pick(KEYS.length)];
      /** @type {string} */
      let payload;
      const roll = random();
      if (roll < 0.1 && uplink.length > 0) {
        // The worst an outside client can do to an own write: the same
        // payload on the same topic, just before it. A payload has no
        // identity of its own, so this is taken for the echo.
        const publish = uplink[pick(uplink.length)];
        key = publish.key;
        kind = kindOf(key);
        payload = publish.payload;
        count("adversary:payload_of_an_own_write_on_its_way");
      } else if (roll < 0.35) payload = "";
      else if (roll < 0.45 && store.has(key))
        payload = /** @type {string} */ (store.get(key));
      else payload = fresh(kind);
      if (payload === "" && !connected && store.has(key))
        count(`cleared_while_disconnected:${kind}`);
      trace.push(`outside: ${key} = ${payload || "(clear)"}`);
      storeApply(key, payload);
      if (connected) downlink.push({ key, payload, retain: false });
    },
    /** @param {number} [at] which message on its way; default: any replay, or the oldest live message of any topic */
    deliver(at) {
      const candidates = downlink
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item, index }) =>
            item.retain ||
            downlink.findIndex(
              (other) => !other.retain && other.key === item.key,
            ) === index,
        );
      if (candidates.length === 0) return;
      const { item, index } =
        at === undefined
          ? candidates[pick(candidates.length)]
          : { item: downlink[at], index: at };
      downlink.splice(index, 1);
      trace.push(
        `deliver: ${item.key} ${item.retain ? "replay" : item.write ? `echo of own write ${item.write}` : "live"} ${item.payload || "(empty)"}`,
      );
      if (mirror.connection < connection)
        count("connect:first_message_before_the_connect_event");
      const entry = mirror.topics.get(item.key);
      if (item.retain && (entry?.record.outstanding.length ?? 0) > 0)
        count("own_write:replay_before_its_echo");
      /** The own write the mirror will take this message for, if any. */
      const head = entry?.writes[0];
      const { decision } = feed(
        {
          type: "message",
          key: item.key,
          kind: kindOf(item.key),
          payload: item.payload,
          retain: item.retain,
          connection,
        },
        { ownClear: item.write !== undefined && item.payload === "" },
      );
      if (decision.reason === "own_echo" && head !== undefined) {
        echoed.add(head);
        // Somebody else's message with the payload of the own write, just
        // before it: a payload is not a name.
        if (head !== item.write)
          count("limit:same_payload_taken_for_the_own_echo");
        else if (acks.some((ack) => ack.write === head))
          count("own_write:echo_before_ack");
      }
    },
    brokerProcess() {
      const publish = uplink.shift();
      if (!publish) return;
      trace.push(
        `broker: processes own write ${publish.write} on ${publish.key}`,
      );
      storeApply(publish.key, publish.payload);
      downlink.push({
        key: publish.key,
        payload: publish.payload,
        retain: false,
        write: publish.write,
      });
      acks.push(publish);
    },
    acknowledge() {
      if (acks.length === 0) return;
      const [ack] = acks.splice(pick(acks.length), 1);
      trace.push(`ack: own write ${ack.write} on ${ack.key}`);
      const known = onItsWay(ack.key, ack.write);
      const landed =
        (mirror.topics.get(ack.key)?.writes.indexOf(ack.write) ?? -1) <
        (mirror.topics.get(ack.key)?.record.landed ?? 0);
      const { decision } = feed({
        type: "published",
        key: ack.key,
        write: ack.write,
        outcome: "confirmed",
      });
      if (known && !landed) {
        if (decision.reason !== "own_ack")
          fail(`the acknowledgement of write ${ack.write} was not taken`);
        count("own_write:ack_before_echo");
      } else if (decision.reason !== "unknown_write")
        fail(
          `the acknowledgement of write ${ack.write}, which is not on its way any more, was taken: ${decision.reason}`,
        );
      if (chance(0.2))
        staleOutcomes.push({ ...ack, outcome: "confirmed", why: "twice" });
    },
    ownWrite() {
      let { key, kind } = KEYS[pick(KEYS.length)];
      // The UI sets a mode or a brightness, and clears every kind.
      let payload =
        kind === "mode" || (kind === "brightness" && chance(0.7))
          ? fresh(kind)
          : "";
      const restricted = KEYS.filter(
        (candidate) => topicView(mirror, candidate.key)?.restriction,
      );
      if (uplink.length > 0 && chance(0.15)) {
        // The same write again while the first is on its way (a second
        // click, another tab).
        ({ key, payload } = uplink[pick(uplink.length)]);
        kind = kindOf(key);
        count("own_write:same_payload_twice_on_its_way");
      } else if (restricted.length > 0 && chance(0.3)) {
        // "Clear" on a record that holds a device back.
        ({ key, kind } = restricted[pick(restricted.length)]);
        payload = "";
      }
      const write = ++writes;
      trace.push(`own write ${write}: ${key} = ${payload || "(clear)"}`);
      const { decision } = feed({
        type: "own-write",
        key,
        kind,
        payload,
        write,
      });
      if (decision.action !== "drop") uplink.push({ key, payload, write });
      else if (connected && mirror.connected)
        fail(`an own write was refused while connected: ${decision.reason}`);
    },
    publishFails() {
      // Certainly not sent: the newest own publish, so the order of the
      // others on the wire is untouched.
      const newest = uplink[uplink.length - 1];
      if (
        newest &&
        PROTECTIVE_KINDS.some((kind) => kind === kindOf(newest.key)) &&
        chance(0.5)
      ) {
        // An own clear of a topic that holds a device back. Before pixdcon
        // learns that it was not sent, somebody else's message for the
        // topic is delivered: older than the clear while that is on its
        // way, and the newest word once it is not.
        const payload = chance(0.4) ? "" : fresh(kindOf(newest.key));
        trace.push(`outside: ${newest.key} = ${payload || "(clear)"}`);
        storeApply(newest.key, payload);
        downlink.push({ key: newest.key, payload, retain: false });
        count("adversary:outside_message_before_an_own_clear_of_a_restriction");
        for (;;) {
          const index = downlink.findIndex(
            (item) => !item.retain && item.key === newest.key,
          );
          if (index < 0) break;
          actions.deliver(index);
        }
      }
      const publish = uplink.pop();
      if (!publish) return;
      trace.push(
        `fail: own write ${publish.write} on ${publish.key} was not sent`,
      );
      const known = onItsWay(publish.key, publish.write);
      if (known)
        count(
          uplink.some((other) => other.key === publish.key)
            ? "own_write:not_sent_with_another_on_its_way"
            : "own_write:not_sent",
        );
      const { decision } = feed({
        type: "published",
        key: publish.key,
        write: publish.write,
        outcome: "failed",
      });
      // Not known any more: somebody else's message with its payload was
      // taken for its echo.
      if (known ? decision.action !== "apply" : !echoed.has(publish.write))
        fail(`the failure of write ${publish.write}: ${decision.reason}`);
      if (chance(0.3))
        staleOutcomes.push({ ...publish, outcome: "failed", why: "twice" });
    },
    staleOutcome() {
      // An outcome of a write that is over: told a second time, or of a
      // connection that has ended.
      const item = staleOutcomes.shift();
      if (!item) return;
      trace.push(
        `outcome again: own write ${item.write} on ${item.key} ${item.outcome}`,
      );
      count(
        item.why === "gone"
          ? "own_write:outcome_of_a_connection_that_is_gone"
          : "own_write:outcome_told_twice",
      );
      const before = views();
      const { decision } = feed({
        type: "published",
        key: item.key,
        write: item.write,
        outcome: item.outcome,
      });
      if (decision.reason !== "unknown_write")
        fail(
          `the outcome of write ${item.write}, which is over, was taken: ${decision.reason}`,
        );
      for (const { key } of KEYS)
        if (!sameView(before.get(key) ?? null, topicView(mirror, key)))
          fail(`${key}: the outcome of a write that is over changed it`);
    },
    disconnect() {
      if (!connected) return;
      // Some of the own publishes on their way still reach the store; their
      // acknowledgements and echoes are lost with the connection. The rest
      // is lost altogether.
      const reaching = pick(uplink.length + 1);
      for (const publish of uplink.slice(0, reaching))
        storeApply(publish.key, publish.payload);
      if (reaching > 0 || acks.length > 0)
        count("own_write:stored_and_its_echo_lost");
      if (uplink.length > reaching) count("own_write:lost_with_the_connection");
      trace.push(
        `disconnect (${reaching} of ${uplink.length} own writes reached the store, ${acks.length} acknowledgements lost)`,
      );
      late = downlink
        .slice(0, pick(downlink.length + 1))
        .map(({ key, payload, retain }) => ({
          key,
          payload,
          retain,
          connection,
        }));
      // Their outcomes may still be told, in any form.
      for (const publish of [...uplink, ...acks])
        if (chance(0.5))
          staleOutcomes.push({
            ...publish,
            outcome: chance(0.5) ? "confirmed" : "failed",
            why: "gone",
          });
      uplink = [];
      downlink = [];
      acks = [];
      connected = false;
      feed({ type: "disconnect", connection });
    },
    lateMessage() {
      // A message of the connection that ended, handed over after its end.
      const item = late.shift();
      if (!item) return;
      trace.push(`late: ${item.key} of connection ${item.connection}`);
      const { decision } = feed({
        type: "message",
        key: item.key,
        kind: kindOf(item.key),
        payload: item.payload,
        retain: item.retain,
        connection: item.connection,
      });
      if (decision.reason !== "superseded_source")
        fail(
          `a message of connection ${item.connection} was not dropped: ${decision.reason}`,
        );
    },
    /** @param {boolean} [announce] false: the connect event is not handed over; the first message makes the connection known */
    connect(announce = chance(0.85)) {
      if (connected) return;
      connection += 1;
      connected = true;
      trace.push(`connect ${connection}${announce ? "" : " (not announced)"}`);
      if (announce) feed({ type: "connect", connection });
      // The replay: what the store holds when the subscribe is handled.
      for (const [key, payload] of store)
        downlink.push({ key, payload, retain: true });
    },
    restart() {
      const reaching = pick(uplink.length + 1);
      for (const publish of uplink.slice(0, reaching))
        storeApply(publish.key, publish.payload);
      trace.push(
        `restart (${reaching} of ${uplink.length} own writes reached the store)`,
      );
      uplink = [];
      downlink = [];
      acks = [];
      late = [];
      staleOutcomes = [];
      handed.clear();
      connected = false;
      connection = 0; // a new process counts its connections from 1
      mirror = createMirror();
      reader = new Map();
      check();
    },
  };

  /** @type {Array<[keyof typeof actions, number]>} */
  const weights = [
    ["outside", 16],
    ["deliver", 30],
    ["brokerProcess", 12],
    ["acknowledge", 9],
    ["ownWrite", 10],
    ["publishFails", 4],
    ["staleOutcome", 2],
    ["disconnect", 4],
    ["lateMessage", 3],
    ["connect", 9],
    ["restart", 1],
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
  }

  // --- the end of the walk: let everything in flight arrive ----------------
  trace.push("— quiesce —");
  if (!connected) actions.connect(true);
  else if (mirror.connection !== connection || !mirror.connected)
    feed({ type: "connect", connection });
  for (let round = 0; ; round++) {
    if (round > 200) fail("the walk does not come to rest");
    while (downlink.length > 0) actions.deliver();
    while (uplink.length > 0) actions.brokerProcess();
    while (acks.length > 0) actions.acknowledge();
    if (downlink.length === 0) break;
  }
  for (const [key, entry] of mirror.topics)
    if (entry.writes.length > 0 || entry.record.outstanding.length > 0)
      fail(`${key}: an own write is still expected back at rest`);

  // A process that starts now and gets the same replay.
  let cold = reduceMirror(createMirror(), {
    type: "connect",
    connection: 1,
  }).state;
  for (const [key, payload] of store)
    cold = reduceMirror(cold, {
      type: "message",
      key,
      kind: kindOf(key),
      payload,
      retain: true,
      connection: 1,
    }).state;

  for (const { key, kind } of KEYS) {
    const stored = store.get(key) ?? null;
    const view = topicView(mirror, key);
    const started = topicView(cold, key);
    // (d) Commands in effect are exactly what the store holds: what a
    // process holds that has just started.
    if ((view?.command ?? null) !== (started?.command ?? null))
      fail(
        `${key}: ${view?.command ?? "nothing"} is in effect; a process that starts now holds ${started?.command ?? "nothing"} (the store: ${stored ?? "empty"})`,
      );
    if (kind !== "device-enabled" && (view?.command ?? null) !== stored)
      fail(
        `${key}: the store holds ${stored ?? "nothing"}, in effect is ${view?.command ?? "nothing"}`,
      );
    if (stored !== null && view?.value !== stored)
      fail(`${key}: the store holds ${stored}, the mirror ${view?.value}`);
    if (stored !== null && !view?.confirmed)
      fail(
        `${key}: ${stored} is stored and connection ${connection} has not delivered it`,
      );
    // What pixdcon cannot know: a topic that was cleared while it was not
    // connected. The record is still there. It must command nothing.
    if (stored === null && view !== null) {
      if (view.confirmed)
        fail(
          `${key}: ${view.value} counts as confirmed and the store is empty`,
        );
      if (kind !== "device-enabled") count(`waits_at_rest:${kind}`);
    }
    // (e) Every restriction the store holds is in force. One that the
    // store no longer holds is left only by a record of an earlier
    // connection: the stated limit.
    const kept = view?.restriction ?? null;
    const held = started?.restriction ?? null;
    if (held !== null) {
      if (kept !== held)
        fail(
          `${key}: the store holds ${stored}, and the restriction "${held}" is not in force`,
        );
    } else if (kept !== null) {
      if (stored !== null || !view || view.connection >= mirror.connection)
        fail(
          `${key}: the restriction "${kept}" is in force, the store holds ${stored ?? "nothing"}`,
        );
      count(`limit:restriction_cleared_while_away:${kind}`);
    }
  }
  return trace.length;
}

test(`R4-5 overrides model: ${WALKS} random walks of up to ${STEPS} steps over the six kinds of retained topic, with a broker that delays, holds replays back, loses writes and drops connections, an outside client that publishes and clears at any time, also while pixdcon is away, and own writes that are acknowledged, echoed, lost or not sent; a command is in effect only on the connection that delivered it, a hint puts nothing into effect and ends no restriction, a reader that follows the effects holds what the state holds, and at rest a running process commands what a process holds that has just started`, () => {
  /** @type {Map<string, number>} */
  const seen = new Map();
  let steps = 0;
  for (let seed = FIRST_SEED; seed < FIRST_SEED + WALKS; seed++)
    steps += walk(seed, seen);
  assert.ok(
    steps > WALKS * STEPS * 0.5,
    `the walks really walked (${steps} steps)`,
  );
  // A short run by hand (a single seed to replay) cannot meet everything.
  if (WALKS >= 1000)
    assert.deepEqual(
      MUST_SEE.filter((what) => !seen.has(what)),
      [],
      "every decision, every kind in every situation, every hostile order and the limits were met at least once",
    );
  assert.deepEqual(
    [...seen.keys()].filter((what) => !MUST_SEE.includes(what)).sort(),
    [],
    "nothing was met that this test does not know about",
  );
  if (process.env.PIXDCON2_MODEL_STATS)
    console.log(`${steps} steps`, Object.fromEntries([...seen].sort()));
});
