import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { TelemetryCollector } from "../lib/telemetry-collector.js";
import { FramePreviewStore } from "../lib/frame-preview-store.js";
import { start as startPing } from "../lib/collectors/ping-collector.js";
import { start as startRpc } from "../lib/collectors/rpc-collector.js";

const logger = { info() {}, debug() {}, warn() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const type of ["ulanzi", "pixoo"]) {
  test(`${type} telemetry skips overlapping polls and discards results after stop/restart`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const requests = [];
    t.mock.method(globalThis, "fetch", (_url, options) => {
      const result = deferred();
      requests.push({ ...result, signal: options.signal });
      return result.promise;
    });
    const published = [];
    const mqttService = { publish(...args) { published.push(args); } };
    const collector = new TelemetryCollector({ mqttService, logger, intervalMs: 10, haDiscovery: false });
    t.after(() => collector.stopAll());
    const device = { name: "screen", type, ip: "device.invalid" };
    collector.start(device);
    t.mock.timers.tick(100);
    assert.equal(requests.length, 1);
    collector.stop("screen");
    assert.equal(requests[0].signal.aborted, true);
    collector.start(device);
    assert.equal(requests.length, 2);
    const response = { ok: true, async json() { return type === "pixoo"
      ? { error_code: 0, Brightness: 47 } : { uptime: 47 }; } };
    requests[0].resolve(response);
    await flush();
    assert.deepEqual(published, []);
    assert.equal(collector.getLatest("screen"), null);
    requests[1].resolve(response);
    await flush();
    assert.equal(published.length, 1);
    assert.ok(collector.getLatest("screen"));
    collector.stopAll();
    assert.equal(collector.getLatest("screen"), null);
    t.mock.timers.tick(100);
    assert.equal(requests.length, 2);
  });
}

test("Pixoo fire-and-forget polls contain publishing errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, async json() { return { error_code: 0 }; } }));
  const warnings = [];
  const collector = new TelemetryCollector({
    mqttService: { publish() { throw new Error("publish failed"); } },
    logger: { ...logger, warn(message) { warnings.push(message); } },
    haDiscovery: false,
  });
  t.after(() => collector.stopAll());
  collector.start({ name: "screen", type: "pixoo", ip: "device.invalid" });
  await flush();
  assert.ok(warnings.some((message) => message.includes("publish failed")));
});

test("preview teardown aborts its request and cannot resurrect a removed frame", async () => {
  const result = deferred();
  let signal;
  const store = new FramePreviewStore({ logger });
  store.registerDevice({ name: "screen", type: "ulanzi" }, {
    getScreen(options) { signal = options.signal; return result.promise; },
  });
  store.unregisterDevice("screen");
  assert.equal(signal.aborted, true);
  result.resolve(Array(256).fill(0xff0000));
  await flush();
  assert.deepEqual(store.list(), {});
});

test("preview replacement ignores the old driver's late result", async (t) => {
  const oldResult = deferred();
  const store = new FramePreviewStore({ logger });
  t.after(() => store.unregisterDevice("screen"));
  const device = { name: "screen", type: "ulanzi" };
  store.registerDevice(device, { getScreen() { return oldResult.promise; } });
  store.registerDevice(device, { async getScreen() { return Array(256).fill(0x00ff00); } });
  await flush();
  oldResult.resolve(Array(256).fill(0xff0000));
  await flush();
  const pixels = Buffer.from(store.list().screen.data, "base64");
  assert.deepEqual([...pixels.slice(0, 3)], [0, 255, 0]);
});

test("preview teardown cancels sleeping polls and validates frame length", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const store = new FramePreviewStore({ logger });
  store.registerDevice({ name: "screen", type: "ulanzi" }, {
    async getScreen() { calls++; return Array(256).fill("#123456"); },
  });
  await flush();
  assert.equal(store.list().screen.width, 32);
  store.unregisterDevice("screen");
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(store.list(), {});
  store.capturePixoo("invalid", new Uint8Array(1));
  assert.deepEqual(store.list(), {});
  const pixels = new Uint8Array(64 * 64 * 3).fill(47);
  store.capturePixoo("valid", pixels);
  pixels.fill(0);
  assert.equal(Buffer.from(store.list().valid.data, "base64")[0], 47);
});

