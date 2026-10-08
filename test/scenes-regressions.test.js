import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import home from "../scenes/pixoo/home.js";
import health from "../scenes/pixoo/health.js";
import kid from "../scenes/pixoo/funkeykid.js";
import clock from "../scenes/ulanzi/clock_with_homestats.js";
import { PixooDriver } from "../lib/pixoo-driver.js";
import { SceneLoader } from "../lib/scene-loader.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const kidTopic = "home/hsb1/funkeykid/display";

function context(values = {}) {
  const handlers = new Map();
  let settingsListener;
  let settingsUnsubscribed = false;
  return {
    logger,
    handlers,
    settings: {
      all: () => values,
      subscribe: (cb) => {
        settingsListener = cb;
        return () => { settingsUnsubscribed = true; };
      },
    },
    mqtt: {
      subscribe: (topic, cb) => handlers.set(topic, cb),
      subscribeWildcard: (topic, cb) => handlers.set(topic, cb),
      unsubscribeAll: () => handlers.clear(),
    },
    update: (next) => settingsListener(next),
    settingsUnsubscribed: () => settingsUnsubscribed,
  };
}

function timers(t) {
  const intervals = new Set();
  const timeouts = new Set();
  t.mock.method(globalThis, "setInterval", (cb, delay) => {
    const id = { cb, delay };
    intervals.add(id);
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (id) => intervals.delete(id));
  t.mock.method(globalThis, "setTimeout", (cb, delay) => {
    const id = { cb, delay };
    timeouts.add(id);
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timeouts.delete(id));
  return { intervals, timeouts };
}

function environment(t, name, value) {
  const existed = Object.hasOwn(process.env, name);
  const prior = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (existed) process.env[name] = prior;
    else delete process.env[name];
  });
}

function freezeTime(t, instant) {
  const RealDate = Date;
  const ms = new RealDate(instant).getTime();
  t.mock.method(globalThis, "Date", class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [ms])); }
    static now() { return ms; }
  });
}

function driver(t) {
  const device = new PixooDriver("offline", { logger });
  t.mock.method(device, "setBrightness", async () => true);
  t.mock.method(device, "push", async () => true);
  return device;
}

async function homeScene(t) {
  const scene = Object.create(home);
  t.mock.method(scene, "_restartNukiPolls", () => {});
  t.mock.method(scene, "_startSyncboxPoll", () => {});
  t.mock.method(scene, "_startUvPoll", () => {});
  const ctx = context();
  await scene.init(ctx);
  t.after(() => scene.destroy(ctx));
  return { scene, ctx };
}

async function clockScene(t, values = {}) {
  const scene = Object.create(clock);
  t.mock.method(scene, "_startSonnenPoll", () => {});
  const ctx = context(values);
  await scene.init(ctx);
  t.after(() => scene.destroy(ctx));
  return { scene, ctx };
}

function requests(t) {
  const pending = [];
  t.mock.method(https, "request", (options, cb) => {
    const req = new EventEmitter();
    req.options = options;
    req.end = () => {};
    req.destroy = () => { req.destroyed = true; req.emit("close"); };
    req.respond = (data, statusCode = 200) => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      cb(res);
      res.emit("data", JSON.stringify(data));
      res.emit("end");
      req.emit("close");
    };
    pending.push(req);
    return req;
  });
  return pending;
}

test("loader eviction clears home self-heal timers and subscriptions after settings changes", async (t) => {
  const scheduled = timers(t);
  for (const method of ["_restartNukiPolls", "_startSyncboxPoll", "_startUvPoll"]) {
    t.mock.method(home, method, () => {});
  }
  const ctx = context();
  const loader = new SceneLoader(fileURLToPath(new URL("../", import.meta.url)), {
    home: { path: "./scenes/pixoo/home.js" },
  }, {
    logger,
    mqttService: { getSceneContext: () => ctx.mqtt },
    sceneSettingsService: { createRuntimeContext: () => ctx.settings },
  });
  await loader.load("home", "scene-test");
  assert.equal(scheduled.timeouts.size, 1);
  assert.equal(scheduled.intervals.size, 1);
  ctx.update({ heal_retry_ms: 60000, heal_initial_delay_ms: 2000 });
  assert.equal(scheduled.timeouts.size, 1);
  assert.equal([...scheduled.timeouts][0].delay, 2000);
  await loader.clearScene("home");
  assert.equal(scheduled.timeouts.size, 0);
  assert.equal(scheduled.intervals.size, 0);
  assert.equal(ctx.handlers.size, 0);
  assert.equal(ctx.settingsUnsubscribed(), true);
});

