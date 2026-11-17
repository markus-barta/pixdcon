/**
 * Test kind 2 of 3 (API and MQTT contract): what pixdcon 2 publishes.
 *
 * Controller payloads and availability use a real loopback broker and a
 * second MQTT client, with recorded store views and injected publish outcomes.
 * Discovery identity is compared directly with the read-only v1 builders.
 * Remaining telemetry/bootstrap integrations name their W1/W3 blockers.
 * Owner: API + live channel worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { connectAsync } from "mqtt";
import { startMemoryBroker } from "../../dev/memory-broker.js";
import { TelemetryCollector } from "../../src/health/telemetry.js";
import { HealthModel } from "../../src/health/health-model.js";
import { createPixooDriver } from "../../src/drivers/pixoo-driver.js";
import { createAwtrixDriver } from "../../src/drivers/awtrix-driver.js";
import { startFakePixoo } from "../../dev/fake-pixoo.js";
import { startFakeAwtrix } from "../../dev/fake-awtrix.js";
import { systemClock } from "../../src/core/clock.js";
import { manualClock } from "../../src/core/clock.js";
import { createLogger } from "../../src/core/logger.js";
import { createTopics } from "../../src/mqtt/topics.js";
import {
  expireAfterSeconds,
  ulanziDiscovery,
  pixooDiscovery,
} from "../../src/mqtt/ha-discovery.js";
import {
  availabilityOutcome,
  availabilitySent,
  createAvailabilityLedger,
  owesOffline,
  planAvailability,
  StatusPublisher,
} from "../../src/mqtt/status-publisher.js";

/**
 * A ledger in which these payloads were published and confirmed, in order.
 *
 * @param {Array<[string, "online"|"offline"]>} published
 */
function ledgerOf(published) {
  const ledger = createAvailabilityLedger();
  for (const [device, payload] of published)
    availabilityOutcome(
      ledger,
      device,
      payload,
      availabilitySent(ledger, device, payload),
      "confirmed",
    );
  return ledger;
}

test("availability is retired: a device that left the config, was disabled or went from drive to shadow gets one more offline while the controller stays online", () => {
  const ledger = ledgerOf([
    ["ulanzi-a", "online"],
    ["ulanzi-b", "online"],
    ["pixoo-c", "online"],
    ["pixoo-d", "online"],
    ["pixoo-d", "offline"],
    ["gone", "online"],
    ["gone-offline", "online"],
    ["gone-offline", "offline"],
  ]);
  const plan = planAvailability(ledger, [
    { name: "ulanzi-a", driven: true, health: "online" },
    { name: "ulanzi-b", driven: false, health: "shadow" }, // drive → shadow, e.g. v1 took it back
    { name: "pixoo-c", driven: false, health: null }, // disabled
    { name: "pixoo-d", driven: true, health: "offline" },
    { name: "never-driven", driven: false, health: "shadow" },
    { name: "starting", driven: true, health: "starting" },
  ]);
  assert.deepEqual(plan, [
    { device: "ulanzi-a", payload: "online", retire: false },
    { device: "ulanzi-b", payload: "offline", retire: true },
    { device: "pixoo-c", payload: "offline", retire: true },
    { device: "pixoo-d", payload: "offline", retire: false },
    { device: "starting", payload: "online", retire: false },
    { device: "gone", payload: "offline", retire: true }, // removed from config.json
  ]);
  // Nothing for a device this instance never said "online" for, and
  // nothing twice: once the offline is confirmed, the device is forgotten.
  const after = ledgerOf([["ulanzi-a", "online"]]);
  assert.deepEqual(
    planAvailability(after, [
      { name: "ulanzi-a", driven: true, health: "stale" },
      { name: "ulanzi-b", driven: false, health: "shadow" },
    ]),
    [{ device: "ulanzi-a", payload: "online", retire: false }],
    "stale is still available; only offline is not",
  );
  // A clean stop: nothing is driven any more, so everything that was said
  // to be online is taken back.
  assert.deepEqual(
    planAvailability(
      ledgerOf([
        ["ulanzi-a", "online"],
        ["pixoo-d", "online"],
        ["pixoo-d", "offline"],
      ]),
      [],
    ),
    [{ device: "ulanzi-a", payload: "offline", retire: true }],
  );
});

