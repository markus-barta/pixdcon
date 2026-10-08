import assert from "node:assert/strict";
import test from "node:test";
import home from "../scenes/pixoo/home.js";
import clock from "../scenes/ulanzi/clock_with_homestats.js";
import kid from "../scenes/pixoo/funkeykid.js";
import { PixooDriver } from "../lib/pixoo-driver.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function context(values = {}, sceneLogger = logger) {
  const handlers = new Map();
  let settingsListener;
  return {
    logger: sceneLogger,
    handlers,
    settings: {
      all: () => values,
      subscribe: (cb) => { settingsListener = cb; return () => {}; },
    },
    update: (next) => settingsListener(next),
    mqtt: {
      subscribe: (topic, cb) => handlers.set(topic, cb),
      subscribeWildcard: (topic, cb) => handlers.set(topic, cb),
      unsubscribeAll: () => handlers.clear(),
    },
  };
}

test("equal and inverted elevation endpoints use a finite brightness step", async (t) => {
  const scene = Object.create(home);
  for (const method of ["_restartNukiPolls", "_startSyncboxPoll", "_startUvPoll"]) {
    t.mock.method(scene, method, () => {});
  }
  t.mock.method(globalThis, "setInterval", () => ({}));
  t.mock.method(globalThis, "clearInterval", () => {});
  t.mock.method(globalThis, "setTimeout", () => ({}));
  t.mock.method(globalThis, "clearTimeout", () => {});
  const ctx = context();
  await scene.init(ctx);
  t.after(() => scene.destroy(ctx));
  const device = new PixooDriver("offline", { logger });
  let brightness;
  t.mock.method(device, "setBrightness", async (value) => { brightness = value; });
  t.mock.method(device, "push", async () => {});
  scene._bri = { day: 80, night: 5, override: null };
  for (const [low, high] of [[10, 10], [20, 10]]) {
    Object.assign(scene._cfg, { sunElevLo: low, sunElevHi: high });
    for (const [elevation, expected] of [[9, 5], [10, 80], [11, 80]]) {
      scene._s.sunElevation = elevation;
      scene._lastBriVal = null;
      await scene.render(device);
      assert.equal(brightness, expected, `${low}/${high} at ${elevation}`);
      assert.ok(Number.isFinite(brightness));
    }
  }
});

test("invalid clock locale/timezone settings fall back and warn once per value", async (t) => {
  const warnings = [];
  const scene = Object.create(clock);
  t.mock.method(scene, "_startSonnenPoll", () => {});
  const ctx = context({ timezone: "Mars/Invalid", locale: "de_AT" }, {
    ...logger, warn: (message) => warnings.push(message),
  });
  await scene.init(ctx);
  t.after(() => scene.destroy(ctx));
  const device = { setBrightness: async () => {}, drawCustom: async () => {} };
  assert.equal(scene._settings.timezone, clock.settingsSchema.timezone.default);
  assert.equal(scene._settings.locale, clock.settingsSchema.locale.default);
  assert.equal(await scene.render(device), 1000);
  assert.equal(await scene.render(device), 1000);
  ctx.update({ timezone: "Mars/Invalid", locale: "de_AT" });
  assert.equal(warnings.length, 2);
  ctx.update({ timezone: "Moon/Invalid", locale: "en_US" });
  assert.equal(warnings.length, 4);
  assert.equal(await scene.render(device), 1000);
  ctx.update({ timezone: "UTC", locale: "en-US" });
  assert.equal(scene._settings.timezone, "UTC");
  assert.equal(scene._settings.locale, "en-US");
  assert.equal(await scene.render(device), 1000);
  ctx.update({ timezone: "Mars/Invalid", locale: "de_AT" });
  assert.equal(warnings.length, 4);
});

test("empty, unsupported and non-string clock locale values use schema defaults", () => {
  const scene = Object.create(clock);
  for (const value of ["", " ", "xx-YY", 123, false]) {
    const settings = scene._mapSettings({ locale: value }, logger);
    assert.equal(settings.locale, clock.settingsSchema.locale.default);
  }
  for (const value of ["", " ", 123, false]) {
    const settings = scene._mapSettings({ timezone: value }, logger);
    assert.equal(settings.timezone, clock.settingsSchema.timezone.default);
  }
});

test("clock fallback produces the same commands as the schema defaults", async (t) => {
  const RealDate = Date;
  t.mock.method(globalThis, "Date", class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ["2026-10-08T12:30:00Z"])); }
    static now() { return new RealDate("2026-10-08T12:30:00Z").getTime(); }
  });
  const frames = [];
  const brightness = [];
  for (const values of [{}, { timezone: "Invalid/Zone", locale: "invalid_locale" }]) {
    const scene = Object.create(clock);
    t.mock.method(scene, "_startSonnenPoll", () => {});
    const ctx = context(values);
    await scene.init(ctx);
    t.after(() => scene.destroy(ctx));
    await scene.render({
      drawCustom: async (frame) => frames.push(frame),
      setBrightness: async (value) => brightness.push(value),
    });
  }
  assert.deepEqual(frames[0], frames[1]);
  assert.equal(brightness[0], brightness[1]);
});

test("invalid volume totals fall back to ten without dropping the overlay or keypress", async (t) => {
  const scene = Object.create(kid);
  const ctx = context();
  await scene.init(ctx);
  t.after(() => scene.destroy(ctx));
  const handle = ctx.handlers.get("home/hsb1/funkeykid/display");
  await handle('{"letter":"A","word":"Affe","color":"#FFCC00"}');
  const device = new PixooDriver("offline", { logger });
  t.mock.method(device, "push", async () => {});
  t.mock.method(device, "setBrightness", async () => {});
  for (const total of [0, -1, 1.5, 65, "10", null, undefined]) {
    await handle(JSON.stringify({ bar: true, bars_total: total, bars_filled: 6, percent: 60 }));
    assert.equal(scene._volumeBar.bars_total, 10);
    assert.equal(scene._volumeBar.bars_filled, 6);
    assert.equal(scene._currentLetter, "A");
    assert.equal(scene._currentWord, "Affe");
    assert.equal(await scene.render(device), 60);
  }
  await handle('{"bar":true,"bars_total":1e999,"bars_filled":20,"percent":100}');
  assert.equal(scene._volumeBar.bars_total, 10);
  assert.equal(scene._volumeBar.bars_filled, 10);
  await handle('{"bar":true,"bars_total":0}');
  assert.equal(scene._volumeBar.bars_total, 10);
  assert.equal(scene._volumeBar.bars_filled, 0);
});

test("valid volume totals retain their geometry and invalid filled values preserve the last overlay", async (t) => {
  const scene = Object.create(kid);
  const ctx = context();
  await scene.init(ctx);
  t.after(() => scene.destroy(ctx));
  const handle = ctx.handlers.get("home/hsb1/funkeykid/display");
  for (const total of [1, 10, 64]) {
    await handle(JSON.stringify({ bar: true, bars_total: total, bars_filled: total }));
    assert.equal(scene._volumeBar.bars_total, total);
    assert.equal(scene._volumeBar.bars_filled, total);
  }
  const previous = scene._volumeBar;
  await handle('{"bar":true,"bars_total":0,"bars_filled":"2"}');
  assert.equal(scene._volumeBar, previous);
});
