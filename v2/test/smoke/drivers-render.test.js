/** Fake-device smoke: W3's runtime against loopback fakes and injected scenes. */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { DeviceError, SceneError } from "../../src/core/errors.js";
import { createPixooDriver } from "../../src/drivers/pixoo-driver.js";
import { createAwtrixDriver, screenToFrame } from "../../src/drivers/awtrix-driver.js";
import { systemClock, manualClock } from "../../src/core/clock.js";
import { HealthModel } from "../../src/health/health-model.js";
import { TelemetryCollector } from "../../src/health/telemetry.js";
import { PreviewStore } from "../../src/render/preview-store.js";
import { createTopics } from "../../src/mqtt/topics.js";
import { deferred, flush, healthConfig, logger, loopRig, rig, StubMqtt, until } from "./runtime-fixture.js";

test("both fakes receive frames of their scenes within 2 s of the start", async (t) => {
  const r = await rig(t);
  await until(() => r.previews.get("p") && r.health.get("u")?.state === "online");
  assert.equal(r.pixoo.state().lastFrame?.[0], 3);
  assert.deepEqual(r.awtrix.state().apps["pixdcon_u"], { text: "3", color: "#00FF00" });
  assert.equal(r.previews.get("p")?.rgb[0], 3);
});

test("switching the scene of one display changes its frames and leaves the other display untouched", async (t) => {
  const r = await rig(t);
  await until(() => r.pixoo.state().frames === 1 && r.awtrix.state().updates === 1);
  r.choose("p", { scene: { scene: "blue" } });
  await until(() => r.pixoo.state().lastFrame?.[0] === 9);
  assert.equal(r.awtrix.state().updates, 1);
  assert.equal(r.tokens.get("p"), 1, "a scene choice does not rebuild the driver");
  assert.equal(r.released.length, 1);
});

test("a display that is offline at the start does not delay the UI or the other display", async (t) => {
  const r = await rig(t, { offline: true });
  await until(() => r.health.get("u")?.state === "online");
  assert.ok(r.scheduler.status().lastWatchdogAt);
  assert.equal(r.scheduler.status().loopsAlive, 2);
  await until(() => r.health.get("p")?.lastError?.kind === "device");
  assert.equal(r.health.get("u")?.state, "online");
});

test("display unplugged: stale after 30 s without a good frame, offline after 2 min, online again after the first good frame", async (t) => {
  const r = await rig(t);
  await until(() => r.previews.get("p"));
  await r.pixoo.setOffline(true);
  await r.clock.advance(500); await until(() => r.health.get("p")?.lastError !== null);
  await r.clock.advance(29500); assert.equal(r.health.get("p")?.state, "stale");
  await r.clock.advance(90000); assert.equal(r.health.get("p")?.state, "offline");
  await r.pixoo.setOffline(false);
  r.scheduler.loop("p")?.retryNow();
  await until(() => r.pixoo.state().frames > 1);
  assert.equal(r.health.get("p")?.state, "online");
});

test("health is by the clock, literally: 29 999 ms after the last good frame online, 30 000 ms stale, 119 999 ms stale, 120 000 ms offline", async (t) => {
  const r = loopRig(t, { delay: 200000 }); await flush();
  assert.equal(r.health.get("p")?.state, "online");
  await r.clock.advance(29999); assert.equal(r.health.get("p")?.state, "online");
  await r.clock.advance(1); assert.equal(r.health.get("p")?.state, "stale");
  await r.clock.advance(89999); assert.equal(r.health.get("p")?.state, "stale");
  await r.clock.advance(1); assert.equal(r.health.get("p")?.state, "offline");
});

test("health has no exception for a slow scene: a scene that returns a 45 s delay is stale from 30 s after its frame until the next one", async (t) => {
  const r = loopRig(t, { delay: 45000 }); await flush();
  await r.clock.advance(30000); assert.equal(r.health.get("p")?.state, "stale");
  await r.clock.advance(14999); assert.equal(r.health.get("p")?.state, "stale");
  await r.clock.advance(1); assert.equal(r.health.get("p")?.state, "online");
  assert.equal(r.loop.status().frameCount, 2);
});

test("a quiet display (paused, stopped, built-in mode, no scene) is judged by probes every 10 s with the same two thresholds", async (t) => {
  for (const target of [{ mode: "pause" }, { mode: "stop" }, { scene: "builtin:clock" }, { scene: null }]) {
    const r = loopRig(t, { target }); await flush();
    await r.clock.advance(10000); assert.ok(r.calls.some((c) => c.op === "probe"));
    assert.ok(["online", "idle"].includes(r.health.get("p")?.state ?? ""));
    r.options.probeError = new DeviceError("unplugged");
    await r.clock.advance(29999); assert.notEqual(r.health.get("p")?.state, "stale");
    await r.clock.advance(1); assert.equal(r.health.get("p")?.state, "stale");
    await r.clock.advance(90000); assert.equal(r.health.get("p")?.state, "offline");
  }
});

test("display hangs (accepts, never answers): the same timing, last error 'Pixoo HTTP timeout after 5000ms'", async (t) => {
  const fakeClock = manualClock();
  const r = await rig(t, { start: false });
  const driver = createPixooDriver({ name: "p", address: r.pixoo.address, clock: fakeClock, logger });
  t.after(() => driver.close());
  r.pixoo.setHang(true);
  const pending = driver.probe();
  const rejected = assert.rejects(pending, { message: "Pixoo HTTP timeout after 5000ms", timeout: true });
  await flush(); await fakeClock.advance(5000); await rejected;
  assert.equal(driver.ready, false);
  const h = r.health;
  h.register("p", { shadow: false, powerCycleMax: 10, plugTopic: null }); h.expect("p", { framesDue: true, hasScene: true }); h.frameOk("p");
  h.renderFailed("p", new DeviceError("Pixoo HTTP timeout after 5000ms"));
  await r.clock.advance(30000); assert.equal(h.get("p")?.state, "stale");
  await r.clock.advance(90000); assert.equal(h.get("p")?.state, "offline");
  assert.equal(h.get("p")?.lastError?.message, "Pixoo HTTP timeout after 5000ms");
});

test("a scene that throws is a scene error: the display stays reachable, no power cycle, the last good frame stays", async (t) => {
  const options = { device: { powerCyclePlugin: { topic: "plug" } }, render: /** @type {any} */ (null) };
  const r = loopRig(t, options); await flush();
  const frame = r.previews.get("p")?.rgb;
  options.render = async () => { throw new SceneError("bad scene"); };
  await r.clock.advance(200000);
  assert.equal(r.health.get("p")?.reason, "scene_error");
  assert.equal(r.health.get("p")?.lastError?.kind, "scene");
  assert.ok(r.calls.some((c) => c.op === "probe"));
  assert.equal(r.mqtt.messages.length, 0);
  assert.deepEqual(r.previews.get("p")?.rgb, frame);
});