test("N6: an online whose acknowledgement was lost with the connection is still owed an offline; the debt ends only when the broker confirmed an offline that was sent after it", () => {
  const ledger = createAvailabilityLedger();
  const driven = [
    { name: "D", driven: true, health: /** @type {const} */ ("online") },
  ];
  const shadow = [
    { name: "D", driven: false, health: /** @type {const} */ ("shadow") },
  ];
  assert.deepEqual(planAvailability(ledger, driven), [
    { device: "D", payload: "online", retire: false },
  ]);

  // The online is handed to the gateway. The broker stores it; the
  // connection ends before its acknowledgement arrives.
  const first = availabilitySent(ledger, "D", "online");
  assert.equal(
    owesOffline(ledger, "D"),
    true,
    "owed from the moment it was handed over, not from the acknowledgement",
  );
  availabilityOutcome(ledger, "D", "online", first, "offline");
  assert.equal(owesOffline(ledger, "D"), true);

  // D goes into shadow, or leaves the config, while the broker is away.
  const retire = [{ device: "D", payload: "offline", retire: true }];
  assert.deepEqual(planAvailability(ledger, shadow), retire);
  assert.deepEqual(planAvailability(ledger, []), retire);

  // After the reconnect the offline is sent. Whatever does not confirm it
  // leaves the debt: a timeout, an error, another lost acknowledgement.
  for (const outcome of /** @type {const} */ ([
    "timeout",
    "error",
    "offline",
    "sent",
  ])) {
    const attempt = availabilitySent(ledger, "D", "offline");
    availabilityOutcome(ledger, "D", "offline", attempt, outcome);
    assert.deepEqual(planAvailability(ledger, shadow), retire, outcome);
  }

  // An offline that was sent before a newer online does not take that back.
  const early = availabilitySent(ledger, "D", "offline");
  const again = availabilitySent(ledger, "D", "online");
  availabilityOutcome(ledger, "D", "offline", early, "confirmed");
  availabilityOutcome(ledger, "D", "online", again, "confirmed");
  assert.deepEqual(planAvailability(ledger, shadow), retire);

  // The broker confirms an offline sent after it: paid, and forgotten.
  const last = availabilitySent(ledger, "D", "offline");
  availabilityOutcome(ledger, "D", "offline", last, "confirmed");
  assert.equal(owesOffline(ledger, "D"), false);
  assert.deepEqual(planAvailability(ledger, shadow), []);
  assert.deepEqual(planAvailability(ledger, []), []);
  assert.equal(ledger.devices.size, 0);
});

test("discovery expiry: every entity loses its state three telemetry intervals after the last telemetry, at least 30 s", () => {
  assert.equal(expireAfterSeconds(60000), 180);
  assert.equal(expireAfterSeconds(5000), 30);
  assert.equal(expireAfterSeconds(10000), 30);
  assert.equal(expireAfterSeconds(10001), 31);
});