test("home initializes against the loader's MQTT-disabled context", async (t) => {
  timers(t);
  for (const method of ["_restartNukiPolls", "_startSyncboxPoll", "_startUvPoll"]) {
    t.mock.method(home, method, () => {});
  }
  const loader = new SceneLoader(fileURLToPath(new URL("../", import.meta.url)), {
    home: { path: "./scenes/pixoo/home.js" },
  }, { logger });
  const scene = await loader.load("home", "offline-scene-test");
  assert.equal(await scene.render(driver(t)), 500);
  await loader.clearCache();
});

test("missing and non-boolean contact fields remain unknown on both displays", async (t) => {
  timers(t);
  const h = await homeScene(t);
  const c = await clockScene(t);
  for (const value of ["{}", "null", "[]", '{"contact":0}', '{"contact":"false"}']) {
    h.ctx.handlers.get("z2m/wz/contact/te-door/#")(value, "z2m/wz/contact/te-door");
    c.ctx.handlers.get("z2m/wz/contact/te-door")(value);
    assert.equal(h.scene._s.terraceOpen, null);
    assert.equal(c.scene._state.terraceOpen, null);
  }
  for (const contact of [false, true]) {
    const payload = JSON.stringify({ contact });
    h.ctx.handlers.get("z2m/wz/contact/te-door/#")(payload, "z2m/wz/contact/te-door");
    c.ctx.handlers.get("z2m/wz/contact/te-door")(payload);
    assert.equal(h.scene._s.terraceOpen, !contact);
    assert.equal(c.scene._state.terraceOpen, !contact);
  }
  h.ctx.handlers.get("z2m/wz/contact/te-door/#")("{}", "z2m/wz/contact/te-door/availability");
  assert.equal(h.scene._s.terraceOnline, null);
});

test("non-finite energy and power payloads cannot break the next home frame", async (t) => {
  timers(t);
  const { scene, ctx } = await homeScene(t);
  ctx.handlers.get("home/ke/sonnenbattery/status")(
    '{"USOC":1e999,"Production_W":1e999,"Consumption_W":1e999}',
  );
  ctx.handlers.get("z2m/wz/plug/zisp08")('{"power":1e999}');
  assert.equal(scene._s.battPct, null);
  assert.equal(scene._s.productionW, null);
  assert.equal(scene._s.consumptionW, null);
  assert.equal(scene._s.tvPower, null);
  assert.equal(await scene.render(driver(t)), 500);
});

test("UV and syncbox teardown abort requests and ignore late responses", async (t) => {
  timers(t);
  environment(t, "SYNCBOX_BEARER_TOKEN", "scene-test-placeholder");
  const pending = requests(t);
  const scene = Object.create(home);
  scene._cfg = scene._mapSettings({});
  scene._s = { syncSeen: null, uvApiSeen: null };
  scene._startSyncboxPoll(logger);
  scene._startUvPoll(logger);
  assert.equal(pending.length, 2);
  assert.match(pending[1].options.path, /timeformat=unixtime/);
  scene._stopSyncboxPoll();
  scene._stopUvPoll();
  assert.ok(pending.every((req) => req.destroyed));
  pending[0].respond({ hdmiSource: "input4", syncActive: true });
  pending[1].respond({ current: { uv_index: 9 } });
  assert.equal(scene._s.syncSeen, null);
  assert.equal(scene._s.uvApiSeen, null);
});

