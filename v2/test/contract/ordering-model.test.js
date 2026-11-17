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
import { generator, world } from "./scene-world.js";

const DEVICES = ["D1", "D2", "D3"];
// PIXDCON2_MODEL_WALKS and PIXDCON2_MODEL_FIRST_SEED change the size and the
// start of the run, for a longer soak by hand; the gate runs the default.
const WALKS = Number(process.env.PIXDCON2_MODEL_WALKS) || 1500;
const FIRST_SEED = Number(process.env.PIXDCON2_MODEL_FIRST_SEED) || 1;
const STEPS = 140;
// The long walks: one run of the process that makes far more own rewrites
// than any list of them could hold (the fourth cross-read's R4-2 was a list
// of 32).
const LONG_WALKS = Math.max(12, Math.round(WALKS / 125));
const LONG_STEPS = 9000;

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
  // The fourth cross-read: a record that only the new connection's late
  // replay confirms again, with the value it had (R4-1).
  "r4:record_confirmed_again_by_a_late_replay",
];

/** What the long walks must have met on top of that (R4-2). */
const LONG_MUST_SEE = [
  "long:100_own_rewrites_in_one_run",
  "long:copy_of_an_own_rewrite_more_than_32_rewrites_old",
  "long:replay_of_an_own_rewrite_more_than_32_rewrites_old",
  "long:more_own_scene_names_than_are_kept",
];

/**
 * One random walk.
 *
 * @param {number} seed
 * @param {Map<string, number>} seen counts of what the walks met (MUST_SEE)
 * @param {boolean} [long] a long walk: LONG_STEPS steps, and the process does not restart before the last tenth of them
 * @returns {number} steps taken
 */