test("health and state payloads keep the v1 fields; the scene of a device is published when it changes", async (t) => {
  const f = await publications(t);
  const health = JSON.parse(f.broker.retained()[f.topics.health]);
  assert.deepEqual(Object.keys(health), [
    "status",
    "timestamp",
    "devices",
    "errorCount",
    "lastError",
  ]);
  assert.equal(health.status, "ok");
  assert.equal(
    health.devices[0].lastSeen,
    f.states.get("U").health.lastContactAt,
  );
  const changed = f.states.get("P");
  changed.effective.scene = "new-scene";
  changed.effective.frameCount = 103;
  f.state.emit("device", changed);
  await f.publisher.pending;
  const state = JSON.parse(f.broker.retained()[f.topics.state]);
  assert.equal(state.currentScene, null);
  assert.equal(state.running, true);
  assert.equal(
    state.devices.find((/** @type {any} */ d) => d.name === "P").scene,
    "new-scene",
    "scene toggle consumer sees the measured scene immediately",
  );
  assert.equal(
    state.devices.find((/** @type {any} */ d) => d.name === "P").frameCount,
    103,
  );
  changed.health.state = "offline";
  changed.health.consecutiveErrors = 1;
  changed.health.lastError = {
    message: "unreachable",
    at: new Date(f.clock.now()).toISOString(),
  };
  f.state.emit("device", changed);
  await f.publisher.pending;
  const failed = JSON.parse(f.broker.retained()[f.topics.health]);
  assert.equal(failed.status, "degraded");
  assert.equal(failed.errorCount, 1);
  changed.health.state = "online";
  changed.health.consecutiveErrors = 0;
  f.state.emit("device", changed);
  await f.publisher.pending;
  assert.equal(JSON.parse(f.broker.retained()[f.topics.health]).status, "ok");
  assert.equal(
    JSON.parse(f.broker.retained()[f.topics.health]).errorCount,
    1,
    "lifetime count survives recovery",
  );
  assert.ok(
    f.broker
      .published()
      .filter((m) => m.clientId === "status-writer")
      .every(
        (m) =>
          m.retain && m.qos === (m.topic.endsWith("/availability") ? 1 : 0),
      ),
  );
});
test("last will: the health topic says offline when the process dies", async (t) => {
  const f = await publications(t);
  const will = StatusPublisher.lastWill(f.topics);
  assert.equal(will.retain, true);
  assert.equal(will.qos, 1);
  assert.equal(JSON.parse(will.payload).status, "offline");
  const received = new Promise((resolve) =>
    f.reader.on("message", (topic, payload) => {
      if (
        topic === f.topics.health &&
        JSON.parse(payload.toString()).status === "offline"
      )
        resolve(undefined);
    }),
  );
  f.writer.stream.destroy();
  await received;
  assert.equal(
    JSON.parse(f.broker.retained()[f.topics.health]).status,
    "offline",
  );
  f.gateway.connected = false;
});
test("Home Assistant discovery identity: topic, unique_id, object_id, state_topic, value_template and the device block equal v1 for Ulanzi (10) and Pixoo (2)", async (_t) => {
  const topics = createTopics();
  const { TelemetryCollector } = await import(
    new URL("../../../lib/telemetry-collector.js", import.meta.url).href
  );
  /** @type {Array<{topic:string, payload:any}>} */ const legacy = [];
  const collector = new TelemetryCollector({
    mqttService: {
      baseTopic: topics.base,
      publishRaw: (
        /** @type {any} */ topic,
        /** @type {any} */ payload,
        /** @type {any} */ retain,
      ) => {
        assert.equal(retain, true);
        legacy.push({ topic, payload: JSON.parse(JSON.stringify(payload)) });
      },
    },
    logger: { info() {} },
  });
  const ulanzi = { name: "ulanzi-57", address: "127.0.0.1:8057" },
    pixoo = { name: "pixoo-189", address: "127.0.0.1:8189" };
  const stats = { uid: "awtrix_5807d0", version: "0.98" };
  collector._publishHaDiscovery({ ...ulanzi, ip: ulanzi.address }, stats);
  collector._publishPixooHaDiscovery({ ...pixoo, ip: pixoo.address });
  const current = [
    ...ulanziDiscovery(ulanzi, stats, topics, { telemetryIntervalMs: 60000 }),
    ...pixooDiscovery(pixoo, topics, { telemetryIntervalMs: 60000 }),
  ];
  assert.equal(current.length, 12);
  for (let i = 0; i < current.length; i++) {
    const expected = { ...legacy[i].payload },
      actual = { ...current[i].payload };
    delete expected.availability_topic;
    delete expected.availability_template;
    delete actual.availability;
    delete actual.availability_mode;
    delete actual.expire_after;
    assert.equal(current[i].topic, legacy[i].topic);
    assert.deepEqual(actual, expected, current[i].topic);
  }
  assert.deepEqual(
    ulanziDiscovery(ulanzi, {}, topics, { telemetryIntervalMs: 60000 }),
    [],
    "no identity without uid",
  );
});
test("Home Assistant discovery availability: Ulanzi sensors and Pixoo brightness name the controller health and the device's availability topic, mode all; every entity, Ulanzi and Pixoo, carries expire_after of three telemetry intervals", async (_t) => {
  const topics = createTopics({ statusBaseTopic: "home/hsb1/pixdcon2" });
  for (const interval of [5000, 60000, 10001]) {
    const ulanzi = ulanziDiscovery(
      { name: "U", address: "127.0.0.1" },
      { uid: "uid" },
      topics,
      { telemetryIntervalMs: interval },
    );
    const pixoo = pixooDiscovery({ name: "P", address: "127.0.0.1" }, topics, {
      telemetryIntervalMs: interval,
    });
    for (const message of [...ulanzi, ...pixoo]) {
      assert.equal(message.payload.expire_after, expireAfterSeconds(interval));
      assert.equal(message.payload.availability_mode, "all");
      assert.equal(Object.hasOwn(message.payload, "availability_topic"), false);
      const entries = /** @type {Array<any>} */ (message.payload.availability);
      assert.equal(entries[0].topic, topics.health);
      assert.equal(
        entries[0].value_template,
        "{{ 'online' if value_json.status in ['ok', 'degraded'] else 'offline' }}",
      );
    }
    assert.deepEqual(
      /** @type {any[]} */ (ulanzi[0].payload.availability).map((v) => v.topic),
      [topics.health, topics.availability("U")],
    );
    assert.equal(
      /** @type {any[]} */ (pixoo[0].payload.availability).length,
      1,
    );
    assert.deepEqual(
      /** @type {any[]} */ (pixoo[1].payload.availability).map((v) => v.topic),
      [topics.health, topics.availability("P")],
    );
  }
});
test("per-device availability: an unplugged Ulanzi turns offline on its own availability topic after 2 min while the other display stays online; back online with the first good frame", async (t) => {
  const f = await publications(t);
  // Recorded measurements from W3's clock-based model; W4 publishes them.
  const u = f.states.get("U");
  u.health.state = "stale";
  f.state.emit("device", u);
  await f.publisher.pending;
  assert.equal(f.broker.retained()[f.topics.availability("U")], "online");
  await f.clock.advance(120000);
  u.health.state = "offline";
  f.state.emit("device", u);
  await f.publisher.pending;
  assert.equal(f.broker.retained()[f.topics.availability("U")], "offline");
  assert.equal(f.broker.retained()[f.topics.availability("P")], "online");
  assert.equal(
    JSON.parse(f.broker.retained()[f.topics.health]).status,
    "degraded",
  );
  u.health.state = "online";
  u.health.lastContactAt = new Date(f.clock.now()).toISOString();
  f.state.emit("device", u);
  await f.publisher.pending;
  assert.equal(f.broker.retained()[f.topics.availability("U")], "online");
});
test("per-device availability: nothing is published for a device in shadow or held back by the v1 interlock, except the one offline that retires a display this instance stopped driving", async (t) => {
  const f = await publications(t);
  assert.equal(f.broker.retained()[f.topics.availability("S")], undefined);
  assert.equal(f.publisher.buildAvailability("S"), null);
  const u = f.devices.find((d) => d.name === "U");
  assert.ok(u);
  u.output.mode = "shadow";
  f.runtime.emit("changed", {});
  await f.publisher.pending;
  assert.equal(f.broker.retained()[f.topics.availability("U")], "offline");
  const before = f.broker
    .published()
    .filter((m) => m.topic === f.topics.availability("U")).length;
  await f.clock.advance(30000);
  await f.publisher.pending;
  assert.equal(
    f.broker.published().filter((m) => m.topic === f.topics.availability("U"))
      .length,
    before,
  );
  assert.equal(f.publisher.buildAvailability("U"), null);
});
test("availability retirement on the wire: a device removed from config.json and a device changed from drive to shadow each get one retained offline while the controller health stays ok; an offline that could not be confirmed is sent again after the reconnect; an online whose acknowledgement was lost with the connection (the broker stored it) is still taken back when the display is no longer driven; a clean stop retires every driven display", async (t) => {
  const f = await publications(t);
  f.gateway.outcome = "offline"; // the broker stores it, but the acknowledgement is lost
  f.gateway.emit("connect", { connection: 2 });
  await f.publisher.pending;
  assert.equal(f.broker.retained()[f.topics.availability("P")], "online");
  assert.equal(owesOffline(f.publisher.ledger, "P"), true);
  f.devices.splice(
    f.devices.findIndex((d) => d.name === "U"),
    1,
  );
  const p = f.devices.find((d) => d.name === "P");
  assert.ok(p);
  p.output.mode = "shadow";
  f.runtime.emit("changed", {});
  await f.publisher.pending;
  assert.equal(owesOffline(f.publisher.ledger, "U"), true);
  assert.equal(owesOffline(f.publisher.ledger, "P"), true);
  f.gateway.outcome = "confirmed";
  f.gateway.emit("connect", { connection: 2 });
  await f.publisher.pending;
  for (const name of ["U", "P"]) {
    assert.equal(f.broker.retained()[f.topics.availability(name)], "offline");
    assert.equal(owesOffline(f.publisher.ledger, name), false);
  }
  assert.equal(JSON.parse(f.broker.retained()[f.topics.health]).status, "ok");
  const before = f.broker
    .published()
    .filter((m) => m.topic.endsWith("/availability")).length;
  f.gateway.emit("connect", { connection: 3 });
  await f.publisher.pending;
  assert.equal(
    f.broker.published().filter((m) => m.topic.endsWith("/availability"))
      .length,
    before,
  );
  p.output.mode = "drive";
  f.runtime.emit("changed", {});
  await f.publisher.pending;
  await f.publisher.stop();
  assert.equal(f.broker.retained()[f.topics.availability("P")], "offline");
  assert.equal(
    JSON.parse(f.broker.retained()[f.topics.health]).status,
    "offline",
  );
  assert.equal(JSON.parse(f.broker.retained()[f.topics.state]).running, false);
});
test("status publisher order: the 30 s republish and the publish on connect are built from the state of that moment; a state event of a device that was removed publishes nothing but its retirement", async (t) => {
  const f = await publications(t);
  f.devices.splice(
    f.devices.findIndex((d) => d.name === "U"),
    1,
  );
  f.states.get("P").effective.scene = "newest";
  // A stale event contains the old device. Only the stores at send time count.
  f.state.emit("device", f.states.get("U"));
  await f.publisher.pending;
  f.gateway.emit("connect", { connection: 2 });
  await f.publisher.pending;
  await f.clock.advance(30000);
  await f.publisher.pending;
  const state = JSON.parse(f.broker.retained()[f.topics.state]);
  assert.deepEqual(
    state.devices.map((/** @type {any} */ d) => d.name),
    ["P"],
  );
  assert.equal(state.devices[0].scene, "newest");
  assert.equal(f.broker.retained()[f.topics.availability("U")], "offline");
  assert.equal(
    f.broker
      .published()
      .filter(
        (m) =>
          m.topic === f.topics.availability("U") && m.payload === "offline",
      ).length,
    1,
  );
});
test("config/effective: the running config in v1's shape includes a blob-only device and a blob-patched key, and lists only driven, enabled devices", async (t) => {
  const f = await publications(t);
  const config = JSON.parse(f.broker.retained()[f.topics.configEffective]);
  assert.deepEqual(config.devices, [
    {
      name: "U",
      type: "ulanzi",
      ip: "127.0.0.1",
      scene: "clock",
      minFrameMs: 123,
    },
    {
      name: "P",
      type: "pixoo",
      ip: "127.0.0.1",
      scene: "radio",
    },
  ]);
  const summary = JSON.parse(f.broker.retained()[f.topics.config]);
  assert.equal(summary.deviceCount, 2);
  assert.equal(summary.sceneCount, 2);
  assert.equal(summary.configPath, "/recorded/config.json");
});
test("telemetry: Ulanzi publishes only good reads, Pixoo publishes reachable false; nothing for a shadow device", async (t) => {
  const f = await publications(t);
  const pixoo = await startFakePixoo(); t.after(() => pixoo.stop());
  const awtrix = await startFakeAwtrix(); t.after(() => awtrix.stop());
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  const p = createPixooDriver({ name: "P", address: pixoo.address, clock: systemClock(), logger });
  const u = createAwtrixDriver({ name: "U", address: awtrix.address, clock: systemClock(), logger });
  t.after(() => Promise.all([p.close(), u.close()]));
  const health = new HealthModel({ clock: f.clock, logger, config: () => ({ staleAfterMs: 30000, offlineAfterMs: 120000, probeIntervalMs: 10000 }) });
  for (const name of ["P", "U"]) health.register(name, { shadow: false, powerCycleMax: 0, plugTopic: null });
  const collector = new TelemetryCollector(/** @type {any} */ ({ mqtt: f.gateway, topics: f.topics, health, clock: f.clock, logger, intervalMs: () => 1000, haDiscovery: false }));
  t.after(() => collector.stopAll());
  const pFirst = telemetryAnswer(f.reader, f.topics.telemetry("P"));
  const uFirst = telemetryAnswer(f.reader, f.topics.telemetry("U"));
  collector.start({ name: "P", type: "pixoo", address: pixoo.address }, p);
  collector.start({ name: "U", type: "ulanzi", address: awtrix.address }, u);
  collector.start({ name: "S", type: "pixoo", address: pixoo.address }, /** @type {any} */ ({ info: { drives: false }, readTelemetry() { assert.fail("shadow polled"); } }));
  const [pGood, uGood] = await Promise.all([pFirst, uFirst]);
  assert.equal(pGood.reachable, true);
  assert.equal(pGood.brightness, 50);
  assert.equal(uGood.bat, 100);
  assert.equal(f.broker.retained()[f.topics.telemetry("S")], undefined);
  // Drain publishes before the next manually clocked poll.
  await new Promise((resolve) => setImmediate(resolve));
  await pixoo.setOffline(true); await awtrix.setOffline(true);
  const failedU = Promise.withResolvers();
  const read = u.readTelemetry;
  u.readTelemetry = async (options) => { try { return await read(options); } finally { failedU.resolve(undefined); } };
  const pFailed = telemetryAnswer(f.reader, f.topics.telemetry("P"));
  await f.clock.advance(1000);
  const snapshot = await pFailed; await failedU.promise;
  assert.equal(snapshot.reachable, false);
  assert.equal(snapshot.brightness, null);
  assert.deepEqual(JSON.parse(f.broker.retained()[f.topics.telemetry("U")]), uGood);
});

