/**
 * PIXD-122: the v1 funkeykid scene through its real loader, settings, MQTT
 * service and HTTP driver. Reuse the existing loopback broker/display peers;
 * no second scene implementation or stricter subscription fake.
 * Owner: shared-scene fixtures (W5).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startMemoryBroker } from "../../dev/memory-broker.js";
import { startFakePixoo } from "../../dev/fake-pixoo.js";
import { cleanupStack, requireNetGuard } from "../helpers/harness.js";
import { silentLogger } from "../helpers/scene-context.js";
import {
  installSharedResolution,
  sharedPaths,
} from "../../src/scenes/v1-shared.js";

const INFO = "home/hsb1/funkeykid/keyboard-info";
const DISPLAY = "home/hsb1/funkeykid/display";
const LIVE = {
  online: true,
  connected: true,
  exclusive: true,
  battery_level: 80,
  battery_low: false,
  heartbeat_s: 10,
  timestamp: 1, // Another machine's clock must not make a live message stale.
};

/** @param {() => unknown} condition @param {string} [note] */
async function until(condition, note = "loopback delivery") {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, note);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** @param {Uint8Array} frame @param {number} x @param {number} y */
function pixel(frame, x, y) {
  return [...frame.slice((y * 64 + x) * 3, (y * 64 + x) * 3 + 3)];
}

/** Assert the visible status word, independently rasterized from pixdcon's font.
 * @param {Uint8Array} frame @param {string} word @param {number[]} color
 */
async function status(frame, word, color) {
  const { libDir } = sharedPaths();
  const { BITMAP_FONT } = await import(
    pathToFileURL(join(libDir, "pixoo-font.js")).href
  );
  const left = Math.round(32 - (word.length * 4 - 1) / 2);
  const expected = new Uint8Array(64 * 64 * 3);
  for (let i = 0; i < word.length; i++) {
    const glyph = BITMAP_FONT[word[i]];
    for (let k = 0; k < 15; k++) {
      if (glyph[k])
        expected.set(
          color,
          ((1 + Math.floor(k / 3)) * 64 + left + i * 4 + (k % 3)) * 3,
        );
    }
  }
  for (let y = 1; y <= 5; y++) {
    assert.deepEqual(
      frame.slice((y * 64 + 12) * 3, (y * 64 + 51) * 3),
      expected.slice((y * 64 + 12) * 3, (y * 64 + 51) * 3),
      `${word}, row ${y}`,
    );
  }
}

/** @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>|null} [retained]
 */
