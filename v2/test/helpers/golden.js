/**
 * Golden frames: compare a rendered picture with a stored one.
 *
 * Test kind 1 of 3 (Markus, phase-2 decision): fixed screen images per scene,
 * rendered from fixed inputs (time, time zone, settings, MQTT messages, HTTP
 * answers). No per-function unit tests.
 *
 * A golden frame is a PNG under test/golden/frames/, one per scenario, so a
 * person can open it and a diff in a pull request shows the picture. PNG is
 * lossless; the comparison is on the decoded RGB bytes, exact, no tolerance.
 * For Ulanzi scenes the exact contract with the display is the AWTRIX payload;
 * it is stored next to the picture as <name>.json and compared as JSON.
 *
 *   UPDATE_GOLDEN=1 npm run test:golden      write or overwrite the stored frames
 *
 * When a comparison fails, the rendered picture and a diff picture (changed
 * pixels in magenta on the dimmed expected frame) are written to test/.out/.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
export const FRAMES_DIR = resolve(here, "../golden/frames");
export const FIXTURES_DIR = resolve(here, "../golden/fixtures");
export const OUT_DIR = resolve(here, "../.out");

/** @typedef {import("../../src/types.js").Frame} Frame */

/**
 * @param {Frame} frame
 * @returns {Promise<Buffer>} PNG bytes
 */
export function encodePng(frame) {
  assert.equal(
    frame.rgb.length,
    frame.width * frame.height * 3,
    "frame size does not match its dimensions",
  );
  return sharp(Buffer.from(frame.rgb), {
    raw: { width: frame.width, height: frame.height, channels: 3 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * @param {Buffer} png
 * @returns {Promise<Frame>}
 */
export async function decodePng(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgb: new Uint8Array(data) };
}

/**
 * Compare a frame with the stored golden frame `name`.
 *
 * @param {string} name file name without extension, e.g. "home3--noon-all-fresh"
 * @param {Frame} frame
 * @returns {Promise<void>} rejects with the number and the first position of differing pixels
 */
export async function expectFrame(name, frame) {
  const file = join(FRAMES_DIR, `${name}.png`);
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(FRAMES_DIR, { recursive: true });
    await writeFile(file, await encodePng(frame));
    return;
  }
  let stored;
  try {
    stored = await readFile(file);
  } catch {
    assert.fail(
      `no golden frame ${name}.png yet; create it with UPDATE_GOLDEN=1 npm run test:golden and look at it`,
    );
  }
  const expected = await decodePng(stored);
  assert.deepEqual(
    { width: frame.width, height: frame.height },
    { width: expected.width, height: expected.height },
    `${name}: size differs`,
  );
  let different = 0;
  let first = "";
  const diff = new Uint8Array(expected.rgb.length);
  for (let i = 0; i < expected.rgb.length; i += 3) {
    const same =
      expected.rgb[i] === frame.rgb[i] &&
      expected.rgb[i + 1] === frame.rgb[i + 1] &&
      expected.rgb[i + 2] === frame.rgb[i + 2];
    if (same) {
      diff[i] = expected.rgb[i] >> 2;
      diff[i + 1] = expected.rgb[i + 1] >> 2;
      diff[i + 2] = expected.rgb[i + 2] >> 2;
    } else {
      different += 1;
      if (!first)
        first = `x${(i / 3) % expected.width} y${Math.floor(i / 3 / expected.width)}`;
      diff[i] = 255;
      diff[i + 2] = 255;
    }
  }
  if (different === 0) return;
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, `${name}.actual.png`), await encodePng(frame));
  await writeFile(
    join(OUT_DIR, `${name}.diff.png`),
    await encodePng({ ...expected, rgb: diff }),
  );
  assert.fail(
    `${name}: ${different} pixel(s) differ, first at ${first}; see test/.out/${name}.actual.png and .diff.png`,
  );
}

/**
 * Compare an AWTRIX payload with the stored one.
 *
 * @param {string} name
 * @param {unknown} payload
 */
export async function expectPayload(name, payload) {
  const file = join(FRAMES_DIR, `${name}.json`);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(FRAMES_DIR, { recursive: true });
    await writeFile(file, text);
    return;
  }
  let stored;
  try {
    stored = await readFile(file, "utf8");
  } catch {
    assert.fail(
      `no golden payload ${name}.json yet; create it with UPDATE_GOLDEN=1 npm run test:golden and read it`,
    );
  }
  assert.deepEqual(
    payload,
    JSON.parse(stored),
    `${name}: AWTRIX payload differs`,
  );
}