/** @param {import('mqtt').MqttClient} client @param {string} topic @returns {Promise<any>} */
function telemetryAnswer(client, topic) {
  return new Promise((resolve) => {
    const listener = (/** @type {string} */ name, /** @type {Buffer} */ payload) => {
      if (name !== topic) return;
      client.off("message", listener);
      resolve(JSON.parse(payload.toString()));
    };
    client.on("message", listener);
  });
}
// Blocker: W1 MqttGateway, OverlayService, RuntimeConfig and StateStore retained bootstrap.
test.todo(
  "retained bootstrap: devices start with mode and brightness already applied, without a fixed sleep",
);

/** Real loopback MQTT transport; recorded W1/W3 views and injected publish outcomes.
 * @param {import("node:test").TestContext} t
 * @param {{shadow?: boolean, statusBase?: string}} [options]
 */
async function publications(t, options = {}) {
  const broker = await startMemoryBroker();
  const topics = createTopics(
    options.statusBase ? { statusBaseTopic: options.statusBase } : {},
  );
  const clock = manualClock();
  const logger = createLogger({ level: "error", sink: { out() {}, err() {} } });
  const writer = await connectAsync(broker.url, {
    clientId: "status-writer",
    reconnectPeriod: 0,
    will: StatusPublisher.lastWill(topics),
  });
  const reader = await connectAsync(broker.url, {
    clientId: "status-reader",
    reconnectPeriod: 0,
  });
  await reader.subscribeAsync("#");
  const gateway = Object.assign(new EventEmitter(), {
    calls:
      /** @type {Array<{topic: string, payload: any, options: any}>} */ ([]),
    connected: true,
    outcome: "confirmed",
    hold: /** @type {Promise<void>|null} */ (null),
    status: () => ({ state: "connected" }),
    async publish(
      /** @type {string} */ topic,
      /** @type {any} */ payload,
      /** @type {any} */ options,
    ) {
      gateway.calls.push({ topic, payload, options });
      if (!gateway.connected)
        return { ok: false, outcome: "offline", connection: 1, error: null };
      const outcome = gateway.outcome;
      const wire =
        typeof payload === "string" ? payload : JSON.stringify(payload);
      // QoS 0 confirms handoff, not broker delivery. Observe the outside
      // reader before assertions about retained wire state (no fixed sleep).
      const observed = new Promise((resolve) => {
        const listener = (
          /** @type {string} */ gotTopic,
          /** @type {Buffer} */ gotPayload,
        ) => {
          if (gotTopic !== topic || gotPayload.toString() !== wire) return;
          reader.off("message", listener);
          resolve(undefined);
        };
        reader.on("message", listener);
      });
      await writer.publishAsync(topic, wire, options);
      await observed;
      if (gateway.hold && topic.endsWith("/availability")) await gateway.hold;
      return {
        ok: outcome === "confirmed",
        outcome,
        connection: 1,
        error: null,
      };
    },
  });
  const devices = [
    { name: "U", enabled: true, output: { mode: "drive" } },
    { name: "P", enabled: true, output: { mode: "drive" } },
    { name: "S", enabled: true, output: { mode: "shadow" } },
    { name: "disabled", enabled: false, output: { mode: "drive" } },
  ];
  /** @type {Map<string, any>} */ const states = new Map(
    devices.map((device) => [
      device.name,
      {
        name: device.name,
        effective: {
          scene: device.name === "U" ? "clock" : "radio",
          frameCount: 101,
        },
        desired: { mode: { value: "play" }, scene: { source: "config" } },
        health: {
          state: device.output.mode === "shadow" ? "shadow" : "online",
          lastContactAt: new Date(clock.now() - 1000).toISOString(),
          consecutiveErrors: 0,
          lastError: null,
        },
      },
    ]),
  );
  if (options.shadow)
    for (const device of devices) device.output.mode = "shadow";
  const runtime = Object.assign(new EventEmitter(), {
    get: () => ({ devices }),
  });
  const state = Object.assign(new EventEmitter(), {
    get: (/** @type {any} */ name) => states.get(name),
    runningConfigV1: () => ({
      devices: [
        {
          name: "U",
          type: "ulanzi",
          ip: "127.0.0.1",
          scene: "clock",
          minFrameMs: 123,
        },
        {
          name: "P",
          type: "pixoo",
          ip: "127.0.0.1",
          scene: "radio",
        },
        { name: "S", type: "pixoo", ip: "127.0.0.1" },
        { name: "disabled", type: "pixoo", ip: "127.0.0.1" },
      ],
      scenes: { clock: { path: "clock.js" }, radio: { path: "radio.js" } },
    }),
  });
  const publisher = new StatusPublisher(
    /** @type {any} */ ({
      mqtt: gateway,
      topics,
      state,
      runtime,
      config: { options: { path: "/recorded/config.json" } },
      clock,
      logger,
    }),
  );
  t.after(async () => {
    await publisher.stop();
    await Promise.all([writer.endAsync(true), reader.endAsync(true)]);
    await broker.stop();
  });
  publisher.start();
  await publisher.pending;
  return {
    broker,
    writer,
    reader,
    topics,
    clock,
    gateway,
    state,
    runtime,
    devices,
    states,
    publisher,
  };
}

