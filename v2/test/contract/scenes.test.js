/**
 * Test kind 2 of 3 (API and MQTT contract): the contract with the shared
 * scenes and with the files v2 shares with v1.
 *
 * What exists now pins the release coordinate: v2 accepts exactly what v1
 * accepts, because it asks v1's validator. The todo entries are the scene
 * side of the round-1 cross-read (PIXD-83): isolation per device, instance
 * tokens, and resources that follow a scene through aliases and copies.
 * Owner: fixtures + edge lane worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renameSync } from "node:fs";
import { registerHooks } from "node:module";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readlink,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ScenesWatcher } from "../../src/scenes/scenes-watcher.js";
import {
  SceneRegistry,
  normalizeSchema,
} from "../../src/scenes/scene-registry.js";
import { createLane } from "../../src/core/ordering.js";
import { SceneRuntime } from "../../src/scenes/scene-runtime.js";
import { OUT_DIR } from "../helpers/golden.js";
import { DeviceError, SceneError } from "../../src/core/errors.js";
import {
  createV1Instance,
  checkV1Module,
  STATE_FIELD_PATTERNS,
} from "../../src/scenes/v1-scene-adapter.js";
import {
  createPixooSurface,
  createUlanziSurface,
} from "../../src/scenes/v1-device-facade.js";
import {
  sceneContexts,
  silentLogger,
  sinkDriver,
} from "../helpers/scene-context.js";
import {
  ensureDataLinks,
  sharedPaths,
  installSharedResolution,
  readVersion,
  validateVersionRecord,
} from "../../src/scenes/v1-shared.js";
import { requireNetGuard } from "../helpers/harness.js";

test("version record: v1's grammar and calendar check, through the shared seam", () => {
  requireNetGuard();
  const scheme = "inspr-calver-3";
  /** @param {string} version */
  const check = (version) =>
    validateVersionRecord({ version, version_scheme: scheme });

  assert.deepEqual(check("261116181524.0.0"), {
    version: "261116181524.0.0",
    version_scheme: scheme,
  });
  assert.deepEqual(check("240229235959.0.0").version, "240229235959.0.0");

  // Twelve digits are not enough: each part has to be a real one (matrix A-104).
  for (const [version, why] of [
    ["269999999999.0.0", "month 99"],
    ["261332000000.0.0", "month 13"],
    ["261100000000.0.0", "day 00"],
    ["261116240000.0.0", "hour 24"],
    ["261116236000.0.0", "minute 60"],
    ["261116235960.0.0", "second 60"],
    ["091116181524.0.0", "year 09"],
    ["v261116181524.0.0", "prefix"],
    ["261116181524.0.0-rc1", "suffix"],
    ["261116181524.1.0", "not .0.0"],
    ["2.4.1", "SemVer"],
  ]) {
    assert.throws(
      () => check(version),
      /^Error: Invalid version\.json: version must be YYMMDDhhmmss\.0\.0$/,
      `${version} (${why})`,
    );
  }
  for (const [version, why] of [
    ["260230120000.0.0", "30 February"],
    ["250229120000.0.0", "29 February in a year that has none"],
    ["260431120000.0.0", "31 April"],
  ]) {
    assert.throws(
      () => check(version),
      /^Error: Invalid version\.json: version contains an invalid Gregorian date$/,
      `${version} (${why})`,
    );
  }
  assert.throws(
    () =>
      validateVersionRecord({
        version: "261116181524.0.0",
        version_scheme: "semver",
      }),
    /version_scheme must be inspr-calver-3/,
  );

  // The repository's own record passes, and is what the process reports.
  assert.match(readVersion().version, /^\d{12}\.0\.0$/);
});

// --- Phase 3 ---------------------------------------------------------------------------------------
test("v1 scene contract: init gets a fresh ctx, render gets the device surface, destroy gets a fresh ctx; afterwards the instance's subscriptions are gone also when destroy threw", async () => {
  const contexts = sceneContexts({ value: { nested: 1 } });
  /** @type {any[]} */
  const calls = [];
  let callbacks = 0;
  const ref = { scene: "contract", device: "fake", token: "one" };
  const instance = await createV1Instance(
    {
      ref,
      moduleNamespace: {
        default: {
          /** @param {any} ctx */
          async init(ctx) {
            calls.push(ctx);
            ctx.settings.subscribe(async (/** @type {any} */ values) => {
              values.value.nested = 999;
              callbacks++;
            });
            ctx.mqtt.subscribe("input", () => {
              callbacks++;
            });
          },
          /** @param {any} surface */
          async render(surface) {
            calls.push(surface);
            return 25;
          },
          /** @param {any} ctx */
          async destroy(ctx) {
            calls.push(ctx);
            throw new Error("destroy failed");
          },
        },
      },
    },
    {
      ...contexts,
      settingsTopic: (device, scene) => `settings/${device}/${scene}`,
      shadowStateDir: null,
      resources: { assetDirs: [], stateFields: [] },
      logger: silentLogger,
    },
  );
  assert.equal(callbacks, 1, "subscriber called at once");
  assert.deepEqual(calls[0].settings.values, { value: { nested: 1 } });
  const surface = { deviceName: "fake" };
  assert.equal(await instance.renderFrame(surface), 25);
  assert.equal(calls[1], surface);
  await instance.release();
  await instance.release();
  assert.notEqual(calls[0], calls[2]);
  assert.equal(calls[2].settingsTopic, "settings/fake/contract");
  const before = callbacks;
  await contexts.deliver("input", "late");
  await contexts.update({ value: 2 });
  assert.equal(callbacks, before);
  assert.equal(contexts.subscriptions.size, 0);
  assert.equal(contexts.settings.get("one")?.size, 0);
  await assert.rejects(instance.renderFrame(surface), SceneError);
});

test("v1 scene contract: failures classify render and init; failed init releases callbacks", async () => {
  const contexts = sceneContexts();
  const deps = {
    ...contexts,
    settingsTopic: () => "settings",
    shadowStateDir: null,
    resources: { assetDirs: [], stateFields: [] },
    logger: silentLogger,
  };
  const ref = { scene: "failure", device: "fake", token: "two" };
  assert.equal(checkV1Module({ default: {} }).ok, false);
  await assert.rejects(
    createV1Instance(
      {
        ref,
        moduleNamespace: {
          default: {
            render() {},
            /** @param {any} ctx */
            init(ctx) {
              ctx.mqtt.subscribe("input", () => {});
              throw new Error("bad init");
            },
          },
        },
      },
      deps,
    ),
    (error) => error instanceof SceneError && error.phase === "init",
  );
  assert.equal(contexts.subscriptions.size, 0);
  const failure = new DeviceError("refused");
  for (const error of [failure, new Error("scene bug")]) {
    const instance = await createV1Instance(
      {
        ref,
        moduleNamespace: {
          render() {
            throw error;
          },
        },
      },
      deps,
    );
    await assert.rejects(
      instance.renderFrame({ deviceName: "fake" }),
      (actual) =>
        error === failure
          ? actual === error
          : actual instanceof SceneError && actual.phase === "render",
    );
    await instance.release();
  }
});

test("scene release: release and shutdown unsubscribe immediately and await an admitted render, including rejection, before destroy", async (t) => {
  const globals = /** @type {any} */ (globalThis);
  for (const shutdown of [false, true]) {
    for (const fail of [false, true]) {
      /** @type {string[]} */
      const calls = [];
      globals.__releaseCalls = calls;
      const frame = Promise.withResolvers();
      const started = Promise.withResolvers();
      const { runtime, contexts } = await runtimePeer(`export default {
        init(ctx) { ctx.mqtt.subscribe('input', () => {}); ctx.settings.subscribe(() => {}); },
        async render(surface) {
          surface.started(); await surface.frame;
          globalThis.__releaseCalls.push('render finished');
          if (surface.fail) throw Error('render failed');
          return 25;
        }, destroy() { globalThis.__releaseCalls.push('destroy'); }
      };`);
      t.after(async () => {
        frame.resolve(undefined);
        await runtime.releaseAll();
      });
      const instance = await runtime.acquire("scene", "device");
      const rendering = instance.renderFrame({
        deviceName: "device",
        frame: frame.promise,
        fail,
        started: () => started.resolve(undefined),
      });
      const rendered = fail
        ? assert.rejects(rendering, /render failed/)
        : rendering;
      await started.promise;
      const releasing = shutdown
        ? runtime.releaseAll()
        : runtime.release(instance);
      await assert.rejects(
        instance.renderFrame({ deviceName: "device" }),
        /released/,
      );
      assert.deepEqual(calls, [], "destroy cannot overtake a render in flight");
      assert.equal(contexts.subscriptions.size, 0);
      assert.equal(contexts.settings.get(instance.ref.token)?.size, 0);
      frame.resolve(undefined);
      await rendered;
      await releasing;
      assert.deepEqual(calls, ["render finished", "destroy"]);
      assert.equal(contexts.subscriptions.size, 0);
      assert.equal(contexts.settings.size, 0);
      await runtime.releaseAll();
    }
  }
  delete globals.__releaseCalls;
});

