/**
 * Test kind 2 of 3 (API and MQTT contract): the wire strings and the broker premise.
 *
 * Pins what must never move by accident: the v1 topic strings, the built-in
 * mode keys, and the two facts about brokers that the overlay rules rest on:
 * a retained replay carries the retain flag, and it may arrive late. The
 * gateway's own guarantees are named at the end. Owner: core/state worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import mqtt from "mqtt";
import { startMemoryBroker } from "../../dev/memory-broker.js";
import { BUILTIN_MODES } from "../../src/drivers/builtin-modes.js";
import { manualClock, systemClock } from "../../src/core/clock.js";
import { createLogger } from "../../src/core/logger.js";
import { MqttGateway } from "../../src/mqtt/mqtt-gateway.js";
import { StatusPublisher } from "../../src/mqtt/status-publisher.js";
import { createTopics } from "../../src/mqtt/topics.js";
import { requireNetGuard } from "../helpers/harness.js";

test("MQTT topics: the v1 wire strings are unchanged", () => {
  requireNetGuard();
  const topics = createTopics();
  // The Home Assistant automation flirc_tv_radio_pixoo189_scene_toggle publishes here, retained.
  assert.equal(
    topics.overlayDeviceScene("pixoo-189"),
    "home/hsb1/pixdcon/overlay/device/pixoo-189/scene",
  );
  assert.equal(
    topics.overlayDeviceIp("ulanzi-56"),
    "home/hsb1/pixdcon/overlay/device/ulanzi-56/ip",
  );
  assert.equal(
    topics.overlayDeviceEnabled("ulanzi-56"),
    "home/hsb1/pixdcon/overlay/device/ulanzi-56/enabled",
  );
  assert.equal(
    topics.overlayScenePath("home3"),
    "home/hsb1/pixdcon/overlay/scene/home3/path",
  );
  assert.equal(topics.overlayBlob, "home/hsb1/pixdcon/overlay/blob");
  assert.deepEqual(topics.overlayFilters, [
    "home/hsb1/pixdcon/overlay/device/+/scene",
    "home/hsb1/pixdcon/overlay/device/+/ip",
    "home/hsb1/pixdcon/overlay/device/+/enabled",
    "home/hsb1/pixdcon/overlay/scene/+/path",
    "home/hsb1/pixdcon/overlay/blob",
  ]);
  assert.equal(topics.mode("pixoo-159"), "home/hsb1/pixdcon/pixoo-159/mode");
  assert.equal(
    topics.brightnessOverride("pixoo-159"),
    "home/hsb1/pixdcon/pixoo-159/brightness_override",
  );
  assert.equal(
    topics.setting("ulanzi-56", "clock_with_homestats", "night_start_hour"),
    "pixdcon/ulanzi-56/clock_with_homestats/settings/night_start_hour",
  );
  assert.equal(
    topics.settingsRoot("ulanzi-56", "clock"),
    "pixdcon/ulanzi-56/clock/settings",
  );
  assert.equal(topics.settingsFilter, "pixdcon/+/+/settings/+");
  assert.equal(topics.health, "home/hsb1/pixdcon/health");
  assert.equal(topics.state, "home/hsb1/pixdcon/state");
  assert.equal(topics.config, "home/hsb1/pixdcon/config");
  assert.equal(topics.configEffective, "home/hsb1/pixdcon/config/effective");
  assert.equal(
    topics.telemetry("ulanzi-56"),
    "home/hsb1/pixdcon/ulanzi-56/telemetry",
  );
  assert.equal(
    topics.discoverySensor("ulanzi-56", "bat"),
    "homeassistant/sensor/pixdcon_ulanzi-56_bat/config",
  );
  assert.equal(
    topics.discoveryBinarySensor("pixoo-159", "reachable"),
    "homeassistant/binary_sensor/pixdcon_pixoo-159_reachable/config",
  );
  // New in v2, next to the telemetry of the device (C-121, C-137, C-138).
  assert.equal(
    topics.availability("ulanzi-56"),
    "home/hsb1/pixdcon/ulanzi-56/availability",
  );
  assert.equal(topics.parse(topics.availability("ulanzi-56")), null);
  // No transition by default: v2 is the one controller on these topics.
  assert.equal(topics.transition, false);
  assert.equal(topics.v1ConfigEffective, topics.configEffective);
});

test("MQTT topics: incoming topics are told apart, and a second status base moves only the controller topics", () => {
  const topics = createTopics({ statusBaseTopic: "home/hsb1/pixdcon2" });
  assert.equal(topics.health, "home/hsb1/pixdcon2/health");
  assert.equal(topics.state, "home/hsb1/pixdcon2/state");
  assert.equal(topics.configEffective, "home/hsb1/pixdcon2/config/effective");
  // The transition: v1 still publishes its device list under the base, and v2 reads it there.
  assert.equal(topics.transition, true);
  assert.equal(topics.v1ConfigEffective, "home/hsb1/pixdcon/config/effective");
  assert.equal(topics.overlayBlob, "home/hsb1/pixdcon/overlay/blob");
  assert.equal(
    topics.telemetry("ulanzi-56"),
    "home/hsb1/pixdcon/ulanzi-56/telemetry",
  );

  assert.deepEqual(
    topics.parse("home/hsb1/pixdcon/overlay/device/pixoo-189/scene"),
    {
      kind: "device-scene",
      device: "pixoo-189",
      scene: null,
      key: null,
    },
  );
  assert.equal(
    topics.parse("home/hsb1/pixdcon/overlay/device/pixoo-189/ip")?.kind,
    "device-ip",
  );
  assert.equal(
    topics.parse("home/hsb1/pixdcon/overlay/device/pixoo-189/enabled")?.kind,
    "device-enabled",
  );
  assert.deepEqual(topics.parse("home/hsb1/pixdcon/overlay/scene/home3/path"), {
    kind: "scene-path",
    device: null,
    scene: "home3",
    key: null,
  });
  assert.equal(topics.parse("home/hsb1/pixdcon/overlay/blob")?.kind, "blob");
  assert.deepEqual(
    topics.parse(
      "pixdcon/ulanzi-56/clock_with_homestats/settings/night_start_hour",
    ),
    {
      kind: "setting",
      device: "ulanzi-56",
      scene: "clock_with_homestats",
      key: "night_start_hour",
    },
  );
  assert.equal(topics.parse("home/hsb1/pixdcon/pixoo-159/mode")?.kind, "mode");
  assert.equal(
    topics.parse("home/hsb1/pixdcon/pixoo-159/brightness_override")?.kind,
    "brightness",
  );
  // v1 documented ".../scenes" (plural) for years; it was never subscribed (matrix A-BUG-34).
  assert.equal(
    topics.parse("home/hsb1/pixdcon/overlay/device/pixoo-189/scenes"),
    null,
  );
  assert.equal(topics.parse("home/hsb1/pixdcon/health"), null);
  assert.equal(topics.parse("home/hsb1/funkeykid/display"), null);
});

test("built-in modes: keys, labels and order are v1's", () => {
  assert.deepEqual(
    BUILTIN_MODES.pixoo.map((mode) => mode.key),
    [
      "builtin:clock",
      "builtin:cloud",
      "builtin:visualizer",
      "builtin:animation",
      "builtin:black",
    ],
  );
  assert.deepEqual(
    BUILTIN_MODES.ulanzi.map((mode) => [mode.key, mode.app]),
    [
      ["builtin:time", "Time"],
      ["builtin:date", "Date"],
      ["builtin:temp", "Temperature"],
      ["builtin:humidity", "Humidity"],
      ["builtin:battery", "Battery"],
    ],
  );
});

test("broker premise: a retained replay carries the retain flag, a live message does not, an empty payload deletes", async (t) => {
  // The overlay rules (a UI choice beats a stored overlay; a newer live overlay
  // wins again) depend on telling these two deliveries apart. This is how the
  // in-memory broker and Mosquitto behave; if it ever stops holding, the rules
  // need another signal.
  const broker = await startMemoryBroker();
  t.after(() => broker.stop());
  const topic = "home/hsb1/pixdcon/overlay/device/pixoo-t/scene";

  const publisher = await mqtt.connectAsync(broker.url);
  t.after(() => publisher.endAsync(true));
  await publisher.publishAsync(topic, "builtin:clock", {
    retain: true,
    qos: 1,
  });
  assert.deepEqual(broker.retained(), { [topic]: "builtin:clock" });

  const subscriber = await mqtt.connectAsync(broker.url);
  t.after(() => subscriber.endAsync(true));
  /** @type {Array<{payload: string, retain: boolean}>} */
  const seen = [];
  /** @type {Array<() => void>} */
  let waiting = [];
  subscriber.on("message", (_topic, payload, packet) => {
    seen.push({ payload: payload.toString(), retain: packet.retain });
    for (const wake of waiting) wake();
    waiting = [];
  });
  /** @param {number} count */
  const received = async (count) => {
    while (seen.length < count)
      await new Promise((wake) => waiting.push(() => wake(undefined)));
  };

  await subscriber.subscribeAsync(topic, { qos: 1 });
  await received(1);
  assert.deepEqual(
    seen[0],
    { payload: "builtin:clock", retain: true },
    "stored overlay: replayed with the retain flag",
  );

  await publisher.publishAsync(topic, "funkeykid", { retain: true, qos: 1 });
  await received(2);
  assert.deepEqual(
    seen[1],
    { payload: "funkeykid", retain: false },
    "new command: delivered live, flag clear",
  );

  await publisher.publishAsync(topic, "", { retain: true, qos: 1 });
  await received(3);
  assert.deepEqual(seen[2], { payload: "", retain: false });
  assert.deepEqual(
    broker.retained(),
    {},
    "an empty retained payload deletes the stored overlay",
  );
});