test("status publisher: an in-flight online is owed before its acknowledgement; queued changes use current output and count intervening errors", async (t) => {
  const f = await publications(t);
  /** @type {() => void} */ let release = () => {};
  f.gateway.hold = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  f.gateway.outcome = "offline";
  const observed = new Promise((resolve) =>
    f.reader.on("message", (topic, payload) => {
      if (
        topic === f.topics.availability("P") &&
        payload.toString() === "online"
      )
        resolve(undefined);
    }),
  );
  f.gateway.emit("connect", { connection: 2 });
  await observed;
  assert.equal(owesOffline(f.publisher.ledger, "P"), true);
  const u = f.states.get("U");
  for (let errors = 1; errors <= 3; errors++) {
    u.health.consecutiveErrors = errors;
    u.health.lastError = {
      message: "failed",
      at: new Date(f.clock.now()).toISOString(),
    };
    f.state.emit("device", u);
  }
  u.health.consecutiveErrors = 0;
  f.state.emit("device", u);
  const p = f.devices.find((d) => d.name === "P");
  assert.ok(p);
  p.output.mode = "shadow";
  f.runtime.emit("changed", {});
  f.gateway.hold = null;
  release();
  await f.publisher.pending;
  assert.equal(f.broker.retained()[f.topics.availability("P")], "offline");
  assert.equal(
    owesOffline(f.publisher.ledger, "P"),
    true,
    "unconfirmed offline still owed",
  );
  assert.equal(JSON.parse(f.broker.retained()[f.topics.health]).errorCount, 3);
  f.gateway.outcome = "confirmed";
  f.gateway.emit("connect", { connection: 2 });
  await f.publisher.pending;
  assert.equal(owesOffline(f.publisher.ledger, "P"), false);
});