function walk(seed, seen, long = false) {
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
  /** The blob rewrites of this run of the process, in the order they were sent. @type {string[]} */
  let ownRun = [];
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
        if (effect.payload !== "") {
          ownRun.push(effect.payload);
          if (ownRun.length === 100) count("long:100_own_rewrites_in_one_run");
        }
        if (w.state().ownScenesFull.size > 0)
          count("long:more_own_scene_names_than_are_kept");
      }
    }
  };

  /** Is this payload a rewrite of this run that more than 32 rewrites followed? @param {string} payload */
  const longAgo = (payload) => {
    const at = ownRun.indexOf(payload);
    return at >= 0 && ownRun.length - at > 32;
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

  /** Invariants 4, 5, 6 and 10. */
  const check = () => {
    // 10. Every change is announced: a consumer that computes a device
    // again only when a "changed" effect names it holds what the precedence
    // over the whole state says, after every single step.
    const stale = w.stale(DEVICES);
    if (stale.length > 0)
      fail(
        `a consumer that is driven by effects is stale. ${stale.join("; ")}`,
      );
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
        if (connected && longAgo(payload))
          count("long:copy_of_an_own_rewrite_more_than_32_rewrites_old");
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
      if (item.retain) {
        if (item.topic === "blob" && longAgo(item.payload))
          count("long:replay_of_an_own_rewrite_more_than_32_rewrites_old");
        // R4-1: the record is held from an earlier connection, with this
        // very value. Nothing about the value changes; its say does.
        const held =
          item.topic === "blob"
            ? w.state().blob.base
            : (w.state().granular.get(item.topic)?.value ?? null);
        const deliveredOn =
          item.topic === "blob"
            ? w.state().blob.delivered
            : (w.state().granular.get(item.topic)?.delivered ?? 0);
        if (held === item.payload && deliveredOn < connection)
          count("r4:record_confirmed_again_by_a_late_replay");
      }
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
      ownRun = []; // a new process knows no rewrite of the one before
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
  const steps = long ? LONG_STEPS : STEPS;
  for (let step = 0; step < steps; step++) {
    let roll = random() * total;
    for (const [name, weight] of weights) {
      roll -= weight;
      if (roll < 0) {
        // A long walk is one run of the process for nine tenths of its way.
        if (!(long && name === "restart" && step < steps * 0.9))
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
    .filter((what) => ![...MUST_SEE, ...LONG_MUST_SEE].includes(what))
    .sort();
  assert.deepEqual(
    unknown,
    [],
    "nothing was met that this test does not know about",
  );
  if (process.env.PIXDCON2_MODEL_STATS)
    console.log(`${steps} steps`, Object.fromEntries([...seen].sort()));
});

test(`ordering model, long: ${LONG_WALKS} walks of ${LONG_STEPS} steps, each one run of the process with more than 100 blob rewrites of its own; an outside client publishes rewrites again that are more than 32 rewrites old, the broker replays them after a reconnect, and more scene names pass through than are kept. Every check of the short walks holds at every step`, () => {
  /** @type {Map<string, number>} */
  const seen = new Map();
  let steps = 0;
  // Seeds of their own, so that a longer soak does not repeat the short walks.
  for (let walked = 0; walked < LONG_WALKS; walked++)
    steps += walk(900_000_000 + FIRST_SEED + walked, seen, true);
  assert.ok(steps > LONG_WALKS * LONG_STEPS * 0.5);
  assert.deepEqual(
    LONG_MUST_SEE.filter((what) => !seen.has(what)),
    [],
    "the walks were long enough to pass every limit",
  );
  assert.deepEqual(
    [...seen.keys()]
      .filter((what) => ![...MUST_SEE, ...LONG_MUST_SEE].includes(what))
      .sort(),
    [],
  );
  if (process.env.PIXDCON2_MODEL_STATS)
    console.log(`${steps} steps`, Object.fromEntries([...seen].sort()));
});

// ---------------------------------------------------------------------------
// One blob, several controllers (the fourth cross-read's R4-3)
// ---------------------------------------------------------------------------

/**
 * pixdcon v1's own overlay module, unchanged: lib/config-overlay.js. It is
 * loaded by path, so that the type check of v2 does not follow it into v1.
 *
 * @type {any}
 */
const { ConfigOverlay } = await import(
  new URL("../../../lib/config-overlay.js", import.meta.url).href
);
const V1_BASE = "home/hsb1/pixdcon";
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

const FLEET_MUST_SEE = [
  "fleet:v1_is_the_writer",
  "fleet:v2_is_the_writer",
  "fleet:second_v2_drives_too",
  "fleet:second_v2_is_the_edge_instance",
  "fleet:choice_while_a_blob_write_of_another_controller_is_in_flight",
  "fleet:two_controllers_chose_before_either_heard_of_the_other",
  "fleet:handover_to_v2",
  "fleet:handover_to_v1",
  "fleet:transition_ended",
  "end:choice_saved_by_a_reader_stripped_by_the_writer",
  "end:choice_made_in_shadow_dropped_at_the_start",
  "end:blob_holds_a_scene_that_v1_put_back",
  "v1:rewrite_stored",
  "v1:rewrite_names_a_scene_for_a_device_a_v2_choice_holds",
  "v1:rewrite_brings_back_another_scene_than_the_store_held",
  "v1:restart",
  "writer:v2_rewrite_delivered_to_the_other_v2",
  "reader:choice_while_the_blob_names_no_scene_for_the_device",
  "reader:live_blob_names_a_scene_while_a_choice_holds",
  "reader:replay_names_a_scene_while_a_choice_holds",
  "reader:blob_without_the_scene_while_a_choice_holds",
  "reader:blob_cleared_while_a_choice_holds",
  "reader:restart_while_a_choice_holds",
  "reader:choice_made_in_shadow_dropped_by_rule_18",
  "limit:outside_blob_scene_for_a_device_a_reader_s_choice_holds",
  "limit:cleared_while_away",
];

/**
 * One walk over a broker that several controllers share: pixdcon v1 (its
 * real ConfigOverlay behind a stand-in for its MQTT service) and two v2
 * instances with their own secrets, I and J. Exactly one controller is the
 * blob's writer (scene-layers.js W1):
 *  - the transition: v1 writes; I drives the displays it has taken over; J
 *    is a second v2 that drives some too, or the edge instance.
 *  - after it: I writes; J is the edge instance; there is no v1.
 * Every display has one driver at a time, or none, and changes hands.
 * Everybody chooses scenes at any time. An outside client publishes to both
 * layers. Messages are delayed per controller, connections drop, processes
 * restart, also v1. And the transition ends, at any moment of a walk that
 * began in it: v1 is stopped, and I starts again as the writer, on the
 * config.json it wrote while it was not.
 *
 * Checked after every step, for both v2 instances:
 *  1. One writer. An instance that is not the blob's writer never publishes
 *     to the blob topic, and whatever reaches the blob topic from a
 *     controller comes from the one that is the writer at that time.
 *  2. No rewrite is a command for another one's display. The walk knows
 *     who published what: a scene in the blob counts as commanded when an
 *     outside client published it for that device, and a rewrite of a
 *     controller commands nothing, whatever it carries. An instance that is
 *     not the writer never shows a blob scene on a device after a choice
 *     there, unless an outside client commanded it after that choice. This
 *     is about what a display shows, whatever rule produced it.
 *     And as the rule itself (scene-layers.js W1): on such an instance a
 *     blob suppression ends only by a newer choice, by rule 18 or with the
 *     device, never by anything delivered; while a choice holds, the blob
 *     decides nothing for that device.
 *  3. Nothing is published for a display the instance does not drive, and
 *     everything published or retired names authoritative evidence.
 *  4. The consumer that is driven by effects agrees with the state.
 * At rest: the walk comes to rest (no controller answers another's write
 * with a write of its own, for ever); mirror and store agree on every
 * instance; and on a display that a v2 drives a new overlay from outside
 * shows at once and a new choice beats it.
 *
 * @param {number} seed
 * @param {Map<string, number>} seen
 * @returns {number} steps taken
 */
function fleetWalk(seed, seen) {
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
      `${message}\n  seed ${seed}, after ${trace.length} steps:\n  ${trace.slice(-(Number(process.env.PIXDCON2_MODEL_TRACE) || 30)).join("\n  ")}`,
    );
  };

  const v1Writes = chance(0.6);
  const secondDrives = v1Writes && chance(0.5);
  count(v1Writes ? "fleet:v1_is_the_writer" : "fleet:v2_is_the_writer");
  count(
    secondDrives
      ? "fleet:second_v2_drives_too"
      : "fleet:second_v2_is_the_edge_instance",
  );
  /** Who may drive a display, until the transition ends. */
  let drivers = v1Writes
    ? secondDrives
      ? ["v1", "I", "J"]
      : ["v1", "I"]
    : ["I"];
  /** The transition has ended in this walk: v1 is gone, I is the writer. */
  let ended = false;
  /** Devices for which I saved a choice while it was not the writer. @type {Set<string>} */
  const carried = new Set();
  /** Device → who drives it now; null: nobody. @type {Map<string, string|null>} */
  const driver = new Map(
    DEVICES.map((device) => [
      device,
      chance(0.15) ? null : drivers[pick(drivers.length)],
    ]),
  );
  /** @param {string} name */
  const outputsOf = (name) =>
    Object.fromEntries(
      DEVICES.map((device) => [
        device,
        /** @type {"drive"|"shadow"} */ (
          driver.get(device) === name ? "drive" : "shadow"
        ),
      ]),
    );

  /** @typedef {{topic: string, payload: string, retain: boolean, own?: boolean}} Message */
  /**
   * @typedef {object} V2
   * @property {"I"|"J"} name
   * @property {false} v1
   * @property {boolean} writer for I it becomes true when the transition ends
   * @property {ReturnType<typeof world>} w
   * @property {number} connection
   * @property {boolean} connected
   * @property {Message[]} downlink
   * @property {Array<{topic: string, payload: string, write: number}>} uplink
   * @property {number[]} acks
   * @property {Array<Message & {connection: number}>} late
   * @property {Set<string>} held devices for which a choice of this instance holds against the blob (only kept for an instance that is not the writer)
   */
  /** @param {"I"|"J"} name @param {boolean} writer @returns {V2} */
  const v2 = (name, writer) => ({
    name,
    v1: false,
    writer,
    w: world({ name, blobWriter: writer, outputs: outputsOf(name) }),
    connection: 0,
    connected: false,
    downlink: [],
    uplink: [],
    acks: [],
    late: [],
    held: new Set(),
  });
  const I = v2("I", !v1Writes);
  const J = v2("J", false);
  const v2s = [I, J];

  /**
   * @typedef {object} V1
   * @property {"v1"} name
   * @property {true} v1
   * @property {boolean} connected
   * @property {Message[]} downlink
   * @property {Array<{topic: string, payload: string, done?: (error?: Error|null) => void, qos: number}>} uplink
   * @property {any} overlay
   */
  /** @type {V1|null} */
  const v1 = v1Writes
    ? {
        name: "v1",
        v1: true,
        connected: false,
        downlink: [],
        uplink: [],
        overlay: null,
      }
    : null;
  const newOverlay = () => {
    if (!v1) return;
    v1.overlay?.unsubscribe();
    v1.overlay = new ConfigOverlay(
      {
        get connected() {
          return v1.connected;
        },
        /** v1's MqttService.publish: a topic below the base; QoS 1 unless told otherwise; false when not connected. @param {string} topic @param {string} payload @param {boolean} _retain @param {(error?: Error|null) => void} [done] @param {number} [qos] */
        publish(topic, payload, _retain, done, qos = 1) {
          if (!v1.connected) return false;
          v1.uplink.push({
            topic: topic === "overlay/blob" ? "blob" : topic.split("/")[2],
            payload,
            done,
            qos,
          });
          // QoS 0: done once it is written to the socket.
          if (qos === 0) done?.(null);
          return true;
        },
        unsubscribeWildcard() {},
      },
      V1_BASE,
      async () => {},
      { logger: QUIET },
    );
  };
  newOverlay();
  /** @type {Array<V1|V2>} */
  const clients = v1 ? [v1, I, J] : [I, J];

  /** The broker's retained store. */
  const store = {
    /** @type {Map<string, string>} */ granular: new Map(),
    /** @type {string|null} */ blob: null,
  };
  /** Every scene v1 put into the store with a rewrite, as "<device>/<scene>". @type {Set<string>} */
  const putBackByV1 = new Set();
  /** "<device>/<scene>" → the last time an outside client published that scene for that device in the blob. A rewrite of a controller carries scenes and commands none. @type {Map<string, number>} */
  const commandedAt = new Map();
  /** Per v2 instance: device → the time of its last choice there that still stands (rule 18 takes it back). @type {Map<string, Map<string, number>>} */
  const chosenAt = new Map([
    ["I", new Map()],
    ["J", new Map()],
  ]);
  let now = 0;
  /** Rewrites of the v2 writer that the broker has stored. @type {string[]} */
  const writerBlobs = [];
  let names = 0;
  const fresh = (/** @type {string} */ prefix) => `${prefix}${++names}`;

  /** Instances that are not the writer and hold a choice for the device. @param {string} device */
  const holders = (device) =>
    v2s.filter((c) => !c.writer && c.held.has(device));

  /**
   * The broker processes a publish: the store takes it, and every client
   * that is connected gets it, the publisher as its own echo.
   *
   * @param {string} topic
   * @param {string} payload
   * @param {V1|V2|null} from null: an outside client
   */
  const broker = (topic, payload, from) => {
    if (topic === "blob") {
      // 1. One writer, at any time.
      const writer = v1Writes && !ended ? "v1" : "I";
      if (from && from.name !== writer)
        fail(
          `${from.name} published to the blob topic; the writer is ${writer}`,
        );
      const before = blobScenes(parseOrNull(store.blob));
      const after = blobScenes(parseOrNull(payload));
      if (from?.v1)
        for (const [device, scene] of after)
          if (before.get(device) !== scene)
            putBackByV1.add(`${device}/${scene}`);
      for (const device of DEVICES) {
        if (holders(device).length === 0) continue;
        if (from?.v1 && after.has(device)) {
          count("v1:rewrite_names_a_scene_for_a_device_a_v2_choice_holds");
          if (after.get(device) !== before.get(device))
            count("v1:rewrite_brings_back_another_scene_than_the_store_held");
        }
        if (
          from === null &&
          after.has(device) &&
          after.get(device) !== before.get(device)
        )
          count(
            "limit:outside_blob_scene_for_a_device_a_reader_s_choice_holds",
          );
      }
      if (from === null)
        for (const [device, scene] of after)
          commandedAt.set(`${device}/${scene}`, ++now);
      if (from?.v1 && payload !== "") count("v1:rewrite_stored");
      if (from && !from.v1 && payload !== "") writerBlobs.push(payload);
      store.blob = payload === "" ? null : payload;
    } else if (payload === "") store.granular.delete(topic);
    else store.granular.set(topic, payload);
    for (const client of clients)
      if (client.connected)
        client.downlink.push({
          topic,
          payload,
          retain: false,
          own: client === from,
        });
  };

  /** Is a blob write of another controller in the broker's hands, or on its way to this one? @param {V1|V2} client */
  const foreignBlobInFlight = (client) =>
    clients.some(
      (other) =>
        other !== client &&
        other.uplink.some((publish) => publish.topic === "blob"),
    ) ||
    client.downlink.some(
      (item) => item.topic === "blob" && !item.retain && !item.own,
    );

  /**
   * What a v2 instance answered: its publishes go onto its wire, and what
   * must hold for an effect is checked.
   *
   * @param {V2} c
   * @param {number} mark
   * @param {string} cause
   */
  const carry = (c, mark, cause) => {
    for (const effect of c.w.effects.slice(mark)) {
      if (effect.type === "retire") {
        if (["connect", "disconnect", "settled", "tick"].includes(cause))
          fail(`${c.name}: a ${cause} retired a suppression (${effect.ended})`);
        if (!mayCause("retire", effect.evidence))
          fail(`${c.name}: retired on ${effect.evidence}`);
        if (effect.layer !== "blob") continue;
        // 2. Nothing that is delivered ends a blob suppression of an
        // instance that is not the writer.
        if (!c.writer && !["replaced", "dropped"].includes(effect.ended))
          fail(
            `${c.name} is not the blob's writer, and its blob suppression for ${effect.device} ended as ${effect.ended}`,
          );
        if (effect.ended === "dropped") {
          chosenAt.get(c.name)?.delete(effect.device);
          if (c.held.delete(effect.device) && cause === "output")
            count("reader:choice_made_in_shadow_dropped_by_rule_18");
        }
        continue;
      }
      if (effect.type !== "publish-clear" && effect.type !== "publish-blob")
        continue;
      if (!c.connected) fail(`${c.name} published while not connected`);
      if (["connect", "disconnect", "settled"].includes(cause))
        fail(`${c.name}: a ${cause} published something`);
      if (
        !mayCause("publish", effect.evidence, {
          repeatOf: effect.evidence === "timer" ? "message" : undefined,
        })
      )
        fail(`${c.name}: publish on ${effect.evidence}`);
      if (effect.type === "publish-clear") {
        // 3.
        if (driver.get(effect.device) !== c.name)
          fail(`${c.name} cleared ${effect.device}, which it does not drive`);
        c.uplink.push({
          topic: effect.device,
          payload: "",
          write: effect.write,
        });
      } else {
        // 1.
        if (!c.writer)
          fail(
            `${c.name} is not the blob's writer and published to the blob topic`,
          );
        for (const { device } of effect.generations) {
          if (driver.get(device) !== c.name)
            fail(`${c.name} stripped ${device}, which it does not drive`);
          if (carried.has(device))
            count("end:choice_saved_by_a_reader_stripped_by_the_writer");
        }
        c.uplink.push({
          topic: "blob",
          payload: effect.payload,
          write: effect.write,
        });
      }
    }
  };

  /** What must hold for a v2 instance after every step. @param {V2} c */
  const check = (c) => {
    // 4.
    const stale = c.w.stale(DEVICES);
    if (stale.length > 0)
      fail(
        `${c.name}: a consumer that is driven by effects is stale. ${stale.join("; ")}`,
      );
    const current = c.w.state().connection;
    for (const device of DEVICES) {
      const inputs = sceneInputs(c.w.state(), device);
      for (const layer of /** @type {const} */ (["granular", "blob"])) {
        const value = inputs[layer];
        if (!value) continue;
        if (value.confirmed !== (value.connection === current))
          fail(`${c.name} ${device} ${layer}: confirmed is wrong`);
        if (value.inEffect && !value.confirmed)
          fail(
            `${c.name} ${device} ${layer}: in effect without being delivered on connection ${current}`,
          );
      }
      // 2. What the display shows, whatever rule led to it. For I this
      // goes on after the transition ended, for the choices it saved
      // before: as the writer it shows a blob scene on such a device only
      // when an outside client commanded it after the choice.
      const chosen = chosenAt.get(c.name)?.get(device);
      if (
        chosen !== undefined &&
        inputs.blob?.inEffect &&
        c.w.shows(device).endsWith("(blob)") &&
        !((commandedAt.get(`${device}/${inputs.blob.scene}`) ?? 0) > chosen)
      )
        fail(
          `${c.name} shows ${c.w.shows(device)} on ${device}: no outside client has published that scene for it since the choice there; a controller's rewrite carried it`,
        );
      // 2. The rule.
      if (c.held.has(device)) {
        if (!c.w.state().suppressions.get(device)?.blob)
          fail(
            `${c.name}: the choice for ${device} no longer holds against the blob, and nothing said why`,
          );
        if (inputs.blob?.inEffect)
          fail(
            `${c.name} shows the blob's ${inputs.blob.scene} on ${device} although a choice holds`,
          );
        if (c.w.shows(device).endsWith("(blob)"))
          fail(
            `${c.name} shows ${c.w.shows(device)} on ${device} although a choice holds`,
          );
      }
    }
  };

  /** @param {V2} c @param {import("../../src/overlay/scene-layers.js").LayersInput} input */
  const feedTo = (c, input) => {
    const mark = c.w.effects.length;
    const result = c.w.feed(input);
    carry(c, mark, input.type);
    check(c);
    return result;
  };

  /** @param {V1|V2} client */
  const replayTo = (client) => {
    for (const [device, payload] of store.granular)
      client.downlink.push({ topic: device, payload, retain: true });
    if (store.blob !== null)
      client.downlink.push({
        topic: "blob",
        payload: store.blob,
        retain: true,
      });
  };

  const anyClient = () => clients[pick(clients.length)];
  const anyV2 = () => v2s[pick(2)];

  const actions = {
    outsideGranular() {
      const device = DEVICES[pick(3)];
      const stored = store.granular.get(device);
      const roll = random();
      const payload =
        roll < 0.2
          ? ""
          : roll < 0.3 && stored !== undefined
            ? stored
            : fresh("g");
      trace.push(`outside: granular ${device} = ${payload || "(clear)"}`);
      broker(device, payload, null);
    },
    outsideBlob() {
      const roll = random();
      /** @type {string} */
      let payload = "";
      if (roll < 0.1 && writerBlobs.length > 0) {
        // Somebody publishes a rewrite of the v2 writer again.
        payload = writerBlobs[pick(writerBlobs.length)];
      } else if (roll < 0.92) {
        const base = parseOrEmpty(store.blob);
        const devices = DEVICES.map((name) => {
          const existing = (base.devices ?? []).find(
            (/** @type {any} */ entry) => entry.name === name,
          );
          const draw = random();
          if (draw < 0.4) return { name, scene: fresh("b") };
          if (draw < 0.6) return { name };
          return existing ?? { name };
        });
        const kept =
          typeof base[WRITE_MARK] === "string" && chance(0.3)
            ? { [WRITE_MARK]: base[WRITE_MARK] }
            : {};
        payload = JSON.stringify({ devices, note: fresh("n"), ...kept });
      }
      trace.push(`outside: blob = ${payload || "(clear)"}`);
      broker("blob", payload, null);
    },
    deliver() {
      const waiting = clients.filter((client) => client.downlink.length > 0);
      if (waiting.length === 0) return;
      const client = waiting[pick(waiting.length)];
      const candidates = client.downlink
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item, index }) =>
            item.retain ||
            client.downlink.findIndex(
              (other) => !other.retain && other.topic === item.topic,
            ) === index,
        );
      const { item, index } = candidates[pick(candidates.length)];
      client.downlink.splice(index, 1);
      trace.push(
        `deliver to ${client.name}: ${item.topic} ${item.retain ? "replay" : item.own ? "own echo" : "live"} ${item.payload || "(empty)"}`,
      );
      if (client.v1) {
        if (item.topic === "blob")
          client.overlay._handleBlob(item.payload, { retain: item.retain });
        else
          client.overlay._handleGranular(
            `${V1_BASE}/overlay/device/${item.topic}/scene`,
            item.payload,
            { retain: item.retain },
          );
        return;
      }
      if (item.topic === "blob" && !client.writer && client.held.size > 0) {
        const scenes = blobScenes(parseOrNull(item.payload));
        for (const device of client.held)
          count(
            item.payload === ""
              ? "reader:blob_cleared_while_a_choice_holds"
              : !scenes.has(device)
                ? "reader:blob_without_the_scene_while_a_choice_holds"
                : item.retain
                  ? "reader:replay_names_a_scene_while_a_choice_holds"
                  : "reader:live_blob_names_a_scene_while_a_choice_holds",
          );
      }
      if (
        item.topic === "blob" &&
        !client.writer &&
        writerBlobs.includes(item.payload)
      )
        count("writer:v2_rewrite_delivered_to_the_other_v2");
      const meta = { retain: item.retain, connection: client.connection };
      if (item.topic === "blob")
        feedTo(client, { type: "blob", payload: item.payload, ...meta });
      else
        feedTo(client, {
          type: "granular",
          device: item.topic,
          payload: item.payload,
          ...meta,
        });
    },
    brokerProcess() {
      const sending = clients.filter((client) => client.uplink.length > 0);
      if (sending.length === 0) return;
      const client = sending[pick(sending.length)];
      if (client.v1) {
        const publish = /** @type {V1["uplink"][number]} */ (
          client.uplink.shift()
        );
        trace.push(
          `broker: processes v1's write on ${publish.topic}: ${publish.payload || "(clear)"}`,
        );
        broker(publish.topic, publish.payload, client);
        // QoS 1: the acknowledgement. (QoS 0 was done when it was written.)
        if (publish.qos !== 0) publish.done?.(null);
        return;
      }
      const publish = /** @type {V2["uplink"][number]} */ (
        client.uplink.shift()
      );
      trace.push(
        `broker: processes write ${publish.write} of ${client.name} on ${publish.topic}`,
      );
      broker(publish.topic, publish.payload, client);
      client.acks.push(publish.write);
    },
    acknowledge() {
      const c = anyV2();
      if (c.acks.length === 0) return;
      const [write] = c.acks.splice(pick(c.acks.length), 1);
      trace.push(`ack to ${c.name}: write ${write}`);
      feedTo(c, { type: "published", write, outcome: "confirmed" });
    },
    choice() {
      const client = anyClient();
      const scene = fresh("c");
      if (foreignBlobInFlight(client))
        count(
          "fleet:choice_while_a_blob_write_of_another_controller_is_in_flight",
        );
      if (client.v1) {
        // v1's UI offers the displays v1 runs.
        const own = DEVICES.filter((device) => driver.get(device) === "v1");
        if (own.length === 0) return;
        const device = own[pick(own.length)];
        trace.push(`choice at v1: ${device} = ${scene}`);
        if (v2s.some((c) => c.uplink.length > 0 || c.acks.length > 0))
          count("fleet:two_controllers_chose_before_either_heard_of_the_other");
        client.overlay.clearDeviceScene(device, scene);
        return;
      }
      const device = DEVICES[pick(3)];
      trace.push(`choice at ${client.name}: ${device} = ${scene}`);
      const named = sceneInputs(client.w.state(), device).blob !== null;
      const mark = client.w.effects.length;
      const { plan, decision } = client.w.choose(device, scene);
      if (decision.action !== "apply")
        fail(`the choice was not applied: ${decision.reason}`);
      // The writer's choices are judged by the walks of one instance, with
      // the one order MQTT cannot give; here only a reader's are followed.
      if (client.writer) chosenAt.get(client.name)?.delete(device);
      else chosenAt.get(client.name)?.set(device, ++now);
      carried.delete(device);
      if (!client.writer) {
        if (plan.blob === null)
          fail(
            `${client.name} is not the writer, and its choice for ${device} does not hold against the blob`,
          );
        client.held.add(device);
        if (!named)
          count("reader:choice_while_the_blob_names_no_scene_for_the_device");
      }
      carry(client, mark, "choice");
      check(client);
    },
    settle() {
      const c = anyV2();
      if (c.connection === 0) return;
      trace.push(`settle hint at ${c.name}`);
      feedTo(c, {
        type: "settled",
        connection: c.connection,
        complete: chance(0.8),
      });
    },
    tick() {
      const client = anyClient();
      trace.push(`tick at ${client.name}`);
      // v1: its retry timer.
      if (client.v1) client.overlay._flushSceneClears();
      else feedTo(client, { type: "tick" });
    },
    disconnect() {
      const client = anyClient();
      if (!client.connected) return;
      client.connected = false;
      // Some of its publishes on their way still reach the store; the
      // others, and every acknowledgement, are lost.
      const reaching = client.uplink.slice(0, pick(client.uplink.length + 1));
      trace.push(
        `disconnect of ${client.name} (${reaching.length} of ${client.uplink.length} writes reached the store)`,
      );
      for (const publish of reaching)
        broker(publish.topic, publish.payload, client);
      client.uplink = [];
      if (client.v1) {
        client.downlink = [];
        client.overlay._onDisconnect();
        return;
      }
      client.late = client.downlink
        .slice(0, pick(client.downlink.length + 1))
        .map((item) => ({ ...item, connection: client.connection }));
      client.downlink = [];
      client.acks = [];
      feedTo(client, { type: "disconnect", connection: client.connection });
    },
    lateMessage() {
      const c = anyV2();
      const item = c.late.shift();
      if (!item) return;
      trace.push(
        `late to ${c.name}: ${item.topic} of connection ${item.connection}`,
      );
      const meta = { retain: item.retain, connection: item.connection };
      const { decision } =
        item.topic === "blob"
          ? feedTo(c, { type: "blob", payload: item.payload, ...meta })
          : feedTo(c, {
              type: "granular",
              device: item.topic,
              payload: item.payload,
              ...meta,
            });
      if (decision.reason !== "superseded_source")
        fail(
          `${c.name}: a message of connection ${item.connection} was not dropped`,
        );
    },
    /** @param {V1|V2} [which] */
    connect(which) {
      const client = which ?? anyClient();
      if (client.connected) return;
      client.connected = true;
      if (client.v1) {
        trace.push("connect of v1");
        replayTo(client);
        client.overlay._onConnect();
        return;
      }
      client.connection += 1;
      trace.push(`connect ${client.connection} of ${client.name}`);
      feedTo(client, { type: "connect", connection: client.connection });
      replayTo(client);
    },
    restart() {
      const client = anyClient();
      const reaching = client.connected
        ? client.uplink.slice(0, pick(client.uplink.length + 1))
        : [];
      client.connected = false;
      trace.push(
        `restart of ${client.name} (${reaching.length} writes reached the store)`,
      );
      for (const publish of reaching)
        broker(publish.topic, publish.payload, client);
      client.uplink = [];
      client.downlink = [];
      if (client.v1) {
        // A new v1 process: it knows nothing of what the old one cleared.
        count("v1:restart");
        newOverlay();
        return;
      }
      client.acks = [];
      client.late = [];
      client.connection = 0;
      if (!client.writer && client.held.size > 0)
        count("reader:restart_while_a_choice_holds");
      client.w.restart();
      check(client);
    },
    /** The last step of the switch-over (knowledge entry, section 10): v1 is stopped, then I is started again and is the blob's writer from then on. */
    endTransition() {
      if (!v1 || ended) return;
      count("fleet:transition_ended");
      // v1 stops. What it had handed to the broker may still be stored.
      const reaching = v1.connected
        ? v1.uplink.slice(0, pick(v1.uplink.length + 1))
        : [];
      trace.push(
        `the transition ends: v1 stops (${reaching.length} of its writes reached the store), I restarts as the blob's writer`,
      );
      for (const publish of reaching)
        broker(publish.topic, publish.payload, v1);
      v1.connected = false;
      v1.uplink = [];
      v1.downlink = [];
      v1.overlay.unsubscribe();
      clients.splice(clients.indexOf(v1), 1);
      ended = true;
      // The interlock is off from the next start on. A display that v1 or
      // a second v2 still had is nobody's, or it is I's when the new
      // process starts: its output changes while nothing of I runs.
      drivers = ["I"];
      for (const device of DEVICES) {
        if (driver.get(device) === "I") continue;
        const was = driver.get(device);
        driver.set(device, null);
        if (was === "J")
          feedTo(J, { type: "output", device, output: "shadow" });
        if (chance(0.5)) driver.set(device, "I");
      }
      // I stops, too. Its clears on their way reach the store or do not.
      for (const publish of I.connected
        ? I.uplink.slice(0, pick(I.uplink.length + 1))
        : [])
        broker(publish.topic, publish.payload, I);
      for (const device of I.held) carried.add(device);
      for (const device of carried)
        if (
          putBackByV1.has(
            `${device}/${blobScenes(parseOrNull(store.blob)).get(device)}`,
          )
        )
          count("end:blob_holds_a_scene_that_v1_put_back");
      const file = I.w;
      I.writer = true;
      I.connected = false;
      I.connection = 0;
      I.uplink = [];
      I.downlink = [];
      I.acks = [];
      I.late = [];
      I.held.clear();
      // A new process on the same config.json: the choices, and the
      // suppressions that were saved with them.
      I.w = world({
        name: "I, the writer",
        blobWriter: true,
        outputs: outputsOf("I"),
        choices: Object.fromEntries(file.choices),
        saved: Object.fromEntries(file.saved),
      });
      for (const effect of I.w.effects)
        if (effect.type === "retire" && effect.ended === "dropped") {
          carried.delete(effect.device);
          if (effect.layer === "blob")
            count("end:choice_made_in_shadow_dropped_at_the_start");
        }
      carry(I, 0, "output");
      check(I);
    },
    /** A display changes hands: the old driver lets go, then the new one takes it. @param {string} [device] @param {string|null} [to] */
    handover(device = DEVICES[pick(3)], to) {
      const from = driver.get(device) ?? null;
      const others = [...drivers, null].filter((name) => name !== from);
      const next = to === undefined ? others[pick(others.length)] : to;
      if (next === from) return;
      trace.push(
        `handover: ${device} from ${from ?? "nobody"} to ${next ?? "nobody"}`,
      );
      driver.set(device, null);
      const old = v2s.find((c) => c.name === from);
      if (old) feedTo(old, { type: "output", device, output: "shadow" });
      driver.set(device, next);
      const taking = v2s.find((c) => c.name === next);
      if (taking) {
        count("fleet:handover_to_v2");
        feedTo(taking, { type: "output", device, output: "drive" });
      } else if (next === "v1") count("fleet:handover_to_v1");
    },
  };

  try {
    /** @type {Array<[keyof typeof actions, number]>} */
    const weights = [
      ["outsideGranular", 8],
      ["outsideBlob", 10],
      ["deliver", 34],
      ["brokerProcess", 18],
      ["acknowledge", 8],
      ["choice", 14],
      ["settle", 3],
      ["tick", 6],
      ["disconnect", 3],
      ["lateMessage", 2],
      ["connect", 12],
      ["restart", 1.5],
      ["handover", 2],
      ["endTransition", 0.7],
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

    // --- the end of the walk: everything in flight arrives -----------------
    trace.push("— quiesce —");
    actions.handover("D1", "I");
    for (const client of clients) actions.connect(client);
    for (let round = 0; ; round++) {
      if (round > 200)
        fail(
          "the walk does not come to rest: the controllers keep answering each other",
        );
      while (clients.some((client) => client.downlink.length > 0))
        actions.deliver();
      while (clients.some((client) => client.uplink.length > 0))
        actions.brokerProcess();
      while (v2s.some((c) => c.acks.length > 0)) actions.acknowledge();
      if (clients.some((client) => client.downlink.length > 0)) continue;
      const marks = v2s.map((c) => c.w.effects.length);
      for (const c of v2s) feedTo(c, { type: "tick" });
      if (!ended) v1?.overlay._flushSceneClears();
      if (
        clients.every((client) => client.uplink.length === 0) &&
        v2s.every((c, index) => c.w.effects.length === marks[index])
      )
        break;
    }

    // Mirror and store agree, on every v2 instance.
    const storedBlob = blobScenes(parseOrNull(store.blob));
    for (const c of v2s) {
      for (const device of DEVICES) {
        const inputs = sceneInputs(c.w.state(), device);
        const drives = driver.get(device) === c.name;
        for (const [layer, stored] of /** @type {const} */ ([
          ["granular", store.granular.get(device)],
          ["blob", storedBlob.get(device)],
        ])) {
          const value = inputs[layer];
          if (
            value &&
            stored === undefined &&
            value.connection < c.connection
          ) {
            count("limit:cleared_while_away");
            if (value.inEffect)
              fail(
                `${c.name} ${device} ${layer}: cleared while away and still in effect`,
              );
            continue;
          }
          if ((value?.scene ?? undefined) !== stored)
            fail(
              `${c.name} ${device} ${layer}: the store holds ${stored}, the mirror ${value?.scene}`,
            );
          if (value && !value.confirmed)
            fail(
              `${c.name} ${device} ${layer}: stored and not delivered on the connection`,
            );
          // What a choice replaced is gone from the store where the
          // instance may remove it: its own granular topic, and the blob
          // for the writer.
          if (
            drives &&
            value &&
            !value.inEffect &&
            (layer === "granular" || c.writer)
          )
            fail(
              `${c.name} ${device} ${layer}: ${value.scene} is still stored although the choice replaced it`,
            );
        }
      }
    }

    // Both directions still work on a display that a v2 instance drives.
    const toggled = fresh("g");
    trace.push(`epilogue: outside granular D1 = ${toggled}`);
    broker("D1", toggled, null);
    while (clients.some((client) => client.downlink.length > 0))
      actions.deliver();
    if (I.w.shows("D1") !== `${toggled} (overlay)`)
      fail(`a new overlay from outside does not show on I: ${I.w.shows("D1")}`);
    const mark = I.w.effects.length;
    I.w.choose("D1", "last");
    carry(I, mark, "choice");
    check(I);
    if (I.w.shows("D1") !== "last (config)")
      fail(`a new choice does not beat the overlay on I: ${I.w.shows("D1")}`);
    return trace.length;
  } finally {
    // v1's module keeps timers; they go with the walk.
    v1?.overlay.unsubscribe();
  }
}

test(`fleet model: ${WALKS} random walks of ${STEPS} steps over one broker with several controllers, pixdcon v1 (its real ConfigOverlay) and two v2 instances with their own secrets; exactly one of them writes the blob. Nobody else publishes to the blob topic, no rewrite is a scene command for another controller's display, a consumer that is driven by effects never goes stale, and the walk comes to rest`, () => {
  /** @type {Map<string, number>} */
  const seen = new Map();
  let steps = 0;
  for (let seed = FIRST_SEED; seed < FIRST_SEED + WALKS; seed++)
    steps += fleetWalk(seed, seen);
  assert.ok(
    steps > WALKS * STEPS * 0.5,
    `the walks really walked (${steps} steps)`,
  );
  if (WALKS >= 1000)
    assert.deepEqual(
      FLEET_MUST_SEE.filter((what) => !seen.has(what)),
      [],
      "every arrangement and every hostile order was met at least once",
    );
  assert.deepEqual(
    [...seen.keys()].filter((what) => !FLEET_MUST_SEE.includes(what)).sort(),
    [],
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
