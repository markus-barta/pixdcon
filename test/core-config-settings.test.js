import test from "node:test";
import assert from "node:assert/strict";
import { ConfigLoader } from "../lib/config-loader.js";
import { ConfigOverlay } from "../lib/config-overlay.js";
import {
  normalizeSettingValue,
  SceneSettingsService,
} from "../lib/scene-settings-service.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const base = {
  devices: [{ name: "panel", type: "pixoo", ip: "file", scene: "clock" }],
  scenes: { clock: { path: "./clock.js" } },
};

test("config rejects non-string scenes and malformed scene paths", () => {
  const loader = new ConfigLoader("unused");
  for (const scene of [123, {}, [], false, 0]) {
    assert.throws(() => loader.parse(JSON.stringify({
      ...base, devices: [{ ...base.devices[0], scene }],
    })), /Invalid scene/);
  }
  assert.equal(loader.parse(JSON.stringify(base)).devices[0].scene, "clock");
  assert.equal(loader.parse(JSON.stringify({
    ...base, devices: [{ ...base.devices[0], scene: null }],
  })).devices[0].scene, null);
  assert.throws(() => loader.parse(JSON.stringify({
    ...base, scenes: { clock: { path: 42 } },
  })), /Invalid.*path/);
});

test("malformed overlay entries warn and preserve file/blob/granular precedence", () => {
  const warnings = [];
  const overlay = new ConfigOverlay(null, "base", async () => {}, {
    logger: { ...logger, warn: (message) => warnings.push(message) },
  });
  overlay._blobPatch = {
    devices: [null, 42, "bad", {}, { name: "panel", ip: "blob", scene: 123 }],
    scenes: { invalid: null, clock: { path: 42 } },
  };
  assert.doesNotThrow(() => overlay.merge(base));
  assert.equal(overlay.merge(base).devices[0].scene, "clock");
  assert.ok(warnings.length > 0);
  overlay._blobPatch = { devices: {} };
  assert.doesNotThrow(() => overlay.merge(base));
  overlay._blobPatch = {
    devices: [{ name: "panel", ip: "blob" }],
    scenes: { clock: { path: "./blob.js" } },
  };
  overlay._devicePatches.set("panel", { ip: "granular" });
  overlay._scenePatches.clock = { path: "./granular.js" };
  const merged = overlay.merge(base);
  assert.equal(merged.devices[0].ip, "granular");
  assert.equal(merged.scenes.clock.path, "./granular.js");
  assert.equal(base.devices[0].ip, "file");
});

test("a throwing initial settings subscriber is removed", () => {
  const service = new SceneSettingsService({ logger });
  assert.throws(() => service.createRuntimeContext("panel", "clock").subscribe(() => {
    throw new Error("subscriber failed");
  }), /subscriber failed/);
  assert.equal(service.watchers.size, 0);
});

test("settings preserve ordinary numeric strings, fractions and clamp behavior", () => {
  const int = { type: "int", min: 0, max: 100 };
  assert.equal(normalizeSettingValue("10", int), 10);
  assert.equal(normalizeSettingValue("10.8", int), 10);
  assert.equal(normalizeSettingValue(" 20 ", int), 20);
  assert.equal(normalizeSettingValue("200", int), 100);
});

test("overlay debounce accepts synchronous callbacks and catches their failures", async () => {
  const called = [];
  const finished = [];
  for (const throws of [false, true]) {
    const overlay = new ConfigOverlay(null, "base", () => {
      called.push(throws);
      if (throws) throw new Error("callback failed");
    }, {
      debounceMs: 1,
      logger: { ...logger, error: (message) => finished.push(message) },
    });
    overlay._scheduleChange();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(called, [false, true]);
  assert.equal(finished.length, 1);
});