test("backoff 1, 2, 4, 8, 16, 30 s with a probe every 10 s; a display that answers ends the wait", async (t) => {
  const error = new DeviceError("unplugged");
  const r = loopRig(t, { deviceError: error, probeError: error }); await flush();
  const start = r.clock.now();
  await r.clock.advance(61000);
  assert.deepEqual(r.calls.filter((c) => c.op === "show").map((c) => c.at - start), [0, 1000, 3000, 7000, 15000, 31000, 61000]);
  assert.deepEqual(r.calls.filter((c) => c.op === "probe").slice(0, 4).map((c) => c.at - start), [25000, 41000, 51000, 61000]);
  r.options.probeError = null; r.options.deviceError = null;
  await r.clock.advance(10000);
  assert.equal(r.health.get("p")?.state, "online");
});

test("10 failed renders with a plug configured: OFF, 10 s, ON, 30 s on the plug topic, then a re-init", async (t) => {
  const error = new DeviceError("no device");
  const r = loopRig(t, { deviceError: error, probeError: error, device: { powerCyclePlugin: { topic: "plug" } } }); await flush();
  await r.clock.advance(151000);
  assert.deepEqual(r.mqtt.messages.map((m) => [m.topic, m.payload]), [["plug", '{"state":"OFF"}']]);
  await r.clock.advance(9999); assert.equal(r.mqtt.messages.length, 1);
  await r.clock.advance(1); assert.equal(r.mqtt.messages[1]?.payload, '{"state":"ON"}');
  const before = r.calls.filter((c) => c.op === "reclaim").length;
  await r.clock.advance(29999); assert.equal(r.calls.filter((c) => c.op === "reclaim").length, before);
  await r.clock.advance(1); assert.ok(r.calls.filter((c) => c.op === "reclaim").length > before);
});

test("power cycles used up: slow probing goes on and 'Retry now' starts over", async (t) => {
  const error = new DeviceError("no device");
  const r = loopRig(t, { deviceError: error, probeError: error, device: { maxPowerCycles: 0, powerCyclePlugin: { topic: "plug" } } }); await flush();
  await r.clock.advance(151000); assert.equal(r.loop.status().phase, "exhausted");
  const probes = r.calls.filter((c) => c.op === "probe").length;
  await r.clock.advance(59999); assert.equal(r.calls.filter((c) => c.op === "probe").length, probes);
  await r.clock.advance(1); assert.equal(r.calls.filter((c) => c.op === "probe").length, probes + 1);
  r.options.deviceError = null; r.options.probeError = null;
  r.loop.retryNow(); r.loop.retryNow(); await flush();
  assert.equal(r.loop.status().phase, "running");
  assert.equal(r.mqtt.messages.length, 0);
});

test("pause holds one frame, stop blanks and switches off, play takes the display back", async (t) => {
  const r = await rig(t); await until(() => r.pixoo.state().frames === 1);
  r.choose("p", { mode: { value: "pause" } }); await until(() => r.pixoo.state().frames === 2);
  await r.clock.advance(2000); assert.equal(r.pixoo.state().frames, 2);
  r.choose("p", { mode: { value: "stop" } }); await until(() => !r.pixoo.state().screenOn);
  assert.ok(r.pixoo.state().lastFrame?.every((v) => v === 0));
  r.choose("p", { mode: { value: "play" } }); await until(() => r.pixoo.state().screenOn && r.pixoo.state().lastFrame?.[0] === 3);
  assert.equal(r.released.length, 0, "pause and stop keep the scene instance");
});

test("stop still powers off when the fake rejects /api/draw and stop errors never cycle the plug", async (t) => {
  const r = await rig(t, { start: false });
  r.devices[1].powerCyclePlugin = { topic: "plug" };
  await r.scheduler.start(); await until(() => r.awtrix.state().updates > 0);
  r.awtrix.failNext(100, "POST /api/draw");
  r.choose("u", { mode: { value: "stop" } });
  await until(() => r.scheduler.loop("u")?.status().phase === "stopped");
  assert.equal(r.awtrix.state().power, false);
  const requests = r.awtrix.state().requests;
  assert.ok(requests.lastIndexOf("POST /api/power") > requests.lastIndexOf("POST /api/draw"));
  await r.clock.advance(400000);
  assert.equal(r.mqtt.messages.length, 0);
  assert.equal(r.scheduler.loop("u")?.status().powerCycleCount, 0);

  // Even failures of the power-off itself must never open the breaker.
  r.awtrix.failNext(100, "POST /api/power");
  r.choose("u", { scene: { scene: "blue" } }); await flush();
  for (let i = 0; i < 12; i++) {
    const before = r.awtrix.state().requests.length;
    await r.clock.advance(30000);
    await until(() => r.awtrix.state().requests.length > before);
  }
  assert.equal(r.mqtt.messages.length, 0);
  assert.equal(r.scheduler.loop("u")?.deviceErrors, 0);
});

test("built-in mode: the fake shows the firmware channel or app and receives no frames", async (t) => {
  const r = await rig(t); await until(() => r.pixoo.state().frames > 0 && r.awtrix.state().updates > 0);
  r.choose("p", { scene: { scene: "builtin:clock" } }); r.choose("u", { scene: { scene: "builtin:time" } });
  await until(() => r.pixoo.state().channel === 0 && r.awtrix.state().currentApp === "Time");
  const counts = [r.pixoo.state().frames, r.awtrix.state().updates];
  await r.clock.advance(20000); assert.deepEqual([r.pixoo.state().frames, r.awtrix.state().updates], counts);
  r.choose("p", { scene: { scene: "red" } }); await until(() => r.pixoo.state().channel === 3);
});

test("brightness override: applied at once; cleared: the scene's last level is applied again", async (t) => {
  const r = loopRig(t, { render: async (/** @type {any} */ sink) => { await sink.requestBrightness(17); await sink.show({ kind: "frame", frame: { width: 64, height: 64, rgb: new Uint8Array(12288) } }); return 45000; } }); await flush();
  assert.equal(r.loop.status().appliedBrightness, 17);
  r.loop.apply({ brightnessOverride: 80 }); await flush(); assert.equal(r.loop.status().appliedBrightness, 80);
  r.loop.apply({ brightnessOverride: null }); await flush(); assert.equal(r.loop.status().appliedBrightness, 17);
  assert.deepEqual(r.calls.filter((c) => c.op === "brightness").map((c) => c.value), [17, 80, 17]);
});

test("mode and brightness from retained controls are applied before the first frame", async (t) => {
  const r = loopRig(t, { target: { mode: "pause", brightnessOverride: 73 } }); await flush();
  const show = r.calls.findIndex((c) => c.op === "show");
  assert.ok(r.calls.findIndex((c) => c.op === "brightness" && c.value === 73) < show);
  await r.clock.advance(20000); assert.equal(r.renders(), 1);
});

