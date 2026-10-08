import assert from "node:assert/strict";
import { once } from "node:events";
import { Duplex, Readable } from "node:stream";
import net from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import mqttPacket from "mqtt-packet";
import { MqttService } from "../lib/mqtt-service.js";
import { ConfigOverlay } from "../lib/config-overlay.js";
import { SceneSettingsService } from "../lib/scene-settings-service.js";
import { TelemetryCollector } from "../lib/telemetry-collector.js";
import { WebServer } from "../lib/web-server.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(check) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("MQTT lifecycle did not progress");
    await delay(5);
  }
}

// Run the real mqtt.js client against a reconnectable in-memory broker.
function broker(t, { online = true, retained = {}, rejectSubscription = false } = {}) {
  const state = { online, retained, rejectSubscription, streams: [], packets: [] };
  t.mock.method(net, "createConnection", () => {
    const parser = mqttPacket.parser();
    const stream = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        parser.parse(chunk);
        callback();
      },
    });
    const send = (packet) => stream.push(mqttPacket.generate(packet));
    parser.on("packet", (packet) => {
      state.packets.push(packet);
      if (packet.cmd === "connect") {
        if (state.online) send({ cmd: "connack", returnCode: 0, sessionPresent: false });
        else queueMicrotask(() => {
          const error = new Error("broker unavailable");
          error.code = "ECONNREFUSED";
          stream.destroy(error);
        });
      } else if (packet.cmd === "subscribe") {
        send({ cmd: "suback", messageId: packet.messageId,
          granted: packet.subscriptions.map(() => state.rejectSubscription ? 128 : 1) });
        if (!state.rejectSubscription) {
          for (const [topic, payload] of Object.entries(state.retained)) {
            if (packet.subscriptions.some((sub) => state.service._topicMatches(sub.topic, topic))) {
              send({ cmd: "publish", topic, payload, qos: 0, retain: true });
            }
          }
        }
      } else if (packet.cmd === "unsubscribe") {
        send({ cmd: "unsuback", messageId: packet.messageId });
      } else if (packet.cmd === "disconnect") {
        queueMicrotask(() => stream.destroy());
      }
      // Deliberately leave QoS publishes unacknowledged for the shutdown test.
    });
    state.streams.push(stream);
    return stream;
  });
  const service = new MqttService({ logger });
  state.service = service;
  t.after(() => service.disconnect());
  return state;
}

async function status(service) {
  const server = new WebServer({ mqttService: service, logger });
  const req = Readable.from([]);
  req.url = "/api/status";
  req.method = "GET";
  const res = { writeHead() {}, end(body) { this.body = body; } };
  await server._handle(req, res);
  return JSON.parse(res.body).mqttConnected;
}

test("late broker restores retained scene data, overlays, settings and live API status", async (t) => {
  const state = broker(t, { online: false, retained: {
    "home/state": "retained",
    "base/overlay/device/panel/ip": "overlay-ip",
    "pixdcon/panel/clock/settings/speed": "42",
  } });
  const service = state.service;
  assert.equal(await service.connect({ keepReconnecting: true, timeoutMs: 20 }), false);
  service.client.options.reconnectPeriod = 10;
  service.client.options.keepalive = 0;
  assert.equal(service.client.disconnecting, false);
  assert.equal(await status(service), false);
  const received = [];
  service.getSceneContext("clock", "panel").subscribe("home/state", (p) => received.push(p));
  service.subscribeDevice("panel", "home/state", (p) => received.push(`device:${p}`));
  service.subscribe("discarded", "home/discarded", () => assert.fail("removed owner called"));
  service.unsubscribeAll("discarded");
  const overlayChanged = [];
  const overlay = new ConfigOverlay(service, "base", () => overlayChanged.push(true), {
    logger, settleMs: 1, debounceMs: 1,
  });
  t.after(() => overlay.unsubscribe());
  await overlay.subscribe();
  const config = { devices: [{ name: "panel", scene: "clock", ip: "base-ip" }], scenes: {} };
  const settings = new SceneSettingsService({
    mqttService: service, logger,
    getConfig: () => config,
    getSceneMetadata: () => ({ clock: { settingsSchema: { speed: { type: "int", default: 10 } } } }),
  });
  t.after(() => settings.stop());
  await settings.start();
  service.publishConfig(config);
  service.setRunning(true);
  service.startPeriodicPublish(10);
  state.online = true;
  // Reconnect immediately instead of waiting for the original 5 s timer.
  service.client.reconnect();
  await waitFor(() => received.includes("retained") && overlayChanged.length > 0);
  assert.ok(received.includes("device:retained"));
  assert.equal(settings.getEffectiveValues("panel", "clock").speed, 42);
  assert.equal(overlay.merge(config).devices[0].ip, "overlay-ip");
  assert.equal(await status(service), true);
  assert.ok(!state.packets.some((p) => p.cmd === "subscribe" && p.subscriptions.some((s) => s.topic === "home/discarded")));
  assert.ok(state.packets.some((p) => p.cmd === "publish" && p.topic === `${service.baseTopic}/config/effective`));
  const statesBefore = state.packets.filter((p) => p.cmd === "publish" && p.topic.endsWith("/state")).length;
  await waitFor(() => state.packets.filter((p) => p.cmd === "publish" && p.topic.endsWith("/state")).length > statesBefore);
  await service.disconnect();
  assert.equal(await status(service), false);
});