test("synchronous HTTP setup failures are caught by background polls", async (t) => {
  timers(t);
  environment(t, "SYNCBOX_BEARER_TOKEN", "scene-test-placeholder");
  t.mock.method(https, "request", () => { throw new Error("bad request options"); });
  const warnings = [];
  const scene = Object.create(home);
  scene._cfg = scene._mapSettings({});
  scene._s = {};
  const log = { ...logger, warn: (msg) => warnings.push(msg) };
  scene._startSyncboxPoll(log);
  scene._startUvPoll(log);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 2);
  scene._stopSyncboxPoll();
  scene._stopUvPoll();
});

test("UV errors and MQTT fallback do not refresh or reuse stale API samples", async (t) => {
  timers(t);
  const pending = requests(t);
  const { scene, ctx } = await homeScene(t);
  home._startUvPoll.call(scene, logger);
  pending[0].respond({});
  assert.equal(scene._s.uvApiSeen, null);
  scene._stopUvPoll();
  // A usable hourly value is retained as missing rather than fabricated as zero.
  home._startUvPoll.call(scene, logger);
  const now = new Date();
  const hour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime();
  pending[1].respond({
    current: { uv_index: 4 },
    hourly: { time: [hour / 1000, hour / 1000 + 3600], uv_index: [null, 8] },
  });
  assert.equal(scene._s.uvHourly24[0], null);
  const seen = scene._s.uvApiSeen;
  ctx.handlers.get("homeassistant/weather/forecast_home/uv_index")("6");
  assert.equal(scene._s.uvApiSeen, seen);
  scene._s.uvApiSeen = Date.now() - scene._cfg.uvStaleMs - 1;
  const device = driver(t);
  const drawText = t.mock.method(device, "drawTextRgbaAligned", async () => {});
  await scene.render(device);
  assert.ok(drawText.mock.calls.some(({ arguments: args }) =>
    args[0] === "6" && args[1][1] === 28));
  scene._stopUvPoll();
});

test("UV interpolation follows timestamped 23/25-hour days and keeps the 06..19 bars aligned", async (t) => {
  timers(t);
  environment(t, "TZ", "Europe/Vienna");
  const pending = requests(t);
  const { scene } = await homeScene(t);
  for (const [date, count] of [["2026-03-29", 23], ["2026-10-25", 25]]) {
    freezeTime(t, date + "T12:30:00");
    const midnight = new Date(date + "T00:00:00").getTime();
    const times = Array.from({ length: count }, (_, i) => midnight + i * 3600000);
    const values = times.map((ms) => new Date(ms).getHours() < 13 ? 4 : 6);
    home._startUvPoll.call(scene, logger);
    pending.at(-1).respond({
      current: { uv_index: 99 },
      hourly: { time: times.map((ms) => ms / 1000), uv_index: values },
    });
    const device = driver(t);
    const text = t.mock.method(device, "drawTextRgbaAligned", async () => {});
    await scene.render(device);
    assert.ok(text.mock.calls.some(({ arguments: args }) =>
      args[0] === "5" && args[1][1] === 28), date);
    const index = times.indexOf(new Date(date + "T06:00:00").getTime());
    assert.equal(scene._s.uvHourly24[index], 4);
    scene._stopUvPoll();
  }
});