test("shadow output: scenes render and previews update, the fake receives no request, the broker no message", async (t) => {
  const r = await rig(t, { start: false });
  for (const device of r.devices) device.output = { mode: "shadow", requested: "shadow", reason: "config" };
  await r.scheduler.start(); await until(() => r.previews.list().length === 2);
  assert.equal(r.previews.get("u")?.source, "simulated");
  assert.equal(r.health.get("p")?.state, "shadow");
  assert.equal(r.pixoo.state().requests.length + r.awtrix.state().requests.length + r.mqtt.messages.length, 0);
});

test("interlocked device (config.json says drive, v1 still lists it): the same as shadow, for driver, telemetry, discovery, availability and the plug", async (t) => {
  let telemetryStarts = 0;
  const r = await rig(t, { start: false, telemetry: { start() { telemetryStarts++; }, stop() {} } });
  for (const device of r.devices) { device.output = { mode: "shadow", requested: "drive", reason: "v1_owner" }; device.powerCyclePlugin = { topic: "plug" }; }
  await r.scheduler.start(); await until(() => r.previews.list().length === 2);
  await r.clock.advance(200000);
  assert.equal(telemetryStarts, 0);
  assert.equal(r.pixoo.state().requests.length + r.awtrix.state().requests.length + r.mqtt.messages.length, 0);
});

test("v1 releases a display (publishes its list without it): that device alone is rebuilt with the real driver and starts to render", async (t) => {
  const r = await rig(t, { start: false });
  for (const device of r.devices) device.output = { mode: "shadow", requested: "drive", reason: "v1_owner" };
  await r.scheduler.start(); await until(() => r.previews.list().length === 2);
  const devices = r.devices.map((/** @type {any} */ d) => d.name === "p" ? { ...d, output: { mode: "drive", requested: "drive", reason: null } } : d);
  r.change(devices, { devicesChanged: { p: ["output"] } });
  await until(() => r.pixoo.state().frames > 0);
  assert.equal(r.tokens.get("p"), 2); assert.equal(r.tokens.get("u"), 1);
  assert.equal(r.awtrix.state().requests.length, 0);
});

test("a scene that calls device.setChannel(index) reaches the fake Pixoo as Channel/SetIndex with that index, through the driver queue", async (t) => {
  const r = await rig(t, { render: async (/** @type {string} */ _, /** @type {string} */ device, /** @type {any} */ surface) => { if (device === "p") await surface.channel(7); return null; } });
  await until(() => r.pixoo.state().channel === 7);
  assert.equal(r.scheduler.loop("p")?.driver.ready, true);
  const requests = r.pixoo.state().requests;
  assert.ok(requests.lastIndexOf("Channel/SetIndex") > requests.indexOf("Draw/ResetHttpGifId"));
});

test("changing one device in config.json restarts that device only", async (t) => {
  const r = await rig(t); await until(() => r.pixoo.state().frames > 0 && r.awtrix.state().updates > 0);
  const u = r.scheduler.loop("u"); const oldFrame = r.previews.get("p");
  r.change(r.devices.map((/** @type {any} */ d) => d.name === "p" ? { ...d, minFrameMs: 750 } : d), { devicesChanged: { p: ["minFrameMs"] } });
  await until(() => r.tokens.get("p") === 2);
  assert.equal(r.scheduler.loop("u"), u); assert.ok(r.previews.get("p")?.seq === oldFrame?.seq);
  assert.equal(r.scheduler.loop("p")?.deps.device.minFrameMs, 750);
});

test("a blob overlay that patches minFrameMs and the plug of one device restarts that device only, with the new values; config.json is untouched", async (t) => {
  const r = await rig(t); await until(() => r.pixoo.state().frames > 0);
  const before = structuredClone(r.devices);
  const changed = r.devices.map((/** @type {any} */ d) => d.name === "p" ? { ...d, minFrameMs: 901, powerCyclePlugin: { topic: "new-plug", offWaitMs: 17 }, blobKeys: ["minFrameMs", "powerCyclePlugin"] } : d);
  r.change(changed, { devicesChanged: { p: ["minFrameMs", "powerCyclePlugin", "blobKeys"] } });
  await until(() => r.tokens.get("p") === 2);
  assert.equal(r.scheduler.loop("p")?.deps.device.powerCyclePlugin?.topic, "new-plug");
  assert.equal(r.scheduler.loop("p")?.deps.device.minFrameMs, 901);
  assert.equal(r.tokens.get("u"), 1); assert.deepEqual(r.devices, before);
});

test("a device that exists only in the blob overlay runs like any other and stops when the blob is cleared", async (t) => {
  const r = await rig(t); await until(() => r.awtrix.state().updates > 0);
  const added = { ...r.devices[1], name: "blob-only", origin: "blob", savedScene: null };
  r.change([...r.devices, added], { devicesAdded: ["blob-only"] });
  await until(() => r.scheduler.loop("blob-only"));
  assert.equal(r.scheduler.loop("blob-only")?.status().phase, "idle");
  r.change(r.devices, { devicesRemoved: ["blob-only"] });
  await until(() => !r.scheduler.loop("blob-only"));
  assert.equal(r.tokens.get("u"), 1);
});

test("legacy app cleanup on the fake AWTRIX: every other custom app is deleted once, ours stays", async (t) => {
  const r = await rig(t, { start: false });
  r.awtrix.seedApps({ old: {}, second: {}, pixdcon_u: { text: "ours" } });
  const driver = createAwtrixDriver({ name: "u", address: r.awtrix.address, clock: systemClock(), logger, cleanupLegacyApps: true }); t.after(() => driver.close());
  await driver.init(); assert.deepEqual(Object.keys(r.awtrix.state().apps), ["pixdcon_u"]);
  const count = r.awtrix.state().requests.length;
  await driver.init(); assert.deepEqual(r.awtrix.state().requests.slice(count), ["GET /api/stats"]);
});



test("scheduler in order: a runtime change with a rev that is not higher than the one applied is dropped; desired events of one device are applied in the order they arrive, each device in its own queue", async (t) => {
  const r = await rig(t); await until(() => r.pixoo.state().frames > 0);
  r.change(r.devices, { devicesChanged: { p: ["address"] } }, 1);
  await flush(); assert.equal(r.tokens.get("p"), 1);
  r.choose("p", { scene: { scene: "blue" } }); r.choose("p", { scene: { scene: "red" } });
  await flush(); assert.equal(r.scheduler.loop("p")?.target.scene, "red");
  const slow = deferred();
  const pQueue = r.scheduler.queues.get("p");
  void pQueue?.run("hold", () => slow.promise);
  r.choose("p", { mode: { value: "stop" } }); r.choose("u", { scene: { scene: "builtin:time" } });
  await until(() => r.awtrix.state().currentApp === "Time");
  assert.equal(r.scheduler.loop("p")?.target.mode, "play");
  slow.resolve(null); await until(() => r.scheduler.loop("p")?.target.mode === "stop");
});