test("broker premise 2: a replay can arrive after the SUBACK, after a sync echo and after the store changed; only its retain flag tells", async (t) => {
  // aedes answers a SUBSCRIBE with the SUBACK first and streams the retained
  // messages afterwards. holdRetained() makes that gap as long as the test
  // wants. This is the order the overlay rules must survive: nothing may be
  // concluded from "the subscribe is acknowledged and my marker came back".
  const broker = await startMemoryBroker();
  t.after(() => broker.stop());
  const topic = "home/hsb1/pixdcon/overlay/device/pixoo-t/scene";
  const sync = "home/hsb1/pixdcon/_sync/n1";

  const outside = await mqtt.connectAsync(broker.url);
  t.after(() => outside.endAsync(true));
  await outside.publishAsync(topic, "builtin:clock", { retain: true, qos: 1 });

  const subscriber = await mqtt.connectAsync(broker.url);
  t.after(() => subscriber.endAsync(true));
  /** @type {Array<{topic: string, payload: string, retain: boolean}>} */
  const seen = [];
  /** @type {Array<() => void>} */
  let waiting = [];
  subscriber.on("message", (messageTopic, payload, packet) => {
    seen.push({
      topic: messageTopic,
      payload: payload.toString(),
      retain: packet.retain,
    });
    for (const wake of waiting) wake();
    waiting = [];
  });
  /** @param {number} count */
  const received = async (count) => {
    while (seen.length < count)
      await new Promise((wake) => waiting.push(() => wake(undefined)));
  };

  const release = broker.holdRetained();
  await subscriber.subscribeAsync([topic, sync], { qos: 1 }); // SUBACK received
  await subscriber.publishAsync(sync, "n1", { qos: 1 });
  await received(1);
  assert.deepEqual(
    seen,
    [{ topic: sync, payload: "n1", retain: false }],
    "the marker is back and the stored overlay has not been delivered yet",
  );

  // Meanwhile the overlay is cleared on the broker (what a UI choice does).
  await outside.publishAsync(topic, "", { retain: true, qos: 1 });
  await received(2);
  assert.deepEqual(seen[1], { topic, payload: "", retain: false });
  assert.deepEqual(broker.retained(), {}, "the store holds nothing any more");

  release();
  await received(3);
  assert.deepEqual(
    seen[2],
    { topic, payload: "builtin:clock", retain: true },
    "the old value arrives last, as a replay: flag set, although the store is empty",
  );
});