test("scene release deadline: a hung frame cannot retain a sampler or subscriptions; late success and failure never destroy twice", async (t) => {
  const globals = /** @type {any} */ (globalThis);
  for (const fail of [false, true]) {
    const deadlineMs = fail ? 0 : 25;
    const frame = Promise.withResolvers();
    const control = { ticks: 0, destroyed: 0, finished: 0, started: false };
    globals.__drain = control;
    const { runtime, contexts } = await runtimePeer(`
      const control = globalThis.__drain;
      export default {
        init(ctx) {
          this.timer = setInterval(() => control.ticks++, 5);
          ctx.mqtt.subscribe('input', () => {}); ctx.settings.subscribe(() => {});
        },
        async render(surface) {
          control.started = true; await surface.frame; control.finished++;
          if (surface.fail) throw Error('late frame failed');
        }, destroy() { clearInterval(this.timer); control.destroyed++; }
      };
    `);
    /** @type {string[]} */
    const warnings = [];
    runtime.deps.logger = {
      ...silentLogger,
      warn: (message) => warnings.push(message),
    };
    t.after(async () => {
      frame.resolve(undefined);
      await runtime.releaseAll();
      delete globals.__drain;
    });
    const instance = await runtime.acquire("scene", "device");
    const rendering = instance.renderFrame({
      deviceName: "device",
      frame: frame.promise,
      fail,
    });
    const rendered = fail
      ? assert.rejects(rendering, /late frame failed/)
      : rendering;
    await waitFor(() => control.started && control.ticks > 0);
    const releasing = runtime.release(instance, { deadlineMs });
    assert.equal(
      contexts.subscriptions.size,
      0,
      "MQTT owner removed before draining",
    );
    assert.equal(
      contexts.settings.get(instance.ref.token)?.size,
      0,
      "settings unsubscribed before draining",
    );
    assert.equal(control.destroyed, 0, "give the frame its remaining budget");
    await waitFor(() => control.destroyed === 1);
    await releasing;
    assert.equal(
      control.finished,
      0,
      "destroy ran even though the frame is still hung",
    );
    assert.equal(runtime.instances.size, 0);
    assert.equal(warnings.length, 1);
    assert.ok(
      warnings[0].includes(`frame drain timed out after ${deadlineMs}ms`),
    );
    const ticks = control.ticks;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(control.ticks, ticks, "destroy stopped the scene's interval");
    frame.resolve(undefined);
    await rendered;
    await instance.release({ deadlineMs: 0 });
    assert.equal(control.destroyed, 1);
    assert.equal(warnings.length, 1);
  }
});

test("scene release deadline: a frame settling within budget cancels the bound and destroys without a warning", async (t) => {
  const frame = Promise.withResolvers();
  const started = Promise.withResolvers();
  let destroyed = 0;
  /** @type {string[]} */
  const warnings = [];
  const contexts = sceneContexts();
  const instance = await createV1Instance(
    {
      ref: { scene: "drain", device: "device", token: "normal-drain" },
      moduleNamespace: {
        async render() {
          started.resolve(undefined);
          await frame.promise;
        },
        destroy() {
          destroyed++;
        },
      },
    },
    {
      ...contexts,
      settingsTopic: () => "settings",
      shadowStateDir: null,
      resources: { assetDirs: [], stateFields: [] },
      logger: { ...silentLogger, warn: (message) => warnings.push(message) },
    },
  );
  t.after(async () => {
    frame.resolve(undefined);
    await instance.release();
  });
  const rendering = instance.renderFrame({ deviceName: "device" });
  await started.promise;
  const releasing = instance.release({ deadlineMs: 40 });
  assert.equal(destroyed, 0);
  frame.resolve(undefined);
  await Promise.all([rendering, releasing]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(destroyed, 1);
  assert.deepEqual(warnings, []);
});

test("v1 scene surface: Pixoo passthrough, AWTRIX payload, legacy screen shape, and refused frames", async () => {
  const driver = sinkDriver();
  /** @type {unknown[]} */
  const calls = [];
  driver.selectChannel = async (index) => {
    calls.push(index);
  };
  driver.readScreen = async () => ({
    width: 32,
    height: 8,
    rgb: new Uint8Array(768).fill(128),
  });
  const sink = {
    driver,
    show: async (/** @type {unknown} */ output) => {
      calls.push(output);
    },
    requestBrightness: async (/** @type {number} */ value) => {
      calls.push(value);
      return true;
    },
  };
  const { loadV1Font } = await import("../../src/scenes/v1-shared.js");
  const pixoo = /** @type {any} */ (
    createPixooSurface(
      { name: "fake", address: "127.0.0.1" },
      sink,
      await loadV1Font(),
    )
  );
  await pixoo.setChannel(7);
  await pixoo.setBrightness(0);
  assert.deepEqual(calls, [7, 1]);
  await pixoo.drawLineRgba([-1e12, 32], [1e12, 32], [255, 0, 0]);
  assert.equal(pixoo.buf[(32 * 64 + 63) * 3], 255);
  await pixoo.drawRectangleRgba([0, 0], [Infinity, 1], [0, 255, 0]);
  await pixoo.drawRectangleRgba([-1e12, -1e12], [2e12, 2e12], [0, 255, 0]);
  assert.equal(pixoo.buf[1], 255);
  await pixoo.push();
  const ulanzi = /** @type {any} */ (
    createUlanziSurface({ name: "fake", address: "127.0.0.1" }, sink)
  );
  const app = { text: "hello", custom: { untouched: true } };
  assert.equal(await ulanzi.drawCustom(app), true);
  assert.equal(/** @type {any} */ (calls.at(-1)).app, app);
  assert.deepEqual(
    (await ulanzi.getScreen()).slice(0, 2),
    [0x808080, 0x808080],
  );
  sink.show = async () => {
    throw new DeviceError("refused");
  };
  await assert.rejects(ulanzi.drawCustom(app), DeviceError);
  await assert.rejects(pixoo.push(), DeviceError);
});
/** @param {string} source
 * @param {(device: string) => import("../../src/types.js").OutputMode} [outputOf] */
async function runtimePeer(source, outputOf = () => "shadow") {
  await mkdir(OUT_DIR, { recursive: true });
  const dataDir = await mkdtemp(join(OUT_DIR, "scene-contract-"));
  const file = join(dataDir, "scene.mjs");
  await writeFile(file, source);
  const contexts = sceneContexts({ value: "initial" });
  const runtime = new SceneRuntime({
    registry: /** @type {any} */ ({
      fileOf: () => file,
      get: () => ({ resources: { assetDirs: [], stateFields: [] } }),
    }),
    settings: /** @type {any} */ ({
      runtimeContext: contexts.settingsContext,
      releaseContext: contexts.releaseContext,
    }),
    mqttContext: contexts.mqttContext,
    settingsTopic: () => "settings",
    outputOf,
    dataDir,
    logger: silentLogger,
  });
  return { runtime, contexts, file, dataDir };
}

test("isolation per device: the scene file is evaluated once per device, so a module-level variable of one device's instance is not seen by another's", async (t) => {
  const { runtime } = await runtimePeer(
    `let count = 0; export default { render() { return ++count; } };`,
  );
  t.after(() => runtime.releaseAll());
  const first = await runtime.acquire("scene", "first");
  const second = await runtime.acquire("scene", "second");
  assert.equal(await first.renderFrame({ deviceName: "first" }), 1);
  assert.equal(await first.renderFrame({ deviceName: "first" }), 2);
  assert.equal(await second.renderFrame({ deviceName: "second" }), 1);
  assert.equal(await runtime.acquire("scene", "first"), first);
});

test("scene import cache: release and acquire reuse one evaluation per file token and device, with fresh instance identities", async (t) => {
  const counts = /** @type {any} */ (globalThis);
  counts.__sceneImportCount = 0;
  const { runtime } = await runtimePeer(`
    globalThis.__sceneImportCount++;
    let frames = 0;
    export default { render() { return ++frames; } };
  `);
  t.after(async () => {
    await runtime.releaseAll();
    delete counts.__sceneImportCount;
  });
  const tokens = new Set();
  for (let frame = 1; frame <= 25; frame++) {
    const instance = await runtime.acquire("scene", "first");
    tokens.add(instance.ref.token);
    assert.equal(await instance.renderFrame({ deviceName: "first" }), frame);
    await runtime.release(instance);
  }
  assert.equal(
    counts.__sceneImportCount,
    1,
    "count module evaluations, not heap growth",
  );
  assert.equal(tokens.size, 25, "instances still have independent owners");
  const other = await runtime.acquire("scene", "second");
  assert.equal(await other.renderFrame({ deviceName: "second" }), 1);
  assert.equal(
    counts.__sceneImportCount,
    2,
    "a different device has its own module",
  );
  await runtime.invalidate(["scene"]);
  await waitFor(() => !runtime.isCurrent(other));
  const replaced = await runtime.acquire("scene", "second");
  assert.equal(await replaced.renderFrame({ deviceName: "second" }), 1);
  assert.equal(
    counts.__sceneImportCount,
    3,
    "a changed file gets a new evaluation",
  );
  await runtime.release(other);
  await runtime.release(replaced);
  const reacquired = await runtime.acquire("scene", "second");
  assert.equal(await reacquired.renderFrame({ deviceName: "second" }), 2);
  assert.equal(
    counts.__sceneImportCount,
    3,
    "the replacement token is cached too",
  );
});

test("scene output mode: drive to shadow and back replaces an unreleased instance and captures state paths before init", async (t) => {
  /** @type {import("../../src/types.js").OutputMode} */
  let output = "drive";
  const { runtime, contexts, dataDir } = await runtimePeer(
    `export default {
    init(ctx) { this._boilerStatePath ??= 'v1-history'; ctx.mqtt.subscribe('input', () => {}); },
    render(surface) { surface.record(this._boilerStatePath); }
  };`,
    () => output,
  );
  runtime.deps.registry.get = () =>
    /** @type {any} */ ({
      resources: { assetDirs: [], stateFields: ["_boilerStatePath"] },
    });
  t.after(() => runtime.releaseAll());
  /** @type {string[]} */
  const paths = [];
  const surface = {
    deviceName: "device",
    record: (/** @type {string} */ path) => paths.push(path),
  };
  const driven = await runtime.acquire("scene", "device");
  await driven.renderFrame(surface);
  output = "shadow";
  const shadow = await runtime.acquire("scene", "device");
  assert.notEqual(shadow, driven);
  assert.equal(runtime.isCurrent(driven), false);
  await shadow.renderFrame(surface);
  assert.deepEqual(paths, [
    "v1-history",
    join(dataDir, ".pixdcon2/shadow-state/device/scene-_boilerStatePath.json"),
  ]);
  assert.equal(
    contexts.subscriptions.size,
    2,
    "old loop still owns its instance",
  );
  await runtime.release(driven);
  assert.equal(
    runtime.isCurrent(shadow),
    true,
    "a late release cannot evict the new mode",
  );
  output = "drive";
  const drivenAgain = await runtime.acquire("scene", "device");
  assert.notEqual(drivenAgain, shadow);
  await drivenAgain.renderFrame(surface);
  assert.equal(paths.at(-1), "v1-history");
});

/** @param {import('node:test').TestContext} t @param {boolean} reloadFirst */
async function assertReloadOwnership(t, reloadFirst) {
  /** @type {import("../../src/types.js").OutputMode} */
  let output = "drive";
  // home3's sampling interval writes this state field independently of render.
  // Use synchronous file writes so a byte comparison also detects late ticks.
  const { runtime, contexts, dataDir } = await runtimePeer(
    `
    import { appendFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    export default {
      init(ctx) {
        this._boilerStatePath ??= fileURLToPath(new URL('./v1-history.json', import.meta.url));
        const sample = () => appendFileSync(this._boilerStatePath, 'sample\\n');
        sample(); this.timer = setInterval(sample, 5);
        ctx.mqtt.subscribe('input', sample); ctx.settings.subscribe(() => {});
      }, render() {}, destroy() { clearInterval(this.timer); }
    };
  `,
    () => output,
  );
  t.after(() => runtime.releaseAll());
  const old = await runtime.acquire("scene", "device");
  if (!reloadFirst) output = "shadow";
  await runtime.invalidate(["scene"]);
  await waitFor(() => runtime.pending.size === 0);
  if (reloadFirst) output = "shadow";
  const shadow = await runtime.acquire("scene", "device");
  // The old loop reaches its frame boundary only after the reload and rebuild.
  await runtime.release(old);
  await waitFor(() => runtime.instances.size <= 2);
  const driveFile = join(dataDir, "v1-history.json");
  const shadowFile = join(
    dataDir,
    ".pixdcon2/shadow-state/device/scene-_boilerStatePath.json",
  );
  const before = await readFile(driveFile, "utf8");
  const shadowBefore = await readFile(shadowFile, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 35));
  await contexts.deliver("input", "sample now");
  assert.equal(
    await readFile(driveFile, "utf8"),
    before,
    "no timer or MQTT write to the drive path after switching",
  );
  assert.ok(
    (await readFile(shadowFile, "utf8")).length > shadowBefore.length,
    "the shadow sampler still runs",
  );
  assert.equal(
    runtime.instances.size,
    1,
    "only the acquired shadow instance survives",
  );
  assert.equal(runtime.isCurrent(shadow), true);
  assert.deepEqual([...contexts.subscriptions.keys()], [shadow.ref.token]);
  assert.deepEqual([...contexts.settings.keys()], [shadow.ref.token]);
}

