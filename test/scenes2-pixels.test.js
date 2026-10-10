import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import home from "../scenes/pixoo/home.js";
import home2, { hysteresisLevel, BOILER_COLOR_STOPS, boilerTempColor as heat, boilerRowColor, heatDotRed, deltaE, mix } from "../scenes/pixoo/home2.js";
import { PixooDriver } from "../lib/pixoo-driver.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const black = [0, 0, 0];
const gray = [60, 60, 60];
// Boiler colours come from the scene's scale (pinned by its own test below).
const dim = (c) => c.map((v) => Math.round(v * 0.65));
const RED = [255, 40, 25];
const PALE_RED = [255, 150, 130];
// The heating dot is red mixed into what is behind it: 70 % at full strength.
const dot = (bg, a = 1) => mix(bg, heatDotRed(bg), 0.7 * a);
// Thermometer bars (PIXD-64): every chart row y has its level's colour, row 0 = y41 = 25 °C.
const lvl = (y) => boilerRowColor(41 - y);
const roof = [200, 200, 160];
const pool = [0, 190, 220];
// home2 (PIXD-62): TE / OL labels and both terrace temperatures share the clock's warm white.
const rowText = [200, 200, 160];

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
    for (const [y, color] of [[10, rowText], [19, rowText]]) {
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
  assert.deepEqual(at(device, 62, 28), heat(56));
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
  assert.deepEqual(row(10), [["17", rowText], ["6", rowText]], "Dachterrasse level with OL, on top (y10)");
  assert.deepEqual(row(19), [["16", rowText], ["1", rowText]], "pool level with TE, below (y19)");
});

test("home2 wide temperatures drop the decimal and keep the degree on x62; -- is right-aligned", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device } = await setup(t);
  const text = t.mock.method(device, "drawTextRgbaAligned");
  for (const value of [-12.4, -123.4]) {
    Object.assign(scene._s, { poolTempC: value, poolTempSeen: Date.now() });
    text.mock.resetCalls();
    await scene.render(device);
    const calls = text.mock.calls.filter(({ arguments: [, [x, y]] }) => y === 19 && x >= 44);
    assert.equal(calls.length, 1, String(value));
    const [str, [x]] = calls[0].arguments;
    assert.equal(str, value === -12.4 ? "-12" : "-123");
    assert.equal(x + str.length * 4 - 1, 61, "integer ends at x60");
    assert.deepEqual(at(device, 62, 19), rowText);
    assert.deepEqual(at(device, 61, 19), black);
    assert.ok(x >= 45, "keeps the left margin");
  }
  // Five glyphs cannot fit even without the decimal: dim -- rather than spilling past x43.
  for (const value of [-1234.5, 12345.6]) {
    Object.assign(scene._s, { poolTempC: value, poolTempSeen: Date.now() });
    await scene.render(device);
    for (let y = 19; y <= 23; y++) {
      assert.deepEqual(at(device, 43, y), [25, 25, 25], `${value}: separator untouched at y${y}`);
      assert.deepEqual(at(device, 44, y), black, `${value}: left margin at y${y}`);
    }
    for (const x of [56, 57, 58, 60, 61, 62]) assert.deepEqual(at(device, x, 21), [80, 80, 80], `${value} -- at x${x}`);
    assert.deepEqual(at(device, 62, 19), black, `${value}: no degree`);
  }
  // Null pool, and a populated but stale Dachterrasse reading: both dim --.
  Object.assign(scene._s, {
    poolTempC: null, poolTempSeen: Date.now(),
    roofTempC: 17.6, roofTempSeen: Date.now() - scene._cfg.tempStaleMs - 1,
  });
  await scene.render(device);
  for (const y of [10, 19]) {
    for (const x of [56, 57, 58, 60, 61, 62]) assert.deepEqual(at(device, x, y + 2), [80, 80, 80], `-- at x${x}`);
    assert.deepEqual(at(device, 59, y + 2), black);
    assert.deepEqual(at(device, 62, y), black, "no degree without a value");
  }
});

