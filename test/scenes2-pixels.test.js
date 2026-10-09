import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import home from "../scenes/pixoo/home.js";
import home2 from "../scenes/pixoo/home2.js";
import { PixooDriver } from "../lib/pixoo-driver.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const black = [0, 0, 0];
const gray = [60, 60, 60];
const roof = [200, 200, 160];
const pool = [0, 190, 220];

function clock(t, instant = "2026-10-08T00:30:00+02:00") {
  const previous = process.env.TZ;
  process.env.TZ = "Europe/Vienna";
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  const RealDate = Date;
  let ms = new RealDate(instant).getTime();
  t.mock.method(globalThis, "Date", class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [ms])); }
    static now() { return ms; }
  });
  t.mock.method(Date, "now", () => ms);
  t.mock.method(globalThis, "setInterval", () => ({}));
  t.mock.method(globalThis, "clearInterval", () => {});
  t.mock.method(globalThis, "setTimeout", () => ({}));
  t.mock.method(globalThis, "clearTimeout", () => {});
  return (next) => { ms = new RealDate(next).getTime(); };
}

async function setup(t, template = home2) {
  const handlers = new Map();
  const ctx = {
    logger,
    settings: { all: () => ({}), subscribe: () => () => {} },
    mqtt: {
      subscribe: (topic, cb) => handlers.set(topic, cb),
      subscribeWildcard: (topic, cb) => handlers.set(topic, cb),
      unsubscribeAll: () => handlers.clear(),
    },
  };
  const scene = Object.create(template);
  for (const method of ["_restartNukiPolls", "_startSyncboxPoll", "_startUvPoll"]) {
    if (scene[method]) t.mock.method(scene, method, () => {});
  }
  let dir;
  if (template === home2) {
    dir = await fs.mkdtemp(join(tmpdir(), "pixdcon-boiler-pixels-"));
    scene._boilerStatePath = join(dir, ".state", "home2-boiler.json");
  }
  t.after(async () => {
    await scene.destroy(ctx);
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });
  await scene.init(ctx);
  const device = new PixooDriver("offline", { logger });
  device.setBrightness = async () => {};
  device.push = async () => {};
  const publish = (temp) => handlers.get("jhw2211/health/boiler")(JSON.stringify({ state: "ok", temp_c: temp }));
  const relay = (power, extra = {}) => handlers.get("z2m/bz/powercontrol/boiler")?.(
    JSON.stringify(power === undefined ? { state: "ON", ...extra } : { state: power > 0 ? "ON" : "OFF", power, ...extra }));
  return { scene, device, publish, relay, handlers };
}

function at(device, x, y) {
  const offset = (y * 64 + x) * 3;
  return Array.from(device.buf.slice(offset, offset + 3));
}

function sampleHome(scene) {
  Object.assign(scene._s, {
    kbConnected: true, sunElevation: 8,
    nukiVrState: "locked", nukiKeState: "unlocked",
    terraceOpen: true, terraceOnline: true,
    w13Open: false, w13Online: true, w14Open: true, w14Online: true,
    roofTempC: 17.7, poolTempC: 25.1,
    roofTempSeen: Date.now(), poolTempSeen: Date.now(),
    battPct: 55, battState: "discharging", battSeen: Date.now(),
    productionW: 3890, consumptionW: 975, energySeen: Date.now(),
    ps5Power: 80, ps5Seen: Date.now(), tvPower: 90, tvSeen: Date.now(),
    pcPower: 40, pcSeen: Date.now(), syncEnabled: true,
    syncInput: "input2", syncActive: true, syncSeen: Date.now(),
  });
}