test("scene reload ownership: output flips before reload; no drive sampler survives the old loop", async (t) => {
  await assertReloadOwnership(t, false);
});

test("scene reload ownership: reload installs before output flips; unacquired drive sampler is released", async (t) => {
  await assertReloadOwnership(t, true);
});

test("scene reload ownership: consecutive reloads release replacements no loop acquired", async (t) => {
  const { runtime, contexts } = await runtimePeer(`export default {
    init(ctx) { ctx.mqtt.subscribe('input', () => {}); }, render() {}
  };`);
  t.after(() => runtime.releaseAll());
  const old = await runtime.acquire("scene", "device");
  for (let i = 0; i < 3; i++) {
    await runtime.invalidate(["scene"]);
    await waitFor(() => runtime.pending.size === 0);
  }
  const replacement = await runtime.acquire("scene", "device");
  await runtime.release(old);
  assert.equal(runtime.instances.size, 1);
  assert.deepEqual([...contexts.subscriptions.keys()], [replacement.ref.token]);
});

let virtualSceneId = 0;

/** A real imported scene, served from memory; timers and MQTT write to a path ledger.
 * @param {import('node:test').TestContext} t */
async function virtualRuntimePeer(t) {
  await mkdir(OUT_DIR, { recursive: true });
  const dataDir = await mkdtemp(join(OUT_DIR, "scene-walk-"));
  const file = join(dataDir, "virtual.mjs");
  const url = pathToFileURL(file).href;
  const slot = `__scene_walk_${++virtualSceneId}`;
  const control = {
    next: 0,
    failNext: false,
    failed: 0,
    started: 0,
    /** @type {ReturnType<typeof Promise.withResolvers<void>>|null} */
    gate: null,
    /** @type {ReturnType<typeof Promise.withResolvers<void>>|null} */
    frame: null,
    /** @type {Set<ReturnType<typeof Promise.withResolvers<void>>>} */
    gates: new Set(),
    /** @type {Map<number, {device: string, path: string}>} */
    live: new Map(),
    /** @type {Map<number, number>} */
    destroyed: new Map(),
    /** @type {Array<{id: number, device: string, path: string, kind: string}>} */
    writes: [],
  };
  /** @type {any} */ (globalThis)[slot] = control;
  const source = `
    const control = globalThis[${JSON.stringify(slot)}];
    export default {
      async init(ctx) {
        this.id = ++control.next;
        this._boilerStatePath ??= 'v1/.state/home3-boiler.json';
        const record = { device: ctx.deviceName, path: this._boilerStatePath };
        control.live.set(this.id, record);
        const write = kind => control.writes.push({id: this.id, ...record, kind});
        this.timer = setInterval(() => write('timer'), 2);
        ctx.mqtt.subscribe('input', () => write('mqtt'));
        ctx.settings.subscribe(() => {});
        control.started++;
        if (control.failNext) { control.failNext = false; control.failed++; throw Error('seeded init failure'); }
        if (control.gate) { control.gates.add(control.gate); await control.gate.promise; }
      },
      render(surface) { surface.record(this.id); return control.frame?.promise; },
      destroy() {
        clearInterval(this.timer);
        control.live.delete(this.id);
        control.destroyed.set(this.id, (control.destroyed.get(this.id) ?? 0) + 1);
      }
    };
  `;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.split("?")[0] === url)
        return { url: specifier, shortCircuit: true };
      return next(specifier, context);
    },
    load(specifier, context, next) {
      if (specifier.split("?")[0] === url)
        return { format: "module", source, shortCircuit: true };
      return next(specifier, context);
    },
  });
  /** @type {Map<string, {output: import('../../src/types.js').OutputMode, exists: boolean, enabled: boolean}>} */
  const devices = new Map();
  for (const device of ["first", "second"])
    devices.set(device, { output: "drive", exists: true, enabled: true });
  const contexts = sceneContexts();
  const peer = {
    runtime: new SceneRuntime({
      registry: /** @type {any} */ ({
        fileOf: () => file,
        get: () => ({ resources: { assetDirs: [], stateFields: [] } }),
      }),
      settings: /** @type {any} */ ({
        runtimeContext: contexts.settingsContext,
        releaseContext: contexts.releaseContext,
      }),
      mqttContext: contexts.mqttContext,
      settingsTopic: () => "settings",
      outputOf: (device) => devices.get(device)?.output ?? "shadow",
      dataDir,
      logger: silentLogger,
    }),
    control,
    contexts,
    devices,
  };
  t.after(async () => {
    control.gate?.resolve();
    control.frame?.resolve();
    for (const gate of control.gates) gate.resolve();
    await peer.runtime.releaseAll();
    hook.deregister();
    delete (/** @type {any} */ (globalThis)[slot]);
  });
  return peer;
}

for (const flip of ["none", "before", "after"]) {
  test(`scene last holder: release old instance without reacquire; output flip ${flip}`, async (t) => {
    const { runtime, control, contexts, devices } = await virtualRuntimePeer(t);
    const policy = devices.get("first");
    assert.ok(policy);
    const old = await runtime.acquire("scene", "first");
    await runtime.invalidate(["scene"]);
    await waitFor(() => runtime.pending.size === 0);
    assert.equal(
      runtime.instances.size,
      2,
      "D held, R prepared but unacquired",
    );
    if (flip === "before") policy.output = "shadow";
    await runtime.release(old);
    if (flip === "after") policy.output = "shadow";
    const before = control.writes.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await contexts.deliver("input", "late");
    assert.equal(
      control.writes.length,
      before,
      "no timer or MQTT state-path writes after release",
    );
    assert.equal(runtime.instances.size, 0);
    assert.equal(runtime.entries.size, 0);
    assert.equal(control.live.size, 0);
    assert.equal(contexts.subscriptions.size, 0);
    assert.equal(contexts.settings.size, 0);
    assert.deepEqual([...control.destroyed.values()], [1, 1]);
  });
}

test("scene last holder: a pending replacement is fenced; late init and repeated old release cannot evict a fresh entry", async (t) => {
  const { runtime, control, contexts } = await virtualRuntimePeer(t);
  const old = await runtime.acquire("scene", "first");
  const gate = Promise.withResolvers();
  control.gate = gate;
  await runtime.invalidate(["scene"]);
  await waitFor(() => control.started === 2);
  await runtime.release(old);
  assert.equal(runtime.entries.size, 0);
  assert.equal(runtime.instances.size, 0);
  // The admitted init is uncancellable. A new entry must not follow it.
  control.gate = null;
  const fresh = await runtime.acquire("scene", "first");
  gate.resolve(undefined);
  await waitFor(() => runtime.pending.size === 0);
  await runtime.release(old);
  assert.equal(runtime.instances.size, 1);
  assert.equal(runtime.isCurrent(fresh), true);
  assert.equal(control.live.size, 1);
  assert.deepEqual([...contexts.subscriptions.keys()], [fresh.ref.token]);
  assert.deepEqual([...contexts.settings.keys()], [fresh.ref.token]);
});

test("scene last holder: several unreleased generations retain one prepared current until the final holder leaves", async (t) => {
  const { runtime, control, contexts } = await virtualRuntimePeer(t);
  const first = await runtime.acquire("scene", "first");
  await runtime.invalidate(["scene"]);
  await waitFor(() => runtime.pending.size === 0);
  const second = await runtime.acquire("scene", "first");
  await runtime.invalidate(["scene"]);
  await waitFor(() => runtime.pending.size === 0);
  assert.equal(runtime.instances.size, 3);
  await runtime.release(first);
  await runtime.release(first);
  assert.equal(
    runtime.instances.size,
    2,
    "second holder still owns the prepared replacement",
  );
  assert.equal(runtime.entries.size, 1);
  await runtime.release(second);
  assert.equal(runtime.instances.size, 0);
  assert.equal(runtime.entries.size, 0);
  assert.equal(control.live.size, 0);
  assert.equal(contexts.subscriptions.size, 0);
});

