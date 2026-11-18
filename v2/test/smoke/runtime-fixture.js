/** Fake-device harness for W3: real driver/loop/model, injected scene surface. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DeviceError } from "../../src/core/errors.js";
import { startFakePixoo } from "../../dev/fake-pixoo.js";
import { startFakeAwtrix } from "../../dev/fake-awtrix.js";
import { manualClock, systemClock } from "../../src/core/clock.js";
import { createDriver } from "../../src/drivers/driver.js";
import { createPixooDriver } from "../../src/drivers/pixoo-driver.js";
import { createAwtrixDriver } from "../../src/drivers/awtrix-driver.js";
import { HealthModel } from "../../src/health/health-model.js";
import { PreviewStore } from "../../src/render/preview-store.js";
import { RenderLoop } from "../../src/render/render-loop.js";
import { Scheduler } from "../../src/render/scheduler.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SceneRegistry } from "../../src/scenes/scene-registry.js";
import { SceneRuntime } from "../../src/scenes/scene-runtime.js";
import { sceneContexts } from "../helpers/scene-context.js";
import { OUT_DIR } from "../helpers/golden.js";

export const logger = { info() {}, debug() {}, warn() {}, error() {} };
export const healthConfig = { staleAfterMs: 30000, offlineAfterMs: 120000, probeIntervalMs: 10000 };
/** @template T @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void}} */
export function deferred() {
  let resolve = /** @type {(value: T) => void} */ (() => {});
  let reject = /** @type {(error: unknown) => void} */ (() => {});
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** @param {() => unknown} predicate @param {string} [message] */
export async function until(predicate, message = "condition") {
  const end = Date.now() + 1000;
  while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(predicate(), message);
}
export async function flush() { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); }

/** Real scene registry/runtime and fake displays; W1 views remain injected.
 * @param {import('node:test').TestContext} t @param {string} source
 * @param {{shadow?: boolean}} [options] */
export async function sceneRig(t, source, options = {}) {
  const r = await rig(t, { start: false, timeoutMs: 5000 });
  await mkdir(OUT_DIR, { recursive: true });
  const dir = await mkdtemp(join(OUT_DIR, "scene-smoke-"));
  const file = join(dir, "scene.js");
  await writeFile(file, source);
  if (options.shadow) for (const device of r.devices) device.output.mode = "shadow";
  /** @type {Record<string, import('../../src/types.js').EffectiveScene>} */
  const sceneEntries = { red: { path: file, source: "config" }, alias: { path: file, source: "config" } };
  const registry = new SceneRegistry({ baseDir: () => dir,
    scenes: () => sceneEntries,
    findBuiltin: () => null, normalizeSettingValue: (value) => value, logger });
  await registry.load();
  const contexts = sceneContexts();
  const sceneRuntime = new SceneRuntime({ registry, dataDir: dir, logger,
    outputOf: (device) => r.runtime.device(device)?.output.mode ?? "shadow",
    settings: /** @type {any} */ ({ runtimeContext: contexts.settingsContext, releaseContext: contexts.releaseContext }),
    mqttContext: contexts.mqttContext, settingsTopic: (device, scene) => `test/${device}/${scene}/settings` });
  r.scheduler.deps.scenes = sceneRuntime;
  t.after(() => sceneRuntime.releaseAll());
  return { ...r, registry, sceneRuntime, contexts, dir, file, sceneEntries };
}

/** Subscribe before starting work; preview acceptance follows the driver's answer.
 * @param {PreviewStore} previews @param {string} device */
export function nextPreview(previews, device) {
  return new Promise((resolve) => {
    const listener = (/** @type {import('../../src/types.js').PreviewFrame} */ frame) => {
      if (frame.device !== device) return;
      previews.off("frame", listener); resolve(frame);
    };
    previews.on("frame", listener);
  });
}

/** @param {EventEmitter} state @param {string} name @param {number} frameCount */
export function nextFrameReport(state, name, frameCount) {
  return new Promise((resolve) => {
    const listener = (/** @type {any} */ report) => {
      if (report.name !== name || report.patch.frameCount !== frameCount) return;
      state.off("reported", listener);
      resolve(report);
    };
    state.on("reported", listener);
  });
}

