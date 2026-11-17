/**
 * Test kind 2 of 3 (API and MQTT contract): the scene layers against a
 * model of a broker, with random and with hostile interleavings.
 *
 * ordering.test.js runs the interleavings somebody thought of. This file
 * runs the ones nobody thought of: a seeded random walk over everything
 * that can happen around the two scene layers, with a broker that behaves
 * as badly as MQTT allows, and an outside client that does the worst thing
 * it can at every step.
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
 *    of the old connection may still be handed over after it ended. (What
 *    the model leaves out, because no rule of pixdcon can decide it: an own
 *    write of a connection that ended, which the broker gets to only after
 *    the next connection has subscribed, followed by a restart before the
 *    repair has landed. While the process lives such a write is known by
 *    its bytes, ordering.test.js "O2"; a new process cannot know them. The
 *    knowledge entry lists it with the limits, section 3.0.)
 *  - the process restarts at any time: only config.json survives (the saved
 *    choices and suppressions).
 *  - the user chooses scenes at any time, connected or not; a device changes
 *    between drive and shadow by an authoritative change.
 *  - the settle hint and the retry tick fire at any time.
 *
 * The adversary (round 4: the third cross-read found two orders the random
 * walk could not produce, because its outside client was too polite). The
 * outside client now copies pixdcon's own writes as far as anybody can:
 *  - an empty payload has no identity, so it clears a topic while pixdcon's
 *    own clear of that topic is on its way: byte for byte the pending write.
 *  - a rewrite of the blob carries a mark nobody else can know before the
 *    broker has stored it (scene-layers.js O1). So for a rewrite that is
 *    still on its way the client publishes the same document without the
 *    mark, or with the mark of an older rewrite it has seen: the oldest one
 *    on its way, and a later one (the third cross-read's N2).
 *  - as soon as the broker has stored a rewrite, the client can copy it
 *    byte for byte, and does: one whose echo is still out, and one of an
 *    earlier time or connection.
 *  - it publishes the value that is stored already once more, and it keeps
 *    pixdcon's mark in a blob it changes, as a client does that reads the
 *    blob, edits it and writes it back.
 *  - a device leaves the effective config and comes back while its writes
 *    are still on their way, and the user chooses again at once.
 *  - an acknowledgement is lost with its connection although the broker
 *    stored the write.
 *  - a retained topic is cleared while pixdcon is not connected.
 * A run counts only when every one of these was produced (MUST_SEE).
 *
 * Checked after every single step:
 *  1. Hints cause nothing. A connect, a disconnect and the settle hint
 *     retire no suppression and publish nothing; a tick retires nothing and
 *     publishes only as a repetition.
 *  2. Every retirement and every publish names authoritative evidence
 *     (core/ordering.js mayCause), and is made while connected.
 *  3. Nothing is ever published for a device in shadow, or for one that
 *     left the config.
 *  4. A UI choice beats what it replaced: a value that was stored in a
 *     layer when the user chose, or anything published before that value,
 *     never shows again on that device (until an authoritative change to
 *     drive drops a choice made in shadow, rule 18, or the device leaves
 *     the config). One case is outside what MQTT can order, and the model
 *     says so instead of hiding it: a live message that is delivered while
 *     no own write is on its way on the same topic cannot be told from one
 *     that was published a moment later. pixdcon takes it as a new command,
 *     so the model excuses a value that was delivered that way after the
 *     choice. Wherever an own write is on its way (every choice on a driven
 *     device clears the granular topic), the order is exact and is checked
 *     as such.
 *  5. Nothing goes backwards: inside one run of the process, a layer never
 *     shows a value that was published before a value it showed earlier.
 *  6. A scene overlay is in effect only when it was delivered on the
 *     connection that is the current one (or the last one, while the broker
 *     is away). A record of an earlier connection is still there, and
 *     decides nothing.
 *  7. A choice generation is never used twice for a device in one run of
 *     the process, and a choice on a driven device sends its own clear, or
 *     still owes it, on the connection it was made on.
 * And at the end of every walk, after everything in flight was delivered:
 *  8. Store and mirror agree: for a driven device nothing that a suppression
 *     hides is left in the store, every scene the store holds is the one in
 *     effect, and nothing is in effect that the store does not hold.
 *  9. Both directions still work: a new overlay from outside shows at once
 *     (the Home Assistant toggle), and a new UI choice beats it again.
 *
 * A failure names the seed and the steps, so it can be replayed.
 *
 * Two smaller walks at the end of the file do the same for the two other
 * places where the third cross-read found that waiting, or an
 * acknowledgement, was taken for a fact:
 *  - per-device availability (status-publisher.js): displays change between
 *    driven and not driven, leave and come back, while publishes reach the
 *    broker or do not and their acknowledgements are lost with the
 *    connection or time out. An "online" that may sit on the broker for a
 *    display that is not driven is always owed an "offline", and at rest no
 *    such "online" is left.
 *  - the registry lane at shutdown (core/ordering.js createLane): imports
 *    that take any time, and a shutdown at any moment, also while one is
 *    running. After the lane was closed nothing is committed and nothing
 *    follows, whenever the import comes back.
 *
 * Owner: core/state worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createLane, mayCause } from "../../src/core/ordering.js";
import {
  availabilityOutcome,
  availabilitySent,
  createAvailabilityLedger,
  owesOffline,
  planAvailability,
} from "../../src/mqtt/status-publisher.js";
import {
  WRITE_MARK,
  blobScenes,
  savedSuppressions,
  sceneInputs,
  withoutMark,
} from "../../src/overlay/scene-layers.js";
import { world } from "./scene-world.js";

const DEVICES = ["D1", "D2", "D3"];
// PIXDCON2_MODEL_WALKS and PIXDCON2_MODEL_FIRST_SEED change the size and the
// start of the run, for a longer soak by hand; the gate runs the default.
const WALKS = Number(process.env.PIXDCON2_MODEL_WALKS) || 1500;
const FIRST_SEED = Number(process.env.PIXDCON2_MODEL_FIRST_SEED) || 1;
const STEPS = 140;

/**
 * What a run must have met to count: every decision and every way a
 * suppression ends that the scene layers know, and every hostile order the
 * generator is there to produce. A model that never reaches a path proves
 * nothing about it.
 */