test("home temperatures remove identity dots and place a single degree after the tight value", async (t) => {
  clock(t);
  const { scene, device } = await setup(t, home);
  for (const [value, dotX, degreeX] of [[7.7, 49, 55], [17.7, 53, 59], [-7.7, 53, 59], [-12.4, 57, 63]]) {
    Object.assign(scene._s, {
      roofTempC: value, poolTempC: value,
      roofTempSeen: Date.now(), poolTempSeen: Date.now(),
    });
    await scene.render(device);
    for (const [y, color] of [[9, roof], [18, pool]]) {
      assert.deepEqual(at(device, dotX, y + 4), color, `decimal for ${value}`);
      assert.deepEqual(at(device, degreeX, y), color, `degree for ${value}`);
      assert.deepEqual(at(device, degreeX - 1, y), black, `degree gap for ${value}`);
      assert.deepEqual(at(device, degreeX, y + 1), black, `degree is one pixel for ${value}`);
      assert.deepEqual(at(device, degreeX, y + 2), black);
      assert.deepEqual(at(device, 44, y + 2), black, "left margin");
      assert.deepEqual(at(device, 43, y + 2), [25, 25, 25], "separator untouched");
    }
    if (value === 7.7) {
      assert.deepEqual(at(device, 45, 9), roof, "digit starts at x45");
      assert.deepEqual(at(device, 45, 11), black, "old identity dot gone");
      assert.deepEqual(at(device, 45, 20), black, "pool identity dot gone");
    }
  }
});

test("wide temperatures lose the decimal while keeping their degree within the cell", async (t) => {
  clock(t);
  const { scene, device } = await setup(t, home);
  const text = t.mock.method(device, "drawTextRgbaAligned");
  for (const value of [-123.4, 1234.5]) {
    Object.assign(scene._s, { roofTempC: value, roofTempSeen: Date.now() });
    text.mock.resetCalls();
    await scene.render(device);
    const calls = text.mock.calls.filter(({ arguments: args }) => args[1][0] === 45 && args[1][1] === 9);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments[0], value === -123.4 ? "-123" : "1234");
    assert.deepEqual(calls[0].arguments[1], [45, 9]);
    assert.deepEqual(at(device, 61, 9), roof);
    assert.deepEqual(at(device, 60, 9), black);
    assert.deepEqual(at(device, 61, 13), black, "no decimal dot");
    assert.deepEqual(at(device, 63, 9), black);
  }
});

test("null and stale top-right temperatures draw dim -- without a degree", async (t) => {
  clock(t);
  const { scene, device } = await setup(t, home);
  for (const stale of [false, true]) {
    Object.assign(scene._s, {
      roofTempC: stale ? 17.7 : null, poolTempC: stale ? 25.1 : null,
      roofTempSeen: stale ? Date.now() - scene._cfg.tempStaleMs - 1 : Date.now(),
      poolTempSeen: stale ? Date.now() - scene._cfg.tempStaleMs - 1 : Date.now(),
    });
    await scene.render(device);
    for (const y of [9, 18]) {
      for (let x = 44; x <= 63; x++) assert.deepEqual(at(device, x, y), black);
      for (const x of [45, 46, 47, 49, 50, 51]) assert.deepEqual(at(device, x, y + 2), [80, 80, 80]);
      assert.deepEqual(at(device, 48, y + 2), black);
    }
  }
});

test("home2 puts pool beside TE and Dachterrasse beside OL, right-aligned on the boiler's degree column", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish } = await setup(t);
  publish(56);
  // [value, first integer column]: the integer ends at x54, dot x56, fraction x58..60, gap x61, ° x62.
  for (const [value, intX] of [[7.7, 52], [17.6, 48], [-7.7, 48]]) {
    Object.assign(scene._s, {
      poolTempC: value, roofTempC: value,
      poolTempSeen: Date.now(), roofTempSeen: Date.now(),
    });
    await scene.render(device);
    for (const [y, color] of [[9, pool], [18, roof]]) {
      assert.deepEqual(at(device, 62, y), color, `degree for ${value}`);
      assert.deepEqual(at(device, 61, y), black, `degree gap for ${value}`);
      assert.deepEqual(at(device, 62, y + 1), black, `single-pixel degree for ${value}`);
      assert.deepEqual(at(device, 56, y + 4), color, `decimal dot for ${value}`);
      assert.deepEqual(at(device, 55, y + 4), black, `gap before the dot for ${value}`);
      assert.deepEqual(at(device, 57, y + 4), black, `gap after the dot for ${value}`);
      for (let x = 44; x < intX; x++) {
        for (let row = y; row < y + 5; row++) assert.deepEqual(at(device, x, row), black, `left of ${value} at x${x}`);
      }
      assert.deepEqual(at(device, 43, y + 2), [25, 25, 25], "separator untouched");
    }
  }
  // The boiler's degree shares the column.
  assert.deepEqual(at(device, 62, 28), [255, 110, 8]);
});