// --- Phase 3: what the gateway guarantees (mqtt-gateway.js) ------------------------------------
test("gateway: every message carries the retain flag as delivered and the number of its connection; nothing is derived from arrival order", async (t) => {
  const { gateway, broker } = await gatewayStack(t);
  await broker.inject("test/value", "stored", { retain: true });
  /** @type {import("../../src/mqtt/mqtt-gateway.js").MqttMessage[]} */
  const seen = [];
  gateway.subscribe("test", "test/+", (message) => seen.push(message));
  await until(() => seen.length === 1);
  await broker.inject("test/value", "live", { retain: true });
  await until(() => seen.length === 2);
  assert.deepEqual(
    seen.map(({ payload, retain, connection }) => ({
      payload,
      retain,
      connection,
    })),
    [
      { payload: "stored", retain: true, connection: 1 },
      { payload: "live", retain: false, connection: 1 },
    ],
  );
});
test("gateway settle: a pacing hint only; a replay held back past it (holdRetained) is still delivered to the owner, flag set", async (t) => {
  const { gateway, broker } = await gatewayStack(t);
  await broker.inject("test/value", "stored", { retain: true });
  const release = broker.holdRetained();
  /** @type {import("../../src/mqtt/mqtt-gateway.js").MqttMessage[]} */
  const seen = [];
  gateway.subscribe("test", "test/value", (message) => seen.push(message));
  const hint = await gateway.settle();
  assert.deepEqual(hint, { connection: 1, complete: true });
  assert.equal(seen.length, 0);
  release();
  await until(() => seen.length === 1);
  assert.equal(seen[0].retain, true);
});
test("gateway publish: a QoS 1 publish cut off by a disconnect answers offline and is not sent again on the next connection", async (t) => {
  const clock = manualClock();
  const { gateway, broker } = await gatewayStack(t, { clock });
  const original = gateway.client;
  assert.ok(original);
  original.on("packetsend", (packet) => {
    if (packet.cmd === "publish" && packet.topic === "test/cut")
      original.stream.destroy();
  });
  const pending = gateway.publish("test/cut", "old", { retain: true });
  assert.equal((await pending).outcome, "offline");
  await until(() => gateway.status().state === "offline");
  await clock.advance(5000);
  await until(() => gateway.status().connection === 2);
  assert.notEqual(gateway.client, original);
  assert.deepEqual(
    broker.published().filter((entry) => entry.topic === "test/cut"),
    [],
  );
  assert.equal((await gateway.publish("test/new", "new")).outcome, "confirmed");
});
test("gateway owners: a second owner of a filter gets the retained replay (C-036); removing one owner leaves the other's handlers and the wire subscription", async (t) => {
  const { gateway, broker } = await gatewayStack(t);
  await broker.inject("test/value", "stored", { retain: true });
  /** @type {string[]} */
  const first = [];
  /** @type {string[]} */
  const second = [];
  gateway.subscribe("first", "test/+", (message) =>
    first.push(message.payload),
  );
  await until(() => first.length === 1);
  gateway.subscribe("second", "test/+", (message) =>
    second.push(message.payload),
  );
  await until(() => second.length === 1);
  gateway.unsubscribeAll("second");
  gateway.subscribe("throws", "test/+", () => {
    throw new Error("handler failure");
  });
  gateway.subscribe("rejects", "test/+", () =>
    Promise.reject(new Error("handler rejection")),
  );
  await gateway.settle();
  first.length = 0;
  await broker.inject("test/value", "new");
  await until(() => first.includes("new"));
  assert.deepEqual(second, ["stored"]);
  assert.equal(first.at(-1), "new");
});
test("gateway instance tokens: the scene contexts of a running instance and of its replacement are two owners; releasing the replacement leaves the running one subscribed", async (t) => {
  const { gateway, broker } = await gatewayStack(t);
  const running = gateway.sceneContext({
    scene: "A",
    device: "D",
    token: "old",
  });
  const replacement = gateway.sceneContext({
    scene: "A",
    device: "D",
    token: "new",
  });
  /** @type {string[]} */
  const old = [];
  /** @type {string[]} */
  const fresh = [];
  running.subscribe("test/value", (payload) => old.push(payload));
  replacement.subscribe("test/value", (payload) => fresh.push(payload));
  await gateway.settle();
  replacement.unsubscribeAll();
  replacement.subscribe("test/value", () =>
    assert.fail("released context subscribed"),
  );
  running.subscribe("test/+", () =>
    assert.fail("exact subscription accepted a filter"),
  );
  await broker.inject("test/value", "current");
  await until(() => old.length === 1);
  assert.deepEqual(old, ["current"]);
  assert.deepEqual(fresh, []);
});
test("gateway last will: the will of the CONNECT packet is the health topic of the status base the process started with", async (t) => {
  const topics = createTopics({ statusBaseTopic: "shadow/status" });
  const { gateway, broker } = await gatewayStack(t, {
    will: StatusPublisher.lastWill(topics),
  });
  const observer = await mqtt.connectAsync(broker.url);
  t.after(() => observer.endAsync(true));
  /** @type {Array<{topic: string, value: any}>} */
  const seen = [];
  observer.on("message", (topic, payload) =>
    seen.push({ topic, value: JSON.parse(payload.toString()) }),
  );
  await observer.subscribeAsync(topics.health);
  gateway.client?.stream.destroy();
  await until(() => seen.length === 1);
  assert.equal(seen[0].topic, "shadow/status/health");
  assert.equal(seen[0].value.status, "offline");
});