test("heating: red triangle and a red dot mixed into each row, rising 1 row/s with a sub-pixel glide to one row above the bar", async (t) => {
  const setTime = clock(t, "2026-10-08T12:30:00+02:00"); // bucket 8 → x54
  const { scene, device, publish, relay } = await setup(t);
  publish(40); // 4 rows: y38..41 (25/30/35/40 °C colours); the dot ends at y37, one row above
  relay(2150);
  // Pinned RGB, independent of the helpers: 70 % heating red over the white-blue bottom row, and over black.
  assert.deepEqual(dot(lvl(41)), [236, 93, 94]);
  assert.deepEqual(dot(black), [179, 28, 18]);
  const start = Date.parse("2026-10-08T12:30:00+02:00");
  const frame = async (seconds) => {
    setTime(start + seconds * 1000);
    await scene.render(device);
    const column = {};
    for (let y = 36; y <= 41; y++) column[y] = at(device, 54, y);
    assert.deepEqual(at(device, 54, 43), [230, 30, 20], `red triangle at ${seconds}s`);
    return column;
  };
  // t=0: the dot sits on the bottom row at full strength; the other rows keep their gradient.
  let c = await frame(0);
  assert.deepEqual(c[41], dot(lvl(41)));
  for (const y of [38, 39, 40]) assert.deepEqual(c[y], lvl(y));
  assert.deepEqual(c[37], black);
  // Pinned fractional mixes, independent of the helpers.
  assert.deepEqual(dot(lvl(40), 0.5), [180, 126, 175]);
  assert.deepEqual(dot(lvl(38), 0.25), [78, 81, 215]);
  assert.deepEqual(dot(black, 0.5), [89, 14, 9]);
  // t=0.5: halfway between y41 and y40, half strength on each; the tail slides in under y41.
  c = await frame(0.5);
  assert.deepEqual(c[41], dot(lvl(41), 0.5 + 0.15));
  assert.deepEqual(c[40], dot(lvl(40), 0.5));
  // t=2.25: y39 at 75 %, y38 at 25 %; the tail (pos 1.25) adds 30 % × 75 % to y40 and 30 % × 25 % to y39.
  c = await frame(2.25);
  assert.deepEqual(c[40], dot(lvl(40), 0.3 * 0.75));
  assert.deepEqual(c[39], dot(lvl(39), 0.75 + 0.3 * 0.25));
  assert.deepEqual(c[38], dot(lvl(38), 0.25));
  assert.deepEqual(c[41], lvl(41));
  // t=4: one row above the bar, on black, full strength; t=4.5 half faded; t=5 restarts at the bottom.
  c = await frame(4);
  assert.deepEqual(c[37], dot(black));
  assert.deepEqual(c[38], dot(lvl(38), 0.3), "tail on the bar's top row");
  assert.deepEqual(c[36], black);
  c = await frame(4.5);
  assert.deepEqual(c[37], dot(black, 0.5));
  c = await frame(5);
  assert.deepEqual(c[41], dot(lvl(41)));
  assert.deepEqual(c[37], black);
});

test("the red mix stands out on every row (ΔE ≥ 25): deep red up to 55 °C, pale hot red on the red rows", () => {
  for (let t = 25; t <= 70; t += 0.25) {
    const bar = heat(t);
    const distance = deltaE(dot(bar), bar);
    assert.ok(distance >= 25, `${t} °C: ${dot(bar)} on ${bar} is only ΔE ${distance.toFixed(1)}`);
  }
  for (let k = 0; k <= 6; k++) assert.deepEqual(heatDotRed(boilerRowColor(k)), RED, `row ${k}`);
  for (let k = 7; k <= 9; k++) assert.deepEqual(heatDotRed(boilerRowColor(k)), PALE_RED, `row ${k}`);
  assert.deepEqual(heatDotRed(black), RED, "always heating red above the bar");
  assert.ok(deltaE(dot(black), black) >= 25, "visible on black above the bar");
});

