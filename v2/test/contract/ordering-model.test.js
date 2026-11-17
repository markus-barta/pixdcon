/**
 * Test kind 2 of 3 (API and MQTT contract): the scene layers against a
 * model of a broker, with random interleavings.
 *
 * ordering.test.js runs the interleavings somebody thought of. This file
 * runs the ones nobody thought of: a seeded random walk over everything
 * that can happen around the two scene layers, with a broker that behaves
 * as badly as MQTT allows.
 *
 * The model:
 *  - a broker with a retained store (the granular topic per device, the
 *    blob). An outside client publishes and clears at any time.
 *  - a connection delivers the live messages of a topic in the order the
 *    broker processed them; a replay may be held back for any time, also
 *    past later live messages, past the settle hint and past own echoes.
 *  - pixdcon's own publishes reach the broker later or never. An
 *    acknowledgement and the own echo arrive in either order. A publish may
 *    fail at once.
 *  - the connection drops at any time: some of the publishes on their way
 *    reach the store, the rest and all acknowledgements are lost. A message
 *    of the old connection may still be handed over after it ended.
 *  - the process restarts at any time: only config.json survives (the saved
 *    choices and suppressions).
 *  - the user chooses scenes at any time, connected or not; a device changes
 *    between drive and shadow by an authoritative change.
 *  - the settle hint and the retry tick fire at any time.
 *
 * Checked after every single step:
 *  1. Hints cause nothing. A connect, a disconnect and the settle hint
 *     retire no suppression and publish nothing; a tick retires nothing and
 *     publishes only as a repetition.
 *  2. Every retirement and every publish names authoritative evidence
 *     (core/ordering.js mayCause), and is made while connected.
 *  3. Nothing is ever published for a device in shadow.
 *  4. A UI choice beats what it replaced: a value that was stored in a
 *     layer when the user chose, or anything published before that value,
 *     never shows again on that device (until an authoritative change to
 *     drive drops a choice made in shadow, rule 18). One case is outside
 *     what MQTT can order, and the model says so instead of hiding it: a
 *     live message that is delivered while no own write is on its way on
 *     the same topic cannot be told from one that was published a moment
 *     later. pixdcon takes it as a new command, so the model excuses a
 *     value that was delivered that way after the choice. Wherever an own
 *     write is on its way (every choice on a driven device clears the
 *     granular topic), the order is exact and is checked as such.
 *  5. Nothing goes backwards: inside one run of the process, a layer never
 *     shows a value that was published before a value it showed earlier.
 * And at the end of every walk, after everything in flight was delivered:
 *  6. Store and mirror agree: for a driven device nothing that a suppression
 *     hides is left in the store, and every scene the store holds is the one
 *     in effect.
 *  7. Both directions still work: a new overlay from outside shows at once
 *     (the Home Assistant toggle), and a new UI choice beats it again.
 *
 * A failure names the seed and the steps, so it can be replayed.
 *
 * Owner: core/state worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mayCause } from "../../src/core/ordering.js";
import {
  blobScenes,
  savedSuppressions,
  sceneInputs,
} from "../../src/overlay/scene-layers.js";
import { world } from "./scene-world.js";

const DEVICES = ["D1", "D2", "D3"];
// PIXDCON2_MODEL_WALKS and PIXDCON2_MODEL_FIRST_SEED change the size and the
// start of the run, for a longer soak by hand; the gate runs the default.
const WALKS = Number(process.env.PIXDCON2_MODEL_WALKS) || 1500;
const FIRST_SEED = Number(process.env.PIXDCON2_MODEL_FIRST_SEED) || 1;
const STEPS = 140;

/**
 * What a walk must have met for the run to count: every decision and every
 * way a suppression ends that the scene layers know. A model that never
 * reaches a path proves nothing about it.
 */
