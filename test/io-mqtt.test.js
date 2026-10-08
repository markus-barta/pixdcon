import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { Duplex } from "node:stream";
import net from "node:net";
import test from "node:test";
import mqtt from "mqtt";
import mqttPacket from "mqtt-packet";
import { MqttService } from "../lib/mqtt-service.js";

const logger = { info() {}, warn() {}, error() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const service = new MqttService({ logger });
  const client = new EventEmitter();
  const pending = [];
  const unsubscribed = [];
  client.subscribe = (topic, opts, callback) => pending.push(callback);
  client.unsubscribe = (topic) => unsubscribed.push(topic);
  service.client = client;
  service.connected = true;
  return { service, client, pending, unsubscribed };
}

for (const wildcard of [false, true]) {
  const kind = wildcard ? "wildcard" : "exact";
  const subscribe = (service, owner, callback) => wildcard
    ? service.subscribeWildcard(owner, "home/+", callback)
    : service.subscribe(owner, "home/state", callback);

  test(`${kind}: late SUBACK error after teardown is harmless`, () => {
    const { service, client, pending, unsubscribed } = fixture();
    subscribe(service, "scene", () => {});
    service.unsubscribeAll("scene");
    assert.doesNotThrow(() => pending[0](new Error("connection closed")));
    assert.equal(client.listenerCount("message"), 0);
    assert.equal(unsubscribed.length, 1);
  });

  test(`${kind}: an old failure cannot remove a replacement using the same callback`, () => {
    const { service, client, pending } = fixture();
    let calls = 0;
    const callback = () => calls++;
    subscribe(service, "scene", callback);
    subscribe(service, "scene", callback);
    pending[0](new Error("old failure"));
    pending[1](null);
    client.emit("message", "home/state", Buffer.from("ok"));
    assert.equal(calls, 1);
    assert.equal(client.listenerCount("message"), 1);
  });

  test(`${kind}: shared subscriptions survive one owner's teardown`, () => {
    const { service, client, unsubscribed } = fixture();
    const received = [];
    subscribe(service, "one", () => received.push("one"));
    subscribe(service, "two", () => received.push("two"));
    service.unsubscribeAll("one");
    client.emit("message", "home/state", Buffer.from("ok"));
    assert.deepEqual(received, ["two"]);
    assert.deepEqual(unsubscribed, []);
    service.unsubscribeAll("two");
    assert.equal(unsubscribed.length, 1);
    assert.equal(client.listenerCount("message"), 0);
  });

  test(`${kind}: rejected asynchronous callbacks are logged without breaking fan-out`, async (t) => {
    const { service, client } = fixture();
    const errors = [];
    const loggerMock = t.mock.method(logger, "error", (...args) => errors.push(args));
    let healthyCalls = 0;
    subscribe(service, "broken", async () => { throw new Error("callback failed"); });
    subscribe(service, "healthy", () => healthyCalls++);
    client.emit("message", "home/state", Buffer.from("ok"));
    await flush();
    assert.equal(healthyCalls, 1);
    assert.equal(loggerMock.mock.callCount(), 1);
    assert.equal(errors[0][1].message, "callback failed");
  });
}

test("wildcards respect levels and MQTT's $ topic boundary", () => {
  const service = new MqttService({ logger });
  assert.equal(service._topicMatches("home/+", "home/state"), true);
  assert.equal(service._topicMatches("home/+", "home/device/state"), false);
  assert.equal(service._topicMatches("home/#", "home"), true);
  assert.equal(service._topicMatches("#", "$SYS/status"), false);
  assert.equal(service._topicMatches("+/status", "$SYS/status"), false);
  assert.equal(service._topicMatches("$SYS/#", "$SYS/status"), true);
});