test("telemetry in order: a read that comes back after its device was stopped or rebuilt publishes nothing and counts as no contact; the poll timer only decides when a read starts", async () => {
  const clock = manualClock(); const mqtt = new StubMqtt(); const health = new HealthModel({ clock, logger, config: () => healthConfig });
  health.register("u", { shadow: false, powerCycleMax: 0, plugTopic: null });
  const held = deferred(); let reads = 0;
  const driver = /** @type {any} */ ({ info: { drives: true }, readTelemetry() { reads++; return held.promise; } });
  const collector = new TelemetryCollector(/** @type {any} */ ({ mqtt, topics: createTopics(), clock, logger, health, intervalMs: () => 1000, haDiscovery: true, discovery: { ulanzi: () => [{ topic: "discovery", payload: {} }] } }));
  collector.start({ name: "u", type: "ulanzi", address: "127.0.0.1" }, driver);
  await clock.advance(10000); assert.equal(reads, 1);
  collector.stop("u"); held.resolve({ uid: "old" }); await flush();
  assert.equal(mqtt.messages.length, 0); assert.equal(health.get("u")?.lastContactAt, null);
  assert.equal(clock.pending(), 0); assert.equal(mqtt.listenerCount("connect"), 0);
});

test("previews in order: the screen read-back of a replaced driver never overwrites a newer frame", async () => {
  const clock = manualClock(); const previews = new PreviewStore({ clock, logger }); const held = deferred();
  const stop = previews.feedFromDevice("u", /** @type {any} */ ({ readScreen: () => held.promise }), 1000);
  stop();
  const frame = { width: 32, height: 8, rgb: new Uint8Array(768).fill(7) };
  previews.put("u", frame, "simulated");
  held.resolve({ ...frame, rgb: new Uint8Array(768).fill(1) }); await flush();
  assert.equal(previews.get("u")?.rgb[0], 7); assert.equal(previews.get("u")?.seq, 1); assert.equal(clock.pending(), 0);
});