test("status publisher: shadow-only output never claims v1 controller topics; a separate status base remains observable", async (t) => {
  const shadow = await publications(t, { shadow: true });
  assert.deepEqual(shadow.broker.retained(), {});
  shadow.gateway.emit("connect", { connection: 2 });
  await shadow.publisher.pending;
  await shadow.clock.advance(30000);
  await shadow.publisher.pending;
  await shadow.publisher.stop();
  assert.deepEqual(shadow.broker.retained(), {});
  const isolated = await publications(t, {
    shadow: true,
    statusBase: "home/hsb1/pixdcon2-edge",
  });
  assert.deepEqual(
    JSON.parse(isolated.broker.retained()[isolated.topics.state]).devices,
    [],
  );
  assert.equal(
    isolated.broker.retained()["home/hsb1/pixdcon/health"],
    undefined,
  );
  assert.equal(
    isolated.broker.retained()[isolated.topics.availability("S")],
    undefined,
  );
});

test("status publisher: 100 frame-only changes publish nothing; scene changes publish state once; connect and 30 s republish once per topic", async (t) => {
  const f = await publications(t);
  const sent = () => f.gateway.calls.map((call) => call.topic);
  f.gateway.calls.length = 0;
  const view = f.states.get("P");
  for (let frame = 0; frame < 100; frame++) {
    view.effective.frameCount++;
    view.health.lastFrameAt = new Date(f.clock.now() + frame).toISOString();
    view.health.lastContactAt = view.health.lastFrameAt;
    view.health.since = view.health.lastFrameAt;
    f.state.emit("device", view);
    await f.publisher.pending;
  }
  assert.deepEqual(
    sent(),
    [],
    "frame and freshness counters do not flood retained topics",
  );
  view.effective.scene = "changed";
  f.state.emit("device", view);
  await f.publisher.pending;
  assert.deepEqual(sent(), [f.topics.state]);
  f.gateway.calls.length = 0;
  await f.clock.advance(29999);
  assert.deepEqual(sent(), []);
  await f.clock.advance(1);
  await f.publisher.pending;
  const batch = [
    f.topics.health,
    f.topics.state,
    f.topics.config,
    f.topics.configEffective,
    f.topics.availability("U"),
    f.topics.availability("P"),
  ];
  assert.deepEqual(sent(), batch, "one refresh per topic at 30 s");
  f.gateway.calls.length = 0;
  f.gateway.emit("connect", { connection: 2 });
  await f.publisher.pending;
  assert.deepEqual(
    sent(),
    batch,
    "reconnect republishes unchanged retained values",
  );
  f.gateway.calls.length = 0;
  view.health.state = "offline";
  f.state.emit("device", view);
  await f.publisher.pending;
  assert.deepEqual(sent(), [f.topics.health, f.topics.availability("P")]);
  f.gateway.calls.length = 0;
  f.state.emit("device", view);
  await f.publisher.pending;
  assert.deepEqual(sent(), []);
});

