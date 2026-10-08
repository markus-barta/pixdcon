import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import home from "../scenes/pixoo/home.js";
import kid from "../scenes/pixoo/funkeykid.js";
import { PixooDriver } from "../lib/pixoo-driver.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function context() {
  const handlers = new Map();
  return {
    logger, handlers,
    settings: { all: () => ({}), subscribe: () => () => {} },
    mqtt: {
      subscribe: (topic, cb) => handlers.set(topic, cb),
      subscribeWildcard: (topic, cb) => handlers.set(topic, cb),
      unsubscribeAll: () => handlers.clear(),
    },
  };
}

function driver() {
  const device = new PixooDriver("offline", { logger });
  device.brightness = [];
  device.setBrightness = async (value) => { device.brightness.push(value); };
  device.push = async () => {};
  return device;
}

function hash(device) {
  return createHash("sha256").update(device.buf).digest("hex");
}

function clock(t) {
  const existed = Object.hasOwn(process.env, "TZ");
  const previous = process.env.TZ;
  process.env.TZ = "Europe/Vienna";
  t.after(() => {
    if (existed) process.env.TZ = previous;
    else delete process.env.TZ;
  });
  const RealDate = Date;
  let ms = new RealDate("2026-10-08T12:30:00").getTime();
  t.mock.method(globalThis, "Date", class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [ms])); }
    static now() { return ms; }
  });
  return (time) => { ms = new RealDate("2026-10-08T" + time).getTime(); };
}

// Golden hashes captured from the pre-PIXD-47 scenes using the real pixel driver.
test("home normal-input pixels, brightness and cadence match the original scene", async (t) => {
  const setTime = clock(t);
  t.mock.method(globalThis, "setInterval", () => ({}));
  t.mock.method(globalThis, "clearInterval", () => {});
  t.mock.method(globalThis, "setTimeout", () => ({}));
  t.mock.method(globalThis, "clearTimeout", () => {});
  const curve = [0,0,0,0,0,0,0.4,1.2,2.4,3.1,4.8,5.6,6.2,5.8,4.9,3.7,2.1,1.4,0.7,0.1,0,0,0,0];
  const cases = [
    ["06:15:00", "83834ab15d14fae39123a80ee62fe112b17d7639c3855b6e0fa3f2f343a506f0"],
    ["08:45:00", "77dcaab930d5e0ab13d18df35880225b3ce469bc224d4e10115e1ee2c80d6bca"],
    ["12:30:00", "314f475f05c0065937d9074dda1a7c3d2e6f9e9c39dd9fbf11bd07618ba7431f"],
    ["19:00:00", "2c7b45d71855f5c6c93d3b5e22930a6921de158938bbba728478602766bab2f4"],
    ["23:15:00", "2e4970c56dba59b0a600646238787c0e8b689b77221adf5363c8287a6626eb58"],
  ];
  for (const [time, expected] of cases) {
    setTime(time);
    const scene = Object.create(home);
    for (const method of ["_restartNukiPolls", "_startSyncboxPoll", "_startUvPoll"]) scene[method] = () => {};
    const ctx = context();
    await scene.init(ctx);
    Object.assign(scene._s, {
      kbConnected: true, sunElevation: 8,
      nukiVrState: "locked", nukiKeState: "unlocked",
      terraceOpen: true, terraceOnline: true,
      w13Open: false, w13Online: true, w14Open: true, w14Online: true,
      roofTempC: 21.5, poolTempC: 25.1,
      roofTempSeen: Date.now(), poolTempSeen: Date.now(),
      battPct: 55, battState: "discharging", battSeen: Date.now(),
      productionW: 3890, consumptionW: 975, energySeen: Date.now(),
      ps5Power: 80, ps5Seen: Date.now(), tvPower: 90, tvSeen: Date.now(),
      pcPower: 40, pcSeen: Date.now(), syncEnabled: true,
      syncInput: "input2", syncActive: true, syncSeen: Date.now(),
      uvCurrentApi: 6, uvHourly24: curve, uvApiSeen: Date.now(),
      uvHourlyTimes: Array.from({ length: 24 }, (_, h) => new Date(2026, 9, 8, h).getTime()),
    });
    const device = driver();
    for (let frame = 0; frame < 3; frame++) assert.equal(await scene.render(device), 500);
    assert.equal(hash(device), expected, time);
    assert.deepEqual(device.brightness, [88]);
    await scene.destroy(ctx);
  }
});

test("funkeykid letter, image and normal volume pixels match the original scene", async (t) => {
  clock(t);
  const scene = Object.create(kid);
  const ctx = context();
  await scene.init(ctx);
  const cases = [
    [{ letter: "A", word: "Affe", color: "#FFCC00" }, 200, "d5db28027f7180fd09b2338b43716cc4df1ad325d770c6eb958544fc0b0f72dc"],
    [{ letter: "B", word: "Biene", image: "b_biene.png", color: "#AA77FF" }, 200, "c50f646b457e2cad69a8254beceb4539a81f2aa326e5f3017c062939c04d1559"],
    [{ bar: true, percent: 60, bars_total: 10, bars_filled: 6, color: "#FFCC00" }, 60, "0bcc07a7b4092f5d7e07710e2bbe7ffb62c587bd849aebccaa285dc65d111f72"],
  ];
  for (const [payload, delay, expected] of cases) {
    await ctx.handlers.get("home/hsb1/funkeykid/display")(JSON.stringify(payload));
    const device = driver();
    assert.equal(await scene.render(device), delay);
    assert.equal(hash(device), expected);
  }
  await scene.destroy(ctx);
});