test("heating_fps: faster frames only while heating, never a 0 ms delay; battery and blink keep elapsed-time pace", async (t) => {
  const setTime = clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish, relay } = await setup(t);
  const start = Date.parse("2026-10-08T12:30:00+02:00");
  publish(40);
  assert.equal(scene._cfg.heatingFps, 2);
  assert.equal(scene.settingsSchema.heating_fps.min, 2, "no 1 fps: a 2 Hz blink cannot alias");
  assert.equal(await scene.render(device), 500, "not heating");
  relay(2150);
  assert.equal(await scene.render(device), 500, "heating at the default 2 fps");
  scene._cfg = scene._mapSettings({ heating_fps: 4 });
  // 4 fps: renders every 250 ms; the 2 fps frame clock advances on every second one.
  const frames = [];
  for (let i = 1; i <= 8; i++) {
    setTime(start + i * 250);
    assert.equal(await scene.render(device), 250, "4 fps target with an instant render");
    frames.push(scene._frame);
  }
  const steps = frames.slice(1).map((f, i) => f - frames[i]);
  assert.deepEqual(steps, [1, 0, 1, 0, 1, 0, 1], "one frame step per 500 ms elapsed");
  // Capped by a slow device: 700 ms between renders still advances one step per 500 ms elapsed.
  const before = scene._frame;
  for (let i = 1; i <= 5; i++) {
    setTime(start + 2000 + i * 700);
    await scene.render(device);
  }
  assert.equal(scene._frame - before, 7, "3500 ms elapsed → 7 steps");
  // A render slower than the target still returns a positive delay, so minFrameMs applies.
  const realPush = device.push;
  device.push = async () => { setTime(Date.now() + 300); };
  assert.equal(await scene.render(device), 1);
  device.push = realPush;
  relay(0);
  assert.equal(await scene.render(device), 500, "back to 500 ms once heating stops");
});

test("a bar that grows mid-rise never makes the dot jump back; the new top applies from the next cycle", async (t) => {
  const setTime = clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish, relay } = await setup(t);
  const start = Date.parse("2026-10-08T12:30:00+02:00");
  publish(40); // 4 rows → 5 s cycles, the dot ends at y37
  relay(2150);
  setTime(start);
  await scene.render(device);
  setTime(start + 7000); // second cycle, 2 s in: dot on row 2 (y39)
  await scene.render(device);
  assert.deepEqual(at(device, 54, 39), dot(lvl(39)));
  publish(45); // 5 rows now, mid-rise
  setTime(start + 7250); // keeps rising: row 2.25 → y38 at 25 % (a re-based phase would drop back to 1.25)
  await scene.render(device);
  assert.deepEqual(at(device, 54, 38), dot(lvl(38), 0.25));
  assert.deepEqual(at(device, 54, 39), dot(lvl(39), 0.75 + 0.3 * 0.25));
  setTime(start + 9000); // this cycle keeps its 4-row top: y37, now inside the taller bar
  await scene.render(device);
  assert.deepEqual(at(device, 54, 37), dot(lvl(37)));
  setTime(start + 10000 + 5000); // next cycle (5 rows → 6 s) at 5 s: its top, y36, one above the bar
  await scene.render(device);
  assert.deepEqual(at(device, 54, 36), dot(black));
});

