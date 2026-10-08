import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rename, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeSettingValue, SceneSettingsService } from "../lib/scene-settings-service.js";
import { ConfigWatcher } from "../lib/config-watcher.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

for (const type of ["int", "float"]) {
  test(`${type} settings accept complete decimal numbers and reject numeric prefixes`, () => {
    const schema = { type };
    for (const raw of ["10bad", "10 bad", "10.2px", "1e", "1e+", "1.2.3", "", " ", "0x10", "Infinity", "NaN", true, null, [], {}, NaN, Infinity]) {
      assert.equal(normalizeSettingValue(raw, schema), null, `accepted ${JSON.stringify(raw)}`);
    }
    for (const raw of [10, "10", " 10 ", "+10", "1e1", "10."]) {
      assert.equal(normalizeSettingValue(raw, schema), 10);
    }
    for (const raw of [10.8, "10.8", " 10.8 "]) {
      assert.equal(normalizeSettingValue(raw, schema), type === "int" ? 10 : 10.8);
    }
    assert.equal(normalizeSettingValue(-10.8, schema), type === "int" ? -10 : -10.8);
    assert.equal(normalizeSettingValue(".5", schema), type === "int" ? 0 : 0.5);
    assert.equal(normalizeSettingValue("200", { type, min: 0, max: 100 }), 100);
  });
}

test("persisted numeric settings survive while invalid MQTT numeric payloads leave them in place", () => {
  const service = new SceneSettingsService({
    logger,
    getConfig: () => ({ devices: [{ name: "panel", scene: "clock", sceneSettings: {
      clock: { speed: " 10 ", temperature: 10.8 },
    } }] }),
    getSceneMetadata: () => ({ clock: { settingsSchema: {
      speed: { type: "int", default: 5 }, temperature: { type: "float", default: 5 },
    } } }),
  });
  service._handleOverlayMessage("pixdcon/panel/clock/settings/speed", "42bad");
  service._handleOverlayMessage("pixdcon/panel/clock/settings/temperature", "42.2bad");
  assert.deepEqual(service.getEffectiveValues("panel", "clock"), { speed: 10, temperature: 10.8 });
  service._handleOverlayMessage("pixdcon/panel/clock/settings/speed", " 42 ");
  assert.equal(service.getEffectiveValues("panel", "clock").speed, 42);
});

test("missing config retries grow to 5 s, warn once per gap, and recover watching", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pixd-mqtt-config-gap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  await writeFile(path, "old");
  const warnings = [];
  const changes = [];
  const watcher = new ConfigWatcher(path, (content) => changes.push(content), {
    logger: { ...logger, warn: (message) => warnings.push(message) },
  });
  t.after(() => watcher.stop());
  await watcher.start();
  await rename(path, join(dir, "old.json"));
  // Let the OS emit rename, then accelerate only timer delays. The callbacks
  // still stat/read/re-arm the real filesystem, using the production logic.
  await delay(30);
  const schedule = watcher._scheduleReload.bind(watcher);
  const scheduledDelays = [];
  t.mock.method(watcher, "_scheduleReload", (delayMs = 500) => {
    scheduledDelays.push(delayMs);
    schedule(1);
  });
  watcher._scheduleReload();
  const waitFor = async (check) => {
    const deadline = Date.now() + 1500;
    while (!check()) {
      if (Date.now() > deadline) assert.fail("config watcher failed to progress");
      await delay(5);
    }
  };
  await waitFor(() => scheduledDelays.length >= 7);
  assert.deepEqual(scheduledDelays.slice(0, 7), [500, 1000, 2000, 4000, 5000, 5000, 5000]);
  assert.equal(warnings.length, 1);
  await writeFile(path, "new");
  await waitFor(() => changes.includes("new"));
  assert.equal(watcher._retryDelayMs, 500);
  assert.equal(watcher._missingWarned, false);
  assert.ok(watcher.watcher);
  await writeFile(path, "last");
  await waitFor(() => changes.includes("last"));
  assert.deepEqual(changes, ["new", "last"]);
  await rename(path, join(dir, "last.json"));
  await waitFor(() => warnings.length === 2);
  await watcher.stop();
  await delay(20);
  assert.equal(watcher.debounceTimer, null);
  assert.equal(watcher.watcher, null);
  assert.equal(warnings.length, 2);
});