test("UV interpolation rejects missing hours and yesterday's data and distinguishes repeated DST hours", async (t) => {
  timers(t);
  environment(t, "TZ", "Europe/Vienna");
  const { scene } = await homeScene(t);
  const cases = [
    ["2026-10-08T12:30:00+02:00", ["2026-10-08T12:00:00+02:00", "2026-10-08T13:00:00+02:00"], [4, 6], "5"],
    ["2026-10-08T12:00:00+02:00", ["2026-10-08T12:00:00+02:00", "2026-10-08T13:00:00+02:00"], [4, null], "4"],
    ["2026-10-08T12:30:00+02:00", ["2026-10-08T12:00:00+02:00", "2026-10-08T13:00:00+02:00"], [4, null], "7"],
    ["2026-10-08T12:30:00+02:00", ["2026-10-08T12:00:00+02:00", "2026-10-08T14:00:00+02:00"], [4, 6], "7"],
    ["2026-10-08T13:30:00+02:00", ["2026-10-08T12:00:00+02:00", "2026-10-08T14:00:00+02:00"], [4, 6], "7"],
    ["2026-10-08T23:30:00+02:00", ["2026-10-08T23:00:00+02:00"], [4], "4"],
    ["2026-10-09T00:30:00+02:00", ["2026-10-08T23:00:00+02:00"], [4], "7"],
    ["2026-10-25T02:30:00+02:00", ["2026-10-25T02:00:00+02:00", "2026-10-25T02:00:00+01:00", "2026-10-25T03:00:00+01:00"], [2, 4, 6], "3"],
    ["2026-10-25T02:30:00+01:00", ["2026-10-25T02:00:00+02:00", "2026-10-25T02:00:00+01:00", "2026-10-25T03:00:00+01:00"], [2, 4, 6], "5"],
  ];
  for (const [instant, times, values, expected] of cases) {
    freezeTime(t, instant);
    scene._s.uvHourlyTimes = times.map((time) => new Date(time).getTime());
    scene._s.uvHourly24 = values;
    scene._s.uvCurrentApi = 7;
    scene._s.uvApiSeen = Date.now();
    const device = driver(t);
    const text = t.mock.method(device, "drawTextRgbaAligned", async () => {});
    await scene.render(device);
    const value = text.mock.calls.filter(({ arguments: args }) => args[1][1] === 28);
    assert.equal(value[0].arguments[0], expected, instant);
  }
});

test("home fallback brightness supports a day window crossing midnight", async (t) => {
  timers(t);
  environment(t, "TZ", "Europe/Vienna");
  freezeTime(t, "2026-10-08T23:30:00+02:00");
  const { scene, ctx } = await homeScene(t);
  ctx.update({ fallback_day_start: "22:00", fallback_night_start: "07:30" });
  const device = driver(t);
  await scene.render(device);
  assert.equal(device.setBrightness.mock.calls[0].arguments[0], 100);
});

test("Sonnen destroy aborts fetch and a late JSON body cannot overwrite battery state", async (t) => {
  timers(t);
  environment(t, "SONNEN_BATTERY_HOST", "offline.invalid");
  environment(t, "SONNEN_BATTERY_API_TOKEN", "scene-test-placeholder");
  let signal;
  let finish;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise((resolve) => { finish = resolve; }) };
  });
  const scene = Object.create(clock);
  scene._state = { batteryPct: 40, batteryState: "standby" };
  scene._settings = scene._mapSettings({});
  scene._startSonnenPoll(logger);
  await new Promise((resolve) => setImmediate(resolve));
  await scene.destroy(context());
  assert.equal(signal.aborted, true);
  finish({ USOC: 90, BatteryCharging: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scene._state.batteryPct, 40);
  assert.equal(scene._state.batteryState, "standby");
});

test("clock day mode uses its displayed timezone and accepts overnight schedules", async (t) => {
  environment(t, "TZ", "UTC");
  freezeTime(t, "2026-10-08T05:30:00Z");
  const { scene } = await clockScene(t, { timezone: "Europe/Vienna" });
  const device = { setBrightness: async () => {}, drawCustom: async () => {} };
  await scene.render(device);
  assert.equal(scene._lastMode, "day"); // 07:30 Vienna, 05:30 on the server.
  scene._settings.dayStartHour = 22;
  scene._settings.nightStartHour = 8;
  await scene.render(device);
  assert.equal(scene._lastMode, "day");
  scene._settings.nightStartHour = 7;
  await scene.render(device);
  assert.equal(scene._lastMode, "night");
});

test("clock debug brightness remains in native 0..255 units", async (t) => {
  const { scene, ctx } = await clockScene(t);
  ctx.handlers.get("pixdcon/debug/bri_override")("200");
  let brightness;
  await scene.render({
    setBrightness: async (value) => { brightness = value; },
    drawCustom: async () => {},
  });
  assert.equal(brightness, 200);
});