test("boiler not heating: below threshold, stale relay, missing power or a raised threshold keep the grey triangle", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish, relay } = await setup(t);
  publish(55);
  const grey = [200, 200, 205];
  const check = async (label) => {
    for (let i = 0; i < 4; i++) {
      await scene.render(device);
      for (let y = 35; y <= 41; y++) assert.deepEqual(at(device, 54, y), lvl(y), `${label}: y${y}`);
      assert.deepEqual(at(device, 54, 43), grey, label);
      for (const x of [53, 54, 55]) assert.deepEqual(at(device, x, 44), grey, label);
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

test("on a full-height bar the dot stops at y33 and never touches the digits' row", async (t) => {
  const setTime = clock(t, "2026-10-08T16:00:00+02:00"); // bucket 10 (15:00–16:30) → x56, under "70" (x54..60)
  const { scene, device, publish, relay } = await setup(t);
  publish(70);
  await scene.render(device);
  const reference = [];
  for (let y = 27; y <= 32; y++) reference.push(at(device, 56, y));
  relay(2150);
  const start = Date.parse("2026-10-08T16:00:00+02:00");
  assert.deepEqual(heatDotRed(lvl(33)), PALE_RED, "pale hot red over the 65 °C row");
  assert.deepEqual(dot(lvl(33)), [251, 119, 100]);
  for (let step = 0; step <= 40; step++) {
    setTime(start + step * 250);
    await scene.render(device);
    for (let y = 27; y <= 32; y++) assert.deepEqual(at(device, 56, y), reference[y - 27], `y${y} at ${step * 0.25}s`);
    if (step === 32) assert.deepEqual(at(device, 56, 33), dot(lvl(33)), "8 rows up at 8 s: the top, y33");
  }
});

test("short bars still show the dot: one row above a 1-row bar, a pulse just above the baseline with no bar", async (t) => {
  const setTime = clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish, relay } = await setup(t);
  const start = Date.parse("2026-10-08T12:30:00+02:00");
  relay(2150);
  publish(25); // 1 row (y41); the dot rises to y40 over 1 s
  setTime(start);
  await scene.render(device);
  assert.deepEqual(at(device, 54, 41), dot(heat(25)));
  setTime(start + 1000);
  await scene.render(device);
  assert.deepEqual(at(device, 54, 40), dot(black));
  assert.deepEqual(at(device, 54, 43), [230, 30, 20]);
  publish(21); // 0 rows: a 1 s fade at y41, on black
  for (const [ms, strength] of [[2000, 1], [2500, 0.5]]) {
    setTime(start + ms);
    await scene.render(device);
    assert.deepEqual(at(device, 54, 41), dot(black, strength), `${ms} ms`);
  }
});

test("row 0 is centred and neutral, upper floor on top: OL row y10, TE row y19; badges open = filled green, closed = hollow red", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device } = await setup(t);
  const text = t.mock.method(device, "drawTextRgbaAligned");
  Object.assign(scene._s, {
    terraceOpen: true, terraceOnline: true, w13Open: false, w13Online: true, w14Open: null, w14Online: true,
  });
  await scene.render(device);
  const label = (str) => text.mock.calls.find(({ arguments: [s] }) => s === str).arguments;
  assert.deepEqual(label("OL").slice(1, 3), [[20, 10], rowText]);
  assert.deepEqual(label("TE").slice(1, 3), [[20, 19], rowText]);
  const green = [40, 210, 80];
  const red = [210, 30, 30];
  // TE open: filled green 3×3 at (29, 20) in the lower row.
  for (let y = 20; y <= 22; y++) for (let x = 29; x <= 31; x++) assert.deepEqual(at(device, x, y), green, `TE x${x} y${y}`);
  // W13 closed: hollow red at (29, 11) in the upper row.
  for (const [x, y] of [[29, 11], [30, 11], [31, 11], [29, 12], [31, 12], [29, 13], [30, 13], [31, 13]]) {
    assert.deepEqual(at(device, x, y), red, `W13 x${x} y${y}`);
  }
  assert.deepEqual(at(device, 30, 12), black, "hollow");
  // W14 unknown: the olive/amber checker is unchanged, at (34, 11).
  assert.deepEqual(at(device, 34, 11), [220, 180, 0]);
  assert.deepEqual(at(device, 35, 11), [70, 50, 0]);
  for (let x = 34; x <= 36; x++) assert.deepEqual(at(device, x, 20), black, "nothing beside the single TE badge");
});