test("scene last holder: releasing current before an older holder keeps the remaining entry usable", async (t) => {
  const { runtime, control } = await virtualRuntimePeer(t);
  const old = await runtime.acquire("scene", "first");
  await runtime.invalidate(["scene"]);
  await waitFor(() => runtime.pending.size === 0);
  const current = await runtime.acquire("scene", "first");
  await runtime.release(current);
  assert.equal(
    runtime.entries.size,
    1,
    "old holder still belongs to the entry",
  );
  await runtime.invalidate(["scene"]);
  await waitFor(() => runtime.pending.size === 0);
  const next = await runtime.acquire("scene", "first");
  await runtime.release(old);
  assert.equal(runtime.isCurrent(next), true);
  assert.equal(control.live.size, 1);
  await runtime.release(next);
  assert.equal(runtime.entries.size, 0);
});

test("scene acquire output guard: exported superseded error marks stale callers without handing out or retiring the new mode", async (t) => {
  const { SupersededLoadError } =
    await import("../../src/scenes/scene-runtime.js");
  assert.equal(typeof SupersededLoadError, "function");
  const { runtime, control, devices } = await virtualRuntimePeer(t);
  const policy = devices.get("first");
  assert.ok(policy);
  const stale = (/** @type {unknown} */ error) =>
    error instanceof SupersededLoadError && error.superseded === true;
  await assert.rejects(
    runtime.acquire("scene", "first", { output: "shadow" }),
    stale,
  );
  assert.equal(runtime.entries.size, 0, "reject before creating an entry");
  assert.equal(control.started, 0);
  const drive = await runtime.acquire("scene", "first", { output: "drive" });
  policy.output = "shadow";
  await assert.rejects(
    runtime.acquire("scene", "first", { output: "drive" }),
    stale,
  );
  assert.equal(control.started, 1, "retired caller cannot start a shadow init");
  const shadow = await runtime.acquire("scene", "first", { output: "shadow" });
  await runtime.release(drive);
  await assert.rejects(
    runtime.acquire("scene", "first", { output: "drive" }),
    stale,
  );
  await runtime.release(drive);
  assert.equal(runtime.isCurrent(shadow), true);
  assert.equal(runtime.instances.size, 1);
  assert.equal(control.started, 2);
});

test("scene init policy fence: output change during init rejects without another acquire or invalidate", async (t) => {
  const { runtime, control, contexts, devices } = await virtualRuntimePeer(t);
  const gate = Promise.withResolvers();
  control.gate = gate;
  const stale = assert.rejects(runtime.acquire("scene", "first"), /superseded/);
  await waitFor(() => control.started === 1);
  const policy = devices.get("first");
  assert.ok(policy);
  policy.output = "shadow";
  gate.resolve(undefined);
  await stale;
  assert.equal(runtime.entries.size, 0);
  assert.equal(runtime.instances.size, 0);
  assert.equal(control.live.size, 0);
  assert.equal(contexts.subscriptions.size, 0);
  assert.equal(contexts.settings.size, 0);
});

test("scene first caller: cancelling every acquire retires a cross-mode invalidate replacement, ready or pending", async (t) => {
  for (const ready of [false, true]) {
    const { runtime, control, contexts, devices } = await virtualRuntimePeer(t);
    const drive = Promise.withResolvers();
    const shadow = Promise.withResolvers();
    control.gate = drive;
    const stale = assert.rejects(
      runtime.acquire("scene", "first"),
      /superseded/,
    );
    await waitFor(() => control.started === 1);
    const policy = devices.get("first");
    assert.ok(policy);
    policy.output = "shadow";
    control.gate = ready ? null : shadow;
    await runtime.invalidate(["scene"]);
    await waitFor(() => control.started === 2);
    if (ready) await waitFor(() => runtime.instances.size === 1);
    drive.resolve(undefined);
    await stale;
    assert.equal(
      runtime.entries.size,
      0,
      "no current or future caller remains",
    );
    shadow.resolve(undefined);
    await waitFor(() => runtime.pending.size === 0);
    assert.equal(runtime.instances.size, 0);
    assert.equal(control.live.size, 0);
    assert.equal(contexts.subscriptions.size, 0);
    assert.equal(contexts.settings.size, 0);
  }
});

test("scene releaseAll budget: hung frames share the supplied remaining drain budget, including zero", async (t) => {
  for (const deadlineMs of [0, 25]) {
    const { runtime, control, contexts } = await virtualRuntimePeer(t);
    /** @type {string[]} */
    const warnings = [];
    runtime.deps.logger = {
      ...silentLogger,
      warn: (message) => warnings.push(message),
    };
    const first = await runtime.acquire("scene", "first");
    const second = await runtime.acquire("scene", "second");
    control.frame = Promise.withResolvers();
    let admitted = 0;
    const surface = { deviceName: "fake", record: () => admitted++ };
    const frames = [first.renderFrame(surface), second.renderFrame(surface)];
    await waitFor(() => admitted === 2);
    const stopping = runtime.releaseAll({ deadlineMs });
    assert.equal(runtime.entries.size, 0);
    assert.equal(
      contexts.subscriptions.size,
      0,
      "all MQTT owners fenced before awaiting frame drain",
    );
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let bound;
    try {
      const drained = await Promise.race([
        stopping.then(() => true),
        new Promise((resolve) => {
          bound = setTimeout(() => resolve(false), 250);
        }),
      ]);
      assert.equal(
        drained,
        true,
        `releaseAll forwarded ${deadlineMs}ms rather than the 6000ms default`,
      );
      assert.equal(
        control.live.size,
        0,
        "bounded destroy stopped both samplers",
      );
      assert.equal(runtime.instances.size, 0);
      assert.equal(contexts.settings.size, 0);
      assert.equal(warnings.length, 2, "one drain warning per hung instance");
      assert.ok(
        warnings.every((warning) =>
          warning.includes(`timed out after ${deadlineMs}ms`),
        ),
      );
    } finally {
      clearTimeout(bound);
      control.frame.resolve();
      await Promise.all([...frames, stopping]);
    }
    const before = control.writes.length;
    await contexts.deliver("input", "late");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(control.writes.length, before);
    assert.deepEqual(
      [...control.destroyed.values()],
      [1, 1],
      "late frames never destroy twice",
    );
  }
});

test("scene ownership model: seeded lifecycle walks preserve owners, state paths and a bounded instance set", async (t) => {
  const started = performance.now();
  // Only intervals are virtual: real imports/init/adapter cleanup still run.
  // Advancing these timers makes path-write checks deterministic after each step.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const peer = await virtualRuntimePeer(t);
  const { control, contexts, devices } = peer;
  /** @type {Map<string, import('../../src/scenes/scene-runtime.js').SceneInstance>} */
  const held = new Map();
  /** @type {Map<import('../../src/scenes/scene-runtime.js').SceneInstance, number>} */
  const identities = new Map();
  const coverage = new Set();
  const operations = [
    "acquire",
    "acquire",
    "invalidate",
    "invalidate",
    "release",
    "flip",
    "remove",
    "disable",
    "fail",
    "shutdown",
  ];
  /** @param {string} device */
  const releaseDevice = async (device) => {
    for (const [key, instance] of held) {
      if (instance.device !== device) continue;
      held.delete(key);
      await peer.runtime.release(instance);
    }
  };
  /** @param {string} evidence */
  const check = async (evidence) => {
    const { runtime } = peer;
    const holders = new Set(held.values());
    const expected = new Set(holders);
    for (const [key, entry] of runtime.entries) {
      const owners = [...holders].filter(
        (instance) => JSON.stringify([instance.scene, instance.device]) === key,
      );
      assert.ok(
        owners.length > 0,
        `entry has no remaining holder: ${evidence}`,
      );
      if (entry.current) expected.add(entry.current);
    }
    assert.deepEqual(
      runtime.instances,
      expected,
      `every installed instance has a holder or is their current replacement: ${evidence}`,
    );
    assert.ok(
      runtime.instances.size <= held.size * 2,
      `at most held + one replacement per key: ${evidence}`,
    );
    assert.equal(
      control.live.size,
      runtime.instances.size,
      `timers match installed instances: ${evidence}`,
    );
    assert.equal(
      contexts.subscriptions.size,
      runtime.instances.size,
      `MQTT owners match instances: ${evidence}`,
    );
    assert.equal(
      contexts.settings.size,
      runtime.instances.size,
      `settings owners match instances: ${evidence}`,
    );
    for (const instance of runtime.instances) {
      if (!identities.has(instance)) {
        await instance.renderFrame({
          deviceName: instance.device,
          record: (/** @type {number} */ id) => identities.set(instance, id),
        });
      }
      const id = identities.get(instance);
      assert.notEqual(id, undefined);
      const record = control.live.get(/** @type {number} */ (id));
      const device = devices.get(instance.device);
      assert.ok(record && device);
      assert.ok(
        device.exists && device.enabled,
        `no instance after removal/disable: ${evidence}`,
      );
      assert.equal(
        record.path.startsWith("v1/"),
        device.output === "drive",
        `state path agrees with outputOf: ${evidence}`,
      );
    }
    const before = control.writes.length;
    t.mock.timers.tick(4);
    await contexts.deliver("input", "pulse");
    const writes = control.writes.slice(before);
    assert.equal(
      writes.filter((write) => write.kind === "timer").length,
      runtime.instances.size * 2,
      evidence,
    );
    assert.equal(
      writes.filter((write) => write.kind === "mqtt").length,
      runtime.instances.size,
      evidence,
    );
    for (const write of writes) {
      const device = devices.get(write.device);
      assert.ok(device);
      assert.ok(
        control.live.has(write.id) && device.exists && device.enabled,
        `no retired timer/MQTT writer: ${evidence}`,
      );
      assert.equal(
        write.path.startsWith("v1/"),
        device.output === "drive",
        `no drive writes in shadow: ${evidence}`,
      );
    }
    assert.ok(
      [...control.destroyed.values()].every((count) => count === 1),
      `destroy exactly once: ${evidence}`,
    );
  };
  for (const seed of [0x89, 0x427b3b08, 0x15ed48c9, 0xb797f284]) {
    let random = seed >>> 0;
    const next = () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return random >>> 0;
    };
    const trace = [];
    for (let step = 0; step < 160; step++) {
      const operation = operations[next() % operations.length];
      const device = ["first", "second"][next() % 2];
      const scene = ["one", "two"][next() % 2];
      const key = JSON.stringify([scene, device]);
      const policy = devices.get(device);
      assert.ok(policy);
      coverage.add(operation);
      trace.push(`${operation}(${scene},${device})`);
      const evidence = `seed=${seed.toString(16)} step=${step} ${trace.slice(-16).join(" → ")}`;
      if (operation === "acquire") {
        // An acquire may begin a fresh enabled device runtime after removal.
        policy.exists = policy.enabled = true;
        const old = held.get(key);
        const instance = await peer.runtime.acquire(scene, device);
        held.set(key, instance);
        if (old && old !== instance) await peer.runtime.release(old);
      } else if (operation === "release") {
        const instance = held.get(key);
        if (instance) {
          held.delete(key);
          await peer.runtime.release(instance);
        }
      } else if (operation === "invalidate") {
        await peer.runtime.invalidate([scene]);
      } else if (
        operation === "flip" ||
        operation === "remove" ||
        operation === "disable"
      ) {
        if (operation === "flip")
          policy.output = policy.output === "drive" ? "shadow" : "drive";
        if (operation === "remove") policy.exists = false;
        if (operation === "disable") policy.enabled = false;
        // Scheduler's documented stop/rebuild boundary; deliberately no reacquire.
        await releaseDevice(device);
      } else if (operation === "fail") {
        if (policy.exists && policy.enabled) {
          control.failNext = true;
          if (held.has(key)) {
            await peer.runtime.invalidate([scene]);
          } else {
            await assert.rejects(
              peer.runtime.acquire(scene, device),
              /seeded init failure/,
              evidence,
            );
          }
        }
      } else {
        await peer.runtime.releaseAll();
        held.clear();
      }
      await waitFor(() => peer.runtime.pending.size === 0);
      await check(evidence);
      control.failNext = false;
      if (peer.runtime.closed)
        peer.runtime = new SceneRuntime(peer.runtime.deps);
    }
    await peer.runtime.releaseAll();
    held.clear();
    await check(`seed=${seed.toString(16)} final shutdown`);
    peer.runtime = new SceneRuntime(peer.runtime.deps);
  }
  assert.deepEqual(
    coverage,
    new Set(operations),
    "every operation was generated",
  );
  assert.ok(control.writes.some((write) => write.kind === "timer"));
  assert.ok(control.writes.some((write) => write.kind === "mqtt"));
  assert.ok(control.failed > 0, "failing init actually ran and cleaned up");
  assert.ok(performance.now() - started < 5000, "model stays inside 5 s");
});