test("status publisher: recovery after uncertain sends republishes earlier values", async (t) => {
  const f = await publications(t);
  const p = f.states.get("P");
  f.gateway.outcome = "timeout"; // Broker stores the attempt; its acknowledgement is lost.
  p.effective.scene = "uncertain-scene";
  p.health.state = "offline";
  f.state.emit("device", p);
  await f.publisher.pending;
  assert.equal(f.broker.retained()[f.topics.availability("P")], "offline");
  f.gateway.outcome = "confirmed";
  f.gateway.calls.length = 0;
  p.effective.scene = "radio";
  p.health.state = "online";
  f.state.emit("device", p);
  await f.publisher.pending;
  assert.deepEqual(
    f.gateway.calls.map((call) => call.topic),
    [f.topics.health, f.topics.state, f.topics.availability("P")],
  );
  assert.equal(f.broker.retained()[f.topics.availability("P")], "online");
  assert.equal(
    JSON.parse(f.broker.retained()[f.topics.state]).devices[1].scene,
    "radio",
  );
});

test("status publisher: uncertain refreshes do not turn frame events into publish retries", async (t) => {
  const f = await publications(t);
  f.gateway.outcome = "timeout";
  f.gateway.emit("connect", { connection: 2 });
  await f.publisher.pending;
  f.gateway.calls.length = 0;
  for (let frame = 0; frame < 100; frame++) {
    f.states.get("P").effective.frameCount++;
    f.state.emit("device", f.states.get("P"));
    await f.publisher.pending;
  }
  assert.deepEqual(f.gateway.calls, []);
  f.gateway.outcome = "confirmed";
  await f.clock.advance(30000);
  await f.publisher.pending;
  assert.equal(
    f.gateway.calls.length,
    6,
    "the next periodic refresh retries each topic once",
  );
});