test("Nuki attention dot follows each lock's MQTT connected / batteryCritical, not ICMP ping", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, handlers } = await setup(t);
  const amber = [255, 190, 40];
  const ke = (field, msg) => handlers.get("nuki/4A5D18FF/#")(msg, `nuki/4A5D18FF/${field}`);
  const vr = (field, msg) => handlers.get("nuki/463F8F47/#")(msg, `nuki/463F8F47/${field}`);
  // Dot pixels: one column right of each 7×7 icon (x14), at its centre row and the one above.
  const dot = async (cy) => {
    await scene.render(device);
    const pixels = [at(device, 14, cy - 1), at(device, 14, cy)].map((p) => p.join());
    assert.equal(pixels[0], pixels[1], "both dot pixels agree");
    return pixels[0] === amber.join();
  };
  const KE = 21;
  const VR = 12;
  assert.equal(await dot(KE), false, "no message yet: no dot");
  ke("connected", "false");
  assert.equal(await dot(KE), true, "disconnected");
  assert.equal(await dot(VR), false, "the other lock is unaffected");
  ke("connected", "maybe");
  assert.equal(await dot(KE), true, "an unparseable payload keeps the last value");
  ke("connected", " TRUE\n");
  assert.equal(await dot(KE), false, "connected again");
  ke("batteryCritical", "true");
  assert.equal(await dot(KE), true, "battery critical");
  ke("batteryCritical", "false");
  assert.equal(await dot(KE), false);
  ke("batteryChargeState", "3");
  ke("state", "3");
  assert.equal(scene._s.nukiKeState, "unlocked", "the lock state still comes from the same subscription");
  assert.equal(await dot(KE), false, "other fields do not touch the dot");
  vr("connected", "false");
  assert.equal(await dot(VR), true);
});

test("home2 no longer pings the Nukis: no ICMP code, polls or ping settings", async () => {
  const source = await fs.readFile(new URL("../scenes/pixoo/home2.js", import.meta.url), "utf8");
  assert.ok(!/execFile|pingHost|child_process/.test(source));
  assert.equal(home2._restartNukiPolls, undefined);
  for (const key of ["nuki_vr_ip", "nuki_ke_ip", "nuki_ping_ms"]) assert.equal(home2.settingsSchema[key], undefined, key);
});

test("energy hysteresis: PV on from 20 W / off below 5 W; consumption up at 500 / 1000 W, down below 450 / 900 W", () => {
  const pv = (prev, w) => hysteresisLevel(prev, w, [20], [5]);
  assert.equal(pv(null, 0), 0);
  assert.equal(pv(null, 25), 1, "first reading decides directly");
  assert.equal(pv(0, 19), 0, "below 20 W stays off");
  assert.equal(pv(0, 20), 1);
  assert.equal(pv(1, 10), 1, "between 5 and 20 W stays on");
  assert.equal(pv(1, 4), 0);
  const cons = (prev, w) => hysteresisLevel(prev, w, [500, 1000], [450, 900]);
  assert.equal(cons(null, 600), 1);
  assert.equal(cons(0, 499), 0);
  assert.equal(cons(0, 500), 1);
  assert.equal(cons(1, 470), 1, "hovering just under 500 W stays up");
  assert.equal(cons(1, 449), 0);
  assert.equal(cons(1, 1000), 2);
  assert.equal(cons(0, 1500), 2, "jumps straight to the top tier");
  assert.equal(cons(2, 950), 2, "hovering just under 1 kW stays up");
  assert.equal(cons(2, 899), 1);
  assert.equal(cons(2, 100), 0, "falls straight to the bottom tier");
});