test("drivers in order: a request that timed out is reported once; its late answer is ignored and does not make the driver ready", async (t) => {
  for (const type of ["pixoo", "ulanzi"]) {
    let finish = () => {};
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"error_code":');
      finish = () => res.end("0}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(null)));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    const driver = (type === "pixoo" ? createPixooDriver : createAwtrixDriver)({ name: "x", address: `127.0.0.1:${port}`, clock: systemClock(), logger, timeoutMs: 25 });
    t.after(() => driver.close());
    await assert.rejects(driver.init(), (error) => error instanceof DeviceError && error.timeout);
    finish(); await flush(); assert.equal(driver.ready, false);
  }
});

test("health timers: the 1 s re-derive and the probe only move a display towards stale and offline by the clock; only an accepted frame or an answered probe moves it back", async () => {
  const clock = manualClock(); const h = new HealthModel({ clock, logger, config: () => healthConfig }); h.start();
  try {
    h.register("p", { shadow: false, powerCycleMax: 1, plugTopic: null }); h.expect("p", { framesDue: true, hasScene: true });
    assert.equal(h.get("p")?.state, "starting");
    await clock.advance(30000); assert.equal(h.get("p")?.state, "stale");
    await clock.advance(90000); assert.equal(h.get("p")?.state, "offline");
    h.contactOk("p"); assert.equal(h.get("p")?.state, "offline", "contact cannot replace an active scene frame");
    h.frameOk("p"); assert.equal(h.get("p")?.state, "online");
    h.expect("p", { framesDue: false, hasScene: false });
    await clock.advance(120000); assert.equal(h.get("p")?.state, "offline");
    h.contactOk("p"); assert.equal(h.get("p")?.state, "idle");
  } finally { h.stop(); }
});

test("fake AWTRIX read-back accepts RGB, packed, hex and nested screens; brightness and built-ins reject invalid values", async (t) => {
  const r = await rig(t, { start: false });
  const driver = createAwtrixDriver({ name: "u", address: r.awtrix.address, clock: systemClock(), logger }); t.after(() => driver.close());
  await driver.init(); await driver.setBrightness(500); assert.equal(r.awtrix.state().brightness, 255);
  await assert.rejects(driver.setBrightness(NaN), DeviceError); assert.equal(driver.ready, false);
  await assert.rejects(driver.activateBuiltin("builtin:Time"), DeviceError);
  for (const screen of [new Array(768).fill(7), new Array(256).fill(0x070707), new Array(8).fill(new Array(32).fill("#070707")), new Array(256).fill([7, 7, 7])])
    assert.deepEqual(screenToFrame(screen)?.rgb, new Uint8Array(768).fill(7));
  assert.equal(screenToFrame([1, 2]), null);
  const frame = { width: 32, height: 8, rgb: new Uint8Array(768).fill(12) };
  await driver.show({ kind: "frame", frame }); assert.deepEqual((await driver.readScreen?.())?.rgb, frame.rgb);
});

test("render pacing: every scene result and a failed brightness retry obey the frame floor", async (t) => {
  for (const delay of [undefined, null, 0, -1, NaN]) {
    const r = loopRig(t, { delay }); await flush();
    await r.clock.advance(499); assert.equal(r.renders(), 1);
    await r.clock.advance(1); assert.equal(r.renders(), 2);
  }
  const r = loopRig(t, { brightnessError: new DeviceError("brightness failed"), target: { brightnessOverride: 70 } }); await flush();
  assert.equal(r.loop.status().appliedBrightness, null);
  r.options.brightnessError = null;
  await r.clock.advance(1000); assert.equal(r.loop.status().appliedBrightness, 70);
});

test("controller health follows watchdog, driven displays, config and broker measurements", async () => {
  const clock = manualClock(); const h = new HealthModel({ clock, logger, config: () => healthConfig });
  const inputs = { watchdogAt: new Date(clock.now()).toISOString(), watchdogIntervalMs: 1000, mqtt: /** @type {any} */ ({ state: "disabled" }), configValid: true, restartRequired: false };
  assert.equal(h.controller(inputs).status, "ok");
  h.register("p", { shadow: false, powerCycleMax: 0, plugTopic: null });
  await clock.advance(30000); inputs.watchdogAt = new Date(clock.now()).toISOString();
  assert.deepEqual(h.controller(inputs), { status: "degraded", reasons: ["display_stale:p"] });
  await clock.advance(2001); assert.equal(h.controller(inputs).status, "failed");
});

test("fake AWTRIX cleanup retries only failed entries, completes the sweep, and stays done across driver rebuilds", async (t) => {
  const r = await rig(t, { start: false });
  r.awtrix.seedApps({ old: {}, other: {}, pixdcon_u: {} });
  r.awtrix.failNext(1, "POST /api/custom?name=old");
  const options = { name: "u", address: r.awtrix.address, clock: systemClock(), logger, cleanupLegacyApps: true };
  const driver = createAwtrixDriver(options); t.after(() => driver.close());
  await driver.init();
  assert.deepEqual(Object.keys(r.awtrix.state().apps).sort(), ["old", "pixdcon_u"]);
  assert.equal(driver.ready, false, "an incomplete cleanup is retried by lazy init");
  await driver.show({ kind: "app", app: { text: "new" } });
  assert.equal(driver.ready, true); assert.deepEqual(Object.keys(r.awtrix.state().apps), ["pixdcon_u"]);
  const count = r.awtrix.state().requests.length;
  const replacement = createAwtrixDriver(options); t.after(() => replacement.close()); await replacement.init();
  assert.deepEqual(r.awtrix.state().requests.slice(count), ["GET /api/stats"]);
});

test("fake drivers keep compound frame writes serialized, preserve reset and switch best effort behavior, and clear readiness on failures", async (t) => {
  const r = await rig(t, { start: false });
  const p = createPixooDriver({ name: "p", address: r.pixoo.address, clock: systemClock(), logger }); t.after(() => p.close()); await p.init();
  const frame = { width: 64, height: 64, rgb: new Uint8Array(12288).fill(33) };
  const before = r.pixoo.state().requests.length;
  await Promise.all([p.show({ kind: "frame", frame }), p.selectChannel?.(6), p.setBrightness(0)]);
  assert.deepEqual(r.pixoo.state().requests.slice(before), ["Draw/ResetHttpGifId", "Draw/SendHttpGif", "Channel/SetIndex", "Channel/SetBrightness"]);
  assert.equal(r.pixoo.state().brightness, 1); assert.equal(p.ready, true);
  r.pixoo.failNext(1, "Draw/ResetHttpGifId");
  await p.show({ kind: "frame", frame }); assert.equal(r.pixoo.state().frames, 2); assert.equal(p.ready, false);
  await p.show({ kind: "frame", frame }); assert.equal(p.ready, true); assert.equal(r.pixoo.state().lastPicId, 3);
  const u = createAwtrixDriver({ name: "u", address: r.awtrix.address, clock: systemClock(), logger }); t.after(() => u.close()); await u.init();
  r.awtrix.failNext(1, "POST /api/switch");
  await u.show({ kind: "app", app: { text: "saved" } }); assert.equal(u.ready, false);
  assert.deepEqual(r.awtrix.state().apps["pixdcon_u"], { text: "saved" });
  await assert.rejects(u.activateBuiltin("builtin:unknown"), DeviceError);
});

test("fake drivers close queued work and cancel a hung telemetry read without waiting for its deadline", async (t) => {
  const r = await rig(t, { start: false });
  const driver = createAwtrixDriver({ name: "u", address: r.awtrix.address, clock: systemClock(), logger });
  await driver.init(); r.awtrix.setHang(true);
  const abort = new AbortController();
  const read = driver.readTelemetry({ signal: abort.signal });
  const cancelled = assert.rejects(read, /cancelled/);
  await flush(); abort.abort(); await cancelled;
  r.awtrix.setHang(false); await driver.setBrightness(22); assert.equal(r.awtrix.state().brightness, 22);
  r.awtrix.setHang(true);
  const hung = assert.rejects(driver.readTelemetry(), /cancelled/);
  const queued = assert.rejects(driver.setPower(false), /closed/);
  await flush(); await driver.close(); await hung; await queued;
  assert.equal(driver.ready, false); assert.equal(r.awtrix.state().power, true);
});

test("telemetry on fake displays publishes native snapshots, repeats discovery on reconnect and follows interval changes", async (t) => {
  const r = await rig(t, { start: false });
  let intervalMs = 2000;
  const topics = createTopics({ baseTopic: "test" });
  const p = createPixooDriver({ name: "p", address: r.pixoo.address, clock: systemClock(), logger }); t.after(() => p.close());
  const u = createAwtrixDriver({ name: "u", address: r.awtrix.address, clock: systemClock(), logger }); t.after(() => u.close());
  r.health.register("p", { shadow: false, powerCycleMax: 0, plugTopic: null }); r.health.register("u", { shadow: false, powerCycleMax: 0, plugTopic: null });
  const discovery = { pixoo: () => [{ topic: "discovery/p", payload: { id: "p" } }], ulanzi: () => [{ topic: "discovery/u", payload: { id: "u" } }] };
  const collector = new TelemetryCollector(/** @type {any} */ ({ mqtt: r.mqtt, topics, health: r.health, intervalMs: () => intervalMs, haDiscovery: true, discovery, clock: r.clock, logger })); t.after(() => collector.stopAll());
  collector.start({ name: "p", type: "pixoo", address: r.pixoo.address }, p); collector.start({ name: "u", type: "ulanzi", address: r.awtrix.address }, u);
  await until(() => r.mqtt.messages.length === 4);
  assert.equal(collector.latest("p")?.brightness, 50); assert.equal(collector.latest("p")?.reachable, true);
  assert.equal(collector.latest("u")?.bat, 100); assert.equal(r.health.get("u")?.apSsid, "awtrix_fake01");
  assert.ok(r.mqtt.messages.every((m) => m.options.retain));
  r.mqtt.emit("connect", { connection: 2 }); await until(() => r.mqtt.messages.length === 8);
  assert.equal(r.mqtt.messages.filter((m) => m.topic.startsWith("discovery/")).length, 4);
  const before = r.mqtt.messages.length;
  await r.clock.advance(1000); await flush(); assert.equal(r.mqtt.messages.length, before);
  intervalMs = 1000; await r.clock.advance(1000); await until(() => r.mqtt.messages.length === before + 4);
  await r.awtrix.setOffline(true); await r.pixoo.setOffline(true);
  const goodU = collector.latest("u");
  await r.clock.advance(1000); await until(() => collector.latest("p")?.reachable === false);
  assert.deepEqual(collector.latest("u"), goodU);
  assert.equal(collector.latest("p")?.brightness, null);
});

test("preview snapshots copy accepted pixels, keep unchanged-frame age and sequence, and preserve the v1 envelope", async () => {
  const clock = manualClock(); const previews = new PreviewStore({ clock, logger });
  const events = []; previews.on("frame", (frame) => events.push(frame));
  const rgb = new Uint8Array(12288).fill(8); const frame = { width: 64, height: 64, rgb };
  previews.put("p", frame, "runtime"); rgb[0] = 9;
  assert.equal(previews.get("p")?.rgb[0], 8);
  const exposed = previews.get("p"); if (exposed) exposed.rgb[0] = 1;
  assert.equal(previews.get("p")?.rgb[0], 8);
  rgb[0] = 8; await clock.advance(500); previews.put("p", frame, "runtime");
  assert.equal(events.length, 1); assert.equal(previews.get("p")?.seq, 2);
  await clock.advance(500); previews.put("p", frame, "runtime"); assert.equal(events.length, 2);
  assert.deepEqual(previews.toV1().p, { width: 64, height: 64, data: Buffer.from(rgb).toString("base64"), source: "runtime", intervalMs: 0, updatedAt: new Date(clock.now()).toISOString() });
  previews.put("p", { width: 64, height: 64, rgb: new Uint8Array(1) }, "runtime"); assert.equal(previews.get("p")?.seq, 3);
});

test("mode changes during a stop request and scene failures cannot strand the new target in an old wait", async (t) => {
  const heldPower = deferred();
  const stopped = loopRig(t, { target: { mode: "stop" } });
  stopped.loop.driver.setPower = async () => { await heldPower.promise; };
  await flush(); stopped.loop.apply({ mode: "play" }); heldPower.resolve(null); await flush();
  assert.equal(stopped.loop.status().phase, "running"); assert.equal(stopped.renders(), 1);
  const heldRender = deferred();
  const r = loopRig(t, { render: () => heldRender.promise }); await flush();
  r.loop.apply({ mode: "stop" }); heldRender.reject(new SceneError("old target")); await flush();
  assert.equal(r.loop.status().phase, "stopped"); assert.equal(r.health.get("p")?.lastError, null);
});

test("a paused runtime applies brightness without another frame and adopts a ready replacement at the next probe boundary", async (t) => {
  const r = await rig(t, { start: false });
  const p = /** @type {any} */ (r.states.get("p")); p.desired.mode.value = "pause";
  const u = /** @type {any} */ (r.states.get("u")); u.desired.scene.scene = "blue";
  await r.scheduler.start(); await until(() => r.previews.get("p"));
  r.choose("p", { brightness: { override: 88 } }); await until(() => r.pixoo.state().brightness === 88);
  assert.equal(r.pixoo.state().frames, 1);
  r.generations.red = 1;
  await r.clock.advance(10000); await until(() => r.pixoo.state().frames === 2 && r.scheduler.loop("p")?.status().phase === "paused");
  assert.equal(r.released.length, 1); assert.equal(r.scheduler.loop("p")?.status().phase, "paused");
});

test("an interrupted power cycle still sends ON and a broker outage consumes no cycle attempt", async (t) => {
  const error = new DeviceError("offline");
  const r = loopRig(t, { deviceError: error, probeError: error, device: { powerCyclePlugin: { topic: "plug" } } }); await flush();
  await r.clock.advance(151000); assert.equal(r.mqtt.messages.length, 1);
  const stopping = r.loop.stop(); await flush(); assert.deepEqual(await stopping, { clean: true });
  assert.deepEqual(r.mqtt.messages.map((m) => m.payload), ['{"state":"OFF"}', '{"state":"ON"}']);
  const offline = loopRig(t, { deviceError: error, probeError: error, device: { powerCyclePlugin: { topic: "plug" } } });
  offline.mqtt.connected = false; await flush(); await offline.clock.advance(200000);
  assert.equal(offline.loop.status().powerCycleCount, 0); assert.equal(offline.mqtt.messages.length, 0);
});

test("uncertain OFF outcomes still owe ON, and reconnect retries ON until confirmed", async (t) => {
  for (const outcome of /** @type {const} */ (["timeout", "offline", "sent"])) {
    const error = new DeviceError("offline");
    const r = loopRig(t, { deviceError: error, probeError: error, device: { maxPowerCycles: 1, powerCyclePlugin: { topic: "plug" } } });
    r.mqtt.outcomes = [outcome, "timeout", "confirmed"];
    await flush(); await r.clock.advance(151000);
    assert.equal(r.loop.plugOnOwed, true); assert.equal(r.loop.status().powerCycleCount, 1);
    await r.clock.advance(10000);
    assert.deepEqual(r.mqtt.messages.map((m) => m.payload), ['{"state":"OFF"}', '{"state":"ON"}']);
    assert.equal(r.loop.plugOnOwed, true, "a timeout of ON cannot forgive the debt");
    await r.clock.advance(999); assert.equal(r.mqtt.messages.length, 2);
    r.mqtt.emit("connect", { connection: ++r.mqtt.connection }); await flush();
    assert.equal(r.mqtt.messages.length, 3); assert.equal(r.loop.plugOnOwed, false);
    assert.equal(r.loop.status().powerCycleCount, 1);
  }
});

test("only a certainly unsent OFF error owes no ON and consumes no power cycle", async (t) => {
  const error = new DeviceError("offline");
  const r = loopRig(t, { deviceError: error, probeError: error, device: { powerCyclePlugin: { topic: "plug" } } });
  r.mqtt.outcomes = ["error"]; await flush(); await r.clock.advance(151000);
  assert.equal(r.loop.plugOnOwed, false); assert.equal(r.loop.status().powerCycleCount, 0);
  assert.deepEqual(r.mqtt.messages.map((m) => m.payload), ['{"state":"OFF"}']);
});

test("failed ON retries on the clock and cannot enter exhausted or send another OFF while owed", async (t) => {
  const error = new DeviceError("offline");
  const r = loopRig(t, { deviceError: error, probeError: error, device: { maxPowerCycles: 1, powerCyclePlugin: { topic: "plug" } } });
  r.mqtt.outcomes = ["confirmed", ...Array(400).fill("error")];
  await flush(); await r.clock.advance(151000 + 10000 + 300000);
  assert.equal(r.loop.status().phase, "retrying"); assert.equal(r.loop.plugOnOwed, true);
  assert.equal(r.health.facts.get("p")?.powerCycles.exhausted, false);
  assert.equal(r.loop.status().powerCycleCount, 1);
  assert.equal(r.mqtt.messages.filter((m) => m.payload === '{"state":"OFF"}').length, 1);
  assert.ok(r.mqtt.messages.filter((m) => m.payload === '{"state":"ON"}').length > 100);
  r.mqtt.outcomes = ["confirmed"];
  r.mqtt.emit("connect", { connection: ++r.mqtt.connection }); await flush();
  assert.equal(r.loop.plugOnOwed, false);
});

test("stop retries an owed ON within its deadline, including reconnect, and bounds an unconfirmed ON", async (t) => {
  for (const confirms of [true, false]) {
    const error = new DeviceError("offline");
    const r = loopRig(t, { deviceError: error, probeError: error, device: { powerCyclePlugin: { topic: "plug" } } });
    r.mqtt.outcomes = ["timeout", ...Array(20).fill("offline")];
    await flush(); await r.clock.advance(151000);
    const stopping = r.loop.stop({ deadlineMs: 3500 }); await flush();
    assert.equal(r.mqtt.messages[1]?.payload, '{"state":"ON"}');
    await r.clock.advance(1000); assert.equal(r.mqtt.messages.length, 3);
    if (confirms) {
      r.mqtt.outcomes = ["confirmed"];
      r.mqtt.emit("connect", { connection: ++r.mqtt.connection }); await flush();
      assert.deepEqual(await stopping, { clean: true }); assert.equal(r.loop.plugOnOwed, false);
    } else {
      await r.clock.advance(2500); assert.deepEqual(await stopping, { clean: false });
      const count = r.mqtt.messages.length;
      r.mqtt.emit("connect", { connection: ++r.mqtt.connection });
      await r.clock.advance(10000); assert.equal(r.mqtt.messages.length, count);
      assert.equal(r.loop.plugOnOwed, true);
    }
    assert.equal(r.mqtt.listenerCount("connect"), 0);
  }
});

test("shutdown waits for an uncertain OFF in flight before restoring ON and bounds a hung ON", async (t) => {
  const error = new DeviceError("offline");
  const r = loopRig(t, { deviceError: error, probeError: error, device: { powerCyclePlugin: { topic: "plug" } } });
  const off = deferred(); const publish = r.mqtt.publish.bind(r.mqtt);
  r.mqtt.publish = async (topic, payload, options) => {
    const result = await publish(topic, payload, options);
    if (payload === '{"state":"OFF"}') await off.promise;
    return result;
  };
  r.mqtt.outcomes = ["timeout", "confirmed"];
  await flush(); await r.clock.advance(151000);
  const stopping = r.loop.stop(); await flush();
  assert.equal(r.mqtt.messages.length, 1, "ON must not overtake the outstanding OFF");
  off.resolve(null); await flush(); assert.deepEqual(await stopping, { clean: true });
  assert.equal(r.mqtt.messages[1]?.payload, '{"state":"ON"}');

  const hung = loopRig(t, { deviceError: error, probeError: error, device: { powerCyclePlugin: { topic: "plug" } } });
  const on = deferred(); const send = hung.mqtt.publish.bind(hung.mqtt);
  hung.mqtt.publish = async (topic, payload, options) => {
    const result = await send(topic, payload, options);
    if (payload === '{"state":"ON"}') await on.promise;
    return result;
  };
  hung.mqtt.outcomes = ["confirmed", "timeout"];
  await flush(); await hung.clock.advance(161000);
  const bounded = hung.loop.stop({ deadlineMs: 2500 });
  await hung.clock.advance(2500); assert.deepEqual(await bounded, { clean: false });
  on.resolve(null); await flush();
  assert.equal(hung.mqtt.messages.length, 2); assert.equal(hung.mqtt.listenerCount("connect"), 0);
});

test("good probes retry rejected frames without replenishing the exhausted cycle budget", async (t) => {
  const error = new DeviceError("offline");
  const r = loopRig(t, { deviceError: error, probeError: error, device: { maxPowerCycles: 1, powerCyclePlugin: { topic: "plug" } } });
  await flush(); await r.clock.advance(151000 + 40000 + 151000);
  assert.equal(r.loop.status().phase, "exhausted"); assert.equal(r.loop.status().powerCycleCount, 1);
  r.options.probeError = null;
  const frames = r.renders(); await r.clock.advance(60000);
  assert.ok(r.renders() > frames); assert.equal(r.loop.status().powerCycleCount, 1);
  assert.equal(r.loop.deviceErrors, 1, "the good probe reset device errors before trying a frame");
  await r.clock.advance(600000);
  assert.equal(r.mqtt.messages.filter((m) => m.payload === '{"state":"OFF"}').length, 1);
  assert.equal(r.loop.status().powerCycleCount, 1);
  r.loop.apply({ mode: "play" }); await flush(); assert.equal(r.loop.status().powerCycleCount, 1);
  r.loop.retryNow(); await flush();
  assert.equal(r.loop.status().powerCycleCount, 0, "manual retry resets cycles even if the frame still fails");
});

test("an accepted frame replenishes a spent cycle budget without a manual retry", async (t) => {
  const error = new DeviceError("offline");
  const r = loopRig(t, { deviceError: error, probeError: error, device: { maxPowerCycles: 1, powerCyclePlugin: { topic: "plug" } } });
  await flush(); await r.clock.advance(151000 + 40000 + 151000);
  assert.equal(r.loop.status().powerCycleCount, 1);
  r.options.probeError = null; r.options.deviceError = null;
  await r.clock.advance(60000);
  assert.equal(r.loop.status().powerCycleCount, 0); assert.equal(r.loop.status().phase, "running");
});

test("scheduler retires disabled devices, preserves previews, re-arms only the changed feed and uses the injected change classifier", async (t) => {
  const r = await rig(t); await until(() => r.previews.get("p") && r.health.get("u")?.state === "online");
  const p = r.scheduler.loop("p"); const u = r.scheduler.loop("u");
  /** @type {string[]} */
  const classified = [];
  r.factories.changeImpact = (key) => { classified.push(key); return key === "preview.pollMs" ? "preview" : "view"; };
  r.change(r.devices.map((/** @type {any} */ d) => d.name === "u" ? { ...d, preview: { ...d.preview, pollMs: 1000 } } : d), { devicesChanged: { u: ["preview.pollMs"] } });
  await flush(); assert.deepEqual(classified, ["preview.pollMs"]); assert.equal(r.scheduler.loop("p"), p); assert.equal(r.scheduler.loop("u"), u);
  assert.equal(r.previews.feeds.get("u")?.pollMs, 1000);
  r.factories.changeImpact = () => "restart";
  r.change(r.devices.map((/** @type {any} */ d) => d.name === "p" ? { ...d, enabled: false } : d), { devicesChanged: { p: ["enabled"] } });
  await until(() => !r.scheduler.loop("p"));
  assert.ok(r.previews.get("p")); assert.equal(r.health.get("p"), undefined); assert.equal(r.scheduler.status().devices, 1);
});

test("watchdog restarts a dead runtime only and reports its measured liveness", async (t) => {
  const r = await rig(t); await until(() => r.pixoo.state().frames > 0);
  const p = r.scheduler.loop("p"); const u = r.scheduler.loop("u");
  assert.ok(p); const stopping = p.stop(); await flush(); await stopping;
  await r.clock.advance(1000); await until(() => r.tokens.get("p") === 2);
  assert.equal(r.scheduler.loop("u"), u); assert.equal(r.scheduler.status().restarts, 1);
  assert.equal(r.scheduler.status().loopsAlive, 2);
});

test("watchdog recovers a failed runtime factory while the other display renders", async (t) => {
  const r = await rig(t, { start: false }); const factory = r.factories.createDriver;
  let failed = true;
  r.factories.createDriver = (device, deps) => { if (device.name === "p" && failed) throw new DeviceError("factory failed"); return factory(device, deps); };
  await r.scheduler.start(); await until(() => r.health.get("u")?.state === "online");
  assert.equal(r.health.get("p")?.lastError?.message, "factory failed");
  assert.equal(r.scheduler.status().devices, 2); assert.equal(r.scheduler.status().loopsAlive, 1);
  failed = false; await r.clock.advance(10000); await until(() => r.previews.get("p"));
  assert.equal(r.scheduler.status().loopsAlive, 2); assert.equal(r.scheduler.status().restarts, 1);
});

test("retired scene pass-throughs cannot select a channel on the replacement display", async (t) => {
  const held = deferred(); let first = true;
  let lateError = /** @type {unknown} */ (null);
  const r = await rig(t, { render: async (/** @type {string} */ _, /** @type {string} */ device, /** @type {any} */ surface) => {
    if (device === "p" && first) { first = false; await held.promise; try { await surface.channel(7); } catch (error) { lateError = error; } }
    await surface.paint(3); return null;
  } }); await until(() => r.renderCalls.has("p"));
  r.change(r.devices.map((/** @type {any} */ d) => d.name === "p" ? { ...d, minFrameMs: 900 } : d), { devicesChanged: { p: ["minFrameMs"] } });
  await flush(); held.resolve(null); await until(() => r.tokens.get("p") === 2);
  assert.ok(lateError instanceof DeviceError); assert.notEqual(r.pixoo.state().channel, 7);
});

test("watchdog replaces an overdue render, honors a long planned wake-up and leaves the other runtime alive", async (t) => {
  const held = deferred(); let first = true;
  const r = await rig(t, { start: false, delay: 120000, render: async (/** @type {string} */ _, /** @type {string} */ name, /** @type {any} */ surface) => {
    if (name === "p" && first) { first = false; await held.promise; }
    await surface.paint(3); return 120000;
  } });
  for (const device of r.devices) device.output = { mode: "shadow", requested: "shadow", reason: "config" };
  await r.scheduler.start(); await flush();
  await r.clock.advance(67000); await until(() => r.tokens.get("p") === 2);
  assert.equal(r.tokens.get("u"), 1); assert.equal(r.scheduler.status().restarts, 1);
  assert.equal(r.scheduler.status().loopsAlive, 2);
  held.resolve(null); await flush();
});

test("scene brightness gets false on refusal and retries its last requested level at the next frame", async (t) => {
  /** @type {boolean[]} */
  const results = [];
  const r = loopRig(t, { brightnessError: new DeviceError("brightness"), render: async (/** @type {any} */ sink) => {
    results.push(await sink.requestBrightness(42));
    await sink.show({ kind: "frame", frame: { width: 64, height: 64, rgb: new Uint8Array(12288) } });
    return null;
  } }); await flush();
  assert.deepEqual(results, [false]); assert.equal(r.loop.status().appliedBrightness, null);
  r.options.brightnessError = null;
  await r.clock.advance(500); assert.equal(r.loop.status().appliedBrightness, 42); assert.deepEqual(results, [false, true]);
});

test("telemetry pacing preserves sub-second remainders and re-reads the interval without overlapping polls", async () => {
  const clock = manualClock(); const mqtt = new StubMqtt();
  const health = new HealthModel({ clock, logger, config: () => healthConfig });
  let interval = 1500;
  /** @type {number[]} */
  const starts = [];
  const driver = /** @type {any} */ ({ info: { drives: true }, async readTelemetry() { starts.push(clock.now()); return { uid: "test" }; } });
  const collector = new TelemetryCollector(/** @type {any} */ ({ mqtt, health, topics: createTopics(), clock, logger, haDiscovery: false, intervalMs: () => interval }));
  collector.start({ name: "u", type: "ulanzi", address: "127.0.0.1" }, driver);
  try {
    await flush(); const start = clock.now();
    await clock.advance(1499); assert.equal(starts.length, 1);
    await clock.advance(1); assert.deepEqual(starts.map((at) => at - start), [0, 1500]);
    interval = 2250;
    await clock.advance(2249); assert.equal(starts.length, 2);
    await clock.advance(1); assert.deepEqual(starts.map((at) => at - start), [0, 1500, 3750]);
  } finally { collector.stopAll(); }
  assert.equal(clock.pending(), 0);
});

test("switching drive to shadow revokes transport work that was queued behind a hung device request", async (t) => {
  const r = await rig(t); await until(() => r.previews.get("p"));
  r.pixoo.setHang(true);
  const p = r.scheduler.loop("p"); assert.ok(p);
  const cancelled = assert.rejects(p.driver.probe(), DeviceError);
  await flush(); await r.clock.advance(500);
  const before = r.pixoo.state().frames;
  r.change(r.devices.map((/** @type {any} */ d) => d.name === "p" ? { ...d, output: { mode: "shadow", requested: "drive", reason: "v1_owner" } } : d), { devicesChanged: { p: ["output"] } });
  await cancelled; r.pixoo.setHang(false);
  await until(() => r.tokens.get("p") === 2 && r.previews.get("p")?.source === "simulated");
  assert.equal(r.pixoo.state().frames, before); assert.equal(r.scheduler.loop("p")?.driver.info.drives, false);
});

test("AWTRIX startup creates its custom app before selecting it and a failed switch keeps the accepted first frame", async (t) => {
  const r = await rig(t, { start: false }); r.awtrix.failNext(1, "POST /api/switch");
  await r.scheduler.start(); await until(() => r.health.get("u")?.state === "online");
  const requests = r.awtrix.state().requests;
  assert.ok(requests.indexOf("POST /api/custom") < requests.indexOf("POST /api/switch"));
  assert.deepEqual(r.awtrix.state().apps["pixdcon_u"], { text: "3", color: "#00FF00" });
  assert.equal(r.scheduler.loop("u")?.driver.ready, false);
});

test("quiet probes and recovery waits read the effective health probe interval", async (t) => {
  const r = loopRig(t, { target: { scene: null } });
  let interval = 2500;
  r.loop.deps.probeIntervalMs = () => interval;
  await flush(); await r.clock.advance(2499); assert.equal(r.calls.filter((c) => c.op === "probe").length, 0);
  await r.clock.advance(1); assert.equal(r.calls.filter((c) => c.op === "probe").length, 1);
  interval = 1500;
  await r.clock.advance(2500); // the already-armed sleep completes; the next one reads the new value
  const before = r.calls.filter((c) => c.op === "probe").length;
  await r.clock.advance(1499); assert.equal(r.calls.filter((c) => c.op === "probe").length, before);
  await r.clock.advance(1); assert.equal(r.calls.filter((c) => c.op === "probe").length, before + 1);
  const error = new DeviceError("offline");
  const recovery = loopRig(t, { deviceError: error, probeError: error });
  recovery.loop.deps.probeIntervalMs = () => 2500;
  await flush(); const start = recovery.clock.now(); await recovery.clock.advance(5500);
  assert.equal((recovery.calls.find((c) => c.op === "probe")?.at ?? 0) - start, 5500);
});