/**
 * A scenario file under test/golden/fixtures/: the fixed inputs of one frame.
 *
 * @typedef {object} GoldenScenario
 * @property {string} name golden frame name
 * @property {string} scene scene key as in dev/dev-config.json
 * @property {import("../../src/types.js").DeviceType} deviceType
 * @property {string} now ISO time with offset, the frozen "now" of the render
 * @property {string} timeZone e.g. "Europe/Vienna"
 * @property {Record<string, unknown>} [settings] saved setting values
 * @property {Array<{topic: string, payload: string|Record<string, unknown>}>} [mqtt] messages delivered after init, in order
 * @property {Array<{url: string, status?: number, body?: unknown}>} [http] answers for the scene's own requests; anything else fails
 * @property {number} [elapsedMs] advance the frozen clock after MQTT
 * @property {boolean} [startFrameBeforeAdvance] render once before advancing (tab timers)
 * @property {Record<string, boolean>} [ping] canned ping answers, never a child process
 * @property {unknown} [boilerHistory] initial history file in the fixture's data directory
 * @property {number} [frames] render this many frames and compare the last one (animations), default 1
 * @property {string} [note] what the picture should show, for the person reviewing it
 */

/**
 * @param {string} file name under test/golden/fixtures/
 * @returns {Promise<GoldenScenario>}
 */
export async function loadScenario(file) {
  return JSON.parse(await readFile(join(FIXTURES_DIR, file), "utf8"));
}

/**
 * Render an unchanged shared scene with fixture I/O. The same scenario runs
 * once through v1's drawing driver and once through v2's adapter and surface.
 * No socket is opened: fetch/HTTPS are in-process answers, and a module-local
 * child_process peer answers ping. The network guard itself stays installed.
 *
 * Extra fixture inputs: elapsedMs advances time after MQTT delivery; ping maps
 * an IP to a canned alive result; boilerHistory seeds the redirected state file.
 * @param {import('node:test').TestContext} t
 * @param {GoldenScenario & {elapsedMs?: number, ping?: Record<string, boolean>, boilerHistory?: unknown}} scenario
 * @param {{reference?: boolean, device?: string, priorDeviceFrames?: number}} [options]
 */