test("energy colours ease over 2 s (smoothstep) between levels; a flip mid-fade starts from the colour on screen", async (t) => {
  const setTime = clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device } = await setup(t);
  const start = Date.parse("2026-10-08T12:30:00+02:00");
  const text = t.mock.method(device, "drawTextRgbaAligned");
  const colorAt = (y) => {
    const call = text.mock.calls.find(({ arguments: [, [x, cy]] }) => cy === y && x >= 22 && x <= 42);
    return call.arguments[2];
  };
  const frame = async (ms, productionW, consumptionW) => {
    Object.assign(scene._s, { productionW, consumptionW, energySeen: start + ms });
    setTime(start + ms);
    text.mock.resetCalls();
    await scene.render(device);
    return { pv: colorAt(29), cons: colorAt(37) };
  };
  const grey = [80, 80, 80];
  const yellow = [255, 220, 0];
  let c = await frame(0, 0, 600);
  assert.deepEqual(c.pv, grey, "first frame: off, no fade");
  assert.deepEqual(c.cons, [200, 40, 40], "first frame: tier 1, no fade");
  c = await frame(500, 2150, 600);
  assert.deepEqual(c.pv, grey, "fade starts at the change");
  c = await frame(1500, 2150, 600);
  assert.deepEqual(c.pv, [168, 150, 40], "halfway: smoothstep(0.5) = 0.5");
  c = await frame(2000, 2150, 600);
  assert.deepEqual(c.pv, [228, 198, 13], "1.5 s in: smoothstep(0.75) = 0.84375");
  c = await frame(2500, 2150, 600);
  assert.deepEqual(c.pv, yellow, "done after 2 s");
  // Off again, then back on 0.5 s later: the second fade starts where the first one was.
  await frame(3000, 0, 600);
  c = await frame(3500, 0, 600);
  assert.deepEqual(c.pv, [228, 198, 13], "0.5 s into fading out: smoothstep(0.25) = 0.15625");
  c = await frame(3500, 2150, 600);
  assert.deepEqual(c.pv, [228, 198, 13], "no jump when the target flips back");
  c = await frame(5500, 2150, 600);
  assert.deepEqual(c.pv, yellow);
  // Consumption: 470 W stays tier 1 (hysteresis); 440 W fades down to tier 0.
  c = await frame(6000, 2150, 470);
  assert.deepEqual(c.cons, [200, 40, 40]);
  await frame(6500, 2150, 440);
  c = await frame(7500, 2150, 440);
  assert.deepEqual(c.cons, [160, 30, 30], "halfway between tier 1 and tier 0");
  c = await frame(8500, 2150, 440);
  assert.deepEqual(c.cons, [120, 20, 20]);
});

test("boiler scale clamps 19/20 to empty and 70/71 to ten rows; 45 is five rows", async (t) => {
  clock(t);
  const { scene, device, publish } = await setup(t);
  for (const [value, height, color] of [
    [19, 0, heat(20)], [20, 0, heat(20)],
    [45, 5, heat(45)], [70, 10, heat(70)], [71, 10, heat(70)],
  ]) {
    publish(value);
    await scene.render(device);
    for (let y = 32; y < 42; y++) {
      assert.deepEqual(at(device, 46, y), y >= 42 - height ? lvl(y) : black, `${value} at y${y}`);
    }
    assert.deepEqual(at(device, 62, 28), color, "degree at the top row");
    assert.deepEqual(at(device, 61, 28), black, "one-pixel degree gap");
    assert.deepEqual(at(device, 62, 29), black, "single-pixel degree");
  }
});

test("the current temperature stays readable above full-height past bars", async (t) => {
  clock(t, "2026-10-08T23:30:00+02:00"); // bucket 15 (x61): x54..60 under the digits are all PAST buckets
  const { scene, device, publish } = await setup(t);
  for (let i = 0; i < scene._boilerHistory.buckets.length; i++) scene._boilerHistory.buckets[i] = { sum: 70, count: 1 };
  publish(70);
  await scene.render(device);
  // "70" ends at x60; the "0" glyph's bottom row (y32) spans x58..60. Drawn last, it keeps the text colour
  // instead of the dimmed full-height bar colour underneath.
  for (const x of [58, 59, 60]) assert.deepEqual(at(device, x, 32), heat(70), `x${x}`);
});

test("boiler readings too wide for the cell read -- instead of crossing the x43 separator", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish } = await setup(t);
  const text = t.mock.method(device, "drawTextRgbaAligned");
  for (const [value, expected] of [[1234, "1234"], [12345.6, "--"], [-1234, "--"]]) {
    publish(value);
    text.mock.resetCalls();
    await scene.render(device);
    const calls = text.mock.calls.filter(({ arguments: [, [x, y]] }) => y === 28 && x >= 44);
    assert.deepEqual(calls.map(({ arguments: [str] }) => str), [expected], String(value));
    for (let y = 28; y <= 32; y++) {
      assert.deepEqual(at(device, 43, y), [25, 25, 25], `${value}: separator at y${y}`);
      assert.deepEqual(at(device, 44, y), black, `${value}: margin at y${y}`);
    }
    if (expected === "--") assert.deepEqual(at(device, 62, 28), black, `${value}: no degree`);
  }
});