test("home2 pool and Dachterrasse readings follow their own sources and colours", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, handlers } = await setup(t);
  const text = t.mock.method(device, "drawTextRgbaAligned");
  // Through the real subscriptions, so swapped topic handlers would fail here.
  handlers.get("z2m/te/temp/pool")(JSON.stringify({ temperature: 16.1 }));
  handlers.get("z2m/dt/motion/hueoutdoor")(JSON.stringify({ temperature: 17.6 }));
  await scene.render(device);
  // x ≥ 44: the temperature cell only, not the TE / OL labels on the same rows.
  const row = (row) => text.mock.calls
    .filter(({ arguments: [, [x, y]] }) => y === row && x >= 44)
    .map(({ arguments: [str, , color] }) => [str, color]);
  const at9 = row(9);
  const at18 = row(18);
  assert.deepEqual(at9, [["16", pool], ["1", pool]]);
  assert.deepEqual(at18, [["17", roof], ["6", roof]]);
});

test("home2 wide temperatures drop the decimal and keep the degree on x62; -- is right-aligned", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device } = await setup(t);
  const text = t.mock.method(device, "drawTextRgbaAligned");
  for (const value of [-12.4, -123.4]) {
    Object.assign(scene._s, { poolTempC: value, poolTempSeen: Date.now() });
    text.mock.resetCalls();
    await scene.render(device);
    const calls = text.mock.calls.filter(({ arguments: [, [x, y]] }) => y === 9 && x >= 44);
    assert.equal(calls.length, 1, String(value));
    const [str, [x]] = calls[0].arguments;
    assert.equal(str, value === -12.4 ? "-12" : "-123");
    assert.equal(x + str.length * 4 - 1, 61, "integer ends at x60");
    assert.deepEqual(at(device, 62, 9), pool);
    assert.deepEqual(at(device, 61, 9), black);
    assert.ok(x >= 45, "keeps the left margin");
  }
  // Five glyphs cannot fit even without the decimal: dim -- rather than spilling past x43.
  for (const value of [-1234.5, 12345.6]) {
    Object.assign(scene._s, { poolTempC: value, poolTempSeen: Date.now() });
    await scene.render(device);
    for (let y = 9; y <= 13; y++) {
      assert.deepEqual(at(device, 43, y), [25, 25, 25], `${value}: separator untouched at y${y}`);
      assert.deepEqual(at(device, 44, y), black, `${value}: left margin at y${y}`);
    }
    for (const x of [56, 57, 58, 60, 61, 62]) assert.deepEqual(at(device, x, 11), [80, 80, 80], `${value} -- at x${x}`);
    assert.deepEqual(at(device, 62, 9), black, `${value}: no degree`);
  }
  // Null pool, and a populated but stale Dachterrasse reading: both dim --.
  Object.assign(scene._s, {
    poolTempC: null, poolTempSeen: Date.now(),
    roofTempC: 17.6, roofTempSeen: Date.now() - scene._cfg.tempStaleMs - 1,
  });
  await scene.render(device);
  for (const y of [9, 18]) {
    for (const x of [56, 57, 58, 60, 61, 62]) assert.deepEqual(at(device, x, y + 2), [80, 80, 80], `-- at x${x}`);
    assert.deepEqual(at(device, 59, y + 2), black);
    assert.deepEqual(at(device, 62, y), black, "no degree without a value");
  }
});

test("boiler heating turns the triangle red and climbs a bright pixel up the current bar at 1 px/s", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00"); // bucket 9 → x55
  const { scene, device, publish, relay } = await setup(t);
  publish(55); // 7 rows: y35..41, colour [255, 120, 12]
  relay(2150);
  const bar = [255, 120, 12];
  const bright = [255, 188, 134];
  const red = [230, 30, 20];
  const climbs = [];
  for (let frame = 1; frame <= 16; frame++) {
    await scene.render(device);
    assert.equal(scene._frame, frame);
    const lit = [];
    for (let y = 35; y <= 41; y++) {
      const pixel = at(device, 55, y);
      if (pixel.join() === bright.join()) lit.push(y);
      else assert.deepEqual(pixel, bar, `frame ${frame}, y${y}`);
    }
    assert.equal(lit.length, 1, `one climbing pixel on frame ${frame}`);
    climbs.push(lit[0]);
    assert.deepEqual(at(device, 55, 43), red);
    for (const x of [54, 55, 56]) assert.deepEqual(at(device, x, 44), red);
  }
  // Two 500 ms frames per row, bottom to top, then wrap to the bottom.
  assert.deepEqual(climbs, [41, 40, 40, 39, 39, 38, 38, 37, 37, 36, 36, 35, 35, 41, 41, 40]);
});