test("instance tokens: a replacement instance and the instance it replaces have different tokens, MQTT owners and settings subscribers", async (t) => {
  const source = `export default {
    init(ctx) { this.values = ctx.settings.all(); ctx.settings.subscribe(v => { this.values = v; }); ctx.mqtt.subscribe('input', () => {}); },
    render() { return 10; }
  };`;
  const { runtime, contexts, file } = await runtimePeer(source);
  t.after(() => runtime.releaseAll());
  const old = await runtime.acquire("scene", "device");
  await writeFile(file, source.replace("return 10", "return 20"));
  assert.deepEqual(await runtime.invalidate(["scene"]), {
    devices: ["device"],
  });
  await waitFor(() => !runtime.isCurrent(old));
  const replacement = await runtime.acquire("scene", "device");
  assert.notEqual(old.ref.token, replacement.ref.token);
  assert.equal(runtime.isCurrent(old), false);
  assert.equal(runtime.isCurrent(replacement), true);
  assert.equal(
    contexts.subscriptions.size,
    2,
    "old subscriptions survive until its frame boundary",
  );
  await runtime.release(old);
  assert.deepEqual([...contexts.subscriptions.keys()], [replacement.ref.token]);
  assert.deepEqual([...contexts.settings.keys()], [replacement.ref.token]);
  await writeFile(
    file,
    `export default { init() { throw Error('bad replacement'); }, render() {} };`,
  );
  await runtime.invalidate(["scene"]);
  await waitFor(() => runtime.pending.size === 0);
  assert.equal(await runtime.acquire("scene", "device"), replacement);
  assert.equal(await replacement.renderFrame({ deviceName: "device" }), 20);
  assert.deepEqual([...contexts.subscriptions.keys()], [replacement.ref.token]);
});

test("first load supersede: waiting callers follow the pending or already ready replacement and stale init is destroyed", async (t) => {
  const globals = /** @type {any} */ (globalThis);
  for (const replacementFirst of [false, true]) {
    const initial = Promise.withResolvers();
    const replacement = Promise.withResolvers();
    const control = { initial, replacement, started: false, destroyed: 0 };
    globals.__firstLoad = control;
    const { runtime, contexts, file } = await runtimePeer(`export default {
      async init(ctx) {
        ctx.mqtt.subscribe('input', () => {}); ctx.settings.subscribe(() => {});
        globalThis.__firstLoad.started = true;
        await globalThis.__firstLoad.initial.promise;
      }, render() { return 10; }, destroy() { globalThis.__firstLoad.destroyed++; }
    };`);
    t.after(async () => {
      initial.resolve(undefined);
      replacement.resolve(undefined);
      await runtime.releaseAll();
    });
    const first = runtime.acquire("scene", "device");
    const second = runtime.acquire("scene", "device");
    await waitFor(() => control.started);
    await writeFile(
      file,
      `export default {
      async init(ctx) {
        ctx.mqtt.subscribe('input', () => {}); ctx.settings.subscribe(() => {});
        await globalThis.__firstLoad.replacement.promise;
      }, render() { return 20; }
    };`,
    );
    await runtime.invalidate(["scene"]);
    if (replacementFirst) {
      replacement.resolve(undefined);
      await runtime.acquire("scene", "device");
      initial.resolve(undefined);
    } else {
      initial.resolve(undefined);
      await waitFor(() => control.destroyed === 1);
      replacement.resolve(undefined);
    }
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one, two);
    assert.equal(one, await runtime.acquire("scene", "device"));
    assert.equal(await one.renderFrame({ deviceName: "device" }), 20);
    assert.equal(control.destroyed, 1);
    assert.deepEqual([...contexts.subscriptions.keys()], [one.ref.token]);
    assert.deepEqual([...contexts.settings.keys()], [one.ref.token]);
    await runtime.releaseAll();
  }
  delete globals.__firstLoad;
});

test("first load output supersede: stale callers reject rather than share the other mode's pending or ready instance", async (t) => {
  const globals = /** @type {any} */ (globalThis);
  for (const replacementFirst of [false, true]) {
    const drive = Promise.withResolvers();
    const shadow = Promise.withResolvers();
    const control = { drive, shadow, started: 0 };
    globals.__outputInit = control;
    /** @type {import("../../src/types.js").OutputMode} */
    let output = "drive";
    const { runtime, contexts } = await runtimePeer(
      `
      const control = globalThis.__outputInit;
      export default {
        async init(ctx) {
          ctx.mqtt.subscribe('input', () => {}); control.started++;
          await (this._boilerStatePath ? control.shadow : control.drive).promise;
        }, render() { return 25; }
      };
    `,
      () => output,
    );
    t.after(async () => {
      drive.resolve(undefined);
      shadow.resolve(undefined);
      await runtime.releaseAll();
      delete globals.__outputInit;
    });
    const stale = assert.rejects(
      runtime.acquire("scene", "device"),
      /superseded/,
    );
    await waitFor(() => control.started === 1);
    output = "shadow";
    const acquiring = runtime.acquire("scene", "device");
    await waitFor(() => control.started === 2);
    if (replacementFirst) shadow.resolve(undefined);
    if (replacementFirst) await acquiring;
    drive.resolve(undefined);
    await stale;
    shadow.resolve(undefined);
    const replacement = await acquiring;
    assert.equal(await replacement.renderFrame({ deviceName: "device" }), 25);
    assert.equal(runtime.instances.size, 1);
    assert.equal(runtime.isCurrent(replacement), true);
    assert.deepEqual(
      [...contexts.subscriptions.keys()],
      [replacement.ref.token],
    );
    await runtime.releaseAll();
  }
});

test("scene reload warnings: a followed failure logs once and release cancellation logs nothing", async (t) => {
  const globals = /** @type {any} */ (globalThis);
  for (const cancel of [false, true]) {
    const gate = Promise.withResolvers();
    const control = { gate, started: 0, cancel };
    globals.__warningInit = control;
    const { runtime, file } = await runtimePeer(
      `export default { render() {} };`,
    );
    /** @type {string[]} */
    const warnings = [];
    runtime.deps.logger = {
      ...silentLogger,
      warn: (message) => warnings.push(message),
    };
    t.after(async () => {
      gate.resolve(undefined);
      await runtime.releaseAll();
      delete globals.__warningInit;
    });
    const old = await runtime.acquire("scene", "device");
    await writeFile(
      file,
      `
      const control = globalThis.__warningInit;
      export default {
        async init() {
          control.started++; await control.gate.promise;
          if (!control.cancel) throw Error('new load broke');
        },
        render() {}
      };
    `,
    );
    await runtime.invalidate(["scene"]);
    await waitFor(() => control.started === 1);
    if (cancel) {
      await runtime.release(old);
    } else {
      await runtime.invalidate(["scene"]);
      await waitFor(() => control.started === 2);
    }
    gate.resolve(undefined);
    await waitFor(() => runtime.pending.size === 0);
    assert.deepEqual(
      warnings,
      cancel
        ? []
        : ["Scene scene reload failed: Scene scene init: new load broke"],
    );
    await runtime.releaseAll();
  }
});