test("the big number takes its value's gradient colour (pinned RGB, including between rows)", async (t) => {
  clock(t);
  const { scene, device, publish } = await setup(t);
  for (const [value, rgb] of [
    [27.5, [165, 194, 255]], [35, [90, 132, 255]], [40, [40, 90, 255]], [45, [105, 70, 238]],
    [52, [182, 45, 179]], [55, [200, 38, 118]],
  ]) {
    publish(value);
    await scene.render(device);
    assert.deepEqual(at(device, 62, 28), rgb, String(value));
  }
});

test("thermometer scale: white-blue → blue (40, tick) → violet → red (60, tick) → bright red, row by row", () => {
  assert.deepEqual(BOILER_COLOR_STOPS, [
    [25, [190, 215, 255]], [40, [40, 90, 255]], [50, [170, 50, 220]], [60, [230, 25, 15]], [70, [255, 70, 45]],
  ]);
  // Pinned row colours (row k = y41-k = 25 + 5k °C), linear in RGB between stops.
  const rows = [
    [190, 215, 255], [140, 173, 255], [90, 132, 255], [40, 90, 255], [105, 70, 238],
    [170, 50, 220], [200, 38, 118], [230, 25, 15], [243, 48, 30], [255, 70, 45],
  ];
  rows.forEach((c, k) => assert.deepEqual(boilerRowColor(k), c, `row ${k}`));
  assert.deepEqual(heat(10), heat(25), "clamped below 25");
  assert.deepEqual(heat(90), heat(70), "clamped above 70");
  assert.deepEqual(heat(null), [80, 80, 80], "no reading is dim");
  for (let t = 15; t <= 75; t += 0.25) {
    const [r, g, b] = heat(t);
    assert.ok(!(g > r + 20 && g > b + 20), `${t} °C must not be green-dominant: ${heat(t)}`);
  }
});

test("past bars use their average at dim65; current uses live temperature; future has only baseline", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00"); // bucket 8 (12:00–13:30) → x54
  const { scene, device, publish } = await setup(t);
  scene._boilerHistory.buckets[0] = { sum: 90, count: 2 }; // average 45 → x46
  scene._boilerHistory.buckets[1] = { sum: 140, count: 2 }; // average 70 → x47
  scene._boilerHistory.buckets[8] = { sum: 45, count: 1 }; // current bucket
  scene._boilerHistory.buckets[9] = { sum: 70, count: 1 }; // future must not render
  publish(70);
  await scene.render(device);
  for (let y = 37; y <= 41; y++) assert.deepEqual(at(device, 46, y), dim(lvl(y)), `past 45 °C, y${y}`);
  assert.deepEqual(at(device, 46, 36), black);
  for (let y = 32; y <= 41; y++) assert.deepEqual(at(device, 47, y), dim(lvl(y)), `past 70 °C, y${y}`);
  assert.deepEqual(at(device, 47, 41), [124, 140, 166], "pinned: white-blue at 65 %");
  assert.deepEqual(at(device, 47, 32), [166, 46, 29], "pinned: bright red at 65 %");
  for (let y = 33; y <= 41; y++) assert.deepEqual(at(device, 54, y), lvl(y), `current, full brightness, y${y}`);
  for (let x = 55; x <= 61; x++) {
    for (let y = 33; y <= 41; y++) assert.deepEqual(at(device, x, y), black, `future x${x}, y${y}`);
    assert.deepEqual(at(device, x, 42), x === 58 ? [130, 130, 130] : gray, `x-axis x${x}`);
  }
  for (const x of [62, 63]) for (let y = 33; y <= 41; y++) assert.deepEqual(at(device, x, y), black, `right margin x${x}, y${y}`);
});