async function v1(t, retained = LIVE) {
  requireNetGuard();
  installSharedResolution();
  const { root, libDir } = sharedPaths();
  const load = (/** @type {string} */ file) =>
    import(pathToFileURL(join(libDir, file)).href);
  const [
    { SceneLoader, loadSceneMetadata },
    { MqttService },
    { PixooDriver },
    { SceneSettingsService },
  ] = await Promise.all([
    load("scene-loader.js"),
    load("mqtt-service.js"),
    load("pixoo-driver.js"),
    load("scene-settings-service.js"),
  ]);
  const cleanup = cleanupStack();
  t.after(() => cleanup.run());
  const broker = await startMemoryBroker();
  cleanup.add("broker", () => broker.stop());
  const pixoo = await startFakePixoo();
  cleanup.add("display", () => pixoo.stop());
  const mqtt = new MqttService({
    host: broker.host,
    port: broker.port,
    logger: silentLogger,
  });
  cleanup.add("v1 MQTT", () => mqtt.disconnect());
  await mqtt.connect();
  if (retained)
    await broker.inject(INFO, JSON.stringify(retained), { retain: true });

  let now = Date.parse("2026-11-24T20:00:00Z");
  t.mock.method(Date, "now", () => now);
  const scenes = { funkeykid: { path: "./scenes/pixoo/funkeykid.js" } };
  const config = {
    devices: [
      {
        name: "pixoo-189",
        sceneSettings: {
          funkeykid: { idle_timeout_ms: 5000 },
        },
      },
    ],
  };
  const metadata = await loadSceneMetadata(root, scenes, {
    logger: silentLogger,
  });
  const settings = new SceneSettingsService({
    getConfig: () => config,
    getSceneMetadata: () => metadata,
    logger: silentLogger,
  });
  cleanup.add("settings", () => settings.stop());
  const loader = new SceneLoader(root, scenes, {
    mqttService: mqtt,
    sceneSettingsService: settings,
    logger: silentLogger,
  });
  cleanup.add("loader", () => loader.clearCache());
  const scene = await loader.load("funkeykid", "pixoo-189");
  if (retained)
    await until(
      () => scene._keyboardInfo !== null,
      "initial retained snapshot",
    );
  const driver = new PixooDriver(pixoo.address, { logger: silentLogger });
  assert.equal(await driver.initialize(), true);

  /** Observe the real MQTT client's delivery after the scene's shared handler.
   * @param {string} topic @param {string|Record<string, unknown>} payload */
  async function publish(topic, payload) {
    const text =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    let received = false;
    const observe = (
      /** @type {string} */ name,
      /** @type {Buffer} */ body,
    ) => {
      if (name === topic && body.toString() === text) received = true;
    };
    mqtt.client.on("message", observe);
    try {
      await broker.inject(topic, text, { retain: topic === INFO });
      await until(() => received);
      // Display image loads are asynchronous; the real callback is not awaited
      // by MqttService's fan-out. Drain I/O rather than assuming it is synchronous.
      for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setImmediate(resolve));
    } finally {
      mqtt.client.off("message", observe);
    }
  }
  return {
    scene,
    loader,
    mqtt,
    pixoo,
    driver,
    config,
    settings,
    cleanup,
    advance(/** @type {number} */ ms) {
      now += ms;
    },
    info(/** @type {Record<string, unknown>} */ patch) {
      return publish(INFO, { ...LIVE, ...patch });
    },
    publish,
    async render() {
      const delay = await scene.render(driver);
      const frame = pixoo.state().lastFrame;
      assert.ok(frame, "real v1 push reached the loopback HTTP display");
      assert.deepEqual(frame, driver.buf, "wire RGB is the real v1 buffer");
      return { delay, frame: frame.slice() };
    },
  };
}

test("v1 funkeykid: retained Ready, Searching and the one-shot wake use reception time, not frame count", async (t) => {
  const f = await v1(t);
  await status((await f.render()).frame, "bereit", [90, 225, 130]);
  await f.info({ connected: false, exclusive: false });
  await status((await f.render()).frame, "suche", [140, 140, 168]);
  f.advance(100);
  await f.info({});
  f.advance(800);
  await status((await f.render()).frame, "verbinde", [110, 170, 255]);
  const before = (await f.render()).frame;
  assert.deepEqual(
    (await f.render()).frame,
    before,
    "same time, any frame count",
  );
  assert.deepEqual(
    pixel(before, 52, 1),
    [0, 0, 0],
    "battery hidden early in wake",
  );
  await f.info({}); // A heartbeat must not restart waking.
  f.advance(1050);
  await status((await f.render()).frame, "hallo!", [255, 220, 80]);
  assert.deepEqual(pixel((await f.render()).frame, 52, 1), [150, 150, 162]);
  f.advance(749);
  await status((await f.render()).frame, "hallo!", [255, 220, 80]);
  f.advance(1);
  await status((await f.render()).frame, "bereit", [90, 225, 130]);
});

test("v1 funkeykid: unsafe outranks low battery and waking; last-will is immediately offline and still", async (t) => {
  const f = await v1(t, { ...LIVE, connected: false });
  await f.info({ exclusive: false, battery_low: true });
  const on = (await f.render()).frame;
  await status(on, "achtung", [255, 70, 60]);
  assert.deepEqual(pixel(on, 0, 8), [255, 50, 40]);
  f.advance(400);
  const off = (await f.render()).frame;
  await status(off, "achtung", [89, 24, 21]);
  assert.deepEqual(
    pixel(off, 0, 8),
    [0, 0, 0],
    "border blinks without hiding the warning",
  );
  await f.info({
    online: false,
    connected: false,
    exclusive: false,
    battery_level: null,
  });
  const offline = (await f.render()).frame;
  await status(offline, "offline", [95, 95, 105]);
  f.advance(4567);
  assert.deepEqual(
    (await f.render()).frame,
    offline,
    "offline art stays still",
  );
});