test("scene reload scheduling: a hanging replacement init leaves the registry lane free and the last good instance running", async (t) => {
  const { createLane } = await import("../../src/core/ordering.js");
  const gate = Promise.withResolvers();
  const control = { gate, started: false, destroyed: false };
  const globals = /** @type {any} */ (globalThis);
  globals.__reloadInit = control;
  const { runtime, file } = await runtimePeer(
    `export default { render() { return 10; } };`,
  );
  t.after(async () => {
    gate.resolve(undefined);
    await runtime.releaseAll();
    delete globals.__reloadInit;
  });
  const old = await runtime.acquire("scene", "device");
  await writeFile(
    file,
    `export default {
    async init() { globalThis.__reloadInit.started = true; await globalThis.__reloadInit.gate.promise; },
    render() { return 20; }, destroy() { globalThis.__reloadInit.destroyed = true; }
  };`,
  );
  const lane = createLane();
  const reloading = lane.run("reload", () => runtime.invalidate(["scene"]));
  let ran = false;
  const following = lane.run("next scene change", () => {
    ran = true;
  });
  await waitFor(() => ran && control.started);
  assert.deepEqual(await reloading, {
    ran: true,
    value: { devices: ["device"] },
  });
  await following;
  assert.equal(runtime.isCurrent(old), true);
  assert.equal(await old.renderFrame({ deviceName: "device" }), 10);
  // Stop fences the unfinished init; it is destroyed if it eventually returns.
  const stopping = runtime.releaseAll();
  gate.resolve(undefined);
  await stopping;
  assert.equal(control.destroyed, true);
  assert.equal(runtime.instances.size, 0);
});
test("resources: home3 reports assetDirs [home3-assets] and stateFields [_boilerStatePath]; so do an alias key for the same file and a copy of it", async () => {
  installSharedResolution();
  await mkdir(OUT_DIR, { recursive: true });
  const dir = await mkdtemp(join(OUT_DIR, "registry-copy-"));
  await ensureDataLinks(dir, silentLogger);
  // Preserve the shared scene's ../../lib imports and its asset directory.
  await mkdir(join(dir, "scenes/pixoo"), { recursive: true });
  const original = join(sharedPaths().scenesDir, "pixoo/home3.js");
  const copy = join(dir, "scenes/pixoo/copy.mjs");
  await writeFile(copy, await readFile(original, "utf8"));
  await symlink(
    join(sharedPaths().scenesDir, "pixoo/home3-assets"),
    join(dir, "scenes/pixoo/home3-assets"),
    "dir",
  );
  installSharedResolution({ extraDirs: [dir] });
  const { registry } = await registryPeer({
    home3: { path: original, source: "config" },
    alias: { path: original, source: "overlay" },
    copy: { path: copy, source: "config" },
  });
  await registry.load();
  for (const meta of registry.list()) {
    assert.equal(meta.status, "ok", meta.error ?? meta.key);
    assert.deepEqual(meta.resources, {
      assetDirs: ["home3-assets"],
      stateFields: ["_boilerStatePath"],
    });
  }
  assert.deepEqual(registry.keysOfFile(original), ["home3", "alias"]);
  assert.deepEqual(
    registry.keysOfFile(
      join(sharedPaths().scenesDir, "pixoo/home3-assets/a/nested.png"),
    ),
    ["home3", "alias"],
  );
  assert.deepEqual(
    registry.keysOfFile(
      join(sharedPaths().scenesDir, "pixoo/home3-assets-other/picture.png"),
    ),
    [],
  );
  assert.equal(registry.get("alias")?.pathSource, "overlay");
});

test("resources: home, funkeykid, health and the Ulanzi scenes report no asset folder and no state field", async () => {
  installSharedResolution();
  const entries = Object.fromEntries(
    [
      "pixoo/home",
      "pixoo/funkeykid",
      "pixoo/health",
      "ulanzi/clock",
      "ulanzi/clock_with_homestats",
      "ulanzi/test-pattern",
    ].map((key) => [
      key,
      {
        path: join(sharedPaths().scenesDir, key + ".js"),
        source: /** @type {const} */ ("config"),
      },
    ]),
  );
  const { registry } = await registryPeer(entries);
  await registry.load();
  for (const meta of registry.list()) {
    assert.equal(meta.status, "ok", meta.error ?? meta.key);
    assert.deepEqual(meta.resources, { assetDirs: [], stateFields: [] });
  }
});
test("shared files: a scene on the data mount resolves ../../lib and ../../assets through the links pixdcon 2 creates, and `sharp` comes from v2's own packages", async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const dataDir = await mkdtemp(join(OUT_DIR, "scene-links-"));
  assert.equal(
    (await ensureDataLinks(dataDir, silentLogger)).created.length,
    2,
  );
  assert.deepEqual((await ensureDataLinks(dataDir, silentLogger)).created, []);
  assert.equal(await readlink(join(dataDir, "lib")), sharedPaths().libDir);
  assert.equal(
    await readlink(join(dataDir, "assets")),
    sharedPaths().assetsDir,
  );
  await mkdir(join(dataDir, "scenes/mounted"), { recursive: true });
  const file = join(dataDir, "scenes/mounted/check.mjs");
  await writeFile(
    file,
    `import sharp from 'sharp'; import { measureText } from '../../lib/pixoo-font.js'; export { sharp, measureText };`,
  );
  installSharedResolution({ extraDirs: [dataDir] });
  const loaded = await import(pathToFileURL(file).href);
  const sharp = (await import("sharp")).default;
  assert.equal(loaded.sharp, sharp);
  assert.equal(loaded.measureText("A").height, 5);
  assert.ok(
    (await readFile(join(dataDir, "lib/pixoo-image.js"), "utf8")).includes(
      "sharp",
    ),
  );
});

// --- Ordering (knowledge entry, section 3.0) ---
test("registry order: load, refresh and sync use the registry lane, read the current effective map and retain last-good metadata on failed import", async () => {
  const peer = await registryPeer();
  const { registry, dir } = peer;
  const lane = createLane();
  await writeFile(
    join(dir, "a.mjs"),
    'export default { name: "Alpha", render() {} };',
  );
  peer.set({ a: { path: "a.mjs", source: "config" } });
  const initial = lane.run("load", () => registry.load());
  await initial;
  assert.equal(registry.get("a")?.name, "Alpha");
  await writeFile(join(dir, "a.mjs"), 'throw new Error("broken edit");');
  await lane.run("refresh", () => registry.refresh(["a"]));
  assert.equal(registry.get("a")?.name, "Alpha");
  assert.equal(registry.get("a")?.status, "broken");
  assert.match(registry.get("a")?.error ?? "", /broken edit/);
  await writeFile(
    join(dir, "b.mjs"),
    'export const name="Beta"; export function render() {}',
  );
  const held = registryGate();
  void lane.run("hold", () => held.promise);
  const pending = lane.run("sync", () =>
    registry.sync({ added: ["b"], removed: ["a"], changed: [] }),
  );
  peer.set({ b: { path: "b.mjs", source: "overlay" } });
  held.resolve();
  await pending;
  assert.deepEqual(
    registry.list().map((meta) => meta.key),
    ["b"],
  );
  assert.equal(registry.get("b")?.pretty_name, "Beta");
  assert.equal(registry.fileOf("b"), join(dir, "b.mjs"));
  assert.equal(registry.get("a"), undefined);
  assert.equal(registry.fileOf("a"), undefined);
  assert.equal(registry.check("b", "ulanzi"), null);
  assert.equal(registry.check(null, "pixoo"), null);
  assert.match(registry.check("missing", "pixoo") ?? "", /Unknown scene/);
  assert.equal(registry.check("builtin:clock", "pixoo"), null);
  assert.match(
    registry.check("builtin:clock", "ulanzi") ?? "",
    /Unknown built-in/,
  );
  const exposed = registry.list();
  exposed[0].name = "mutated";
  assert.equal(registry.get("b")?.name, "Beta");
});
test("scene runtime order: one pending load per scene and device; an instance whose load finishes after it was released or replaced is destroyed and not handed out; MQTT and settings callbacks of a released instance are not called", async (t) => {
  // The deferred init belongs to the imported scene. Resolving it after stop
  // proves that its subscriptions cannot escape the runtime's generation fence.
  const slot = `__scene_test_${Date.now()}`;
  /** @type {any} */ (globalThis)[slot] = {};
  t.after(() => {
    delete (/** @type {any} */ (globalThis)[slot]);
  });
  const { runtime, contexts } = await runtimePeer(`export default {
    async init(ctx) {
      ctx.mqtt.subscribe('input', () => { globalThis['${slot}'].called = true; });
      ctx.settings.subscribe(() => {});
      await new Promise(resolve => { globalThis['${slot}'].ready = resolve; });
    }, render() { return 10; }, destroy() { globalThis['${slot}'].destroyed = true; }
  };`);
  const first = runtime.acquire("scene", "device");
  const second = runtime.acquire("scene", "device");
  const rejected = Promise.all([
    assert.rejects(first, /superseded/),
    assert.rejects(second, /superseded/),
  ]);
  while (!(/** @type {any} */ (globalThis)[slot].ready))
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(contexts.subscriptions.size, 1);
  const stopping = runtime.releaseAll();
  /** @type {any} */ (globalThis)[slot].ready();
  await rejected;
  await stopping;
  assert.equal(/** @type {any} */ (globalThis)[slot].destroyed, true);
  assert.equal(contexts.subscriptions.size, 0);
  assert.equal(contexts.settings.size, 0);
  await contexts.deliver("input", "late");
  assert.equal(/** @type {any} */ (globalThis)[slot].called, undefined);
});
test("scenes watcher order: a file event is a hint; the file is read after the debounce, and a change that arrives while a reload runs waits in the lane behind it", async (t) => {
  await mkdir(OUT_DIR, { recursive: true });
  const dir = await mkdtemp(join(OUT_DIR, "watch-contract-"));
  const file = join(dir, "scene.js");
  await writeFile(file, "// baseline");
  /** @type {string[]} */
  const seen = [];
  let finishFirst = () => {};
  const first = new Promise((resolve) => {
    finishFirst = () => resolve(undefined);
  });
  const watcher = new ScenesWatcher({
    dirs: () => [dir],
    logger: silentLogger,
    debounceMs: 25,
    retryMs: 10,
    async onChange(path) {
      seen.push((await readFile(path, "utf8")).replace(/^\/\/ /, ""));
      if (seen.length === 1) await first;
    },
  });
  t.after(() => {
    watcher.stop();
    finishFirst();
  });
  watcher.start();
  watcher.start();
  await writeFile(file, "// first hint");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen, [], "no read on the native hint");
  await writeFile(file, "// last content before debounce");
  await waitFor(() => seen.length === 1);
  assert.deepEqual(seen, ["last content before debounce"]);
  await writeFile(file, "// changed during the first reload");
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(seen.length, 1, "the pending reload waits");
  finishFirst();
  await waitFor(() => seen.length === 2);
  assert.equal(seen[1], "changed during the first reload");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    seen.length,
    2,
    "poll and native watch do not report an edit twice",
  );
  await writeFile(file, "// cancelled on stop");
  watcher.stop();
  watcher.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seen.length, 2);
});