test("initial MQTT error rejects startup and stops orphaned reconnects", async (t) => {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  t.mock.method(net, "createConnection", () => stream);
  const service = new MqttService({ logger });
  const connecting = service.connect();
  const connectListeners = service.client.listenerCount("connect");
  const errorListeners = service.client.listenerCount("error");
  const checked = assert.rejects(connecting, /broker refused/);
  service.client.emit("error", new Error("broker refused"));
  await checked;
  assert.equal(service.connected, false);
  assert.equal(service.client.disconnecting, true);
  assert.equal(service.client.listenerCount("connect"), connectListeners - 1);
  assert.equal(service.client.listenerCount("error"), errorListeners - 1);
  assert.equal(service.client.reconnectTimer, null);
  await service.disconnect();
});

test("MQTT reconnect keeps one logical handler and disconnect releases it", async (t) => {
  const streams = [];
  t.mock.method(net, "createConnection", () => {
    const parser = mqttPacket.parser();
    const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { parser.parse(chunk); callback(); } });
    parser.on("packet", (packet) => {
      if (packet.cmd === "connect") {
        stream.push(mqttPacket.generate({ cmd: "connack", returnCode: 0, sessionPresent: false }));
      } else if (packet.cmd === "subscribe") {
        stream.push(mqttPacket.generate({ cmd: "suback", messageId: packet.messageId, granted: [1] }));
        stream.push(mqttPacket.generate({ cmd: "publish", topic: "home/state", payload: "retained", qos: 0, retain: true }));
      } else if (packet.cmd === "disconnect") {
        queueMicrotask(() => stream.destroy());
      }
    });
    streams.push(stream);
    return stream;
  });
  const service = new MqttService({ logger });
  t.after(() => service.disconnect());
  await service.connect();
  service.client.options.reconnectPeriod = 1;
  let calls = 0;
  service.subscribe("scene", "home/state", () => calls++);
  await flush();
  assert.equal(calls, 1);
  const closed = once(service.client, "close");
  const reconnected = once(service.client, "connect");
  streams[0].destroy();
  await closed;
  assert.equal(service.connected, false);
  await reconnected;
  await flush();
  assert.equal(service.connected, true);
  assert.equal(calls, 2);
  assert.equal(service.client.listenerCount("message"), 1);
  service.startPeriodicPublish();
  await service.disconnect();
  assert.equal(service.publishInterval, null);
  assert.equal(service.client.listenerCount("message"), 0);
  assert.equal(service._subscriptions.size, 0);
});

// Exercise mqtt.js itself over an in-memory MQTT broker, without sockets.
for (const wildcard of [false, true]) {
  test(`mqtt.js replays retained data for a second ${wildcard ? "wildcard" : "exact"} owner`, async (t) => {
    const packets = [];
    const parser = mqttPacket.parser();
    const stream = new Duplex({
      read() {},
      write(chunk, encoding, callback) {
        parser.parse(chunk);
        callback();
      },
    });
    const send = (packet) => stream.push(mqttPacket.generate(packet));
    parser.on("packet", (packet) => {
      if (packet.cmd === "connect") {
        send({ cmd: "connack", returnCode: 0, sessionPresent: false });
      } else if (packet.cmd === "subscribe") {
        packets.push(packet);
        send({ cmd: "suback", messageId: packet.messageId, granted: [1] });
        send({ cmd: "publish", topic: "home/state", payload: "retained", qos: 0, retain: true });
      }
    });
    const client = new mqtt.MqttClient(() => stream, { keepalive: 0, reconnectPeriod: 0 });
    t.after(() => new Promise((resolve) => client.end(true, resolve)));
    await once(client, "connect");
    const service = new MqttService({ logger });
    service.client = client;
    service.connected = true;
    const received = [];
    const subscribe = (owner) => {
      const callback = (...args) => received.push([owner, args.at(-1)]);
      if (wildcard) service.subscribeWildcard(owner, "home/+", callback);
      else service.subscribe(owner, "home/state", callback);
    };
    subscribe("one");
    await flush();
    subscribe("two");
    await flush();
    assert.equal(packets.length, 2);
    assert.ok(received.some(([owner, payload]) => owner === "two" && payload === "retained"));
    service.unsubscribeAll("one");
    service.unsubscribeAll("two");
  });
}
