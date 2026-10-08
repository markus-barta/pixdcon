import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SceneLoader } from "../lib/scene-loader.js";
import { MqttService } from "../lib/mqtt-service.js";
import { EventEmitter } from "node:events";
import { SceneSettingsService } from "../lib/scene-settings-service.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

async function fixture(source = "export default { version: 1, render() {} };") {
  const dir = await mkdtemp(join(tmpdir(), "pixd47-core-loader-"));
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  const path = join(dir, "scene.js");
  await writeFile(path, source);
  return { dir, path, loader: new SceneLoader(dir, { clock: { path } }, { logger }) };
}

test("all devices get the new module after scene eviction", async () => {
  const { path, loader } = await fixture();
  await loader.load("clock", "one");
  await loader.load("clock", "two");
  await writeFile(path, "export default { version: 2, render() {} };");
  await loader.clearScene("clock");
  assert.equal((await loader.load("clock", "one")).version, 2);
  assert.equal((await loader.load("clock", "two")).version, 2);
});

test("per-device eviction detection survives another device reloading first", async () => {
  const { loader } = await fixture();
  const old = await loader.load("clock", "two");
  await loader.clearScene("clock");
  await loader.load("clock", "one");
  assert.equal(loader.isLoaded("clock", "two", old), false);
});

test("failed init is cleaned up and retried rather than cached", async () => {
  const { loader } = await fixture(`export default {
    async init() { throw new Error("init failed"); },
    render() {},
    destroy() { globalThis.__coreDestroyed = (globalThis.__coreDestroyed || 0) + 1; },
  };`);
  globalThis.__coreDestroyed = 0;
  try {
    await assert.rejects(loader.load("clock", "one"), /init failed/);
    assert.equal(loader.isLoaded("clock", "one"), false);
    assert.equal(globalThis.__coreDestroyed, 1);
    await assert.rejects(loader.load("clock", "one"), /init failed/);
    assert.equal(globalThis.__coreDestroyed, 2);
  } finally {
    delete globalThis.__coreDestroyed;
  }
});

test("MQTT wildcard cleanup removes the evicted scene but keeps other owners", async () => {
  const { dir, path } = await fixture(`export default {
    init(ctx) { ctx.mqtt.subscribeWildcard("sensors/+", () => {}); },
    render() {},
    destroy(ctx) { ctx.mqtt.unsubscribeAll(); },
  };`);
  const mqtt = new MqttService({ logger });
  mqtt.client = new EventEmitter();
  mqtt.client.subscribe = (_topic, _options, callback) => callback();
  const unsubscribed = [];
  mqtt.client.unsubscribe = (topic) => unsubscribed.push(topic);
  mqtt.connected = true;
  const loader = new SceneLoader(dir, { clock: { path }, other: { path } }, {
    logger, mqttService: mqtt,
  });
  await loader.load("clock", "one");
  await loader.load("clock", "two");
  await loader.load("other", "three");
  await loader.clearScene("clock");
  assert.deepEqual([...mqtt._wildcardEntries.get("sensors/+").callbacks.keys()], ["other__three"]);
  assert.equal(mqtt.client.listenerCount("message"), 1);
  assert.deepEqual(unsubscribed, []);
  await loader.clearCache();
  assert.equal(mqtt._wildcardEntries.size, 0);
  assert.equal(mqtt.client.listenerCount("message"), 0);
  assert.deepEqual(unsubscribed, ["sensors/+"]);
});

test("scene URLs handle spaces and URL metacharacters in configured paths", async () => {
  const { dir } = await fixture();
  const path = join(dir, "scene #?.js");
  await writeFile(path, "export default { render() { return 123; } };");
  const loader = new SceneLoader(dir, { special: { path } }, { logger });
  assert.equal((await loader.load("special", "one")).render(), 123);
});

test("a new loader reimports changed files during a config reload", async () => {
  const { dir, path, loader } = await fixture();
  await loader.load("clock", "one");
  await writeFile(path, "export default { version: 2, render() {} };");
  await loader.clearCache();
  const next = new SceneLoader(dir, { clock: { path } }, { logger });
  assert.equal((await next.load("clock", "one")).version, 2);
});

test("settings subscribers are released even if destroy throws", async () => {
  const { dir, path } = await fixture(`export default {
    init(ctx) { ctx.settings.subscribe(() => {}); },
    render() {}, destroy() { throw new Error("destroy failed"); },
  };`);
  const service = new SceneSettingsService({ logger });
  const loader = new SceneLoader(dir, { clock: { path } }, {
    logger, sceneSettingsService: service,
  });
  await loader.load("clock", "one");
  assert.equal(service.watchers.size, 1);
  await loader.clearScene("clock");
  assert.equal(service.watchers.size, 0);
});

test("identical basenames in different directories match only the changed scene", () => {
  const loader = new SceneLoader("/data", {
    original: { path: "scenes/pixoo/home.js" },
    cloned: { path: "generated-scenes/pixoo/home.js" },
  }, { logger });
  assert.deepEqual(loader.findScenesByFilename("home.js", "/data/generated-scenes/pixoo"), ["cloned"]);
});