test("scenes watcher recovery: missing/replaced directories and resource pictures, without repeated reloads", async (t) => {
  await mkdir(OUT_DIR, { recursive: true });
  const parent = await mkdtemp(join(OUT_DIR, "watch-recovery-"));
  const dir = join(parent, "mounted");
  const assets = join(parent, "copy-assets");
  /** @type {string[]} */
  const seen = [];
  let dirs = [dir];
  const watcher = new ScenesWatcher({
    dirs: () => dirs,
    logger: silentLogger,
    debounceMs: 10,
    retryMs: 15,
    async onChange(path) {
      seen.push(path);
    },
  });
  t.after(() => watcher.stop());
  watcher.start();
  await mkdir(dir);
  const file = join(dir, "later.js");
  await writeFile(file, "// appeared after start");
  await waitFor(() => seen.includes(file));
  // Populate off-mount first, then swap without yielding to a poll/debounce
  // while the mount path is absent or its replacement is still empty.
  const replacement = join(parent, "replacement-ready");
  await mkdir(replacement);
  await writeFile(join(replacement, "later.js"), "// replacement directory");
  renameSync(dir, join(parent, "old-directory"));
  renameSync(replacement, dir);
  await waitFor(() => seen.filter((path) => path === file).length === 2);
  await mkdir(assets);
  dirs = [dir, assets];
  const image = join(assets, "picture.png");
  await writeFile(image, "fixture pixels");
  await waitFor(() => seen.includes(image));
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(seen.length, 3);
});

test("scenes watcher poll failure: a throwing directory supplier is logged on the retry timer and polling recovers", async (t) => {
  await mkdir(OUT_DIR, { recursive: true });
  const dir = await mkdtemp(join(OUT_DIR, "watch-poll-failure-"));
  const file = join(dir, "scene.js");
  await writeFile(file, "// baseline");
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const seen = [];
  let fail = false;
  const watcher = new ScenesWatcher({
    dirs() {
      if (fail) throw new Error("fixture dirs unavailable");
      return [dir];
    },
    logger: {
      ...silentLogger,
      warn: (message) => warnings.push(String(message)),
    },
    debounceMs: 5,
    retryMs: 5,
    async onChange(path) {
      seen.push(await readFile(path, "utf8"));
    },
  });
  t.after(() => watcher.stop());
  watcher.start();
  fail = true;
  // Wait for the actual interval callback; an uncaught exception fails this file.
  await waitFor(() => warnings.length > 0);
  assert.match(warnings[0], /fixture dirs unavailable; retrying/);
  assert.equal(watcher.watchers.size, 1, "the last known watch survives");
  fail = false;
  await writeFile(file, "// after recovery");
  await waitFor(() => seen.includes("// after recovery"));
});

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      "scene contract peer did not observe the expected event",
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("migration file contract: legacy scene choice, unknown keys, shadow default and isolated controller status; source stays byte-identical", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const cli = promisify(execFile);
  await mkdir(OUT_DIR, { recursive: true });
  const root = await mkdtemp(join(OUT_DIR, "migration-"));
  const input = join(root, "v1-copy.json"),
    output = join(root, "v2-data");
  const config = {
    devices: [
      {
        name: " fake ",
        type: "pixoo",
        ip: " 127.0.0.1:1234 ",
        scenes: ["clock", "other"],
        enabled: "false",
        extra: { retained: true },
      },
    ],
    scenes: { clock: { path: "scenes/clock.js" } },
    extraRoot: ["unchanged"],
  };
  const source = JSON.stringify(config);
  await writeFile(input, source);
  const command = new URL("../../src/config/migrate-v1.js", import.meta.url)
    .pathname;
  const result = await cli(process.execPath, [command, input, output]);
  const report = JSON.parse(result.stdout);
  const migrated = JSON.parse(
    await readFile(join(output, "config.json"), "utf8"),
  );
  assert.equal(await readFile(input, "utf8"), source);
  assert.equal(migrated.devices[0].name, "fake");
  assert.equal(migrated.devices[0].ip, "127.0.0.1:1234");
  assert.equal(migrated.devices[0].scene, "clock");
  assert.equal(migrated.devices[0].enabled, false);
  assert.equal(migrated.devices[0].output, "shadow");
  assert.equal(Object.hasOwn(migrated.devices[0], "scenes"), false);
  assert.deepEqual(migrated.devices[0].extra, { retained: true });
  assert.deepEqual(migrated.extraRoot, ["unchanged"]);
  assert.equal(migrated.mqtt.baseTopic, "home/hsb1/pixdcon");
  assert.equal(migrated.mqtt.settingsBaseTopic, "pixdcon");
  assert.equal(migrated.mqtt.statusBaseTopic, "home/hsb1/pixdcon2");
  assert.equal(migrated.output.default, "shadow");
  assert.match(report.warnings[0], /only the first/);
  assert.ok(report.changes.length >= 8);
  assert.equal(await readlink(join(output, "lib")), sharedPaths().libDir);
  assert.equal(await readlink(join(output, "assets")), sharedPaths().assetsDir);
  const saved = await readFile(join(output, "config.json"), "utf8");
  await assert.rejects(
    cli(process.execPath, [command, input, output]),
    /refusing to overwrite/,
  );
  assert.equal(await readFile(join(output, "config.json"), "utf8"), saved);
  const drive = join(root, "drive-data");
  await cli(process.execPath, [
    command,
    input,
    drive,
    "--output",
    "drive",
    "--status-base-topic",
    "test/v2-edge",
  ]);
  const driven = JSON.parse(await readFile(join(drive, "config.json"), "utf8"));
  assert.equal(driven.devices[0].output, "drive");
  assert.equal(driven.mqtt.statusBaseTopic, "test/v2-edge");
});

test("migration file contract: duplicates, malformed source, unknown CLI flags and an in-place write produce no replacement", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const cli = promisify(execFile);
  const { access } = await import("node:fs/promises");
  await mkdir(OUT_DIR, { recursive: true });
  const root = await mkdtemp(join(OUT_DIR, "migration-reject-"));
  const input = join(root, "config.json"),
    output = join(root, "target");
  const command = new URL("../../src/config/migrate-v1.js", import.meta.url)
    .pathname;
  const entry = { name: "duplicate", type: "ulanzi", ip: "127.0.0.1" };
  const source = JSON.stringify({
    devices: [entry, { ...entry, name: " duplicate " }],
    scenes: {},
  });
  await writeFile(input, source);
  await assert.rejects(
    cli(process.execPath, [command, input, output]),
    /duplicate device name/,
  );
  await assert.rejects(access(join(output, "config.json")));
  assert.equal(await readFile(input, "utf8"), source);
  await writeFile(input, "{broken");
  await assert.rejects(
    cli(process.execPath, [command, input, output]),
    /Invalid config JSON/,
  );
  await assert.rejects(
    cli(process.execPath, [command, input, output, "--unknown", "x"]),
    /Usage:/,
  );
  await writeFile(input, JSON.stringify({ devices: [entry], scenes: {} }));
  const valid = await readFile(input, "utf8");
  await assert.rejects(
    cli(process.execPath, [command, input, root]),
    /different files/,
  );
  assert.equal(await readFile(input, "utf8"), valid);
});

test("migration shadow status: a shared v1 controller namespace refuses output until status-base-topic is explicitly supplied", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { access } = await import("node:fs/promises");
  const cli = promisify(execFile);
  await mkdir(OUT_DIR, { recursive: true });
  const root = await mkdtemp(join(OUT_DIR, "migration-status-"));
  const input = join(root, "v1-copy.json");
  const command = new URL("../../src/config/migrate-v1.js", import.meta.url)
    .pathname;
  for (const explicitBase of [false, true]) {
    const mqtt = {
      statusBaseTopic: "home/hsb1/pixdcon",
      ...(explicitBase ? { baseTopic: "home/hsb1/pixdcon" } : {}),
    };
    const source = JSON.stringify({ devices: [], scenes: {}, mqtt });
    await writeFile(input, source);
    const output = join(root, `refused-${explicitBase}`);
    await assert.rejects(
      cli(process.execPath, [command, input, output]),
      /shadow controller status shares v1's base topic; provide --status-base-topic explicitly/,
    );
    await assert.rejects(
      access(output),
      "refusal creates no output directory or links",
    );
    assert.equal(await readFile(input, "utf8"), source);
  }
  const isolated = join(root, "isolated");
  await cli(process.execPath, [
    command,
    input,
    isolated,
    "--status-base-topic",
    "test/v2-edge",
  ]);
  const config = JSON.parse(
    await readFile(join(isolated, "config.json"), "utf8"),
  );
  assert.equal(config.output.default, "shadow");
  assert.equal(config.mqtt.statusBaseTopic, "test/v2-edge");
  const acknowledged = join(root, "acknowledged");
  const result = await cli(process.execPath, [
    command,
    input,
    acknowledged,
    "--status-base-topic",
    "home/hsb1/pixdcon",
  ]);
  assert.match(
    JSON.parse(result.stdout).warnings[0],
    /Controller status shares v1/,
  );
  const driven = join(root, "driven");
  await cli(process.execPath, [command, input, driven, "--output", "drive"]);
  assert.equal(
    JSON.parse(await readFile(join(driven, "config.json"), "utf8")).output
      .default,
    "drive",
  );
});