test("boiler not heating: below threshold, stale relay, missing power or a raised threshold keep the grey triangle", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish, relay } = await setup(t);
  publish(55);
  const grey = [200, 200, 205];
  const check = async (label) => {
    for (let i = 0; i < 4; i++) {
      await scene.render(device);
      for (let y = 35; y <= 41; y++) assert.deepEqual(at(device, 55, y), [255, 120, 12], `${label}: y${y}`);
      assert.deepEqual(at(device, 55, 43), grey, label);
      for (const x of [54, 55, 56]) assert.deepEqual(at(device, x, 44), grey, label);
    }
  };
  await check("no relay message yet");
  relay(0);
  await check("relay off");
  relay(99);
  await check("below 100 W");
  relay(2150);
  scene._s.boilerPowerSeen = Date.now() - scene._cfg.staleMs - 1;
  await check("stale relay reading");
  relay(undefined);
  await check("payload without power");
  relay(2150, { last_seen: new Date(Date.now() - scene._cfg.staleMs - 1000).toISOString() });
  await check("retained payload whose last_seen is older than staleMs");
  relay(2150, { last_seen: Date.now() - 3600000 });
  await check("retained payload with an hour-old epoch last_seen");
  relay(2150, { last_seen: Date.now() - 1000 });
  assert.equal(scene._boilerHeating(), true, "a recent epoch last_seen counts as fresh");
  relay(2150, { last_seen: Date.now() + 3600000 });
  assert.equal(scene._s.boilerPowerSeen, Date.now(), "a future last_seen is clamped to now");
  relay(2150, { last_seen: new Date(Date.now() - 1000).toISOString() });
  assert.equal(scene._boilerHeating(), true, "a recent ISO last_seen counts as fresh");
  relay(2150);
  scene._cfg = scene._mapSettings({ boiler_heating_w: 3000 });
  await check("threshold raised to 3000 W");
  relay(100);
  scene._cfg = scene._mapSettings({});
  assert.equal(scene._boilerHeating(), true, "100 W meets the default threshold");
});

test("under the digits, a full-height heating bar keeps its climbing pixel visible below y32", async (t) => {
  clock(t, "2026-10-08T16:00:00+02:00"); // bucket 12 → x58, under "70" (x54..60)
  const { scene, device, publish, relay } = await setup(t);
  publish(70);
  relay(2150);
  const bright = [243, 138, 128];
  const climbs = [];
  for (let frame = 1; frame <= 20; frame++) {
    await scene.render(device);
    const lit = [];
    for (let y = 33; y <= 41; y++) if (at(device, 58, y).join() === bright.join()) lit.push(y);
    assert.equal(lit.length, 1, `one visible climbing pixel on frame ${frame}`);
    climbs.push(lit[0]);
    assert.deepEqual(at(device, 58, 32), [230, 20, 0], "the digit row keeps the text colour");
  }
  assert.equal(Math.min(...climbs), 33);
  assert.equal(Math.max(...climbs), 41);
});

test("a heating boiler with a bar under two rows keeps the red triangle but has nothing to climb", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish, relay } = await setup(t);
  relay(2150);
  for (const [temp, rows] of [[25, 1], [21, 0]]) {
    publish(temp);
    for (let i = 0; i < 3; i++) {
      await scene.render(device);
      assert.deepEqual(at(device, 55, 43), [230, 30, 20]);
      if (rows === 1) assert.deepEqual(at(device, 55, 41), [63, 171, 249], `${temp} keeps its bar colour`);
      // y32 is the digits' bottom row; below it, only the current-column background.
      for (let y = 33; y < 42 - rows; y++) assert.deepEqual(at(device, 55, y), gray, `${temp} y${y}`);
    }
  }
});

