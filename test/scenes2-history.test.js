import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import home2 from "../scenes/pixoo/home2.js";
import { PixooDriver } from "../lib/pixoo-driver.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const topic = "jhw2211/health/boiler";

function clock(t, instant = "2026-10-08T00:00:00+02:00") {
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
  return (next) => { ms = new RealDate(next).getTime(); };
}

function timers(t) {
  const active = new Map();
  const add = (cb, ms) => {
    const id = {};
    active.set(id, { cb, ms });
    return id;
  };
  t.mock.method(globalThis, "setInterval", add);
  t.mock.method(globalThis, "setTimeout", add);
  t.mock.method(globalThis, "clearInterval", (id) => active.delete(id));
  t.mock.method(globalThis, "clearTimeout", (id) => active.delete(id));
  return active;
}

async function setup(t, { content, settings = {} } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), "pixdcon-boiler-"));
  const path = join(dir, ".state", "home2-boiler.json");
  const warnings = [];
  const handlers = new Map();
  let update;
  let unsubscribed = false;
  const ctx = {
    logger: { ...logger, warn: (message) => warnings.push(message) },
    settings: {
      all: () => settings,
      subscribe: (cb) => { update = cb; return () => { unsubscribed = true; }; },
    },
    mqtt: {
      subscribe: (key, cb) => handlers.set(key, cb),
      subscribeWildcard: (key, cb) => handlers.set(key, cb),
      unsubscribeAll: () => handlers.clear(),
    },
  };
  const scene = Object.create(home2);
  scene._boilerStatePath = path;
  for (const method of ["_restartNukiPolls", "_startSyncboxPoll"]) {
    t.mock.method(scene, method, () => {});
  }
  t.after(async () => {
    if (scene._boilerSampling) await scene.destroy(ctx);
    await fs.rm(dir, { recursive: true, force: true });
  });
  if (content !== undefined) {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content);
  }
  await scene.init(ctx);
  const publish = (temp) => handlers.get(topic)(JSON.stringify({ state: "ok", temp_c: temp }));
  return { scene, ctx, path, warnings, handlers, publish, update: (values) => update(values),
    unsubscribed: () => unsubscribed };
}

function savedDay(date = "2026-10-08") {
  return { date, buckets: Array.from({ length: 18 }, () => ({ sum: 0, count: 0 })) };
}

test("home2 metadata, boiler settings and subscriptions replace UV", async (t) => {
  clock(t);
  timers(t);
  const { scene, handlers, update } = await setup(t);
  assert.equal(scene.name, "home2");
  assert.equal(scene.pretty_name, "Home Dashboard 2");
  assert.equal(scene.deviceType, "pixoo");
  assert.equal(scene._cfg.boilerStaleMs, 1800000);
  assert.equal(scene.settingsSchema.boiler_stale_ms.default, 1800000);
  assert.ok(handlers.has(topic));
  assert.ok(![...handlers.keys()].some((key) => /uv/i.test(key)));
  assert.ok(!Object.keys(scene.settingsSchema).some((key) => key.startsWith("uv_")));
  assert.equal(scene._startUvPoll, undefined);
  update({ boiler_stale_ms: 60000 });
  assert.equal(scene._cfg.boilerStaleMs, 60000);
});

test("wall-clock buckets include 00:00, 01:19, 01:20 and 23:59", async (t) => {
  const setTime = clock(t);
  timers(t);
  const { scene, publish } = await setup(t);
  for (const [time, index] of [["00:00:00", 0], ["01:19:00", 0], ["01:20:00", 1], ["23:59:00", 17]]) {
    setTime(`2026-10-08T${time}+02:00`);
    publish(45);
    await scene._sampleBoiler();
    assert.equal(scene._boilerBucketIndex, index, time);
  }
  assert.deepEqual(scene._boilerHistory.buckets[0], { sum: 90, count: 2 });
  assert.deepEqual(scene._boilerHistory.buckets[1], { sum: 45, count: 1 });
  assert.deepEqual(scene._boilerHistory.buckets[17], { sum: 45, count: 1 });
});