test("resources: the adapter redirects declared state fields before init for aliases and copied keys; drive preserves its own history path", async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const dataDir = await mkdtemp(join(OUT_DIR, "shadow-paths-"));
  const original = join(dataDir, "original-history.json");
  const contexts = sceneContexts();
  for (const scene of ["home3", "alias", "home3-copy", "../escape"]) {
    /** @type {string[]} */
    const paths = [];
    const instance = await createV1Instance(
      {
        ref: { scene, device: "shadow", token: scene },
        moduleNamespace: {
          default: {
            _boilerStatePath: original,
            async init() {
              paths.push(this._boilerStatePath);
              await writeFile(this._boilerStatePath, "fixture-history");
            },
            render() {},
          },
        },
      },
      {
        ...contexts,
        shadowStateDir: join(dataDir, "shadow"),
        resources: { assetDirs: [], stateFields: ["_boilerStatePath"] },
        settingsTopic: () => "settings",
        logger: silentLogger,
      },
    );
    assert.equal(
      paths[0],
      join(
        dataDir,
        "shadow",
        `${encodeURIComponent(scene)}-_boilerStatePath.json`,
      ),
    );
    assert.equal(await readFile(paths[0], "utf8"), "fixture-history");
    await instance.release();
  }
  const { access } = await import("node:fs/promises");
  await assert.rejects(
    access(original),
    "a shadow never wrote the original history",
  );
  const driven = await createV1Instance(
    {
      ref: { scene: "alias", device: "drive", token: "drive" },
      moduleNamespace: {
        default: {
          _boilerStatePath: original,
          async init() {
            await writeFile(this._boilerStatePath, "drive-history");
          },
          render() {},
        },
      },
    },
    {
      ...contexts,
      shadowStateDir: null,
      resources: { assetDirs: [], stateFields: ["_boilerStatePath"] },
      settingsTopic: () => "settings",
      logger: silentLogger,
    },
  );
  await driven.release();
  assert.equal(await readFile(original, "utf8"), "drive-history");
});

test("shadow state fallback: every known field is redirected before init when registry metadata omits it, alongside extra declared fields", async () => {
  await mkdir(OUT_DIR, { recursive: true });
  const dataDir = await mkdtemp(join(OUT_DIR, "shadow-fallback-"));
  const original = join(dataDir, "v1-history.json");
  await writeFile(original, "v1 history must survive");
  for (const declared of [[], ["_customStatePath"]]) {
    const fields = [...new Set([...STATE_FIELD_PATTERNS, ...declared])];
    const paths = new Map();
    const exported = {
      ...Object.fromEntries(fields.map((field) => [field, original])),
      /** @this {Record<string, any>} */
      async init() {
        for (const field of fields) {
          paths.set(field, this[field]);
          await writeFile(this[field], "shadow history");
        }
      },
      render() {},
    };
    const instance = await createV1Instance(
      {
        ref: { scene: "alias", device: "device", token: "fallback" },
        moduleNamespace: { default: exported },
      },
      {
        ...sceneContexts(),
        settingsTopic: () => "settings",
        logger: silentLogger,
        shadowStateDir: join(dataDir, "shadow"),
        resources: { assetDirs: [], stateFields: declared },
      },
    );
    for (const field of fields) {
      assert.equal(
        paths.get(field),
        join(dataDir, "shadow", `alias-${field}.json`),
      );
      assert.equal(await readFile(paths.get(field), "utf8"), "shadow history");
    }
    await instance.release();
    assert.equal(await readFile(original, "utf8"), "v1 history must survive");
  }
});

/** @param {Record<string, import('../../src/types.js').EffectiveScene>} [initial] */
async function registryPeer(initial = {}) {
  await mkdir(OUT_DIR, { recursive: true });
  const dir = await mkdtemp(join(OUT_DIR, "registry-"));
  let entries = initial;
  const registry = new SceneRegistry({
    baseDir: () => dir,
    scenes: () => entries,
    findBuiltin: (type, key) =>
      type === "pixoo" && key === "builtin:clock"
        ? { key, label: "Clock" }
        : null,
    normalizeSettingValue: (value) => value,
    logger: silentLogger,
  });
  return {
    registry,
    dir,
    set(/** @type {typeof initial} */ next) {
      entries = next;
    },
  };
}

function registryGate() {
  let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
}

test("registry shutdown: load, refresh and sync commit nothing, emit nothing and resolve without keys when aborted during import", async (t) => {
  for (const method of ["load", "refresh", "sync"]) {
    const { registry, dir, set } = await registryPeer();
    set({
      a: { path: "a.mjs", source: "config" },
      b: { path: "b.mjs", source: "config" },
    });
    await writeFile(
      join(dir, "a.mjs"),
      'export default { name: "Old A", render() {} };',
    );
    await writeFile(
      join(dir, "b.mjs"),
      'export default { name: "Old B", render() {} };',
    );
    await registry.load();
    const before = registry.list();
    /** @type {unknown[]} */ const events = [];
    registry.on("changed", (event) => events.push(event));
    const entered = registryGate(),
      held = registryGate();
    const slot = `__registry_${method}`;
    const globals = /** @type {any} */ (globalThis);
    globals[slot] = { entered: entered.resolve, wait: held.promise };
    t.after(() => {
      held.resolve();
      delete globals[slot];
    });
    await writeFile(
      join(dir, "a.mjs"),
      'export default { name: "New A", render() {} };',
    );
    await writeFile(
      join(dir, "b.mjs"),
      `globalThis['${slot}'].entered(); await globalThis['${slot}'].wait; export default { name: "New B", render() {} };`,
    );
    const abort = new AbortController();
    const pending =
      method === "load"
        ? registry.load({ signal: abort.signal })
        : method === "refresh"
          ? registry.refresh(["a", "b"], { signal: abort.signal })
          : registry.sync(
              { added: [], removed: [], changed: ["a", "b"] },
              { signal: abort.signal },
            );
    await entered.promise;
    abort.abort();
    held.resolve();
    assert.deepEqual(await pending, { keys: [] });
    assert.deepEqual(
      registry.list(),
      before,
      "no partial commit of the earlier import",
    );
    assert.deepEqual(events, []);
    assert.deepEqual(
      await registry.sync(
        { added: [], removed: ["a"], changed: [] },
        { signal: abort.signal },
      ),
      { keys: [] },
    );
    assert.deepEqual(registry.list(), before);
  }
});

test("registry metadata: defaults use the injected normalizer; invalid schemas and missing render stay visible as broken", async () => {
  const { registry, dir, set } = await registryPeer();
  /** @type {unknown[]} */ const normalized = [];
  registry.deps.normalizeSettingValue = (raw, field) => {
    normalized.push([raw, field.type, field.min, field.max]);
    return raw === "invalid" ? undefined : Number(raw);
  };
  const sources = {
    good: 'export default { deviceType: "pixoo", settingsSchema: { count: { type: "int", default: "4", min: 1, max: 5 } }, render() {} };',
    invalid:
      'export default { settingsSchema: { value: { default: "invalid" } }, render() {} };',
    bounds:
      'export default { settingsSchema: { value: { type: "int", min: 5, max: 1 } }, render() {} };',
    noRender: 'export default { name: "Visible" };',
    shape: "export default { settingsSchema: [], render() {} };",
  };
  for (const [key, source] of Object.entries(sources))
    await writeFile(join(dir, `${key}.mjs`), source);
  set(
    Object.fromEntries(
      Object.keys(sources).map((key) => [
        key,
        { path: `${key}.mjs`, source: "config" },
      ]),
    ),
  );
  await registry.load();
  assert.equal(registry.get("good")?.settingsSchema.count.default, 4);
  assert.deepEqual(normalized[0], ["4", "int", 1, 5]);
  assert.equal(
    registry.check("good", "ulanzi"),
    null,
    "deviceType is a filter, not a restriction",
  );
  for (const key of ["invalid", "bounds", "noRender", "shape"]) {
    assert.equal(registry.get(key)?.status, "broken");
    assert.ok(registry.check(key, "pixoo"));
  }
  const { schema, problems } = normalizeSchema({ text: {} });
  assert.deepEqual(problems, []);
  assert.deepEqual(schema.text, {
    type: "string",
    label: "text",
    group: "General",
    description: "",
    default: undefined,
    placeholder: "",
  });
  for (const invalid of [
    42,
    [],
    { x: null },
    { x: { type: "unknown" } },
    { x: { type: "enum", options: [] } },
    { x: { min: Infinity } },
    { x: { step: 0 } },
  ])
    assert.ok(normalizeSchema(invalid).problems.length);
});

test("registry refresh: unchanged scenes are not reimported, errors recover, and removed keys stay removed", async (t) => {
  const { registry, dir, set } = await registryPeer();
  const globals = /** @type {any} */ (globalThis);
  globals.__registryCount = { a: 0, b: 0 };
  t.after(() => {
    delete globals.__registryCount;
  });
  for (const key of ["a", "b"])
    await writeFile(
      join(dir, `${key}.mjs`),
      `globalThis.__registryCount.${key}++; export default { render() {} };`,
    );
  set({
    a: { path: "a.mjs", source: "config" },
    b: { path: "b.mjs", source: "config" },
  });
  await registry.load();
  /** @type {unknown[]} */ const events = [];
  registry.on("changed", (event) => events.push(event));
  assert.deepEqual(await registry.refresh(["a"]), { keys: [] });
  assert.deepEqual(globals.__registryCount, { a: 2, b: 1 });
  assert.deepEqual(events, []);
  await writeFile(join(dir, "a.mjs"), "export default { render: null };");
  await registry.refresh(["a"]);
  assert.equal(registry.get("a")?.status, "broken");
  await writeFile(
    join(dir, "a.mjs"),
    'export default { name: "Recovered", render() {} };',
  );
  await registry.refresh(["a"]);
  assert.equal(registry.get("a")?.status, "ok");
  assert.equal(registry.get("a")?.error, null);
  set({ b: { path: "b.mjs", source: "config" } });
  assert.deepEqual(
    await registry.sync({ added: [], removed: ["a"], changed: [] }),
    { keys: ["a"] },
  );
  assert.deepEqual(
    registry.list().map((meta) => meta.key),
    ["b"],
  );
});