for (const wildcard of [false, true]) {
  test(`${wildcard ? "wildcard" : "exact"} offline owners replay once on every reconnect`, async (t) => {
    const state = broker(t, { retained: { "home/state": "retained" } });
    const service = state.service;
    // Even subscriptions created before connect() must survive.
    const received = [];
    const subscribe = (owner) => {
      const callback = (...args) => received.push([owner, args.at(-1)]);
      if (wildcard) service.subscribeWildcard(owner, "home/+", callback);
      else service.subscribe(owner, "home/state", callback);
    };
    subscribe("one");
    await service.connect({ keepReconnecting: true });
    await flush();
    assert.deepEqual(received, [["one", "retained"]]);
    subscribe("two");
    await flush();
    assert.deepEqual(received.slice(-2), [["one", "retained"], ["two", "retained"]]);
    service.client.options.reconnectPeriod = 10;
    for (let i = 0; i < 2; i++) {
      const closed = once(service.client, "close");
      const connected = once(service.client, "connect");
      state.streams.at(-1).destroy();
      await closed;
      if (i === 0) subscribe("offline");
      const count = received.length;
      await connected;
      await flush();
      assert.equal(received.length, count + 3);
      assert.equal(service.client.listenerCount("message"), 1);
    }
    // One subscribe for the initial owner, one retained replay for owner two,
    // and one subscribe per reconnect; mqtt.js must not also resubscribe.
    assert.equal(state.packets.filter((p) => p.cmd === "subscribe").length, 4);
    await service.disconnect();
    assert.equal(service.client.listenerCount("message"), 0);
    assert.equal(service._subscriptions.size, 0);
  });
}

test("subscription rejection keeps the logical owner for the next connect", async (t) => {
  const state = broker(t, { rejectSubscription: true, retained: { "home/state": "recovered" } });
  const service = state.service;
  await service.connect({ keepReconnecting: true });
  const received = [];
  service.subscribe("scene", "home/state", (p) => received.push(p));
  await flush();
  assert.equal(service._topicEntries.get("home/state").callbacks.size, 1);
  state.rejectSubscription = false;
  service.client.options.reconnectPeriod = 10;
  state.streams.at(-1).destroy();
  await waitFor(() => received.length === 1);
  assert.deepEqual(received, ["recovered"]);
});

test("disconnect force-closes within 2 s with an unacknowledged QoS publish", async (t) => {
  const state = broker(t);
  const service = state.service;
  await service.connect({ keepReconnecting: true });
  service.subscribe("scene", "home/state", () => {});
  await flush();
  service.client.publish("home/pending", "pending", { qos: 1 }, () => {});
  await flush();
  assert.ok(Object.keys(service.client.outgoing).length > 0);
  service.startPeriodicPublish(10);
  const start = Date.now();
  await service.disconnect();
  assert.ok(Date.now() - start < 2600, "disconnect exceeded the 2 s bound plus scheduling margin");
  await flush();
  assert.equal(state.streams.at(-1).destroyed, true);
  assert.equal(service.client.disconnected, true);
  assert.equal(service.client.reconnectTimer, null);
  assert.equal(service.connected, false);
  assert.equal(service.publishInterval, null);
  assert.equal(service.client.listenerCount("message"), 0);
});

test("silent broker bounds the initial wait and an offline disconnect stops reconnects", async (t) => {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  t.mock.method(net, "createConnection", () => stream);
  const service = new MqttService({ logger });
  t.after(() => service.disconnect());
  const start = Date.now();
  assert.equal(await service.connect({ keepReconnecting: true, timeoutMs: 20 }), false);
  assert.ok(Date.now() - start < 500);
  await service.disconnect();
  assert.equal(stream.destroyed, true);
  assert.equal(service.client.reconnectTimer, null);
  assert.equal(service.client.listenerCount("connect"), 2); // mqtt.js + persistent service lifecycle.
});

for (const type of ["ulanzi", "pixoo"]) {
  test(`${type} telemetry waits to mark HA discovery sent until MQTT is online`, async (t) => {
    const service = new MqttService({ logger });
    const published = [];
    const raw = [];
    t.mock.method(service, "publish", (...args) => { if (service.connected) published.push(args); });
    t.mock.method(service, "publishRaw", (...args) => raw.push(args));
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () =>
      type === "ulanzi" ? { uid: "test-panel", uptime: 1 } : { error_code: 0, Brightness: 10 } }));
    const collector = new TelemetryCollector({ mqttService: service, logger, intervalMs: 10 });
    t.after(() => collector.stopAll());
    collector.start({ name: "panel", type, ip: "127.0.0.1" });
    await waitFor(() => collector.getLatest("panel"));
    assert.equal(collector._haPublished.has("panel"), false);
    assert.equal(raw.length, 0);
    service.connected = true;
    await waitFor(() => collector._haPublished.has("panel"));
    assert.ok(raw.length > 0);
    assert.ok(published.some(([topic]) => topic === "panel/telemetry"));
  });
}