// --- Ordering (knowledge entry, section 3.0) ---
test("gateway order: connect is emitted before the first message of a connection and disconnect after its last; a handler is called synchronously, in the order the packets arrived; connection numbers only rise", async (t) => {
  const clock = manualClock();
  const { gateway, broker } = await gatewayStack(t, { clock });
  /** @type {string[]} */
  const log = [];
  gateway.on("connect", ({ connection }) => log.push(`connect:${connection}`));
  gateway.on("disconnect", ({ connection }) =>
    log.push(`disconnect:${connection}`),
  );
  gateway.subscribe("test", "test/value", (message) =>
    log.push(`${message.connection}:${message.payload}`),
  );
  await gateway.settle();
  const original = gateway.client;
  await broker.inject("test/value", "one", { retain: true });
  await until(() => log.length === 1);
  await broker.dropClients();
  await until(() => log.length === 2);
  await clock.advance(5000);
  await until(() => log.length === 4);
  assert.deepEqual(log, ["1:one", "disconnect:1", "connect:2", "2:one"]);
  original?.emit("message", "test/value", Buffer.from("late"), {
    cmd: "publish",
    qos: 0,
    dup: false,
    topic: "test/value",
    payload: Buffer.from("late"),
    retain: false,
  });
  assert.equal(
    log.length,
    4,
    "old transport cannot deliver on a new connection",
  );
});
test("gateway publish outcome: no acknowledgement in time on a connection that stays up answers timeout; error only when the message was certainly not sent; the own echo arrives on the connection it was published on", async (t) => {
  const clock = manualClock();
  const { gateway } = await gatewayStack(t, { clock });
  /** @type {import("../../src/mqtt/mqtt-gateway.js").MqttMessage[]} */
  const seen = [];
  gateway.subscribe("test", "test/echo", (message) => seen.push(message));
  await gateway.settle();
  assert.equal(
    (await gateway.publish("test/echo", "value")).outcome,
    "confirmed",
  );
  await until(() => seen.length === 1);
  assert.equal(seen[0].connection, 1);
  assert.equal(seen[0].retain, false);
  assert.equal((await gateway.publish("bad/#", "value")).outcome, "error");
  const client = gateway.client;
  assert.ok(client);
  t.mock.method(client, "publish", () => client);
  const unanswered = gateway.publish("test/no-ack", "value", { timeoutMs: 20 });
  await clock.advance(20);
  assert.equal((await unanswered).outcome, "timeout");
  t.mock.method(client, "publish", () => {
    throw new Error("transport failed after entry");
  });
  assert.equal(
    (await gateway.publish("test/uncertain", "value")).outcome,
    "timeout",
  );
});
test("gateway timers: the reconnect, the connect timeout and the settle timeout change the status and the hint only; no subscriber is called because one of them fired", async (t) => {
  const clock = manualClock();
  const { gateway, broker } = await gatewayStack(t, { clock });
  /** @type {import("../../src/mqtt/mqtt-gateway.js").MqttMessage[]} */
  const seen = [];
  gateway.subscribe("test", "test/absent", (message) => seen.push(message));
  await gateway.settle();
  await broker.dropClients();
  await until(() => gateway.status().state === "offline");
  assert.deepEqual(await gateway.settle(), { connection: 1, complete: false });
  await clock.advance(5000);
  await until(() => gateway.status().connection === 2);
  await gateway.settle();
  assert.deepEqual(seen, []);
});

/** @param {import("node:test").TestContext} t @param {{clock?: import("../../src/types.js").Clock, will?: import("../../src/mqtt/mqtt-gateway.js").LastWill}} [options] */
async function gatewayStack(t, options = {}) {
  requireNetGuard();
  const broker = await startMemoryBroker();
  const gateway = MqttGateway.fromEnv(
    {
      MOSQUITTO_HOST: broker.host,
      MQTT_PORT: String(broker.port),
      PIXDCON2_MQTT_ANONYMOUS: "1",
    },
    {
      instance: "contract",
      syncTopic: (nonce) => `test/_sync/${nonce}`,
      clock: options.clock ?? systemClock(),
      logger: createLogger({ sink: { out() {}, err() {} } }),
      will: options.will,
    },
  );
  assert.ok(gateway);
  t.after(async () => {
    await gateway.stop();
    await broker.stop();
  });
  assert.equal(await gateway.start(), true);
  return { gateway, broker };
}

/** @param {() => boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "gateway condition timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