export async function renderScenario(t, scenario, options = {}) {
  const { EventEmitter } = await import("node:events");
  const https = (await import("node:https")).default;
  const { pathToFileURL } = await import("node:url");
  const { mkdtemp } = await import("node:fs/promises");
  const { SceneRuntime } = await import("../../src/scenes/scene-runtime.js");
  const { createPixooSurface, createUlanziSurface } =
    await import("../../src/scenes/v1-device-facade.js");
  const {
    loadV1Font,
    loadV1ReferenceDrivers,
    sharedPaths,
    installSharedResolution,
  } = await import("../../src/scenes/v1-shared.js");
  const { rasterizeAwtrixApp } =
    await import("../../src/drivers/awtrix-raster.js");
  const { sceneContexts, silentLogger, sinkDriver } =
    await import("./scene-context.js");
  installSharedResolution();
  const oldZone = process.env.TZ;
  const envKeys = [
    "SONNEN_BATTERY_HOST",
    "SONNEN_BATTERY_API_TOKEN",
    "SYNCBOX_BEARER_TOKEN",
  ];
  const previousEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  process.env.SONNEN_BATTERY_HOST = "127.0.0.1";
  process.env.SONNEN_BATTERY_API_TOKEN = "fixture-only";
  process.env.SYNCBOX_BEARER_TOKEN = "fixture-only";
  process.env.TZ = scenario.timeZone;
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: Date.parse(scenario.now),
  });
  await mkdir(OUT_DIR, { recursive: true });
  const dataDir = await mkdtemp(join(OUT_DIR, "golden-"));
  const { scenesDir } = sharedPaths();
  const sceneFile = join(
    scenesDir,
    scenario.deviceType,
    `${scenario.scene}.js`,
  );
  const pingKey = Symbol.for("pixdcon2.golden.ping");
  const globals = /** @type {any} */ (globalThis);
  globals[pingKey] = (
    /** @type {string} */ program,
    /** @type {string[]} */ args,
    /** @type {unknown} */ _options,
    /** @type {Function} */ callback,
  ) => {
    const alive =
      program === "ping" && scenario.ping?.[args.at(-1) ?? ""] === true;
    queueMicrotask(() =>
      callback(
        alive
          ? null
          : Object.assign(new Error("fixture: no ping answer"), {
              code: "ENOENT",
            }),
        alive ? "64 bytes: time=1.0 ms" : "",
      ),
    );
    return { kill() {} };
  };
  // Scoped import peer, never a patch of net-guard or the process-wide spawn API.
  const hook = await installGoldenPingPeer();
  /** @param {string} url */
  const answer = (url) =>
    scenario.http?.find((row) =>
      row.url.endsWith("*")
        ? url.startsWith(row.url.slice(0, -1))
        : row.url === url,
    );
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (/** @type {unknown} */ input) => {
      const row = answer(String(input));
      if (!row) throw new Error(`fixture: no HTTP answer for ${input}`);
      return new Response(JSON.stringify(row.body ?? {}), {
        status: row.status ?? 200,
      });
    },
  );
  const httpsMock = t.mock.method(
    https,
    "request",
    (/** @type {any} */ input, /** @type {Function} */ callback) => {
      const url =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : `https://${input.hostname ?? input.host}${input.path ?? "/"}`;
      const request = new EventEmitter();
      let ended = false;
      Object.assign(request, {
        end() {
          queueMicrotask(() => {
            if (ended) return;
            const row = answer(url);
            if (!row) {
              request.emit(
                "error",
                new Error(`fixture: no HTTP answer for ${url}`),
              );
              request.emit("close");
              return;
            }
            const response = Object.assign(new EventEmitter(), {
              statusCode: row.status ?? 200,
            });
            callback(response);
            response.emit("data", JSON.stringify(row.body ?? {}));
            response.emit("end");
            request.emit("close");
          });
        },
        destroy() {
          ended = true;
          request.emit("close");
        },
      });
      return /** @type {any} */ (request);
    },
  );
  /** @type {import('../../src/scenes/scene-runtime.js').SceneInstance|undefined} */
  let instance;
  /** @type {import('../../src/scenes/scene-runtime.js').SceneRuntime|undefined} */
  let runtime;
  /** @type {any} */
  let referenceScene;
  /** @type {import('../../src/scenes/v1-scene-adapter.js').V1SceneContext|undefined} */
  let referenceContext;
  try {
    const url = pathToFileURL(sceneFile);
    url.searchParams.set(
      "fixture",
      `${scenario.name}-${options.reference ? "v1" : "v2"}-${options.device ?? "device"}-${dataDir}`,
    );
    const namespace = await import(url.href);
    const exported = namespace.default ?? namespace;
    const settings = Object.fromEntries(
      Object.entries(exported.settingsSchema ?? {}).map(([key, field]) => [
        key,
        /** @type {any} */ (field).default,
      ]),
    );
    Object.assign(settings, scenario.settings);
    const contexts = sceneContexts(settings, exported.settingsSchema ?? {});
    const ref = {
      scene: scenario.scene,
      device: options.device ?? "golden",
      token: dataDir,
    };
    const stateFields = (await readFile(sceneFile, "utf8")).includes(
      "_boilerStatePath",
    )
      ? ["_boilerStatePath"]
      : [];
    const shadowStateDir = join(dataDir, "state");
    if (scenario.boilerHistory) {
      await mkdir(shadowStateDir, { recursive: true });
      await writeFile(
        join(shadowStateDir, `${scenario.scene}-_boilerStatePath.json`),
        JSON.stringify(scenario.boilerHistory),
      );
    }
    /** @type {Frame|null} */
    let frame = null;
    /** @type {Record<string, unknown>|null} */
    let payload = null;
    /** @type {number[]} */
    const brightness = [];
    /** @type {import('../../src/scenes/v1-device-facade.js').SceneSurface} */
    let surface;
    if (options.reference) {
      const { PixooDriver, UlanziDriver } = await loadV1ReferenceDrivers();
      const driver =
        scenario.deviceType === "pixoo"
          ? new PixooDriver("127.0.0.1", {
              deviceName: ref.device,
              logger: silentLogger,
            })
          : new UlanziDriver("127.0.0.1", { logger: silentLogger });
      driver.initialized = true;
      driver.setBrightness = async (/** @type {number} */ value) => {
        brightness.push(value);
        return true;
      };
      if (scenario.deviceType === "pixoo") {
        // Use the real v1 push path and decode its wire payload, with transport replaced.
        driver._httpPost = async (/** @type {any} */ body) => {
          if (body.Command === "Draw/SendHttpGif")
            frame = {
              width: 64,
              height: 64,
              rgb: new Uint8Array(Buffer.from(body.PicData, "base64")),
            };
          return { error_code: 0 };
        };
      } else {
        driver.drawCustom = async (
          /** @type {Record<string, unknown>} */ app,
        ) => {
          payload = structuredClone(app);
          frame = rasterizeAwtrixApp(app).frame;
          return true;
        };
      }
      surface = driver;
      referenceScene = Object.create(exported);
      if (stateFields.length)
        referenceScene._boilerStatePath = join(
          shadowStateDir,
          `${scenario.scene}-_boilerStatePath.json`,
        );
      referenceContext = {
        logger: silentLogger,
        deviceName: ref.device,
        sceneName: ref.scene,
        settingsTopic: "golden/settings",
        settings: contexts.settingsContext(ref),
        mqtt: contexts.mqttContext(ref),
      };
      await referenceScene.init?.(referenceContext);
    } else {
      const sink = {
        driver: sinkDriver(),
        /** @param {import('../../src/drivers/driver.js').DeviceOutput} output */
        async show(output) {
          if (output.kind === "frame")
            frame = { ...output.frame, rgb: output.frame.rgb.slice() };
          else {
            payload = structuredClone(output.app);
            frame = rasterizeAwtrixApp(output.app).frame;
          }
        },
        async requestBrightness(/** @type {number} */ value) {
          brightness.push(value);
          return true;
        },
      };
      surface =
        scenario.deviceType === "pixoo"
          ? createPixooSurface(
              { name: ref.device, address: "127.0.0.1" },
              sink,
              await loadV1Font(),
            )
          : createUlanziSurface(
              { name: ref.device, address: "127.0.0.1" },
              sink,
            );
      runtime = new SceneRuntime({
        registry: /** @type {any} */ ({
          fileOf: () => sceneFile,
          get: () => ({ resources: { assetDirs: [], stateFields } }),
        }),
        settings: /** @type {any} */ ({
          runtimeContext: contexts.settingsContext,
          releaseContext: contexts.releaseContext,
        }),
        mqttContext: contexts.mqttContext,
        settingsTopic: () => "golden/settings",
        outputOf: () => "shadow",
        dataDir,
        logger: silentLogger,
      });
      if (scenario.boilerHistory) {
        const stateDir = join(dataDir, ".pixdcon2/shadow-state", ref.device);
        await mkdir(stateDir, { recursive: true });
        await writeFile(
          join(stateDir, `${scenario.scene}-_boilerStatePath.json`),
          JSON.stringify(scenario.boilerHistory),
        );
      }
      if (options.priorDeviceFrames) {
        const prior = await runtime.acquire(scenario.scene, "prior-device");
        for (let i = 0; i < options.priorDeviceFrames; i++)
          await prior.renderFrame(surface);
      }
      instance = await runtime.acquire(scenario.scene, ref.device);
    }
    /** Flush scene-owned asynchronous fixture polls without advancing the frame clock. */
    const flush = async () => {
      for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setImmediate(resolve));
    };
    await flush();
    for (const message of scenario.mqtt ?? [])
      await contexts.deliver(message.topic, message.payload);
    const render = async () => {
      if (options.reference) await referenceScene.render(surface);
      else await instance?.renderFrame(surface);
    };
    if (scenario.startFrameBeforeAdvance) await render();
    if (scenario.elapsedMs) {
      t.mock.timers.tick(scenario.elapsedMs);
      await flush();
    }
    for (let i = 0; i < (scenario.frames ?? 1); i++) await render();
    assert.ok(frame, `${scenario.name}: scene pushed a frame`);
    return { frame: /** @type {Frame} */ (frame), payload, brightness };
  } finally {
    await runtime?.releaseAll();
    if (referenceScene) await referenceScene.destroy?.(referenceContext);
    httpsMock.mock.restore();
    fetchMock.mock.restore();
    hook.deregister();
    delete globals[pingKey];
    t.mock.timers.reset();
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    if (oldZone === undefined) delete process.env.TZ;
    else process.env.TZ = oldZone;
  }
}

/** Import-scoped ping fixture peer. Leaves the guarded child_process API intact.
 * Loaded before the shared scene import smoke so its cached helpers see the peer.
 */
export async function installGoldenPingPeer() {
  const { registerHooks } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { sharedPaths } = await import("../../src/scenes/v1-shared.js");
  const { scenesDir, libDir } = sharedPaths();
  const pingModule =
    "data:text/javascript," +
    encodeURIComponent(
      `export function execFile(...args) { return globalThis[Symbol.for('pixdcon2.golden.ping')](...args); }`,
    );
  return registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL ?? "";
      if (
        (specifier === "child_process" || specifier === "node:child_process") &&
        [scenesDir, libDir].some((dir) =>
          parent.startsWith(pathToFileURL(`${dir}/`).href),
        )
      ) {
        return { url: pingModule, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}