test("boiler scale clamps 19/20 to empty and 70/71 to ten rows; 45 is five rows", async (t) => {
  clock(t);
  const { scene, device, publish } = await setup(t);
  for (const [value, height, color] of [
    [19, 0, [80, 150, 255]], [20, 0, [80, 150, 255]],
    [45, 5, [234, 194, 106]], [70, 10, [230, 20, 0]], [71, 10, [230, 20, 0]],
  ]) {
    publish(value);
    await scene.render(device);
    for (let y = 32; y < 42; y++) {
      assert.deepEqual(at(device, 46, y), y >= 42 - height ? color : gray, `${value} at y${y}`);
    }
    assert.deepEqual(at(device, 62, 28), color, "degree at the top row");
    assert.deepEqual(at(device, 61, 28), black, "one-pixel degree gap");
    assert.deepEqual(at(device, 62, 29), black, "single-pixel degree");
  }
});

test("the current temperature stays readable above full-height past bars", async (t) => {
  clock(t, "2026-10-08T23:30:00+02:00"); // bucket 17: x54..60 under the digits are all PAST buckets
  const { scene, device, publish } = await setup(t);
  for (let i = 0; i <= 17; i++) scene._boilerHistory.buckets[i] = { sum: 70, count: 1 };
  publish(70);
  await scene.render(device);
  // "70" ends at x60; the "0" glyph's bottom row (y32) spans x58..60. Drawn last, it keeps the text colour
  // instead of the dimmed full-height bar colour [150, 13, 0] underneath.
  for (const x of [58, 59, 60]) assert.deepEqual(at(device, x, 32), [230, 20, 0], `x${x}`);
});

test("boiler colour runs blue → cyan → pale neutral → amber → orange → red, never through green", async (t) => {
  clock(t);
  const { scene, device, publish } = await setup(t);
  for (const [value, color] of [
    [27.5, [55, 181, 246]], [35, [100, 200, 231]], [40, [200, 200, 215]],
    [45, [234, 194, 106]], [50, [255, 170, 32]], [55, [255, 120, 12]],
  ]) {
    publish(value);
    await scene.render(device);
    assert.deepEqual(at(device, 62, 28), color, String(value));
  }
});

test("past bars use their average at dim65; current uses live temperature; future has only baseline", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish } = await setup(t);
  scene._boilerHistory.buckets[0] = { sum: 90, count: 2 }; // average 45
  scene._boilerHistory.buckets[1] = { sum: 140, count: 2 }; // average 70
  scene._boilerHistory.buckets[9] = { sum: 45, count: 1 }; // current bucket
  scene._boilerHistory.buckets[10] = { sum: 70, count: 1 }; // future must not render
  publish(70);
  await scene.render(device);
  for (let y = 37; y <= 41; y++) assert.deepEqual(at(device, 46, y), [152, 126, 69]);
  assert.deepEqual(at(device, 46, 36), black);
  for (let y = 32; y <= 41; y++) assert.deepEqual(at(device, 47, y), [150, 13, 0]);
  for (let y = 33; y <= 41; y++) assert.deepEqual(at(device, 55, y), [230, 20, 0]);
  for (let x = 56; x <= 63; x++) {
    for (let y = 33; y <= 41; y++) assert.deepEqual(at(device, x, y), black, `future x${x}, y${y}`);
    assert.deepEqual(at(device, x, 42), gray);
  }
});

test("stale current shows -- and blinking error while the current bucket retains its average", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish } = await setup(t);
  publish(70);
  scene._s.boilerTempSeen = Date.now() - scene._cfg.boilerStaleMs - 1;
  scene._boilerHistory.buckets[9] = { sum: 90, count: 2 };
  await scene.render(device); // Odd frame: error X.
  for (const [x, y] of [[60, 28], [62, 28], [61, 29], [60, 30], [62, 30]]) {
    assert.deepEqual(at(device, x, y), [200, 0, 0]);
  }
  for (let y = 37; y <= 41; y++) assert.deepEqual(at(device, 55, y), [234, 194, 106]);
  await scene.render(device); // Even frame: no error X, no degree pixel.
  for (const x of [56, 57, 58, 60, 61, 62]) assert.deepEqual(at(device, x, 30), [80, 80, 80]);
  assert.deepEqual(at(device, 62, 28), black);
  scene._boilerHistory.buckets[9] = { sum: 0, count: 0 };
  await scene.render(device);
  for (let y = 33; y <= 41; y++) assert.deepEqual(at(device, 55, y), gray);
});