const MUST_SEE = [
  "decision:current",
  "decision:superseded",
  "decision:own_echo",
  "decision:own_twin",
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
  // The adversary.
  "adversary:document_of_oldest_own_rewrite_on_its_way",
  "adversary:document_of_later_own_rewrite_on_its_way",
  "adversary:copy_of_own_rewrite_before_its_echo",
  "adversary:copy_of_earlier_own_rewrite",
  "adversary:clear_while_own_clear_on_its_way",
  "adversary:same_value_again",
  "adversary:outside_blob_keeps_the_mark",
  "adversary:removed_with_writes_in_flight",
  "adversary:readded_with_writes_in_flight",
  "adversary:choice_after_readd_with_writes_in_flight",
  "adversary:ack_lost_with_connection",
  "adversary:granular_cleared_while_disconnected",
  "adversary:blob_cleared_while_disconnected",
];

/**
 * A small seeded generator (mulberry32): the same seed, the same walk.
 *
 * @param {number} seed
 * @returns {() => number} numbers in [0, 1)
 */
export function generator(seed) {
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
  /**
   * Every time an outside client published a value. A value that was
   * published more than once cannot say which publish a delivery is.
   *
   * @type {Map<string, number[]>}
   */
  const times = new Map();
  let now = 0;
  let names = 0;
  let connection = 0;
  let connected = false;
  /** Devices in the effective config. */
  const present = new Set(DEVICES);
  /** Messages on their way to pixdcon; own = the echo of an own write. @type {Array<{topic: string, payload: string, retain: boolean, own?: boolean, devices?: string[]}>} */
  let downlink = [];
  /** Own publishes on their way to the broker, in order. devices: whom the write is for. @type {Array<{topic: string, payload: string, write: number, devices: string[]}>} */
  let uplink = [];
  /** Acknowledgements on their way to pixdcon. @type {Array<{write: number, devices: string[]}>} */
  let acks = [];
  /** Messages of a connection that has ended, still to be handed over. @type {Array<{topic: string, payload: string, retain: boolean, connection: number}>} */
  let late = [];
  /** Every blob rewrite of pixdcon that the broker has stored in this walk: what anybody can have read. @type {Set<string>} */
  const ownBlobs = new Set();
  /** Devices that came back while a write for them was still on its way. @type {Set<string>} */
  const cameBackEarly = new Set();
  /** Per device and layer: publish time of the newest value a choice replaced. @type {Map<string, number>} */
  const replacedAt = new Map();
  /** Per device and layer: values delivered live, with no own write on their topic on its way, since the last choice. @type {Map<string, Set<string>>} */
  const excused = new Map();
  /** Per device and layer: publish time of the newest value that was in effect in this run of the process. @type {Map<string, number>} */
  let shownAt = new Map();
  /** Per device: the highest choice generation of this run of the process. @type {Map<string, number>} */
  let generations = new Map();

  /** @param {string} message */
  const fail = (message) => {
    throw new Error(
      `${message}\n  seed ${seed}, after ${trace.length} steps:\n  ${trace.slice(-(Number(process.env.PIXDCON2_MODEL_TRACE) || 25)).join("\n  ")}`,
    );
  };

  /** @param {string} topic @param {string} payload @param {boolean} [own] a write of pixdcon itself */
  const storeApply = (topic, payload, own = false) => {
    if (own && topic === "blob") ownBlobs.add(payload);
    if (topic === "blob") store.blob = payload === "" ? null : payload;
    else if (payload === "") store.granular.delete(topic);
    else store.granular.set(topic, payload);
  };

  /** Is an own write for this device on its way: to the broker, as an echo, or as an acknowledgement? @param {string} device */
  const inFlightFor = (device) =>
    uplink.some((publish) => publish.devices.includes(device)) ||
    downlink.some((item) => item.own && item.devices?.includes(device)) ||
    acks.some((ack) => ack.devices.includes(device));

  /**
   * The bookkeeping for what the reducer answered: its publishes go onto
   * the wire, and everything that must hold for an effect is checked.
   *
   * @param {number} mark effects before this index were handled
   * @param {string} cause type of the input
   */
  const carryOut = (mark, cause) => {
    for (const effect of w.effects.slice(mark)) {
      if (effect.type === "retire") {
        count(`retire:${effect.ended}`);
        if (["connect", "disconnect", "settled", "tick"].includes(cause))
          fail(`a ${cause} retired a suppression (${effect.ended})`);
        if (!mayCause("retire", effect.evidence))
          fail(`retired on ${effect.evidence}`);
      }
      if (effect.type !== "publish-clear" && effect.type !== "publish-blob")
        continue;
      count(`publish:${effect.evidence}`);
      if (!connected) fail(`published while not connected: ${effect.type}`);
      if (["connect", "disconnect", "settled", "removed"].includes(cause))
        fail(`a ${cause} published something`);
      if (
        !mayCause("publish", effect.evidence, {
          repeatOf: effect.evidence === "timer" ? "message" : undefined,
        })
      )
        fail(`publish on ${effect.evidence}`);
      if (cause === "tick" && effect.evidence !== "timer")
        fail("a tick published as if it were evidence");
      if (effect.type === "publish-clear") {
        if (w.state().outputs.get(effect.device) !== "drive")
          fail(`a clear for ${effect.device}, which is not driven`);
        uplink.push({
          topic: effect.device,
          payload: "",
          write: effect.write,
          devices: [effect.device],
        });
      } else {
        for (const { device } of effect.generations)
          if (w.state().outputs.get(device) !== "drive")
            fail(`a blob rewrite strips ${device}, which is not driven`);
        uplink.push({
          topic: "blob",
          payload: effect.payload,
          write: effect.write,
          devices: effect.generations.map(({ device }) => device),
        });
      }
    }
  };

  /** Feed an input, carry out its effects, check what must hold for every step. @param {import("../../src/overlay/scene-layers.js").LayersInput} input */
  const feed = (input) => {
    const mark = w.effects.length;
    const result = w.feed(input);
    count(`decision:${result.decision.reason}`);
    carryOut(mark, input.type);
    check();
    return result;
  };

  /** Invariants 4, 5 and 6. */
  const check = () => {
    const current = w.state().connection;
    for (const device of DEVICES) {
      const inputs = sceneInputs(w.state(), device);
      for (const layer of /** @type {const} */ (["granular", "blob"])) {
        const held = inputs[layer];
        if (!held) continue;
        if (held.confirmed !== (held.connection === current))
          fail(
            `${device} ${layer}: ${held.scene} of connection ${held.connection} is called ${held.confirmed ? "confirmed" : "not confirmed"} on connection ${current}`,
          );
        if (!held.inEffect) continue;
        if (!held.confirmed)
          fail(
            `${device} ${layer}: ${held.scene} is in effect although connection ${current} has not delivered it (it is of connection ${held.connection})`,
          );
        const stamps = times.get(held.scene);
        if (!stamps)
          return fail(
            `${device} ${layer} shows ${held.scene}, which nobody published`,
          );
        const latest = Math.max(...stamps);
        const key = `${device}/${layer}`;
        const replaced = replacedAt.get(key);
        if (
          replaced !== undefined &&
          latest <= replaced &&
          !excused.get(key)?.has(held.scene)
        )
          fail(
            `${device} ${layer} shows ${held.scene} (published at ${latest}), which the user's choice replaced (it replaced what was published at ${replaced})`,
          );
        // Published more than once: which publish this delivery is cannot
        // be told, so it says nothing about going backwards.
        if (stamps.length > 1) continue;
        const shown = shownAt.get(key);
        if (shown !== undefined && latest < shown)
          fail(
            `${device} ${layer} went back to ${held.scene} (published at ${latest}) after showing a value published at ${shown}`,
          );
        shownAt.set(key, latest);
      }
    }
  };

  /** A fresh, unique scene name with its publish time. @param {string} prefix */
  const fresh = (prefix) => {
    const name = `${prefix}${++names}`;
    times.set(name, [++now]);
    return name;
  };
  /** An outside client publishes a value that was published before, once more. @param {string} value */
  const again = (value) => times.get(value)?.push(++now);

  const actions = {
    outsideGranular() {
      const device = DEVICES[pick(3)];
      const stored = store.granular.get(device);
      /** @type {string} */
      let payload;
      const roll = random();
      if (roll < 0.2) {
        payload = "";
        if (uplink.some((publish) => publish.topic === device))
          count("adversary:clear_while_own_clear_on_its_way");
        if (!connected && stored !== undefined)
          count("adversary:granular_cleared_while_disconnected");
      } else if (roll < 0.3 && stored !== undefined) {
        // The same scene once more: the toggle is pressed again.
        payload = stored;
        again(stored);
        count("adversary:same_value_again");
      } else {
        payload = fresh("g");
      }
      trace.push(`outside: granular ${device} = ${payload || "(clear)"}`);
      storeApply(device, payload);
      if (connected) downlink.push({ topic: device, payload, retain: false });
    },
    outsideBlob() {
      /** @type {string} */
      let payload = "";
      const pending = uplink.filter((publish) => publish.topic === "blob");
      const echoing = downlink.filter(
        (item) => item.own && item.topic === "blob",
      );
      const roll = random();
      /** Own rewrites the broker has stored: anybody can have read them. */
      const stored = [...ownBlobs].filter((own) => own !== "");
      const rewrites = pending.filter((publish) => publish.payload !== "");
      if (roll < 0.2 && rewrites.length > 0) {
        // The same document as a rewrite that is still on its way. Its mark
        // cannot be known yet: the client publishes the document without
        // one, or with the mark of an older rewrite it has read.
        const index = chance(0.5) ? 0 : pick(rewrites.length);
        const document = withoutMark(parseOrNull(rewrites[index].payload));
        const seen = stored.map((own) => parseOrNull(own)?.[WRITE_MARK]);
        payload = JSON.stringify(
          chance(0.3) && seen.length > 0
            ? { ...document, [WRITE_MARK]: seen[pick(seen.length)] }
            : document,
        );
        count(
          index === 0
            ? "adversary:document_of_oldest_own_rewrite_on_its_way"
            : "adversary:document_of_later_own_rewrite_on_its_way",
        );
        for (const scene of blobScenes(parseOrNull(payload)).values())
          again(scene);
      } else if (roll < 0.36 && stored.length > 0) {
        // Byte for byte a rewrite of pixdcon that the broker has stored.
        const before = echoing.filter((item) => item.payload !== "");
        payload =
          before.length > 0 && chance(0.6)
            ? before[pick(before.length)].payload
            : stored[pick(stored.length)];
        count(
          before.some((item) => item.payload === payload)
            ? "adversary:copy_of_own_rewrite_before_its_echo"
            : "adversary:copy_of_earlier_own_rewrite",
        );
        // Whatever scenes it names are published once more, now.
        for (const scene of blobScenes(parseOrNull(payload)).values())
          again(scene);
      } else if (roll < 0.92) {
        const base = parseOrEmpty(store.blob);
        // An outside client republishes the blob: some scenes anew, some
        // dropped, some entries as it finds them in the store.
        const devices = DEVICES.map((name) => {
          const existing = (base.devices ?? []).find(
            (/** @type {any} */ entry) => entry.name === name,
          );
          const draw = random();
          if (draw < 0.45) return { name, scene: fresh("b") };
          if (draw < 0.65) return { name };
          // Published again as it is. For pixdcon that is a new publish of
          // the same scene (an outside live blob is a new command for every
          // device it names a scene for, S3 a): the value has two publish
          // times from now on.
          if (typeof existing?.scene === "string") again(existing.scene);
          return existing ?? { name };
        });
        // A client that reads the blob, edits it and writes it back keeps
        // the keys it does not know, pixdcon's mark among them.
        const kept =
          typeof base[WRITE_MARK] === "string" && chance(0.3)
            ? { [WRITE_MARK]: base[WRITE_MARK] }
            : {};
        if (WRITE_MARK in kept) count("adversary:outside_blob_keeps_the_mark");
        payload = JSON.stringify({ devices, note: fresh("n"), ...kept });
      }
      if (payload === "" && !connected && store.blob !== null)
        count("adversary:blob_cleared_while_disconnected");
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
        `deliver: ${item.topic} ${item.retain ? "replay" : item.own ? "own echo" : "live"} ${item.payload || "(empty)"}`,
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
      storeApply(publish.topic, publish.payload, true);
      downlink.push({
        topic: publish.topic,
        payload: publish.payload,
        retain: false,
        own: true,
        devices: publish.devices,
      });
      acks.push({ write: publish.write, devices: publish.devices });
    },
    acknowledge() {
      if (acks.length === 0) return;
      const [{ write }] = acks.splice(pick(acks.length), 1);
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
      if (!present.has(device)) return;
      const scene = `c${++names}`;
      // What the user sees stored in each layer at this moment is what the
      // choice replaces.
      const inputs = sceneInputs(w.state(), device);
      for (const layer of /** @type {const} */ (["granular", "blob"])) {
        const held = inputs[layer];
        const stamps = held ? times.get(held.scene) : undefined;
        if (stamps)
          replacedAt.set(
            `${device}/${layer}`,
            Math.max(
              Math.min(...stamps),
              replacedAt.get(`${device}/${layer}`) ?? 0,
            ),
          );
        excused.delete(`${device}/${layer}`);
      }
      if (cameBackEarly.has(device) && inFlightFor(device))
        count("adversary:choice_after_readd_with_writes_in_flight");
      trace.push(`choice: ${device} = ${scene}`);
      const mark = w.effects.length;
      const { plan, decision } = w.choose(device, scene);
      if (decision.action !== "apply")
        fail(`the choice was not applied: ${decision.reason}`);
      // 7. A generation is used once per device in one run of the process.
      const before = generations.get(device) ?? 0;
      if (!(plan.generation > before))
        fail(
          `the choice on ${device} has generation ${plan.generation}; ${before} was used before in this run of the process`,
        );
      generations.set(device, plan.generation);
      if (connected && w.state().outputs.get(device) === "drive") {
        const sent = w
          .since(mark, "publish-clear")
          .some(
            (effect) =>
              effect.device === device && effect.generation === plan.generation,
          );
        const owed =
          w.state().suppressions.get(device)?.granular?.owedOn ===
          w.state().connection;
        if (!sent && !owed)
          fail(
            `the choice on ${device} (generation ${plan.generation}) neither sent its own clear nor owes it`,
          );
      }
      carryOut(mark, "choice");
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
      // Some of the own publishes on their way still reach the store, before
      // the next connection subscribes. Their acknowledgements, and those
      // that were on their way, are lost. The rest of the publishes is lost.
      const reaching = pick(uplink.length + 1);
      for (const publish of uplink.slice(0, reaching))
        storeApply(publish.topic, publish.payload, true);
      if (reaching > 0 || acks.length > 0)
        count("adversary:ack_lost_with_connection");
      trace.push(
        `disconnect (${reaching} of ${uplink.length} own writes reached the store, ${acks.length} acknowledgements lost)`,
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
        storeApply(publish.topic, publish.payload, true);
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
      generations = new Map(); // and so is invariant 7
      cameBackEarly.clear();
      w.restart();
      check();
    },
    output() {
      // An authoritative change: config.json, or v1's device list.
      const device = chance(0.5) ? "D2" : "D3";
      if (!present.has(device)) return;
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
    remove() {
      // The device leaves the effective config: its entry is deleted, and
      // the choice made for it goes with the entry.
      const candidates = DEVICES.filter((device) => present.has(device));
      if (candidates.length === 0) return;
      const device = candidates[pick(candidates.length)];
      if (inFlightFor(device)) count("adversary:removed_with_writes_in_flight");
      trace.push(`remove: ${device}`);
      present.delete(device);
      cameBackEarly.delete(device);
      for (const layer of ["granular", "blob"]) {
        replacedAt.delete(`${device}/${layer}`);
        excused.delete(`${device}/${layer}`);
      }
      const mark = w.effects.length;
      const { decision } = w.remove(device);
      count(`decision:${decision.reason}`);
      carryOut(mark, "removed");
      if (w.state().suppressions.has(device))
        fail(`${device} left the config and still has a suppression`);
      check();
    },
    /** @param {"drive"|"shadow"} [wanted] */
    readd(wanted) {
      const candidates = DEVICES.filter((device) => !present.has(device));
      if (candidates.length === 0) return;
      const device = candidates[pick(candidates.length)];
      // D1 is the driven device of the epilogue: it comes back driven.
      const output =
        wanted ?? (device === "D1" || chance(0.6) ? "drive" : "shadow");
      if (inFlightFor(device)) {
        count("adversary:readded_with_writes_in_flight");
        cameBackEarly.add(device);
      }
      trace.push(`re-add: ${device} (${output})`);
      present.add(device);
      const mark = w.effects.length;
      const { decision } = w.add(device, output);
      count(`decision:${decision.reason}`);
      carryOut(mark, "output");
      check();
    },
  };

  /** @type {Array<[keyof typeof actions, number]>} */
  const weights = [
    ["outsideGranular", 10],
    ["outsideBlob", 9],
    ["deliver", 30],
    ["brokerProcess", 16],
    ["acknowledge", 10],
    ["publishFails", 1],
    ["choice", 10],
    ["settle", 4],
    ["tick", 5],
    ["disconnect", 3],
    ["lateMessage", 3],
    ["connect", 8],
    ["restart", 1],
    ["output", 1],
    ["remove", 1],
    ["readd", 4],
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
  while (present.size < DEVICES.length) actions.readd();
  if (w.state().outputs.get("D1") !== "drive") fail("D1 is not driven");
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

  // 8. Store and mirror agree.
  const storedBlob = blobScenes(parseOrNull(store.blob));
  for (const device of DEVICES) {
    const inputs = sceneInputs(w.state(), device);
    const driven = w.state().outputs.get(device) === "drive";
    for (const [layer, stored] of /** @type {const} */ ([
      ["granular", store.granular.get(device)],
      ["blob", storedBlob.get(device)],
    ])) {
      const held = inputs[layer];
      // What pixdcon cannot know (matrix A-182): a topic that was cleared
      // while it was not connected. MQTT has no message for "this topic is
      // empty", so the record of the earlier connection is still there. It
      // must not decide anything any more.
      if (held && stored === undefined && held.connection < connection) {
        count("limit:cleared_while_away");
        if (held.inEffect)
          fail(
            `${device} ${layer}: ${held.scene} was cleared while pixdcon was away and is still in effect`,
          );
        continue;
      }
      if ((held?.scene ?? undefined) !== stored)
        fail(
          `${device} ${layer}: the store holds ${stored}, the mirror ${held?.scene}`,
        );
      if (held && !held.confirmed)
        fail(
          `${device} ${layer}: ${held.scene} is stored and was not delivered on connection ${connection}`,
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

  // 9. Both directions still work, on a driven device.
  const toggled = fresh("g");
  trace.push(`epilogue: outside granular D1 = ${toggled}`);
  storeApply("D1", toggled);
  downlink.push({ topic: "D1", payload: toggled, retain: false });
  actions.deliver();
  if (w.shows("D1") !== `${toggled} (overlay)`)
    fail(`a new overlay from outside does not show: D1 shows ${w.shows("D1")}`);
  for (;;) {
    const before = trace.length;
    actions.choice();
    if (trace.length > before) break; // the dice named D1, D2 or D3: all present
  }
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

test(`ordering model: ${WALKS} random walks of up to ${STEPS} steps over the scene layers, a broker that delays, reorders replays, loses writes and drops connections, and an outside client that copies pixdcon's own writes; hints cause nothing, a choice beats what it replaced, nothing goes backwards, nothing undelivered decides, store and mirror agree at rest`, () => {
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
  if (WALKS >= 1000) {
    const missing = MUST_SEE.filter((what) => !seen.has(what));
    assert.deepEqual(
      missing,
      [],
      "every decision, every ending and every hostile order was met at least once",
    );
  }
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

// ---------------------------------------------------------------------------
// Per-device availability: what the broker may hold, and what is owed
// ---------------------------------------------------------------------------

const AVAILABILITY_MUST_SEE = [
  "online_stored_and_its_acknowledgement_lost",
  "online_lost_with_the_connection",
  "acknowledgement_timed_out",
  "publish_not_sent",
  "owed_for_a_display_in_shadow",
  "owed_for_a_display_that_left",
  "left_with_an_online_on_its_way",
  "older_offline_confirmed_after_a_newer_online",
  "debt_paid",
];

/**
 * @param {number} seed
 * @param {Map<string, number>} seen
 */
function availabilityWalk(seed, seen) {
  const count = (/** @type {string} */ what) =>
    seen.set(what, (seen.get(what) ?? 0) + 1);
  const random = generator(seed);
  const pick = (/** @type {number} */ n) => Math.floor(random() * n);
  const chance = (/** @type {number} */ p) => random() < p;
  /** @type {string[]} */
  const trace = [];
  /** @param {string} message */
  const fail = (message) => {
    throw new Error(
      `${message}\n  seed ${seed}, after ${trace.length} steps:\n  ${trace.slice(-25).join("\n  ")}`,
    );
  };

  const NAMES = ["A", "B", "C"];
  const ledger = createAvailabilityLedger();
  /** The effective config. @type {Map<string, {driven: boolean, health: "online"|"offline"}>} */
  const devices = new Map(
    NAMES.map((name) => [name, { driven: true, health: "online" }]),
  );
  /** The broker's retained availability topics. @type {Map<string, string>} */
  const store = new Map();
  let connected = false;
  /** @typedef {{device: string, payload: "online"|"offline", number: number, told: boolean}} Publish told: the publisher has got an outcome for it */
  /** Publishes on their way to the broker, in order. @type {Publish[]} */
  let uplink = [];
  /** Acknowledgements on their way back. @type {Publish[]} */
  let acks = [];

  const listed = () =>
    [...devices].map(([name, device]) => ({
      name,
      driven: device.driven,
      health: device.driven ? device.health : /** @type {const} */ ("shadow"),
    }));
  const driven = (/** @type {string} */ name) =>
    devices.get(name)?.driven === true;
  /** @param {Publish} publish @param {"confirmed"|"offline"|"timeout"|"error"} outcome */
  const tell = (publish, outcome) => {
    if (publish.told) return;
    publish.told = true;
    const owedBefore = owesOffline(ledger, publish.device);
    if (
      outcome === "confirmed" &&
      publish.payload === "offline" &&
      (ledger.devices.get(publish.device)?.online ?? 0) > publish.number
    )
      count("older_offline_confirmed_after_a_newer_online");
    availabilityOutcome(
      ledger,
      publish.device,
      publish.payload,
      publish.number,
      outcome,
    );
    if (owedBefore && !owesOffline(ledger, publish.device)) count("debt_paid");
  };

  /** What may never happen: an "online" that may sit on the broker for a display that is not driven, with nothing owed. */
  const check = () => {
    for (const name of NAMES) {
      const mayBeOnline =
        store.get(name) === "online" ||
        uplink.some(
          (publish) => publish.device === name && publish.payload === "online",
        );
      if (!mayBeOnline || driven(name)) continue;
      if (!owesOffline(ledger, name))
        fail(
          `${name} may be "online" on the broker, is not driven, and no "offline" is owed`,
        );
      count(
        devices.has(name)
          ? "owed_for_a_display_in_shadow"
          : "owed_for_a_display_that_left",
      );
    }
  };

  const actions = {
    /** What the publisher does on a change, on a connect and every 30 s. */
    publish() {
      if (!connected) return;
      for (const entry of planAvailability(ledger, listed())) {
        // Handed to the gateway: counted before anything is awaited.
        const number = availabilitySent(ledger, entry.device, entry.payload);
        uplink.push({
          device: entry.device,
          payload: entry.payload,
          number,
          told: false,
        });
        trace.push(`publish ${entry.device} ${entry.payload} (${number})`);
      }
    },
    process() {
      const publish = uplink.shift();
      if (!publish) return;
      trace.push(`broker stores ${publish.device} ${publish.payload}`);
      store.set(publish.device, publish.payload);
      acks.push(publish);
    },
    acknowledge() {
      if (acks.length === 0) return;
      const [publish] = acks.splice(pick(acks.length), 1);
      trace.push(
        `ack ${publish.device} ${publish.payload} (${publish.number})`,
      );
      tell(publish, "confirmed");
    },
    timeout() {
      // No acknowledgement in time on a connection that is still up. The
      // broker may store the message all the same.
      const waiting = [...uplink, ...acks].filter((publish) => !publish.told);
      if (waiting.length === 0) return;
      const publish = waiting[pick(waiting.length)];
      trace.push(`timeout ${publish.device} ${publish.payload}`);
      count("acknowledgement_timed_out");
      tell(publish, "timeout");
    },
    notSent() {
      const publish = uplink.pop();
      if (!publish) return;
      trace.push(`not sent ${publish.device} ${publish.payload}`);
      count("publish_not_sent");
      tell(publish, "error");
    },
    disconnect() {
      if (!connected) return;
      const reaching = pick(uplink.length + 1);
      for (const publish of uplink.slice(0, reaching)) {
        store.set(publish.device, publish.payload);
        if (publish.payload === "online")
          count("online_stored_and_its_acknowledgement_lost");
      }
      if (
        uplink.slice(reaching).some((publish) => publish.payload === "online")
      )
        count("online_lost_with_the_connection");
      trace.push(`disconnect (${reaching} of ${uplink.length} stored)`);
      // Every publish of that connection that is not confirmed is answered
      // "offline" by the gateway, stored or not.
      for (const publish of [...uplink, ...acks]) tell(publish, "offline");
      uplink = [];
      acks = [];
      connected = false;
    },
    connect() {
      if (connected) return;
      connected = true;
      trace.push("connect");
    },
    output() {
      const present = [...devices.keys()];
      if (present.length === 0) return;
      const name = present[pick(present.length)];
      const device = /** @type {{driven: boolean}} */ (devices.get(name));
      device.driven = !device.driven;
      trace.push(`${name} ${device.driven ? "driven" : "in shadow"}`);
    },
    health() {
      const present = [...devices.values()];
      if (present.length === 0) return;
      const device = present[pick(present.length)];
      device.health = device.health === "online" ? "offline" : "online";
    },
    remove() {
      const present = [...devices.keys()];
      if (present.length === 0) return;
      const name = present[pick(present.length)];
      if (
        uplink.some(
          (publish) => publish.device === name && publish.payload === "online",
        )
      )
        count("left_with_an_online_on_its_way");
      devices.delete(name);
      trace.push(`${name} left the config`);
    },
    add() {
      const absent = NAMES.filter((name) => !devices.has(name));
      if (absent.length === 0) return;
      const name = absent[pick(absent.length)];
      devices.set(name, { driven: chance(0.6), health: "online" });
      trace.push(`${name} is back`);
    },
  };

  /** @type {Array<[keyof typeof actions, number]>} */
  const weights = [
    ["publish", 8],
    ["process", 12],
    ["acknowledge", 8],
    ["timeout", 1],
    ["notSent", 1],
    ["disconnect", 3],
    ["connect", 5],
    ["output", 4],
    ["health", 2],
    ["remove", 2],
    ["add", 3],
  ];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (let step = 0; step < 80; step++) {
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

  // At rest: connected, and the publisher has gone round until nothing is
  // owed. No "online" is left for a display that is not driven.
  trace.push("— quiesce —");
  actions.connect();
  for (let round = 0; ; round++) {
    if (round > 10) fail("the debt is never paid");
    actions.publish();
    while (uplink.length > 0) actions.process();
    while (acks.length > 0) actions.acknowledge();
    if (!planAvailability(ledger, listed()).some((entry) => entry.retire))
      break;
  }
  for (const name of NAMES) {
    const device = devices.get(name);
    if (device?.driven) {
      const expected = device.health === "offline" ? "offline" : "online";
      if (store.get(name) !== expected)
        fail(
          `${name} is driven and ${device.health}; the broker holds ${store.get(name)}`,
        );
    } else if (store.get(name) === "online") {
      fail(`${name} is not driven and still "online" on the broker`);
    } else if (owesOffline(ledger, name)) {
      fail(`${name} is still owed an offline at rest`);
    }
  }
  return trace.length;
}

test(`availability model: ${WALKS} random walks over displays that are driven, in shadow, removed and back, with publishes that are stored or lost and acknowledgements that are lost or late; an online that may be on the broker is always owed an offline, and at rest none is left for a display that is not driven`, () => {
  /** @type {Map<string, number>} */
  const seen = new Map();
  let steps = 0;
  for (let seed = FIRST_SEED; seed < FIRST_SEED + WALKS; seed++)
    steps += availabilityWalk(seed, seen);
  assert.ok(steps > WALKS * 20, `the walks really walked (${steps} steps)`);
  if (WALKS >= 1000)
    assert.deepEqual(
      AVAILABILITY_MUST_SEE.filter((what) => !seen.has(what)),
      [],
      "every case was met at least once",
    );
  assert.deepEqual(
    [...seen.keys()].filter((what) => !AVAILABILITY_MUST_SEE.includes(what)),
    [],
  );
  if (process.env.PIXDCON2_MODEL_STATS)
    console.log(`${steps} steps`, Object.fromEntries([...seen].sort()));
});

// ---------------------------------------------------------------------------
// The registry lane at shutdown
// ---------------------------------------------------------------------------

const LANE_MUST_SEE = [
  "closed_while_an_import_ran",
  "closed_with_pieces_queued",
  "closed_while_idle",
  "import_came_back_after_the_close",
  "piece_skipped",
  "committed_and_followed",
];

/**
 * @param {number} seed
 * @param {Map<string, number>} seen
 */
async function laneWalk(seed, seen) {
  const count = (/** @type {string} */ what) =>
    seen.set(what, (seen.get(what) ?? 0) + 1);
  const random = generator(seed);
  const pick = (/** @type {number} */ n) => Math.floor(random() * n);
  /** @type {string[]} */
  const trace = [];
  /** @param {string} message */
  const fail = (message) => {
    throw new Error(
      `${message}\n  seed ${seed}:\n  ${trace.slice(-25).join("\n  ")}`,
    );
  };
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  /** What a piece threw: the lane reports it and goes on, so it is kept here. @type {unknown[]} */
  const thrown = [];
  const lane = createLane({ onError: (_name, error) => thrown.push(error) });
  /** One import per piece: it comes back when its gate is opened. @type {Array<{open: () => void, opened: boolean}>} */
  const imports = [];
  /** @type {Set<number>} */
  const running = new Set();
  /** @type {number[]} */
  const committed = [];
  /** @type {number[]} */
  const followed = [];
  /** @type {Array<Promise<{ran: boolean}>>} */
  const results = [];
  /** Shutdown has released the scenes. */
  let released = false;

  const actions = {
    enqueue() {
      if (lane.closed()) return;
      const id = imports.length;
      let open = () => {};
      const back = new Promise((resolve) => {
        open = () => resolve(undefined);
      });
      imports.push({ open, opened: false });
      trace.push(`piece ${id} queued`);
      results.push(
        lane.runThen(
          `piece ${id}`,
          // The registry: an import that takes time, then the commit,
          // unless the signal says that shutdown has begun.
          async (signal) => {
            running.add(id);
            await back;
            running.delete(id);
            if (signal.aborted) {
              count("import_came_back_after_the_close");
              return id;
            }
            if (released) fail(`piece ${id} committed after the release`);
            committed.push(id);
            return id;
          },
          // The scene runtime: replace the instances.
          (done) => {
            if (released) fail(`piece ${done} was followed after the release`);
            followed.push(done);
          },
        ),
      );
    },
    comeBack() {
      const waiting = imports.filter((entry) => !entry.opened);
      if (waiting.length === 0) return;
      const entry = waiting[pick(waiting.length)];
      entry.opened = true;
      trace.push(`import ${imports.indexOf(entry)} comes back`);
      entry.open();
    },
    stop() {
      if (lane.closed()) return;
      count(
        running.size > 0
          ? "closed_while_an_import_ran"
          : lane.pending() > 0
            ? "closed_with_pieces_queued"
            : "closed_while_idle",
      );
      if (lane.pending() > 1) count("closed_with_pieces_queued");
      trace.push(`stop: lane closed, ${lane.pending()} pending`);
      lane.close();
      // The wait for the lane ran out at once; the scenes are released.
      released = true;
    },
  };
  /** @type {Array<[keyof typeof actions, number]>} */
  const weights = [
    ["enqueue", 5],
    ["comeBack", 5],
    ["stop", 1],
  ];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (let step = 0; step < 14; step++) {
    let roll = random() * total;
    for (const [name, weight] of weights) {
      roll -= weight;
      if (roll < 0) {
        actions[name]();
        break;
      }
    }
    if (random() < 0.7) await turn();
  }
  // Every import comes back in the end, in any order, long after the stop.
  actions.stop();
  while (imports.some((entry) => !entry.opened)) actions.comeBack();
  await lane.drain();
  const outcomes = await Promise.all(results);
  if (thrown.length > 0) throw thrown[0];

  for (const [id, outcome] of outcomes.entries())
    if (!outcome.ran) count("piece_skipped");
    else if (followed.includes(id)) count("committed_and_followed");
  if (committed.some((id, index) => index > 0 && committed[index - 1] > id))
    fail(`pieces committed out of order: ${committed}`);
  if (followed.some((id) => !committed.includes(id)))
    fail(`a piece was followed without having committed: ${followed}`);
  if (lane.pending() !== 0) fail("the lane did not come to rest");
  return trace.length;
}

test("lane model: 400 random walks over scene work that takes any time and a shutdown at any moment, also while an import is running; after the lane was closed nothing is committed and nothing follows, whenever the import comes back", async () => {
  /** @type {Map<string, number>} */
  const seen = new Map();
  let steps = 0;
  for (let seed = FIRST_SEED; seed < FIRST_SEED + 400; seed++)
    steps += await laneWalk(seed, seen);
  assert.ok(steps > 400, `the walks really walked (${steps} steps)`);
  assert.deepEqual(
    LANE_MUST_SEE.filter((what) => !seen.has(what)),
    [],
    "every case was met at least once",
  );
  assert.deepEqual(
    [...seen.keys()].filter((what) => !LANE_MUST_SEE.includes(what)),
    [],
  );
});