test("DST 23/25-hour days use local minutes and the same 18 calendar buckets", async (t) => {
  const setTime = clock(t);
  timers(t);
  const { scene, publish } = await setup(t);
  for (const [date, hours, repeatedCount] of [["2026-03-29", 23, 0], ["2026-10-25", 25, 2]]) {
    const midnight = new Date(date + "T00:00:00").getTime();
    const nextMidnight = new Date(new Date(midnight).getFullYear(), new Date(midnight).getMonth(), new Date(midnight).getDate() + 1).getTime();
    assert.equal((nextMidnight - midnight) / 3600000, hours);
    for (let h = 0; h < hours; h++) {
      setTime(midnight + h * 3600000);
      publish(40);
      await scene._sampleBoiler();
    }
    const { buckets } = scene._boilerHistory;
    assert.equal(buckets.length, 18);
    assert.equal(buckets.reduce((n, b) => n + b.count, 0), hours);
    assert.equal(buckets[1].count, repeatedCount); // 02:00 is skipped / repeated.
    assert.equal(buckets[0].count, 2);
    assert.equal(buckets[17].count, 1);
    assert.equal(scene._boilerHistory.date, date);
    assert.equal(scene._boilerBucketIndex, 17);
  }
});

test("minute sampling averages finite values and invalid MQTT cannot refresh them", async (t) => {
  const setTime = clock(t);
  const active = timers(t);
  const { scene, publish, handlers } = await setup(t);
  const sampler = active.get(scene._boilerTimer);
  assert.equal(sampler.ms, 60000);
  publish(30);
  assert.equal(scene._boilerHistory.buckets[0].count, 0);
  sampler.cb();
  await scene._boilerSave;
  setTime("2026-10-08T00:01:00+02:00");
  publish(50);
  sampler.cb();
  await scene._boilerSave;
  assert.deepEqual(scene._boilerHistory.buckets[0], { sum: 80, count: 2 });
  assert.equal(scene._boilerHistory.buckets[0].sum / scene._boilerHistory.buckets[0].count, 40);
  const seen = scene._s.boilerTempSeen;
  setTime("2026-10-08T00:02:00+02:00");
  for (const msg of ["null", "[]", "{", '{"temp_c":null}', '{"temp_c":"60"}', '{"temp_c":1e999}']) {
    handlers.get(topic)(msg);
  }
  assert.equal(scene._s.boilerTempC, 50);
  assert.equal(scene._s.boilerTempSeen, seen);
});

test("stale readings stop sampling; the configured timeout includes its boundary", async (t) => {
  const setTime = clock(t);
  timers(t);
  const { scene, publish, update } = await setup(t);
  publish(55);
  setTime("2026-10-08T00:30:00+02:00");
  assert.equal(scene._boilerCurrent(), 55);
  await scene._sampleBoiler();
  setTime("2026-10-08T00:30:00.001+02:00");
  assert.equal(scene._boilerCurrent(), null);
  await scene._sampleBoiler();
  assert.equal(scene._boilerHistory.buckets[0].count, 1);
  update({ boiler_stale_ms: 3600000 });
  await scene._sampleBoiler();
  assert.equal(scene._boilerHistory.buckets[0].count, 2);
});

test("day change resets history during render and samples into the new local date", async (t) => {
  const setTime = clock(t, "2026-10-08T23:59:00+02:00");
  timers(t);
  const { scene, publish, path } = await setup(t);
  publish(50);
  await scene._sampleBoiler();
  setTime("2026-10-09T00:00:00+02:00"); // UTC is still October 8.
  const device = new PixooDriver("offline", { logger });
  device.setBrightness = async () => {};
  device.push = async () => {};
  await scene.render(device);
  assert.equal(scene._boilerHistory.date, "2026-10-09");
  assert.ok(scene._boilerHistory.buckets.every((b) => b.count === 0));
  publish(60);
  await scene._sampleBoiler();
  assert.deepEqual(scene._boilerHistory.buckets[0], { sum: 60, count: 1 });
  assert.equal(scene._boilerHistory.buckets[17].count, 0);
  assert.equal(JSON.parse(await fs.readFile(path, "utf8")).date, "2026-10-09");
});