test("v1 funkeykid: three missed advertised beats expire status, malformed messages do not refresh it, recovery wakes", async (t) => {
  const f = await v1(t, { ...LIVE, heartbeat_s: 2 });
  f.advance(5999);
  await status((await f.render()).frame, "bereit", [90, 225, 130]);
  for (const bad of [
    "{",
    "null",
    "[]",
    "{}",
    '{"online":true,"connected":"false"}',
    '{"online":true,"connected":true,"exclusive":"yes"}',
  ]) {
    await f.publish(INFO, bad);
  }
  f.advance(1);
  await status((await f.render()).frame, "offline", [95, 95, 105]);
  await f.info({ heartbeat_s: 2 });
  await status((await f.render()).frame, "verbinde", [110, 170, 255]);
  f.advance(2600);
  await f.info({ heartbeat_s: 2 });
  f.advance(5999);
  await status((await f.render()).frame, "bereit", [90, 225, 130]);
  f.advance(1);
  await status((await f.render()).frame, "offline", [95, 95, 105]);
});

test("v1 funkeykid: unknown and zero battery, producer low flag, and invalid heartbeat fallback", async (t) => {
  const f = await v1(t);
  for (const level of [null, undefined, "80", -1, 101]) {
    await f.info({ battery_level: level });
    assert.deepEqual(
      pixel((await f.render()).frame, 52, 1),
      [0, 0, 0],
      String(level),
    );
  }
  await f.info({ battery_level: 0, battery_low: false });
  const zero = (await f.render()).frame;
  await status(zero, "bereit", [90, 225, 130]);
  assert.deepEqual(
    pixel(zero, 53, 2),
    [255, 180, 40],
    "zero is known; no invented low threshold",
  );
  await f.info({ battery_level: 80, battery_low: true });
  const low = (await f.render()).frame;
  await status(low, "akku!", [255, 170, 60]);
  assert.deepEqual(
    pixel(low, 53, 2),
    [255, 60, 50],
    "producer flag governs low colour",
  );
  await f.info({ battery_level: null, battery_low: true });
  await status((await f.render()).frame, "akku!", [255, 170, 60]);
  assert.deepEqual(pixel((await f.render()).frame, 52, 1), [0, 0, 0]);
  await f.info({ exclusive: undefined });
  await status((await f.render()).frame, "achtung", [255, 70, 60]);
  for (const beat of [0, -1, "10", null, 1e308]) {
    await f.info({ heartbeat_s: beat });
    f.advance(29999);
    await status((await f.render()).frame, "bereit", [90, 225, 130]);
    f.advance(1);
    await status((await f.render()).frame, "offline", [95, 95, 105]);
    // Finish the next recovery wake before checking the next fallback.
    await f.info({});
    f.advance(2600);
  }
});

test("v1 funkeykid: disconnected/unsafe status covers old pictures; volume and connected letter/idle paths retain priority and pixels", async (t) => {
  const f = await v1(t);
  await f.publish(DISPLAY, {
    letter: "A",
    word: "Affe",
    image: "a_affe.png",
    color: "#FF8800",
  });
  await until(() => f.scene._currentImage !== null, "keypress image loaded");
  const active = await f.render();
  assert.equal(active.delay, 200);
  await f.info({ connected: false });
  await status((await f.render()).frame, "suche", [140, 140, 168]);
  await f.publish(DISPLAY, {
    bar: true,
    percent: 70,
    bars_total: 10,
    bars_filled: 7,
  });
  const volume = await f.render();
  assert.equal(volume.delay, 60);
  assert.equal(f.scene._currentLetter, "A");
  f.advance(1500);
  await status((await f.render()).frame, "suche", [140, 140, 168]);
  await f.info({ exclusive: false });
  await status((await f.render()).frame, "achtung", [89, 24, 21]);
  await f.info({});
  assert.deepEqual(
    (await f.render()).frame,
    active.frame,
    "letter path resumes unchanged",
  );
  f.advance(6000);
  const idle = await f.render();
  assert.equal(idle.delay, 1000);
  assert.notDeepEqual(idle.frame, active.frame);
  await f.info({ online: false });
  await status((await f.render()).frame, "offline", [95, 95, 105]);
  await f.info({});
  assert.deepEqual(
    (await f.render()).frame,
    idle.frame,
    "connected idle image remains unchanged",
  );
});