export class StubMqtt extends EventEmitter {
  /** @type {Array<{topic: string, payload: any, options: any}>} */
  messages = [];
  connected = true;
  connection = 1;
  /** @type {import('../../src/mqtt/mqtt-gateway.js').PublishResult['outcome'][]} */
  outcomes = [];
  status() { return { state: this.connected ? "connected" : "offline" }; }
  /** @param {string} topic @param {any} payload @param {any} options */
  async publish(topic, payload, options) {
    this.messages.push({ topic, payload: structuredClone(payload), options });
    const outcome = this.outcomes.shift() ?? (this.connected ? "confirmed" : "offline");
    return { ok: outcome === "confirmed" || outcome === "sent", outcome, connection: this.connection, error: null };
  }
}

/** @param {string} name @param {'pixoo'|'ulanzi'} type @param {string} address @param {Partial<import('../../src/types.js').EffectiveDevice>} [patch] @returns {import('../../src/types.js').EffectiveDevice} */
export function deviceEntry(name, type, address, patch = {}) {
  return { name, type, address, origin: "config", addressSource: "config", enabled: true, held: false, enabledSource: "config", savedScene: "red", output: { mode: "drive", requested: "drive", reason: null }, displayName: name, comment: "", preview: { pollMs: 2000, showGrid: false }, minFrameMs: 500, maxPowerCycles: 10, powerCyclePlugin: null, cleanupLegacyApps: false, sceneSettings: {}, blobKeys: [], ...patch };
}
/** @param {import('../../src/types.js').EffectiveDevice} device @returns {import('../../src/types.js').DesiredState} */
export function desiredOf(device) {
  const since = new Date(0).toISOString();
  return { scene: { scene: device.savedScene, source: "config", since, overlayId: null, problem: null }, choice: { scene: device.savedScene, persisted: true, notSavedReason: null, chosenAt: null, overridden: false }, mode: { value: "play", source: "default", since }, brightness: { override: null, source: "none", since }, address: { value: device.address, source: device.addressSource }, enabled: device.enabled, held: device.held, enabledSource: device.enabledSource, output: device.output.mode, outputProblem: null };
}

