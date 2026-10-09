import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "node:path";
import * as url from "node:url";
import * as vm from "node:vm";
import { ConfigLoader } from "../lib/config-loader.js";
import { ConfigOverlay } from "../lib/config-overlay.js";
import { SceneLoader, loadSceneMetadata } from "../lib/scene-loader.js";
import { SceneSettingsService } from "../lib/scene-settings-service.js";

async function waitFor(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("startup did not progress");
    await delay(5);
  }
}

async function startup(t, { online = true, overlayIp } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pixd-mqtt-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "clock.mjs"), `export default {
    settingsSchema: { speed: { type: "int", default: 10 } },
    init(context) {
      this.payload = null;
      context.mqtt.subscribe("home/state", (payload) => { this.payload = payload; });
    },
    render() { return 1000; }
  };`);
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    devices: [{ name: "panel", type: "pixoo", ip: "base-ip", scene: "clock" }],
    scenes: { clock: { path: "./clock.mjs" } },
  }));
  const state = { errors: [], subscriptions: [], devices: [], telemetry: [] };
  const proc = new EventEmitter();
  proc.env = { LOG_LEVEL: "error", PIXDCON_CONFIG_PATH: configPath, MOSQUITTO_PASS: "test-placeholder" };
  proc.exit = (code) => { state.exitCode = code; };
  const context = vm.createContext({ process: proc,
    console: { log() {}, info() {}, warn() {}, error(message) { state.errors.push(message); } },
    setTimeout, clearTimeout,
  });
  class FakeMqtt {
    constructor() { state.mqtt = this; this.connected = online; this.baseTopic = "base"; }
    async connect(options) { state.connectOptions = options; return this.connected; }
    async disconnect() { this.connected = false; state.disconnected = true; }
    startPeriodicPublish() { state.periodic = true; }
    publishConfig(config) { state.publishedConfig = config; }
    setRunning() {}
    updateStatus() {}
    updateDeviceStatus() {}
    updateDeviceState() {}
    subscribeDevice() {}
    unsubscribeDevice() {}
    recordError() {}
    subscribeWildcard(namespace, topic, callback) {
      state.subscriptions.push({ namespace, topic, callback });
      if (this.connected && topic === "base/overlay/device/+/ip" && overlayIp !== undefined) {
        callback("base/overlay/device/panel/ip", overlayIp);
      }
    }
    unsubscribeWildcard() {}
    getSceneContext() {
      return { subscribe(topic, callback) { state.sceneCallback = callback; }, unsubscribeAll() {} };
    }
  }
  class FakeDriver {
    async initialize() { return true; }
  }
  class FakeLoop {
    constructor(_driver, loader, sceneName, options) {
      this.loader = loader;
      this.sceneName = sceneName;
      this.options = options;
      state.loops = [...(state.loops || []), this];
    }
    async start() {
      state.scene = await this.loader.load(this.sceneName, this.options.deviceName);
    }
    async stop() { await this.loader.unloadScene(this.sceneName, this.options.deviceName); }
    getStatus() { return { mode: "play" }; }
  }
  class FakeWatcher {
    async start() {}
    stop() {}
  }
  class FakePreview {
    registerDevice(device) { state.devices.push(device); }
    unregisterDevice() {}
  }
  class FakeTelemetry {
    constructor(options) { state.telemetryMqtt = options.mqttService; }
    start(device) { state.telemetry.push(device.name); }
    stop() {}
    stopAll() {}
  }
  class FakeWeb {
    constructor(options) { state.web = options; }
    start() { state.ready = true; }
    stop() {}
  }
  const modules = {
    "../lib/config-loader.js": { ConfigLoader },
    "../lib/scene-loader.js": { SceneLoader, loadSceneMetadata },
    "./render-loop.js": { RenderLoop: FakeLoop },
    "../lib/ulanzi-driver.js": { UlanziDriver: FakeDriver },
    "../lib/pixoo-driver.js": { PixooDriver: FakeDriver },
    "../lib/mqtt-service.js": { MqttService: FakeMqtt },
    "../lib/config-watcher.js": { ConfigWatcher: FakeWatcher },
    "../lib/config-overlay.js": { ConfigOverlay },
    "../lib/scenes-watcher.js": { ScenesWatcher: FakeWatcher },
    "../lib/web-server.js": { WebServer: FakeWeb },
    "../lib/frame-preview-store.js": { FramePreviewStore: FakePreview },
    "../lib/scene-settings-service.js": { SceneSettingsService },
    "../lib/telemetry-collector.js": { TelemetryCollector: FakeTelemetry },
    path, url,
  };
  const indexUrl = new URL("../src/index.js", import.meta.url);
  const entry = new vm.SourceTextModule(await readFile(indexUrl, "utf8"), {
    context, initializeImportMeta(meta) { meta.url = indexUrl.href; },
  });
  await entry.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `unmocked dependency: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await entry.evaluate();
  t.after(async () => {
    proc.emit("SIGTERM");
    await waitFor(() => state.exitCode !== undefined);
  });
  await waitFor(() => state.ready && state.scene);
  return state;
}

if (typeof vm.SourceTextModule !== "function") {
  test("MQTT startup integration in an isolated module VM", async () => {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--experimental-vm-modules", "--test", url.fileURLToPath(import.meta.url),
    ], { timeout: 10_000, env: childEnv });
    assert.match(stdout, /(?:tests 3|# tests 3)/);
  });
} else {
  test("startup keeps offline MQTT attached to every dependent service", async (t) => {
    const state = await startup(t, { online: false });
    assert.equal(state.connectOptions.keepReconnecting, true);
    assert.equal(state.connectOptions.timeoutMs, 5000);
    assert.equal(state.web.mqttService, state.mqtt);
    assert.equal(state.telemetryMqtt, state.mqtt);
    assert.equal(state.loops[0].options.mqttService, state.mqtt);
    assert.ok(state.periodic);
    assert.deepEqual(state.telemetry, ["panel"]);
    assert.ok(state.subscriptions.some(({ namespace }) => namespace === "_config_overlay"));
    const settings = state.subscriptions.find(({ namespace }) => namespace === "_scene_settings_service");
    assert.ok(settings);
    state.mqtt.connected = true;
    state.sceneCallback("retained-late");
    settings.callback("pixdcon/panel/clock/settings/speed", "42");
    assert.equal(state.scene.payload, "retained-late");
    assert.equal(state.web.getSceneSettingsState().panel.clock.effective.speed, 42);
    const overlay = state.subscriptions.find(({ topic }) => topic === "base/overlay/device/+/ip");
    overlay.callback("base/overlay/device/panel/ip", "late-ip");
    await waitFor(() => state.web.getEffectiveConfig().devices[0].ip === "late-ip");
    assert.equal(state.errors.length, 0);
  });

  test("invalid retained startup overlay logs once and keeps the base device running", async (t) => {
    const state = await startup(t, { overlayIp: "   " });
    assert.equal(state.web.getEffectiveConfig().devices[0].ip, "base-ip");
    assert.equal(state.devices[0].ip, "base-ip");
    assert.ok(state.errors.some((message) => message.includes("Invalid startup overlay")));
    const overlay = state.subscriptions.find(({ topic }) => topic === "base/overlay/device/+/ip");
    overlay.callback("base/overlay/device/panel/ip", "fixed-ip");
    await waitFor(() => state.web.getEffectiveConfig().devices[0].ip === "fixed-ip");
  });

  test("valid retained startup overlay is validated and used for the first device", async (t) => {
    const state = await startup(t, { overlayIp: "overlay-ip" });
    assert.equal(state.web.getEffectiveConfig().devices[0].ip, "overlay-ip");
    assert.equal(state.devices[0].ip, "overlay-ip");
    assert.equal(state.publishedConfig.devices[0].ip, "overlay-ip");
    assert.equal(state.errors.length, 0);
  });
}