const MUST_SEE = [
  "decision:current",
  "decision:superseded",
  "decision:own_echo",
  "decision:hint",
  "decision:replay_after_live",
  "decision:before_own_write",
  "decision:older_own_echo",
  "decision:older_own_write",
  "decision:superseded_source",
  "decision:unknown_write",
  "retire:outside_command",
  "retire:stored_while_away",
  "retire:confirmed",
  "retire:nothing_to_strip",
  "retire:replaced",
  "retire:dropped",
  "publish:command",
  "publish:message",
  "publish:ack",
  "publish:timer",
  "publish:config",
  "limit:cleared_while_away",
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
 * One random walk.
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

  const w = world({ outputs: { D1: "drive", D2: "drive", D3: "shadow" } });
  /** The broker's retained store. */
  const store = {
    /** @type {Map<string, string>} */ granular: new Map(),
    /** @type {string|null} */ blob: null,
  };
  /** Publish time of every value an outside client ever published. @type {Map<string, number>} */
  const publishedAt = new Map();
  let now = 0;
  let names = 0;
  let connection = 0;
  let connected = false;
  /** Messages on their way to pixdcon; own = the echo of an own write. @type {Array<{topic: string, payload: string, retain: boolean, own?: boolean}>} */
  let downlink = [];
  /** Own publishes on their way to the broker, in order. @type {Array<{topic: string, payload: string, write: number}>} */
  let uplink = [];
  /** Acknowledgements on their way to pixdcon. @type {number[]} */
  let acks = [];
  /** Messages of a connection that has ended, still to be handed over. @type {Array<{topic: string, payload: string, retain: boolean, connection: number}>} */
  let late = [];
  /** Per device and layer: publish time of the newest value a choice replaced. @type {Map<string, number>} */
  const replacedAt = new Map();
  /** Scenes an outside client published a second time, unchanged. @type {Set<string>} */
  const republished = new Set();
  /** Per device and layer: values delivered live, with no own write on their topic on its way, since the last choice. @type {Map<string, Set<string>>} */
  const excused = new Map();
  /** Per device and layer: publish time of the newest value that was in effect in this run of the process. @type {Map<string, number>} */
  let shownAt = new Map();

  /** @param {string} message */
  const fail = (message) => {
    throw new Error(
      `${message}\n  seed ${seed}, after ${trace.length} steps:\n  ${trace.slice(-(Number(process.env.PIXDCON2_MODEL_TRACE) || 25)).join("\n  ")}`,
    );
  };

  /** @param {string} topic @param {string} payload */
  const storeApply = (topic, payload) => {
    if (topic === "blob") store.blob = payload === "" ? null : payload;
    else if (payload === "") store.granular.delete(topic);
    else store.granular.set(topic, payload);
  };

  /** Feed an input, carry out its effects, check what must hold for every step. @param {import("../../src/overlay/scene-layers.js").LayersInput} input */
  const feed = (input) => {
    const mark = w.effects.length;
    const result = w.feed(input);
    count(`decision:${result.decision.reason}`);
    for (const effect of w.effects.slice(mark)) {
      if (effect.type === "retire") count(`retire:${effect.ended}`);
      if (effect.type === "publish-clear" || effect.type === "publish-blob") {
        count(`publish:${effect.evidence}`);
        if (!connected) fail(`published while not connected: ${effect.type}`);
        if (["connect", "disconnect", "settled"].includes(input.type))
          fail(`a ${input.type} published something`);
        if (
          !mayCause("publish", effect.evidence, {
            repeatOf: effect.evidence === "timer" ? "message" : undefined,
          })
        )
          fail(`publish on ${effect.evidence}`);
        if (input.type === "tick" && effect.evidence !== "timer")
          fail("a tick published as if it were evidence");
        if (effect.type === "publish-clear") {
          if (w.state().outputs.get(effect.device) !== "drive")
            fail(`a clear for ${effect.device}, which is in shadow`);
          uplink.push({
            topic: effect.device,
            payload: "",
            write: effect.write,
          });
        } else {
          for (const { device } of effect.generations)
            if (w.state().outputs.get(device) !== "drive")
              fail(`a blob rewrite strips ${device}, which is in shadow`);
          uplink.push({
            topic: "blob",
            payload: effect.payload,
            write: effect.write,
          });
        }
      }
      if (effect.type === "retire") {
        if (["connect", "disconnect", "settled", "tick"].includes(input.type))
          fail(`a ${input.type} retired a suppression (${effect.ended})`);
        if (!mayCause("retire", effect.evidence))
          fail(`retired on ${effect.evidence}`);
      }
    }
    check();
    return result;
  };

  /** Invariants 4 and 5. */
  const check = () => {
    for (const device of DEVICES) {
      const inputs = sceneInputs(w.state(), device);
      for (const layer of /** @type {const} */ (["granular", "blob"])) {
        const held = inputs[layer];
        if (!held || !held.inEffect) continue;
        const at = publishedAt.get(held.scene);
        if (at === undefined)
          fail(
            `${device} ${layer} shows ${held.scene}, which nobody published`,
          );
        if (republished.has(held.scene)) continue;
        const key = `${device}/${layer}`;
        const replaced = replacedAt.get(key);
        if (
          replaced !== undefined &&
          /** @type {number} */ (at) <= replaced &&
          !excused.get(key)?.has(held.scene)
        )
          fail(
            `${device} ${layer} shows ${held.scene} (published at ${at}), which the user's choice replaced (it replaced what was published at ${replaced})`,
          );
        const shown = shownAt.get(key);
        if (shown !== undefined && /** @type {number} */ (at) < shown)
          fail(
            `${device} ${layer} went back to ${held.scene} (published at ${at}) after showing a value published at ${shown}`,
          );
        shownAt.set(key, /** @type {number} */ (at));
      }
    }
  };

  /** A fresh, unique scene name with its publish time. @param {string} prefix */
  const fresh = (prefix) => {
    const name = `${prefix}${++names}`;
    publishedAt.set(name, ++now);
    return name;
  };

  const actions = {
    outsideGranular() {
      const device = DEVICES[pick(3)];
      const payload = chance(0.8) ? fresh("g") : "";
      trace.push(`outside: granular ${device} = ${payload || "(clear)"}`);
      storeApply(device, payload);
      if (connected) downlink.push({ topic: device, payload, retain: false });
    },
    outsideBlob() {
      /** @type {string} */
      let payload = "";
      if (chance(0.9)) {
        const base = parseOrEmpty(store.blob);
        // An outside client republishes the blob: some scenes anew, some
        // dropped, some entries as it finds them in the store.
        const devices = DEVICES.map((name) => {
          const existing = (base.devices ?? []).find(
            (/** @type {any} */ entry) => entry.name === name,
          );
          const roll = random();
          if (roll < 0.45) return { name, scene: fresh("b") };
          if (roll < 0.65) return { name };
          // Published again as it is. For pixdcon that is a new publish of
          // the same scene (an outside live blob is a new command for every
          // device it names a scene for, S3 a), but the value has two
          // publish times now and cannot say which one a delivery is: it is
          // left out of the two checks that compare publish times.
          if (typeof existing?.scene === "string")
            republished.add(existing.scene);
          return existing ?? { name };
        });
        payload = JSON.stringify({ devices, note: fresh("n") });
      }
      trace.push(`outside: blob = ${payload || "(clear)"}`);
      storeApply("blob", payload);
      if (connected) downlink.push({ topic: "blob", payload, retain: false });
    },
    deliver() {
      // Any replay, or the oldest live message of a topic.
      const candidates = downlink
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item, index }) =>
            item.retain ||
            downlink.findIndex(
              (other) => !other.retain && other.topic === item.topic,
            ) === index,
        );
      if (candidates.length === 0) return;
      const { item, index } = candidates[pick(candidates.length)];
      downlink.splice(index, 1);
      if (!item.retain && !item.own) {
        // Is an own write on its way on this topic (not yet at the broker,
        // or its echo not yet delivered)? Then the broker processed this
        // message before it, and its publish time stands. Otherwise nothing
        // orders it against a choice: it counts as published now.
        const ownOnItsWay =
          uplink.some((publish) => publish.topic === item.topic) ||
          downlink.some((other) => other.own && other.topic === item.topic);
        if (!ownOnItsWay) {
          const carried =
            item.topic === "blob"
              ? [...blobScenes(parseOrNull(item.payload))].map(
                  ([device, scene]) => [`${device}/blob`, scene],
                )
              : [[`${item.topic}/granular`, item.payload]];
          for (const [key, value] of carried) {
            if (!excused.has(key)) excused.set(key, new Set());
            excused.get(key)?.add(value);
          }
        }
      }
      const meta = { retain: item.retain, connection };
      trace.push(
        `deliver: ${item.topic} ${item.retain ? "replay" : "live"} ${item.payload || "(empty)"}`,
      );
      if (item.topic === "blob")
        feed({ type: "blob", payload: item.payload, ...meta });
      else
        feed({
          type: "granular",
          device: item.topic,
          payload: item.payload,
          ...meta,
        });
    },
    brokerProcess() {
      const publish = uplink.shift();
      if (!publish) return;
      trace.push(
        `broker: processes own write ${publish.write} on ${publish.topic}`,
      );
      storeApply(publish.topic, publish.payload);
      downlink.push({
        topic: publish.topic,
        payload: publish.payload,
        retain: false,
        own: true,
      });
      acks.push(publish.write);
    },
    acknowledge() {
      if (acks.length === 0) return;
      const [write] = acks.splice(pick(acks.length), 1);
      trace.push(`ack: write ${write}`);
      feed({ type: "published", write, outcome: "confirmed" });
    },
    publishFails() {
      // Certainly not sent: the newest own publish, so the order of the
      // others on the wire is untouched.
      const publish = uplink.pop();
      if (!publish) return;
      trace.push(`fail: write ${publish.write} was not sent`);
      feed({ type: "published", write: publish.write, outcome: "failed" });
    },
    choice() {
      const device = DEVICES[pick(3)];
      const scene = `c${++names}`;
      // What the user sees stored in each layer at this moment is what the
      // choice replaces.
      const inputs = sceneInputs(w.state(), device);
      for (const layer of /** @type {const} */ (["granular", "blob"])) {
        const held = inputs[layer];
        const at = held ? publishedAt.get(held.scene) : undefined;
        if (at !== undefined)
          replacedAt.set(
            `${device}/${layer}`,
            Math.max(at, replacedAt.get(`${device}/${layer}`) ?? 0),
          );
        excused.delete(`${device}/${layer}`);
      }
      trace.push(`choice: ${device} = ${scene}`);
      const mark = w.effects.length;
      w.choose(device, scene);
      // The same bookkeeping as feed(), for the effects of the choice.
      for (const effect of w.effects.slice(mark)) {
        if (effect.type === "retire") count(`retire:${effect.ended}`);
        if (effect.type === "publish-clear" || effect.type === "publish-blob")
          count(`publish:${effect.evidence}`);
        if (effect.type === "publish-clear")
          uplink.push({
            topic: effect.device,
            payload: "",
            write: effect.write,
          });
        if (effect.type === "publish-blob")
          uplink.push({
            topic: "blob",
            payload: effect.payload,
            write: effect.write,
          });
        if (
          (effect.type === "publish-clear" || effect.type === "publish-blob") &&
          !connected
        )
          fail("a choice published while not connected");
        if (
          effect.type === "publish-clear" &&
          w.state().outputs.get(effect.device) !== "drive"
        )
          fail(`a clear for ${effect.device}, which is in shadow`);
      }
      check();
    },
    settle() {
      if (connection === 0) return;
      trace.push("settle hint");
      feed({ type: "settled", connection, complete: chance(0.8) });
    },
    tick() {
      trace.push("tick");
      feed({ type: "tick" });
    },
    disconnect() {
      if (!connected) return;
      // Some of the own publishes on their way still reach the store.
      const reaching = pick(uplink.length + 1);
      for (const publish of uplink.slice(0, reaching))
        storeApply(publish.topic, publish.payload);
      trace.push(
        `disconnect (${reaching} of ${uplink.length} own writes reached the store)`,
      );
      late = downlink
        .slice(0, pick(downlink.length + 1))
        .map(({ topic, payload, retain }) => ({
          topic,
          payload,
          retain,
          connection,
        }));
      uplink = [];
      downlink = [];
      acks = [];
      connected = false;
      feed({ type: "disconnect", connection });
    },
    lateMessage() {
      // A message of the connection that ended, processed after its end.
      const item = late.shift();
      if (!item) return;
      trace.push(`late: ${item.topic} of connection ${item.connection}`);
      const meta = { retain: item.retain, connection: item.connection };
      const { decision } =
        item.topic === "blob"
          ? feed({ type: "blob", payload: item.payload, ...meta })
          : feed({
              type: "granular",
              device: item.topic,
              payload: item.payload,
              ...meta,
            });
      if (decision.reason !== "superseded_source")
        fail(
          `a message of connection ${item.connection} was not dropped: ${decision.reason}`,
        );
    },
    connect() {
      if (connected) return;
      connection += 1;
      connected = true;
      trace.push(`connect ${connection}`);
      feed({ type: "connect", connection });
      // The replay: what the store holds when the subscribe is handled.
      for (const [device, payload] of store.granular)
        downlink.push({ topic: device, payload, retain: true });
      if (store.blob !== null)
        downlink.push({ topic: "blob", payload: store.blob, retain: true });
    },
    restart() {
      const reaching = pick(uplink.length + 1);
      for (const publish of uplink.slice(0, reaching))
        storeApply(publish.topic, publish.payload);
      trace.push(
        `restart (${reaching} of ${uplink.length} own writes reached the store)`,
      );
      uplink = [];
      downlink = [];
      acks = [];
      late = [];
      connected = false;
      connection = 0; // a new process counts its connections from 1
      shownAt = new Map(); // invariant 5 is about one run of the process
      w.restart();
      check();
    },
    output() {
      // An authoritative change: config.json, or v1's device list.
      const device = chance(0.5) ? "D2" : "D3";
      const next =
        w.state().outputs.get(device) === "drive" ? "shadow" : "drive";
      trace.push(`output: ${device} → ${next}`);
      if (next === "drive") {
        // Rule 18: a choice made in shadow is dropped; what it replaced may show.
        for (const layer of ["granular", "blob"]) {
          const suppression = w.state().suppressions.get(device)?.[
            /** @type {"granular"|"blob"} */ (layer)
          ];
          if (suppression?.output === "shadow")
            replacedAt.delete(`${device}/${layer}`);
        }
      }
      feed({ type: "output", device, output: next });
    },
  };

  /** @type {Array<[keyof typeof actions, number]>} */
  const weights = [
    ["outsideGranular", 10],
    ["outsideBlob", 8],
    ["deliver", 30],
    ["brokerProcess", 16],
    ["acknowledge", 10],
    ["publishFails", 1],
    ["choice", 9],
    ["settle", 4],
    ["tick", 5],
    ["disconnect", 3],
    ["lateMessage", 3],
    ["connect", 8],
    ["restart", 1],
    ["output", 1],
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
  if (!connected) actions.connect();
  for (let round = 0; ; round++) {
    if (round > 200) fail("the walk does not come to rest");
    while (downlink.length > 0) actions.deliver();
    while (uplink.length > 0) actions.brokerProcess();
    while (acks.length > 0) actions.acknowledge();
    if (downlink.length > 0) continue;
    const mark = w.effects.length;
    actions.tick();
    if (uplink.length === 0 && w.effects.length === mark) break;
  }

  // 6. Store and mirror agree.
  const storedBlob = blobScenes(parseOrNull(store.blob));
  for (const device of DEVICES) {
    const inputs = sceneInputs(w.state(), device);
    const driven = w.state().outputs.get(device) === "drive";
    for (const [layer, stored] of /** @type {const} */ ([
      ["granular", store.granular.get(device)],
      ["blob", storedBlob.get(device)],
    ])) {
      const held = inputs[layer];
      // The one thing pixdcon cannot know (M4, matrix A-182): a topic that
      // was cleared while it was not connected. MQTT has no message for
      // "this topic is empty", so the record of the earlier connection
      // stays, visibly older than the current connection.
      if (held && stored === undefined && held.connection < connection) {
        count("limit:cleared_while_away");
        continue;
      }
      if ((held?.scene ?? undefined) !== stored)
        fail(
          `${device} ${layer}: the store holds ${stored}, the mirror ${held?.scene}`,
        );
      if (driven && held && !held.inEffect)
        fail(
          `${device} ${layer}: ${held.scene} is still stored although the choice replaced it`,
        );
    }
  }
  for (const { device, layer, suppression } of savedSuppressions(w.state())) {
    if (w.state().outputs.get(device) !== "drive") continue;
    const stored =
      layer === "granular"
        ? store.granular.get(device)
        : storedBlob.get(device);
    if (stored !== undefined)
      fail(
        `${device} ${layer}: a suppression (generation ${suppression.generation}) is still saved while ${stored} is stored`,
      );
  }

  // 7. Both directions still work, on a driven device.
  const toggled = fresh("g");
  trace.push(`epilogue: outside granular D1 = ${toggled}`);
  storeApply("D1", toggled);
  downlink.push({ topic: "D1", payload: toggled, retain: false });
  actions.deliver();
  if (w.shows("D1") !== `${toggled} (overlay)`)
    fail(`a new overlay from outside does not show: D1 shows ${w.shows("D1")}`);
  actions.choice.call(null);
  return trace.length;
}

