import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import * as vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "node:path";
import * as url from "node:url";
import { ConfigLoader } from "../lib/config-loader.js";
import { ConfigOverlay, recomputeWithSavedSceneSettings } from "../lib/config-overlay.js";
import { RenderLoop } from "../src/render-loop.js";
import { SceneSettingsService } from "../lib/scene-settings-service.js";

const { createContext, SourceTextModule, SyntheticModule } = vm;

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function waitFor(check) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("lifecycle did not progress");
    await delay(5);
  }
}

async function harness(options = {}) {
  const events = [];
  const exited = deferred();
  const state = { events, exited, inFrame: false, initializations: 0 };
  const config = {
    devices: [{ name: "panel", type: "pixoo", ip: "one", scene: options.scene || "clock" }],
    scenes: { clock: { path: "./clock.js" } },
  };
  const proc = new EventEmitter();
  proc.env = { LOG_LEVEL: "error", PIXDCON_CONFIG_PATH: "/data/config.json", MOSQUITTO_PASS: "test-placeholder" };
  proc.exit = (code) => { events.push(`exit:${code}`); exited.resolve(code); };
  state.proc = proc;
  const context = createContext({
    process: proc,
    console: { log() {}, info() {}, warn() {}, error(message) { events.push(`error:${message}`); } },
    setTimeout, clearTimeout,
  });

  class FakeConfigLoader extends ConfigLoader {
    async load() { return this.parse(JSON.stringify(config)); }
  }
  class FakeMqtt {
    constructor() { this.connected = true; this.baseTopic = "base"; state.mqtt = this; }
    async connect() { if (options.mqttFails) throw new Error("offline"); }
    async disconnect() { events.push("disconnect"); }
    startPeriodicPublish() {}
    publishConfig() {}
    setRunning() {}
    updateStatus() {}
    updateDeviceStatus() {}
    subscribeDevice() {}
    unsubscribeDevice() {}
    recordError() {}
    subscribeWildcard(namespace, _topic, callback) {
      if (namespace === "_scene_settings_service") {
        callback("pixdcon/panel/clock/settings/speed", "42");
      }
    }
    unsubscribeWildcard() {}
  }
  class FakeDriver {
    constructor(ip) { this.ip = ip; this.initialized = true; }
    async initialize() {
      state.initializations++;
      events.push(`init:${this.ip}`);
      if (options.initializeGate) await options.initializeGate.promise;
      return true;
    }
    async setBrightness() {}
    async setScreen() {}
    async setChannel() {
      state.inBuiltin = true;
      if (options.builtinGate) await options.builtinGate.promise;
    }
    async clear() {}
  }
  class FakeSceneLoader {
    constructor(_base, _scenes, loaderOptions) {
      this.cache = new Map();
      state.settings = loaderOptions.sceneSettingsService;
      events.push("loader");
    }
    getSceneDirs() { return ["/data"]; }
    findScenesByFilename() { return ["clock"]; }
    async load(name, device) {
      const key = `${name}:${device}`;
      if (this.cache.has(key)) return this.cache.get(key);
      const scene = {
        async render() {
          state.inFrame = true;
          if (options.frameGate) await options.frameGate.promise;
          state.inFrame = false;
          return 60_000;
        },
      };
      this.cache.set(key, scene);
      return scene;
    }
    isLoaded(name, device, scene) { return this.cache.get(`${name}:${device}`) === scene; }
    async unloadScene(name, device) {
      if (this.cache.delete(`${name}:${device}`)) {
        events.push(state.inFrame ? "destroy-during-frame" : "destroy");
      }
    }
    async clearCache() { assert.equal(this.cache.size, 0); }
    async clearScene() { assert.equal(this.cache.size, 0); events.push("clear-scene"); }
  }
  class FakeConfigWatcher {
    constructor(_path, callback) { state.reload = callback; }
    async start() {}
    async stop() { events.push("config-stop"); }
  }
  class FakeScenesWatcher {
    constructor(_dirs, callback) { state.sceneReload = callback; }
    start() {}
    stop() { events.push("scenes-stop"); }
  }
  class FakePreview {
    registerDevice() {}
    unregisterDevice() {}
  }
  class FakeTelemetry {
    start() {}
    stop() {}
    stopAll() {}
  }
  class FakeWebServer {
    constructor(webOptions) { state.web = webOptions; }
    start() { state.ready = true; }
    stop() { events.push("web-stop"); }
  }
  const modules = {
    "../lib/config-loader.js": { ConfigLoader: FakeConfigLoader },
    "../lib/scene-loader.js": {
      SceneLoader: FakeSceneLoader,
      async loadSceneMetadata() {
        events.push("metadata");
        return { clock: { settingsSchema: { speed: { type: "int", default: 1 } } } };
      },
    },
    "./render-loop.js": { RenderLoop },
    "../lib/ulanzi-driver.js": { UlanziDriver: FakeDriver },
    "../lib/pixoo-driver.js": { PixooDriver: FakeDriver },
    "../lib/mqtt-service.js": { MqttService: FakeMqtt },
    "../lib/config-watcher.js": { ConfigWatcher: FakeConfigWatcher },
    "../lib/config-overlay.js": { ConfigOverlay, recomputeWithSavedSceneSettings },
    "../lib/scenes-watcher.js": { ScenesWatcher: FakeScenesWatcher },
    "../lib/web-server.js": { WebServer: FakeWebServer },
    "../lib/frame-preview-store.js": { FramePreviewStore: FakePreview },
    "../lib/scene-settings-service.js": { SceneSettingsService },
    "../lib/telemetry-collector.js": { TelemetryCollector: FakeTelemetry },
    path, url,
  };
  const indexUrl = new URL("../src/index.js", import.meta.url);
  const entry = new SourceTextModule(await readFile(indexUrl, "utf8"), {
    context, initializeImportMeta(meta) { meta.url = indexUrl.href; },
  });
  await entry.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `unmocked dependency: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await entry.evaluate();
  return state;
}

if (typeof SourceTextModule !== "function") {
  test("startup/reload/shutdown integration in an isolated module VM", async () => {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--experimental-vm-modules", "--test", url.fileURLToPath(import.meta.url),
    ], { timeout: 15_000, env: childEnv });
    assert.match(stdout, /(?:tests 6|# tests 6)/);
  });
} else {
  test("startup applies retained settings after metadata and shutdown destroys scenes", async () => {
    const state = await harness();
    await waitFor(() => state.ready);
    assert.equal(state.settings.getEffectiveValues("panel", "clock").speed, 42);
    state.proc.emit("SIGTERM");
    await waitFor(() => state.events.includes("exit:0"));
    assert.ok(state.events.indexOf("destroy") < state.events.indexOf("disconnect"));
  });

  test("config and scene reloads serialize and wait for an in-flight render", async () => {
    const frameGate = deferred();
    const state = await harness({ frameGate });
    await waitFor(() => state.ready && state.inFrame);
    const nextConfig = (ip) => JSON.stringify({
      devices: [{ name: "panel", type: "pixoo", ip, scene: "clock" }],
      scenes: { clock: { path: "./clock.js" } },
    });
    const first = state.reload(nextConfig("two"));
    const second = state.reload(nextConfig("three"));
    const scene = state.sceneReload("clock.js", "/data");
    await delay(10);
    assert.equal(state.events.filter((event) => event === "loader").length, 1);
    assert.ok(!state.events.includes("destroy"));
    frameGate.resolve();
    await Promise.all([first, second, scene]);
    assert.ok(!state.events.includes("destroy-during-frame"));
    assert.deepEqual(state.events.filter((event) => event.startsWith("init:")), ["init:one", "init:two", "init:three"]);
    assert.equal(state.web.getEffectiveConfig().devices[0].ip, "three");
    state.proc.emit("SIGTERM");
    await waitFor(() => state.events.includes("exit:0"));
  });

  test("shutdown during startup prevents late device creation", async () => {
    const initializeGate = deferred();
    const state = await harness({ initializeGate });
    await waitFor(() => state.initializations > 0);
    state.proc.emit("SIGTERM");
    state.proc.emit("SIGINT");
    initializeGate.resolve();
    await waitFor(() => state.events.includes("exit:0"));
    assert.equal(state.web, undefined);
    assert.equal(state.events.filter((event) => event.startsWith("exit:")).length, 1);
  });

  test("shutdown during a built-in driver call waits without hanging", async () => {
    const builtinGate = deferred();
    const state = await harness({ scene: "builtin:clock", builtinGate });
    await waitFor(() => state.ready && state.inBuiltin);
    state.proc.emit("SIGTERM");
    builtinGate.resolve();
    await waitFor(() => state.events.includes("exit:0"));
  });

  test("failed initial MQTT connection is disconnected before continuing", async () => {
    const state = await harness({ mqttFails: true });
    await waitFor(() => state.ready);
    assert.ok(state.events.indexOf("disconnect") < state.events.indexOf("init:one"));
    state.proc.emit("SIGTERM");
    await waitFor(() => state.events.includes("exit:0"));
  });

  test("config edits observed during device startup are applied after startup", async () => {
    const initializeGate = deferred();
    const state = await harness({ initializeGate });
    await waitFor(() => state.initializations > 0);
    assert.equal(typeof state.reload, "function");
    const reloaded = state.reload(JSON.stringify({
      devices: [{ name: "panel", type: "pixoo", ip: "updated", scene: "clock" }],
      scenes: { clock: { path: "./clock.js" } },
    }));
    initializeGate.resolve();
    await reloaded;
    assert.equal(state.web.getEffectiveConfig().devices[0].ip, "updated");
    state.proc.emit("SIGTERM");
    await waitFor(() => state.events.includes("exit:0"));
  });
}
