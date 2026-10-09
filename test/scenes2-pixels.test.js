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
  return { scene, device, publish };
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

test("home2 matches home at every pixel outside the boiler cell across normal/stale states", async (t) => {
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
        if (x >= 44 && y >= 27 && y <= 44) continue;
        assert.deepEqual(at(first.device, x, y), at(second.device, x, y), `x${x}, y${y}`);
      }
    }
  }
});

test("write coordinator previews for home and home2 with a cold/heated/cooling boiler day", async (t) => {
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
  const previews = resolve(".previews");
  await fs.mkdir(previews, { recursive: true });
  for (const { scene, device } of [first, second]) {
    await scene.render(device);
    const options = { raw: { width: 64, height: 64, channels: 3 } };
    await sharp(device.buf, options).png().toFile(join(previews, `${scene.name}.png`));
    await sharp(device.buf, options).resize(512, 512, { kernel: "nearest" }).png().toFile(join(previews, `${scene.name}-8x.png`));
  }
});
