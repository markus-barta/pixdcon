import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import home3 from "../scenes/pixoo/home3.js";
import { PixooDriver } from "../lib/pixoo-driver.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const black = [0, 0, 0];
const sep = [25, 25, 25];
const cable = [38, 38, 42];

function clock(t, instant = "2026-10-10T12:30:00+02:00") {
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

async function setup(t, settings = {}) {
  const handlers = new Map();
  const ctx = {
    logger,
    settings: { all: () => settings, subscribe: () => () => {} },
    mqtt: {
      subscribe: (topic, cb) => handlers.set(topic, cb),
      subscribeWildcard: (topic, cb) => handlers.set(topic, cb),
      unsubscribeAll: () => handlers.clear(),
    },
  };
  const scene = Object.create(home3);
  t.mock.method(scene, "_startSyncboxPoll", () => {});
  const dir = await fs.mkdtemp(join(tmpdir(), "pixdcon-home3-"));
  scene._boilerStatePath = join(dir, ".state", "home3-boiler.json");
  t.after(async () => {
    await scene.destroy(ctx);
    await fs.rm(dir, { recursive: true, force: true });
  });
  await scene.init(ctx);
  const device = new PixooDriver("offline", { logger });
  device.setBrightness = async () => {};
  device.push = async () => {};
  const send = (topic, payload) => handlers.get(topic)(typeof payload === "string" ? payload : JSON.stringify(payload), topic);
  return { scene, device, handlers, send };
}

function at(device, x, y) {
  const offset = (y * 64 + x) * 3;
  return Array.from(device.buf.slice(offset, offset + 3));
}

test("home3 metadata, data-topic settings and subscriptions; no keyboard topic", async (t) => {
  clock(t);
  const { scene, handlers } = await setup(t);
  assert.equal(scene.name, "home3");
  assert.equal(scene.pretty_name, "Home Dashboard 3");
  assert.equal(scene.settingsSchema.nuki_vr_plug_topic.default, "z2m/vr/plug/zisp03");
  assert.equal(scene.settingsSchema.nuki_ke_plug_topic.default, "");
  assert.equal(scene.settingsSchema.car_battery_topic.default, "homeassistant/sensor/battery_level_2/state");
  for (const topic of [
    "home/ke/sonnenbattery/latestdata", "z2m/vr/plug/zisp03",
    "homeassistant/sensor/battery_level_2/state", "homeassistant/sensor/charging_2/state",
    "homeassistant/binary_sensor/charge_cable_2/state", "homeassistant/number/charge_limit_2/state",
  ]) assert.ok(handlers.has(topic), topic);
  assert.ok(![...handlers.keys()].some((k) => /keyboard/.test(k)), "the keyboard dots are gone");
  assert.ok(![...handlers.keys()].includes(""), "an empty Keller plug topic is not subscribed");
});

test("no title bar: rows at y0 / y22 / y43, separators y21 and y42, x43 for rows 0-1, x21 for rows 1-2", async (t) => {
  clock(t);
  const { scene, device } = await setup(t);
  await scene.render(device);
  for (let x = 0; x < 64; x++) { assert.deepEqual(at(device, x, 21), sep); assert.deepEqual(at(device, x, 42), sep); }
  for (let y = 0; y <= 41; y++) if (y !== 21) assert.deepEqual(at(device, 43, y), sep, `x43 y${y}`);
  assert.notDeepEqual(at(device, 43, 50), sep, "row 2 media cell is merged across x43");
  for (let y = 22; y <= 63; y++) if (y !== 42) assert.deepEqual(at(device, 21, y), sep, `x21 y${y}`);
  assert.notDeepEqual(at(device, 21, 10), sep, "row 0 status cell is merged across x21");
  for (const x of [1, 2, 3, 30, 33, 36]) assert.deepEqual(at(device, x, 1), black, "no HOME / clock / keyboard dots");
});

test("Nukis centred in the first cell; a plugged lock gets a dark cable into its centre, charging runs a dot along it", async (t) => {
  const setTime = clock(t);
  const { scene, device, send, handlers } = await setup(t);
  await scene.render(device);
  for (let x = 0; x <= 6; x++) assert.deepEqual(at(device, x, 5), black, `unplugged x${x}`);
  send("z2m/vr/plug/zisp03", { state: "ON", power: 0 });
  await scene.render(device);
  for (let x = 0; x <= 6; x++) assert.deepEqual(at(device, x, 5), cable, `plugged x${x}`);
  for (let x = 0; x <= 6; x++) assert.deepEqual(at(device, x, 14), black, "the Keller lock is not plugged");
  handlers.get("nuki/463F8F47/#")("true", "nuki/463F8F47/batteryCharging"); // the wildcard handler
  assert.equal(scene._s.nukiVrCharging, true);
  const lit = new Set();
  for (let step = 0; step < 12; step++) {
    setTime(Date.parse("2026-10-10T12:30:00+02:00") + step * 200);
    await scene.render(device);
    for (let x = 0; x <= 6; x++) if (at(device, x, 5).join() !== cable.join()) lit.add(x);
  }
  assert.ok(lit.size >= 4, `the charging dot travels along the cable (${[...lit]})`);
  send("z2m/vr/plug/zisp03", { state: "OFF" });
  await scene.render(device);
  for (let x = 0; x <= 6; x++) assert.deepEqual(at(device, x, 5), black, "unplugged again");
});

test("Sonnen ring mirrors the cabinet's Eclipse LED; the cabinet has a very dark 3D frame", async (t) => {
  clock(t);
  const { scene, device, send } = await setup(t);
  await scene.render(device);
  assert.deepEqual(at(device, 4, 28), [60, 60, 64], "unknown until latestdata arrives");
  send("home/ke/sonnenbattery/latestdata", { ic_status: { "Eclipse Led": { "Pulsing White": true, "Solid Red": false } } });
  await scene.render(device);
  assert.deepEqual(at(device, 4, 28), [50, 200, 180], "fine: greenish blue");
  send("home/ke/sonnenbattery/latestdata", { ic_status: { "Eclipse Led": { "Pulsing Orange": true } } });
  await scene.render(device);
  assert.deepEqual(at(device, 4, 28), [255, 150, 0], "warning: amber");
  send("home/ke/sonnenbattery/latestdata", { ic_status: { "Eclipse Led": { "Blinking Red": true } } });
  await scene.render(device);
  assert.deepEqual(at(device, 4, 28), [230, 30, 25], "error: red");
  send("home/ke/sonnenbattery/latestdata", "not json");
  await scene.render(device);
  assert.deepEqual(at(device, 4, 28), [230, 30, 25], "garbage keeps the last state");
  assert.deepEqual(at(device, 0, 24), [26, 26, 29], "frame top-left corner");
  assert.deepEqual(at(device, 6, 24), [26, 26, 29], "top face stops 1 px before the right edge");
  assert.notDeepEqual(at(device, 7, 24), [26, 26, 29]);
  assert.deepEqual(at(device, 0, 38), [26, 26, 29], "left face down to one row above the body's bottom");
  assert.notDeepEqual(at(device, 0, 39), [26, 26, 29]);
});

test("house and car battery: same position in their cells; car % keeps the last value through unknown; limit tick on the frame", async (t) => {
  clock(t);
  const { scene, device, send } = await setup(t);
  const text = t.mock.method(device, "drawTextRgbaAligned");
  Object.assign(scene._s, { battPct: 62, battState: "charging", battSeen: Date.now() });
  send("homeassistant/sensor/battery_level_2/state", "50");
  send("homeassistant/number/charge_limit_2/state", "70");
  send("homeassistant/binary_sensor/charge_cable_2/state", "on");
  send("homeassistant/sensor/charging_2/state", "charging");
  await scene.render(device);
  const label = (s) => text.mock.calls.find(({ arguments: [str] }) => str === s)?.arguments[1];
  assert.deepEqual(label("62%"), [19, 23], "house %: right-aligned, ends at x18 (2 px off the edge), cell y+1");
  assert.deepEqual(label("50%"), [19, 44], "car %: right-aligned, ends at x18, cell y+1");
  for (const [y, what] of [[35, "house"], [56, "car"]]) {
    for (const x of [6, 18]) assert.deepEqual(at(device, x, y), [95, 95, 95], `${what} battery frame x${x}`);
    assert.deepEqual(at(device, 19, y + 2), [95, 95, 95], `${what} nub`);
  }
  assert.deepEqual(at(device, 14, 56), [150, 150, 155], "70 % limit tick on the car battery's top frame");
  for (const y of [23, 44]) { assert.deepEqual(at(device, 19, y + 2), black); assert.deepEqual(at(device, 20, y + 2), black); }
  assert.deepEqual(at(device, 20, 51), cable, "the car cable enters from the right, 2 px below the %");
  send("homeassistant/sensor/battery_level_2/state", "unknown");
  send("homeassistant/sensor/charging_2/state", "unavailable");
  text.mock.resetCalls();
  await scene.render(device);
  assert.deepEqual(label("50%"), [19, 44], "unknown keeps the last good value");
  assert.equal(scene._s.carCharging, true, "unavailable keeps the charging state");
  send("homeassistant/binary_sensor/charge_cable_2/state", "off");
  await scene.render(device);
  assert.deepEqual(at(device, 20, 51), black, "no cable when unplugged");
});

test("media: home2 icons; the Sync Box connector sits in the gap 1 px above the TV's bottom frame, yellow syncing / grey idle", async (t) => {
  clock(t);
  const { scene, device } = await setup(t);
  Object.assign(scene._s, { syncEnabled: true, syncSeen: Date.now(), syncInput: "input4", syncActive: true });
  await scene.render(device);
  for (let x = 30; x <= 32; x++) assert.deepEqual(at(device, x, 55), [240, 220, 0], `PS5 link x${x}`);
  for (let x = 52; x <= 54; x++) assert.deepEqual(at(device, x, 55), black);
  Object.assign(scene._s, { syncInput: "input2", syncActive: false });
  await scene.render(device);
  for (let x = 52; x <= 54; x++) assert.deepEqual(at(device, x, 55), [90, 90, 95], `PC link x${x}`);
  for (let x = 30; x <= 32; x++) assert.deepEqual(at(device, x, 55), black);
  Object.assign(scene._s, { syncSeen: Date.now() - scene._cfg.syncboxFreshMs - 1 });
  await scene.render(device);
  for (const x of [30, 31, 32, 52, 53, 54]) assert.deepEqual(at(device, x, 55), black, "offline: no link");
  // TV bottom frame row is y56 (icon at y44; white when on); power-LED bars at y61
  Object.assign(scene._s, { tvPower: 90, tvSeen: Date.now() });
  await scene.render(device);
  assert.deepEqual(at(device, 33, 56), [255, 255, 255]);
  assert.deepEqual(at(device, 33, 55), [255, 255, 255], "the link row y55 is the frame's left edge, so the PS5 link touches it");
  for (const x of [26, 41, 57]) assert.notDeepEqual(at(device, x, 61), black, `LED bar x${x}`);
});