/** @param {string|null} text */
function parseOrNull(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** @param {string|null} text */
function parseOrEmpty(text) {
  return parseOrNull(text) ?? {};
}

test(`ordering model: ${WALKS} random walks of up to ${STEPS} steps over the scene layers and a broker that delays, reorders replays, loses writes and drops connections; hints cause nothing, a choice beats what it replaced, nothing goes backwards, store and mirror agree at rest`, () => {
  /** @type {Map<string, number>} */
  const seen = new Map();
  let steps = 0;
  for (let seed = FIRST_SEED; seed < FIRST_SEED + WALKS; seed++)
    steps += walk(seed, seen);
  assert.ok(
    steps > WALKS * STEPS * 0.5,
    `the walks really walked (${steps} steps)`,
  );
  const missing = MUST_SEE.filter((what) => !seen.has(what));
  assert.deepEqual(
    missing,
    [],
    "every decision and every ending was met at least once",
  );
  const unknown = [...seen.keys()]
    .filter((what) => !MUST_SEE.includes(what))
    .sort();
  assert.deepEqual(
    unknown,
    [],
    "nothing was met that this test does not know about",
  );
  if (process.env.PIXDCON2_MODEL_STATS)
    console.log(`${steps} steps`, Object.fromEntries([...seen].sort()));
});