/** @param {import('node:test').TestContext} t @param {any} [options] */
export async function rig(t, options = {}) {
  const clock = manualClock();
  const health = new HealthModel({ clock, logger, config: () => healthConfig });
  const previews = new PreviewStore({ clock, logger });
  const mqtt = new StubMqtt();
  const pixoo = await startFakePixoo(); t.after(() => pixoo.stop());
  const awtrix = await startFakeAwtrix(); t.after(() => awtrix.stop());
  const devices = options.devices ?? [deviceEntry("p", "pixoo", pixoo.address), deviceEntry("u", "ulanzi", awtrix.address)];
  const runtimes = new Map();
  /** @type {Map<string, number>} */
  const renderCalls = new Map();
  /** @type {string[]} */
  const released = [];
  /** @type {Record<string, number>} */
  const generations = {};
  const scenes = {
    async acquire(/** @type {string} */ scene, /** @type {string} */ device) {
      const key = `${scene}:${device}:${generations[scene] ?? 0}`;
      if (!runtimes.has(key)) runtimes.set(key, {
        scene, device, ref: { scene, device, token: key },
        async renderFrame(/** @type {any} */ surface) {
          renderCalls.set(device, (renderCalls.get(device) ?? 0) + 1);
          if (options.render) return options.render(scene, device, surface);
          await surface.paint(scene === "blue" ? 9 : 3);
          return options.delay ?? null;
        }, async release() { released.push(key); },
      });
      return runtimes.get(key);
    },
    isCurrent(/** @type {any} */ instance) { return instance.ref.token.endsWith(`:${generations[instance.scene] ?? 0}`); },
    async release(/** @type {any} */ instance) { await instance.release(); },
  };
  const factories = {
    createDriver(/** @type {any} */ device, /** @type {any} */ deps) {
      if (device.output === "shadow") return createDriver(device, deps);
      const opts = { ...device, ...deps, clock: systemClock(), timeoutMs: options.timeoutMs ?? 40 };
      return device.type === "pixoo" ? createPixooDriver(opts) : createAwtrixDriver(opts);
    },
    async createSurface(/** @type {any} */ device, /** @type {any} */ sink) {
      return {
        deviceName: device.name,
        async paint(/** @type {number} */ value) {
          if (device.type === "pixoo") await sink.show({ kind: "frame", frame: { width: 64, height: 64, rgb: new Uint8Array(64 * 64 * 3).fill(value) } });
          else await sink.show({ kind: "app", app: { text: String(value), color: "#00FF00" } });
        },
        brightness: (/** @type {number} */ value) => sink.requestBrightness(value),
        channel: (/** @type {number} */ value) => sink.driver.selectChannel(value),
      };
    },
    rasterizeAwtrixApp(/** @type {any} */ app) { return { frame: { width: 32, height: 8, rgb: new Uint8Array(768).fill(Number(app.text) || 0) }, unsupported: [] }; },
    changeImpact: (/** @type {string} */ key) => key === "preview.pollMs" ? "preview" : ["comment", "displayName", "savedScene"].includes(key) ? "view" : "restart",
  };
  const states = new Map(devices.map((/** @type {any} */ d) => [d.name, { desired: desiredOf(d) }]));
  const state = Object.assign(new EventEmitter(), {
    get: (/** @type {string} */ name) => states.get(name),
    runtimeStarted(/** @type {string} */ name, /** @type {number} */ token) { tokens.set(name, token); },
    reportEffective(/** @type {string} */ name, /** @type {any} */ patch, /** @type {number} */ token) { reports.push({ name, patch, token }); state.emit("reported", { name, patch, token }); },
    reportHealth(/** @type {string} */ name, /** @type {any} */ view) { healthReports.push({ name, view }); },
  });
  const tokens = new Map();
  /** @type {any[]} */
  const reports = [];
  /** @type {any[]} */
  const healthReports = [];
  let effective = { devices, rev: 1, scenes: {}, health: healthConfig };
  const runtime = Object.assign(new EventEmitter(), { get: () => effective, device: (/** @type {string} */ name) => effective.devices.find((/** @type {any} */ d) => d.name === name) });
  const scheduler = new Scheduler(/** @type {any} */ ({ state, runtime, factories, scenes, health, previews, mqtt, telemetry: options.telemetry ?? null, clock, logger }));
  health.start(); t.after(() => health.stop());
  t.after(async () => {
    const stopping = scheduler.stop({ deadlineMs: 5 });
    await clock.advance(6); await stopping;
  });
  if (options.offline) await pixoo.setOffline(true);
  if (options.start !== false) { await scheduler.start(); await flush(); }
  return {
    clock, health, previews, mqtt, pixoo, awtrix, devices, states, state, runtime, scheduler, factories, scenes, generations, renderCalls, released, tokens, reports, healthReports,
    change(/** @type {any[]} */ devices, /** @type {any} */ diff, rev = effective.rev + 1) {
      const previous = effective; effective = { ...effective, devices, rev };
      for (const device of devices) if (!states.has(device.name)) states.set(device.name, { desired: desiredOf(device) });
      runtime.emit("changed", { effective, previous, diff: { devicesAdded: [], devicesRemoved: [], devicesChanged: {}, scenesAdded: [], scenesRemoved: [], scenesChanged: [], globalChanged: [], ...diff } });
    },
    choose(/** @type {string} */ name, /** @type {any} */ patch, changed = Object.keys(patch)) {
      const entry = /** @type {any} */ (states.get(name));
      Object.assign(entry.desired, patch); state.emit("desired", { name, desired: structuredClone(entry.desired), changed });
    },
  };
}