test("status publisher: effective config fields named since or timestamp are real config changes", async (t) => {
  const f = await publications(t);
  const config = f.state.runningConfigV1();
  Object.assign(config, { custom: { since: 1, timestamp: "first" } });
  f.state.runningConfigV1 = () => config;
  f.runtime.emit("changed");
  await f.publisher.pending;
  f.gateway.calls.length = 0;
  Object.assign(config, { custom: { since: 2, timestamp: "second" } });
  f.runtime.emit("changed");
  await f.publisher.pending;
  assert.deepEqual(
    f.gateway.calls.map((call) => call.topic),
    [f.topics.configEffective],
  );
});

test("held display: availability is retired like a disabled display and published again when the address hold ends", async (t) => {
  const f = await publications(t);
  const device = f.devices.find((device) => device.name === "P");
  assert.ok(device);
  Object.assign(device, { enabled: false, held: true });
  f.runtime.emit("changed", {});
  await f.publisher.pending;
  assert.equal(f.broker.retained()[f.topics.availability("P")], "offline");
  assert.equal(owesOffline(f.publisher.ledger, "P"), false);
  assert.equal(f.broker.retained()[f.topics.availability("U")], "online");
  Object.assign(device, { enabled: true, held: false });
  f.runtime.emit("changed", {});
  await f.publisher.pending;
  assert.equal(f.broker.retained()[f.topics.availability("P")], "online");
});