test("funkeykid rejects odd word and volume payloads while preserving the last keypress", async (t) => {
  const scene = Object.create(kid);
  const ctx = context();
  await scene.init(ctx);
  const handle = ctx.handlers.get(kidTopic);
  await handle('{"letter":"A","word":"Affe","color":"#FFCC00"}');
  for (const payload of [
    '{"letter":"B","word":123}', "null", "[]",
    '{"bar":true,"bars_total":1e999}',
    '{"bar":true,"bars_total":-1}',
    '{"bar":true,"bars_total":1.5}',
    '{"bar":true,"bars_filled":"2"}',
  ]) await handle(payload);
  assert.equal(scene._currentLetter, "A");
  assert.equal(scene._currentWord, "Affe");
  assert.equal(scene._volumeBar, null);
  assert.equal(await scene.render(driver(t)), 200);
  await handle('{"bar":true,"bars_total":1,"bars_filled":1,"percent":100}');
  const device = driver(t);
  assert.equal(await scene.render(device), 60);
  assert.ok(device.buf.some((value) => value > 0));
  const at = (x, y) => Array.from(device.buf.slice((y * 64 + x) * 3, (y * 64 + x) * 3 + 3));
  assert.deepEqual(at(27, 10), [40, 220, 40]);
  await scene.destroy(ctx);
});

test("funkeykid image loads cannot overwrite newer messages or resurrect a destroyed scene", async () => {
  const scene = Object.create(kid);
  const other = Object.create(kid);
  const ctx = context();
  const otherCtx = context();
  await scene.init(ctx);
  await other.init(otherCtx);
  assert.notEqual(scene._bgImages, other._bgImages);
  const handle = ctx.handlers.get(kidTopic);
  const slow = handle('{"letter":"A","word":"Affe","image":"missing-race-test.png"}');
  await handle('{"letter":"B","word":"Biene","color":"#FFCC00"}');
  await slow;
  assert.equal(scene._currentLetter, "B");
  const pending = handle('{"letter":"C","word":"Clown","image":"missing-destroy-test.png"}');
  await scene.destroy(ctx);
  await pending;
  assert.equal(scene._currentLetter, null);
  assert.equal(scene._lastKeypressAt, 0);
  await other.destroy(otherCtx);
});

test("late Nuki results from a replaced poll cannot overwrite the new result", async (t) => {
  timers(t);
  const callbacks = [];
  t.mock.method(childProcess, "execFile", (_file, _args, _options, cb) => { callbacks.push(cb); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const scene = Object.create(home);
  scene._logger = logger;
  scene._cfg = scene._mapSettings({});
  scene._s = { nukiVrAlive: null, nukiKeAlive: null };
  scene._restartNukiPolls();
  scene._restartNukiPolls();
  callbacks[2](null);
  callbacks[3](null);
  callbacks[0](new Error("old ping failed"));
  callbacks[1](new Error("old ping failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scene._s.nukiVrAlive, true);
  assert.equal(scene._s.nukiKeAlive, true);
  await scene.destroy(context());
});

test("health rejects non-finite sensor readings and propagates device errors to the render loop", async (t) => {
  timers(t);
  t.mock.method(childProcess, "exec", (_cmd, _options, cb) => { cb(new Error("offline"), ""); });
  t.mock.method(childProcess, "execFile", (_file, _args, _options, cb) => { cb(new Error("offline"), ""); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const scene = Object.create(health);
  const ctx = context();
  await scene.init(ctx);
  ctx.handlers.get("shellies/bz/boiler/info")('{"wifi_sta":{"rssi":1e999}}');
  ctx.handlers.get("z2m/bz/powercontrol/boiler")('{"linkquality":"bad"}');
  ctx.handlers.get("jhw2211/health/boiler")('{"temp_c":"bad","nr_running":"bad"}');
  ctx.handlers.get("jhw2211/health/heat-chain")('{"checked_at":"bad"}');
  assert.equal(scene._state.wifi["bz-sh"].rssi, null);
  assert.equal(scene._state.zigbee["bz-boi"].lqi, null);
  assert.equal(scene._state.boiler.tempC, null);
  assert.equal(scene._state.boiler.nrRunning, null);
  assert.equal(scene._state.heatChain.checkedAt, null);
  const device = driver(t);
  t.mock.method(device, "push", async () => { throw new Error("display offline"); });
  await assert.rejects(scene.render(device), /display offline/);
  await scene.destroy(ctx);
});