/** Single loop, controllable stub driver and real health/preview models. @param {import('node:test').TestContext} t @param {any} [options] */
export function loopRig(t, options = {}) {
  const clock = manualClock();
  const health = new HealthModel({ clock, logger, config: () => healthConfig });
  const previews = new PreviewStore({ clock, logger });
  const mqtt = new StubMqtt();
  const device = deviceEntry("p", "pixoo", "127.0.0.1:1", options.device);
  health.register("p", { shadow: device.output.mode === "shadow", powerCycleMax: device.maxPowerCycles, plugTopic: device.powerCyclePlugin?.topic ?? null }); health.start();
  /** @type {Array<{op: string, at: number, value?: any}>} */
  const calls = [];
  const record = (/** @type {string} */ op, /** @type {any} */ value) => calls.push({ op, value, at: clock.now() });
  let ready = false;
  const driver = {
    info: { type: "pixoo", width: 64, height: 64, brightness: { min: 1, max: 100 }, drives: device.output.mode === "drive" },
    get ready() { return ready; },
    async init() { ready = true; record("init", null); },
    async reclaim() { ready = true; record("reclaim", null); },
    async probe() { record("probe", null); if (options.probeError) throw options.probeError; return { at: new Date(clock.now()).toISOString() }; },
    async show(/** @type {any} */ output) { record("show", output); if (options.deviceError) throw options.deviceError; },
    async setBrightness(/** @type {number} */ value) { record("brightness", value); if (options.brightnessError) throw options.brightnessError; },
    async setPower(/** @type {boolean} */ value) { record("power", value); },
    async blank() { record("blank", null); },
    async activateBuiltin(/** @type {string} */ value) { record("builtin", value); },
    async close() { ready = false; record("close", null); },
  };
  let current = true;
  /** @type {any} */
  let sink;
  let renders = 0;
  const instance = { scene: "red", device: "p", ref: { scene: "red", device: "p", token: "one" },
    async renderFrame() { renders++; if (options.render) return options.render(sink, renders); await sink.show({ kind: "frame", frame: { width: 64, height: 64, rgb: new Uint8Array(64 * 64 * 3).fill(4) } }); return options.delay ?? null; }, async release() { record("release", null); },
  };
  const scenes = { async acquire() { return instance; }, async release(/** @type {any} */ old) { await old.release(); }, isCurrent() { return current; } };
  const loop = new RenderLoop(/** @type {any} */ ({ device: { ...device, output: device.output.mode }, driver, health, previews, mqtt, clock, logger,
    scenes, createSurface: async (/** @type {any} */ _, /** @type {any} */ target) => { sink = target; return { deviceName: "p" }; }, report() {},
  }), { scene: "red", mode: "play", brightnessOverride: null, ...options.target });
  t.after(async () => { const stop = loop.stop({ deadlineMs: 5 }); await clock.advance(6); await stop; health.stop(); });
  loop.start();
  return { loop, clock, health, previews, mqtt, calls, options, renders: () => renders, replace() { current = false; } };
}

/** Scheduler with real loopback drivers/probes and a scene's controllable device failure.
 * @param {import('node:test').TestContext} t @param {{slowOn?: boolean}} [options] */
export async function owedOnRig(t, options = {}) {
  // Use the same DeviceError as transport rejection, without blocking clock advancement on HTTP.
  const r = await rig(t, { start: false, render: async (/** @type {string} */ _, /** @type {string} */ name, /** @type {any} */ surface) => {
    if (name === "p") throw new DeviceError("frame rejected");
    await surface.paint(3); return 1200000;
  } });
  r.devices[0].powerCyclePlugin = { topic: "original-plug", onPayload: "ON-OLD", offPayload: "OFF-OLD" };
  r.devices[0].maxPowerCycles = 1;
  r.mqtt.outcomes = ["confirmed", ...Array(500).fill("timeout")];
  const publish = r.mqtt.publish.bind(r.mqtt);
  let inFlight = 0; let maxInFlight = 0;
  r.mqtt.publish = async (topic, payload, opts) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const result = await publish(topic, payload, opts);
      if (options.slowOn && payload === "ON-OLD") await r.clock.sleep(opts.timeoutMs ?? 5000);
      return result;
    } finally { inFlight--; }
  };
  await r.scheduler.start();
  await until(() => r.scheduler.loop("p")?.deviceErrors === 1);
  const loop = r.scheduler.loop("p"); assert.ok(loop);
  for (const [index, ms] of [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000, 10000].entries()) {
    await r.clock.advance(ms);
    await until(() => loop.deviceErrors === index + 2);
  }
  await until(() => loop.status().powerCycleCount === 1); await flush();
  await r.clock.advance(10000);
  await until(() => r.mqtt.messages.some((m) => m.payload === "ON-OLD"));
  return { ...r, loop, maxInFlight: () => maxInFlight };
}