test("a late Pixoo push cannot resurrect or overwrite a replacement preview", async () => {
  const store = new FramePreviewStore({ logger });
  const oldDriver = {};
  const newDriver = {};
  const device = { name: "screen", type: "pixoo" };
  const oldPixels = new Uint8Array(64 * 64 * 3).fill(47);
  const newPixels = new Uint8Array(64 * 64 * 3).fill(100);
  store.registerDevice(device, oldDriver);
  store.capturePixoo(device.name, oldPixels, oldDriver);
  store.unregisterDevice(device.name);
  store.capturePixoo(device.name, oldPixels, oldDriver);
  assert.deepEqual(store.list(), {});
  store.registerDevice(device, newDriver);
  store.capturePixoo(device.name, newPixels, newDriver);
  store.capturePixoo(device.name, oldPixels, oldDriver);
  assert.equal(Buffer.from(store.list().screen.data, "base64")[0], 100);
  store.unregisterDevice(device.name);
});

test("RPC polling has one request per lane and stops without late state updates", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const requests = [];
  t.mock.method(globalThis, "fetch", (_url, options) => {
    const result = deferred();
    requests.push({ ...result, signal: options.signal });
    return result.promise;
  });
  const state = { wifi: { shelly: { online: false } }, services: { web: { alive: false } }, heatChain: {} };
  const collector = startRpc({
    wifi: [{ label: "shelly", type: "shelly-gen2-rpc", rpcUrl: "http://device.invalid", rssiField: "wifi.rssi" }],
    services: [{ label: "web", type: "http", url: "http://service.invalid" }], rpcIntervalMs: 10,
  }, state, logger);
  t.after(() => collector.stop());
  t.mock.timers.tick(100);
  assert.equal(requests.length, 2);
  collector.stop();
  assert.ok(requests.every((request) => request.signal.aborted));
  for (const request of requests) request.resolve({ ok: true, async json() { return { wifi: { rssi: -47 } }; } });
  await flush();
  assert.deepEqual(state.wifi.shelly, { online: false });
  assert.deepEqual(state.services.web, { alive: false });
});

test("RPC timeout remains active during JSON decoding", async (t) => {
  const timeout = new AbortController();
  const reading = deferred();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  t.mock.method(globalThis, "fetch", async (_url, options) => ({
    ok: true,
    json() {
      reading.resolve();
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    },
  }));
  const state = { wifi: { shelly: { online: true } }, services: {}, heatChain: {} };
  const collector = startRpc({
    wifi: [{ label: "shelly", type: "shelly-gen2-rpc", rpcUrl: "http://device.invalid", rssiField: "wifi.rssi" }],
    services: [], rpcIntervalMs: 60_000,
  }, state, logger);
  t.after(() => collector.stop());
  await reading.promise;
  timeout.abort(new Error("body deadline"));
  await flush();
  assert.equal(state.wifi.shelly.online, false);
});

test("RPC liveness probes release response bodies", async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false, status: 401, body: { async cancel() { cancelled = true; } },
  }));
  const state = { wifi: {}, services: { web: {} }, heatChain: {} };
  const collector = startRpc({ wifi: [], services: [{ label: "web", type: "http", url: "http://service.invalid" }], rpcIntervalMs: 60_000 }, state, logger);
  t.after(() => collector.stop());
  await flush();
  assert.equal(cancelled, true);
  assert.equal(state.services.web.alive, true);
});

test("ping uses literal argv, skips overlapping sweeps, and aborts on stop", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls = [];
  const execMock = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls.push({ command, args, options, callback });
  });
  syncBuiltinESMExports();
  t.after(() => { execMock.mock.restore(); syncBuiltinESMExports(); });
  const ip = "device.invalid; echo SHOULD_NOT_EXECUTE";
  const state = { wifi: { host: { online: false } } };
  const collector = startPing({ wifi: [{ type: "ping", label: "host", ip }], pingIntervalMs: 10 }, state, logger);
  t.after(() => collector.stop());
  t.mock.timers.tick(100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ping");
  assert.equal(calls[0].args.at(-1), ip);
  collector.stop();
  assert.equal(calls[0].options.signal.aborted, true);
  calls[0].callback(null, "time=1.2 ms");
  await flush();
  assert.deepEqual(state.wifi.host, { online: false });
});

test("collector configuration errors are logged, not unhandled rejections", async (t) => {
  const warnings = [];
  const log = { ...logger, warn(message) { warnings.push(message); } };
  const ping = startPing({ pingIntervalMs: 60_000 }, {}, log);
  const rpc = startRpc({ services: [], rpcIntervalMs: 60_000 }, {}, log);
  t.after(() => { ping.stop(); rpc.stop(); });
  await flush();
  assert.equal(warnings.length, 2);
});