test("stale current shows -- and blinking error while the current bucket retains its average", async (t) => {
  clock(t, "2026-10-08T12:30:00+02:00");
  const { scene, device, publish } = await setup(t);
  publish(70);
  scene._s.boilerTempSeen = Date.now() - scene._cfg.boilerStaleMs - 1;
  scene._boilerHistory.buckets[8] = { sum: 90, count: 2 };
  await scene.render(device); // Odd frame: error X.
  for (const [x, y] of [[60, 28], [62, 28], [61, 29], [60, 30], [62, 30]]) {
    assert.deepEqual(at(device, x, y), [200, 0, 0]);
  }
  for (let y = 37; y <= 41; y++) assert.deepEqual(at(device, 54, y), lvl(y), `average 45 → 5 gradient rows, y${y}`);
  await scene.render(device); // Even frame: no error X, no degree pixel.
  for (const x of [56, 57, 58, 60, 61, 62]) assert.deepEqual(at(device, x, 30), [80, 80, 80]);
  assert.deepEqual(at(device, 62, 28), black);
  scene._boilerHistory.buckets[8] = { sum: 0, count: 0 };
  await scene.render(device);
  // No value and no current-column line (PIXD-60): the column is empty above the baseline.
  for (let y = 27; y <= 41; y++) assert.deepEqual(at(device, 54, y), black, `y${y}`);
});

test("boiler axes cross at the origin (x44..63 / y32..43); 6-hour ticks brighter inside the x-axis incl. 24:00; 40/60 °C on the y-axis", async (t) => {
  clock(t, "2026-10-08T01:50:00+02:00"); // bucket 1 (01:30–03:00) → x47
  const { scene, device, publish } = await setup(t);
  publish(20);
  await scene.render(device);
  const tick = [130, 130, 130];
  // y-axis at x45: dim grey y32..43 (1 px past the baseline), coloured 40/60 °C points.
  assert.deepEqual(at(device, 45, 38), [40, 90, 255], "40 °C");
  assert.deepEqual(at(device, 45, 34), [230, 25, 15], "60 °C");
  for (let y = 32; y <= 43; y++) if (y !== 34 && y !== 38) assert.deepEqual(at(device, 45, y), gray, `y-axis y${y}`);
  assert.deepEqual(at(device, 45, 31), black, "stops at the chart's top row");
  assert.deepEqual(at(device, 45, 44), black, "overshoots the baseline by exactly 1 px");
  // x-axis at y42: x44..63 (1 px left of the y-axis, to the cell edge), ticks at 00/06/12/18/24.
  for (let x = 44; x <= 63; x++) {
    const expected = [46, 50, 54, 58, 62].includes(x) ? tick : gray;
    assert.deepEqual(at(device, x, 42), expected, `x-axis x${x}`);
  }
  assert.deepEqual(at(device, 43, 42), [25, 25, 25], "the separator is untouched");
  // The row below holds only the triangle (and the y-axis overshoot at x45).
  for (let x = 46; x <= 63; x++) if (x !== 47) assert.deepEqual(at(device, x, 43), black, `y43 x${x}`);
  assert.deepEqual(at(device, 47, 43), [200, 200, 205], "triangle tip under the current bucket");
});

test("the final bucket's current marker and full-height bar stay within the cell; the chart ends at x61", async (t) => {
  clock(t, "2026-10-08T23:59:00+02:00"); // bucket 15 → x61
  const { scene, device, publish } = await setup(t);
  const pixel = t.mock.method(device, "_setPixel");
  publish(70);
  await scene.render(device);
  assert.ok(pixel.mock.calls.every(({ arguments: [x, y] }) => x >= 0 && x <= 63 && y >= 0 && y <= 63));
  for (let y = 32; y <= 41; y++) assert.deepEqual(at(device, 61, y), lvl(y));
  for (const x of [62, 63]) for (let y = 33; y <= 41; y++) assert.deepEqual(at(device, x, y), black, `margin x${x}, y${y}`);
  for (const x of [60, 61, 62]) assert.deepEqual(at(device, x, 44), [200, 200, 205], `arrow base x${x}`);
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
        // Row 0: home2 recolours and re-centres the labels and badges (x20..36) and the
        // temperatures (x44..63); margins and the x43 separator must still match.
        if (y >= 8 && y <= 25 && ((x >= 20 && x <= 36) || x >= 44)) continue;
        if (x >= 22 && x <= 42 && y >= 27 && y <= 44) continue; // home2 fades the energy colours
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
