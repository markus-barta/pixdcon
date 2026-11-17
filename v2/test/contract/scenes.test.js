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
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readlink,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ScenesWatcher } from "../../src/scenes/scenes-watcher.js";
import { SceneRuntime } from "../../src/scenes/scene-runtime.js";
import { OUT_DIR } from "../helpers/golden.js";
import { DeviceError, SceneError } from "../../src/core/errors.js";
import {
  createV1Instance,
  checkV1Module,
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
  assert.equal(await runtime.acquire("scene", "device"), replacement);
  assert.equal(await replacement.renderFrame({ deviceName: "device" }), 20);
  assert.deepEqual([...contexts.subscriptions.keys()], [replacement.ref.token]);
});
// Blocker: scene-registry.js reserved for architect round 4; request w5-to-w1-1.md.
test.todo(
  "resources: home3 reports assetDirs [home3-assets] and stateFields [_boilerStatePath]; so do an alias key for the same file and a copy of it",
);
// Blocker: same reserved registry implementation (w5-to-w1-1.md).
test.todo(
  "resources: home, funkeykid, health and the Ulanzi scenes report no asset folder and no state field",
);
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
// Blocker: reserved registry and W1 registry-lane integration (w5-to-w1-1.md).
test.todo(
  "registry order: load, refresh and sync are called from main.js's lane only, read the effective scene map when they run, and a failed import keeps the last good metadata",
);
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
  await rename(dir, join(parent, "old-directory"));
  await mkdir(dir);
  await writeFile(file, "// replacement directory");
  await waitFor(() => seen.filter((path) => path === file).length === 2);
  await mkdir(assets);
  dirs = [dir, assets];
  const image = join(assets, "picture.png");
  await writeFile(image, "fixture pixels");
  await waitFor(() => seen.includes(image));
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(seen.length, 3);
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