test("v1 funkeykid: no retained status starts offline; display still works before a status snapshot", async (t) => {
  const f = await v1(t, null);
  await status((await f.render()).frame, "offline", [95, 95, 105]);
  await f.publish(DISPLAY, { letter: "A", word: "Affe", color: "#FFCC00" });
  await until(() => f.scene._currentLetter === "A");
  assert.equal((await f.render()).delay, 200);
  assert.deepEqual(pixel((await f.render()).frame, 8, 2), [255, 204, 0]);
});

test("v1 funkeykid: device instances own their status, cleanup fences late callbacks, config reload replays retained status", async (t) => {
  const f = await v1(t);
  const other = await f.loader.load("funkeykid", "second-panel");
  await until(() => other._keyboardInfo !== null);
  assert.notEqual(f.scene._keyboardInfo, other._keyboardInfo);
  assert.notEqual(f.scene._startPixels, other._startPixels);
  const oldCallback = f.mqtt._topicEntries
    .get(INFO)
    .callbacks.get("funkeykid__pixoo-189");
  assert.equal(typeof oldCallback, "function");
  await f.loader.unloadScene("funkeykid", "pixoo-189");
  oldCallback(JSON.stringify({ ...LIVE, connected: false }));
  assert.equal(
    f.scene._keyboardInfo,
    null,
    "a queued callback cannot resurrect a destroyed scene",
  );
  await f.info({ connected: false });
  assert.equal(
    other._keyboardInfo.connected,
    false,
    "the other subscriber survives teardown",
  );
  assert.equal(f.scene._keyboardInfo, null);
  await f.loader.clearCache();
  assert.equal(f.mqtt._subscriptions.size, 0);
  assert.equal(f.settings.watchers.size, 0);
  f.config.devices[0].sceneSettings.funkeykid.idle_timeout_ms = 12000;
  // ConfigWatcher rebuilds the loader as part of PIXD-75's lifecycle queue.
  const Loader = f.loader.constructor;
  const next = new Loader(f.loader.baseDir, f.loader.scenesMap, {
    mqttService: f.mqtt,
    sceneSettingsService: f.settings,
    logger: silentLogger,
  });
  f.cleanup.add("reloaded loader", () => next.clearCache());
  const fresh = await next.load("funkeykid", "pixoo-189");
  await until(
    () => fresh._keyboardInfo !== null,
    "retained replay after config reload",
  );
  assert.equal(fresh._settings.idle_timeout_ms, 12000);
  await fresh.render(f.driver);
  const frame = f.pixoo.state().lastFrame;
  assert.ok(frame);
  await status(frame, "suche", [140, 140, 168]);
});

test("v1 funkeykid: real RenderLoop sends status frames and releases MQTT ownership on stop", async (t) => {
  const f = await v1(t);
  const { root } = sharedPaths();
  const { RenderLoop } = await import(
    pathToFileURL(join(root, "src/render-loop.js")).href
  );
  const loop = new RenderLoop(f.driver, f.loader, "funkeykid", {
    deviceName: "pixoo-189",
    minFrameMs: 10,
    logger: silentLogger,
  });
  f.cleanup.add("render loop", () => loop.stop());
  const running = loop.start();
  await until(() => f.pixoo.state().frames > 0);
  await f.info({ connected: false });
  const count = f.pixoo.state().frames;
  await until(() => f.pixoo.state().frames > count);
  const frame = f.pixoo.state().lastFrame;
  assert.ok(frame);
  await status(frame, "suche", [140, 140, 168]);
  await loop.stop();
  await running;
  assert.equal(f.mqtt._subscriptions.size, 0);
  assert.equal(f.settings.watchers.size, 0);
});