test("persistence round-trip retains sums/counts and batches writes for five minutes", async (t) => {
  const setTime = clock(t);
  timers(t);
  const { scene, publish, ctx, path } = await setup(t);
  publish(45);
  const rename = t.mock.method(fs, "rename");
  for (let minute = 1; minute <= 10; minute++) {
    setTime(`2026-10-08T00:${String(minute).padStart(2, "0")}:00+02:00`);
    await scene._sampleBoiler();
    assert.equal(rename.mock.callCount(), Math.floor(minute / 5));
  }
  const saved = JSON.parse(await fs.readFile(path, "utf8"));
  assert.deepEqual(saved.buckets[0], { sum: 450, count: 10 });
  await scene.destroy(ctx);
  const loaded = Object.create(home2);
  loaded._boilerStatePath = path;
  loaded._logger = logger;
  await loaded._startBoilerHistory();
  assert.deepEqual(loaded._boilerHistory, saved);
  await loaded._stopBoilerHistory();
});

test("bucket changes persist immediately, even inside the five-minute write interval", async (t) => {
  const setTime = clock(t, "2026-10-08T01:19:00+02:00");
  timers(t);
  const { scene, publish, path } = await setup(t);
  publish(30);
  await scene._sampleBoiler();
  await assert.rejects(fs.readFile(path), { code: "ENOENT" });
  setTime("2026-10-08T01:20:00+02:00");
  publish(60);
  await scene._sampleBoiler();
  const saved = JSON.parse(await fs.readFile(path, "utf8"));
  assert.deepEqual(saved.buckets.slice(0, 2), [{ sum: 30, count: 1 }, { sum: 60, count: 1 }]);
});

test("corrupt or malformed histories warn once and start with empty buckets", async (t) => {
  clock(t);
  timers(t);
  for (const content of ["{", JSON.stringify({ date: "2026-10-08", buckets: [] }),
    JSON.stringify({ ...savedDay(), buckets: Array(18).fill({ sum: "60", count: 1 }) }),
    JSON.stringify({ ...savedDay(), buckets: Array(18).fill({ sum: 60, count: -1 }) })]) {
    const { scene, warnings } = await setup(t, { content });
    assert.ok(scene._boilerHistory.buckets.every((b) => b.count === 0));
    assert.equal(warnings.length, 1);
    await scene._saveBoilerHistory(true);
    assert.equal(warnings.length, 1);
  }
});

test("yesterday's file is discarded even when its buckets are valid", async (t) => {
  clock(t);
  timers(t);
  const saved = savedDay("2026-10-07");
  saved.buckets[0] = { sum: 70, count: 1 };
  const { scene } = await setup(t, { content: JSON.stringify(saved) });
  assert.equal(scene._boilerHistory.date, "2026-10-08");
  assert.ok(scene._boilerHistory.buckets.every((b) => b.count === 0));
});

test("atomic persistence writes a sibling temp file before replacing the final file", async (t) => {
  clock(t);
  timers(t);
  const before = JSON.stringify(savedDay());
  const { scene, publish, path } = await setup(t, { content: before });
  publish(55);
  await scene._sampleBoiler();
  const realRename = fs.rename;
  const rename = t.mock.method(fs, "rename", async (from, to) => {
    assert.equal(to, path);
    assert.equal(dirname(from), dirname(path));
    assert.ok(from.endsWith(".tmp"));
    assert.equal(await fs.readFile(path, "utf8"), before);
    assert.equal(JSON.parse(await fs.readFile(from, "utf8")).buckets[0].sum, 55);
    await realRename(from, to);
  });
  await scene._saveBoilerHistory(true);
  assert.equal(rename.mock.callCount(), 1);
  rename.mock.restore();
  assert.deepEqual(await fs.readdir(dirname(path)), ["home2-boiler.json"]);
});