test("boiler y ticks and 06/12/18 x ticks follow the UV chart style", async (t) => {
  clock(t, "2026-10-08T01:50:00+02:00");
  const { scene, device, publish } = await setup(t);
  publish(20);
  await scene.render(device);
  for (const y of [32, 37, 42]) assert.deepEqual(at(device, 45, y), gray);
  for (const x of [50, 55, 59]) assert.deepEqual(at(device, x, 43), gray);
  for (const y of [33, 34, 35, 36, 38, 39, 40, 41]) assert.deepEqual(at(device, 45, y), black);
  for (let x = 45; x <= 63; x++) assert.deepEqual(at(device, x, 42), gray);
  assert.deepEqual(at(device, 47, 43), [200, 200, 205]);
});

test("the final bucket's current marker and full-height bar stay within x44..63", async (t) => {
  clock(t, "2026-10-08T23:59:00+02:00");
  const { scene, device, publish } = await setup(t);
  const pixel = t.mock.method(device, "_setPixel");
  publish(70);
  await scene.render(device);
  assert.ok(pixel.mock.calls.every(({ arguments: [x, y] }) => x >= 0 && x <= 63 && y >= 0 && y <= 63));
  for (let y = 32; y <= 41; y++) assert.deepEqual(at(device, 63, y), [230, 20, 0]);
  assert.deepEqual(at(device, 62, 44), [200, 200, 205]);
  assert.deepEqual(at(device, 63, 44), [200, 200, 205]);
  assert.deepEqual(at(device, 43, 44), [25, 25, 25]);
});

test("home2 matches home at every pixel outside the boiler and temperature cells across normal/stale states", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const first = await setup(t, home);
  const second = await setup(t);
  sampleHome(first.scene);
  sampleHome(second.scene);
  second.publish(55);
  for (const state of [
    {},
    { nukiVrState: "unlocking", terraceOpen: false, terraceOnline: false, w13Open: null, pcSeen: null, tvSeen: null, syncSeen: null },
    { roofTempSeen: null, poolTempSeen: null, battSeen: null, energySeen: null, battPct: null, productionW: null, consumptionW: null },
  ]) {
    Object.assign(first.scene._s, state);
    Object.assign(second.scene._s, state);
    assert.equal(await first.scene.render(first.device), 500);
    assert.equal(await second.scene.render(second.device), 500);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (x >= 44 && y >= 27 && y <= 44) continue; // boiler cell
        if (x >= 44 && y >= 8 && y <= 25) continue; // home2 swaps and right-aligns the temperatures
        assert.deepEqual(at(first.device, x, y), at(second.device, x, y), `x${x}, y${y}`);
      }
    }
  }
});

test("write coordinator previews for home and home2 with a cold/heated/cooling boiler day", { skip: !process.env.PIXDCON_PREVIEWS && "set PIXDCON_PREVIEWS=1 to write .previews/*.png" }, async (t) => {
  clock(t, "2026-10-08T18:30:00+02:00");
  const first = await setup(t, home);
  const second = await setup(t);
  sampleHome(first.scene);
  sampleHome(second.scene);
  const uvCurve = [0,0,0,0,0,0,0.4,1.2,2.4,3.1,4.8,5.6,6.2,5.8,4.9,3.7,2.1,1.4,0.7,0.1,0,0,0,0];
  Object.assign(first.scene._s, {
    uvCurrentApi: 0.7, uvHourly24: uvCurve, uvApiSeen: Date.now(),
    uvHourlyTimes: Array.from({ length: 24 }, (_, h) => new Date(2026, 9, 8, h).getTime()),
  });
  const temperatures = [25, 25, 24, 26, 65, 70, 65, 60, 55, 50, 47, 44, 42, 40];
  for (const [index, value] of temperatures.entries()) {
    second.scene._boilerHistory.buckets[index] = { sum: value * 80, count: 80 };
  }
  second.publish(40);
  second.relay(2150);
  const previews = resolve(".previews");
  await fs.mkdir(previews, { recursive: true });
  for (const { scene, device } of [first, second]) {
    await scene.render(device);
    const options = { raw: { width: 64, height: 64, channels: 3 } };
    await sharp(device.buf, options).png().toFile(join(previews, `${scene.name}.png`));
    await sharp(device.buf, options).resize(512, 512, { kernel: "nearest" }).png().toFile(join(previews, `${scene.name}-8x.png`));
  }
});