test("rename failures keep the last file, remove temp residue, and do not poison later saves", async (t) => {
  clock(t);
  timers(t);
  const before = JSON.stringify(savedDay());
  const { scene, path, publish, warnings } = await setup(t, { content: before });
  publish(60);
  await scene._sampleBoiler();
  const rename = t.mock.method(fs, "rename", async () => { throw new Error("read-only disk"); });
  await scene._saveBoilerHistory(true);
  await scene._saveBoilerHistory(true);
  assert.equal(warnings.length, 1);
  assert.equal(await fs.readFile(path, "utf8"), before);
  assert.deepEqual(await fs.readdir(dirname(path)), ["home2-boiler.json"]);
  rename.mock.restore();
  await scene._saveBoilerHistory(true);
  assert.equal(JSON.parse(await fs.readFile(path, "utf8")).buckets[0].sum, 60);
});

test("missing and unwritable state paths never break rendering", async (t) => {
  clock(t);
  timers(t);
  const { scene, publish, warnings } = await setup(t);
  assert.equal(warnings.length, 0); // A missing file is the normal first run: silent.
  publish(50);
  await scene._sampleBoiler();
  t.mock.method(fs, "mkdir", async () => { throw new Error("unwritable directory"); });
  await scene._saveBoilerHistory(true);
  await scene._saveBoilerHistory(true);
  const device = new PixooDriver("offline", { logger });
  device.setBrightness = async () => {};
  device.push = async () => {};
  assert.equal(await scene.render(device), 500);
  assert.equal(warnings.length, 1); // one save warning, however often the save fails
  assert.match(warnings[0], /save failed/);
  assert.deepEqual(scene._boilerHistory.buckets[0], { sum: 50, count: 1 });
});

test("destroy after a failed init does not throw", async () => {
  const { default: home2 } = await import("../scenes/pixoo/home2.js");
  const scene = Object.create(home2);
  await scene._stopBoilerHistory(); // nothing started: no save queue, no timer
});

test("destroy flushes unsaved samples, clears timers and ignores late callbacks", async (t) => {
  clock(t);
  const active = timers(t);
  const { scene, publish, ctx, path, handlers, unsubscribed } = await setup(t);
  const sample = active.get(scene._boilerTimer).cb;
  const handle = handlers.get(topic);
  publish(42);
  sample();
  await scene._boilerSave;
  await assert.rejects(fs.readFile(path), { code: "ENOENT" });
  await scene.destroy(ctx);
  assert.equal(active.size, 0);
  assert.equal(scene._boilerTimer, null);
  assert.equal(scene._boilerSampling, false);
  assert.equal(handlers.size, 0);
  assert.equal(unsubscribed(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")).buckets[0], { sum: 42, count: 1 });
  handle('{"temp_c":70}');
  sample();
  assert.equal(scene._s.boilerTempC, 42);
  assert.equal(scene._boilerHistory.buckets[0].count, 1);
});

test("destroy waits for an in-flight write and flushes samples added during it", async (t) => {
  clock(t);
  timers(t);
  const { scene, publish, ctx, path } = await setup(t);
  publish(30);
  await scene._sampleBoiler();
  const realWrite = fs.writeFile;
  let release;
  let started;
  const blocked = new Promise((done) => { release = done; });
  const writing = new Promise((done) => { started = done; });
  const write = t.mock.method(fs, "writeFile", async (...args) => {
    started();
    await blocked;
    return realWrite(...args);
  });
  const first = scene._saveBoilerHistory(true);
  await writing;
  publish(70);
  const sample = scene._sampleBoiler();
  const closing = scene.destroy(ctx);
  release();
  await Promise.all([first, sample, closing]);
  assert.equal(write.mock.callCount(), 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")).buckets[0], { sum: 100, count: 2 });
  assert.equal(scene._boilerDirty, false);
});

test("the default state path is next to the scene rather than the working directory", async (t) => {
  clock(t);
  timers(t);
  const scene = Object.create(home2);
  scene._logger = logger;
  const read = t.mock.method(fs, "readFile", async () => JSON.stringify(savedDay()));
  t.mock.method(scene, "_saveBoilerHistory", async () => {});
  await scene._startBoilerHistory();
  t.after(() => scene._stopBoilerHistory());
  assert.equal(read.mock.calls[0].arguments[0], resolve("scenes/pixoo/.state/home2-boiler.json"));
});
