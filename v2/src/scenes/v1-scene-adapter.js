/**
 * v1 scene adapter: runs an unchanged v1 scene module inside v2.
 *
 * THE v1 SCENE CONTRACT, exactly (matrix B-004 to B-012, section 4.1; source
 * lib/scene-loader.js:98-164 and 286-314 at 5819dcb):
 *
 *   const exported = module.default || module      // object with the hooks
 *   const scene = Object.create(exported)          // one per (scene, device); methods on the prototype,
 *                                                  // instance fields (this._state, this._settings, …) per device
 *   scene.render must be a function, else the load fails
 *   if (typeof scene.init === "function") await scene.init(ctx)        // once, before the first render
 *   delay = await scene.render(device)                                 // every frame
 *   if (typeof scene.destroy === "function") await scene.destroy(ctx)  // on release; a throw is logged
 *
 *   ctx = {
 *     logger,                                   // {debug, info, warn, error}
 *     deviceName, sceneName,
 *     settingsTopic,                            // "<settingsBase>/<device>/<scene>/settings"
 *     settings: { schema, values, get(key), all(), subscribe(cb) → unsubscribe },
 *     mqtt: { deviceName, subscribe(topic, cb(payload)), subscribeWildcard(pattern, cb(payload, topic)), unsubscribeAll() },
 *   }
 *   A fresh ctx object is built for init and for destroy, as in v1. Both
 *   belong to the same instance (InstanceRef): release removes only that
 *   instance's subscriptions before draining its admitted frames. Destroy
 *   follows frame settlement or the remaining stop budget (default 6 s),
 *   with a warning when a hung frame outlives that budget.
 *
 *   device = the v1 driver surface, see v1-device-facade.js
 *
 *   render's return value: a number > 0 is the delay in ms until the next
 *   frame. v1 ran anything else without a pause (S-7); v2's loop applies the
 *   frame floor instead, so the adapter reports "no delay given" as null.
 *
 * Metadata fields read from the exported object: name, pretty_name,
 * description, deviceType, settingsSchema (scene-registry.js).
 *
 * Deliberate differences, all invisible to the shipped scenes:
 *  - ctx.settings.schema and ctx.settings.values are live getters, not
 *    snapshots taken at init (B-167); the fields stay
 *  - ctx.mqtt has subscribeWildcard also when MQTT is not configured (S-17)
 *  - a callback given to ctx.settings.subscribe gets its own copy of the
 *    values, and a promise it returns is awaited and its rejection logged
 *    (A-188, A-189, A-BUG-41)
 *  - errors are classified: a DeviceError thrown by the device surface passes
 *    through; everything else becomes a SceneError with the phase
 *
 * One evaluation per device. The runtime imports the scene file once per
 * device (scene-runtime.js), so `exported` above is that device's own object
 * and module-level state is not shared between devices (B-005).
 *
 * Scene state files. Scenes are files v2 must not edit, yet two of them write
 * a history file next to themselves (home2, home3:
 * `this._boilerStatePath ??= <scene dir>/.state/<name>-boiler.json`, B-153).
 * For a device in shadow output the adapter sets every field named in the
 * scene's `resources.stateFields` on the instance before init, pointing into
 * v2's own data directory:
 *   <data dir>/.pixdcon2/shadow-state/<device>/<scene key>-<field>.json
 * so a shadow never writes into the scenes directory that v1 is using. The
 * fields come from the content of the scene file (scene-registry.js), not
 * from its key: an alias of home3 under another key and a copy of home3 are
 * redirected exactly like home3 itself (B-183). STATE_FIELD_PATTERNS is the
 * complete list of what the registry looks for; shadow also sets these
 * fields if metadata missed them. A driven device keeps the
 * scene's own path, so the history continues across the switch-over.
 *
 * Owner: fixtures + edge lane worker.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DeviceError, SceneError } from "../core/errors.js";

/** @typedef {import("./scene-runtime.js").SceneInstance} SceneInstance */

/**
 * Instance fields that hold the path of a file a scene writes. The registry
 * reports a field in `SceneMeta.resources.stateFields` when the scene file
 * mentions it.
 *
 * @type {ReadonlyArray<string>}
 */
export const STATE_FIELD_PATTERNS = Object.freeze(["_boilerStatePath"]);

/**
 * Folders beside a scene file that hold its own pictures are named
 * "<something>-assets" (scenes/pixoo/home3-assets). The registry reports a
 * folder in `SceneMeta.resources.assetDirs` when the scene file mentions it
 * and it exists beside the file.
 */
export const ASSET_DIR_PATTERN = /["'`]([A-Za-z0-9._-]+-assets)\//g;

/**
 * v1 `ctx.settings` (matrix A-094, A-095, B-012).
 *
 * @typedef {object} V1SettingsContext
 * @property {Record<string, import("../types.js").SettingField>} schema
 * @property {Record<string, unknown>} values
 * @property {(key: string) => unknown} get effective value now
 * @property {() => Record<string, unknown>} all effective values now
 * @property {(cb: (values: Record<string, unknown>) => unknown) => () => void} subscribe called at once and after every change of an effective value
 */

/**
 * @typedef {object} V1SceneContext
 * @property {import("../types.js").Logger} logger
 * @property {string} deviceName
 * @property {string} sceneName
 * @property {string} settingsTopic
 * @property {V1SettingsContext} settings
 * @property {import("../mqtt/mqtt-gateway.js").V1MqttContext} mqtt
 */

/**
 * @typedef {object} V1AdapterDeps
 * @property {(ref: import("../types.js").InstanceRef) => V1SettingsContext} settingsContext
 * @property {(ref: import("../types.js").InstanceRef) => import("../mqtt/mqtt-gateway.js").V1MqttContext} mqttContext
 * @property {(device: string, scene: string) => string} settingsTopic topics.settingsRoot
 * @property {string|null} shadowStateDir "<data dir>/.pixdcon2/shadow-state/<device>" for a device in shadow output, else null
 * @property {import("../types.js").SceneResources} resources of the scene file
 * @property {import("../types.js").Logger} logger
 */

/**
 * Does this module satisfy the v1 contract?
 *
 * @param {unknown} moduleNamespace result of import()
 * @returns {{ok: true, exported: Record<string, unknown>} | {ok: false, problem: string}}
 */
export function checkV1Module(moduleNamespace) {
  if (
    moduleNamespace === null ||
    (typeof moduleNamespace !== "object" &&
      typeof moduleNamespace !== "function")
  ) {
    return {
      ok: false,
      problem: "Scene module must export an object with render()",
    };
  }
  const namespace = /** @type {Record<string, unknown>} */ (moduleNamespace);
  const exported = namespace.default || namespace;
  if (
    exported === null ||
    (typeof exported !== "object" && typeof exported !== "function") ||
    typeof (/** @type {Record<string, unknown>} */ (exported).render) !==
      "function"
  ) {
    return { ok: false, problem: "Scene module must export render()" };
  }
  return {
    ok: true,
    exported: /** @type {Record<string, unknown>} */ (exported),
  };
}

/**
 * Create and initialise the instance of a v1 scene for one device.
 *
 * @param {{ref: import("../types.js").InstanceRef, moduleNamespace: unknown}} target moduleNamespace: the evaluation of the scene file for this device
 * @param {V1AdapterDeps} deps
 * @returns {Promise<SceneInstance>}
 * @throws {import("../core/errors.js").SceneError} phase "contract" or "init"
 */
export async function createV1Instance(target, deps) {
  const { ref } = target;
  const checked = checkV1Module(target.moduleNamespace);
  if (!checked.ok)
    throw new SceneError(checked.problem, { ...ref, phase: "contract" });
  const scene = Object.create(checked.exported);
  let active = true;
  /** @type {Promise<void>|null} */
  let releasing = null;
  /** @type {Set<Promise<number|null>>} */
  const frames = new Set();
  /** @type {Set<() => void>} */
  const unsubscribers = new Set();
  const settings = deps.settingsContext(ref);
  const mqtt = deps.mqttContext(ref);
  /** @param {unknown} error */
  const log = (error) =>
    deps.logger.warn(
      `[scene:${ref.scene}:${ref.device}] ${error instanceof Error ? error.message : String(error)}`,
    );
  /** @param {() => unknown} callback */
  const invoke = async (callback) => {
    if (!active) return;
    try {
      await callback();
    } catch (error) {
      log(error);
    }
  };
  /** @returns {V1SceneContext} */
  const context = () => ({
    logger: deps.logger,
    deviceName: ref.device,
    sceneName: ref.scene,
    settingsTopic: deps.settingsTopic(ref.device, ref.scene),
    settings: {
      get schema() {
        return structuredClone(settings.schema);
      },
      get values() {
        return structuredClone(settings.values);
      },
      get: (key) => structuredClone(settings.get(key)),
      all: () => structuredClone(settings.all()),
      subscribe(callback) {
        if (!active) return () => {};
        const unsubscribe = settings.subscribe((values) =>
          invoke(() => callback(structuredClone(values))),
        );
        unsubscribers.add(unsubscribe);
        return () => {
          unsubscribers.delete(unsubscribe);
          unsubscribe();
        };
      },
    },
    mqtt: {
      deviceName: mqtt.deviceName,
      subscribe(topic, callback) {
        if (active)
          mqtt.subscribe(topic, (payload) => invoke(() => callback(payload)));
      },
      subscribeWildcard(pattern, callback) {
        if (active)
          mqtt.subscribeWildcard(pattern, (payload, topic) =>
            invoke(() => callback(payload, topic)),
          );
      },
      unsubscribeAll: () => mqtt.unsubscribeAll(),
    },
  });
  /** @param {unknown} error @param {"init"|"render"} phase */
  const classify = (error, phase) =>
    error instanceof DeviceError
      ? error
      : new SceneError(
          `Scene ${ref.scene} ${phase}: ${error instanceof Error ? error.message : String(error)}`,
          { ...ref, phase, cause: error },
        );
  /** @param {import("./scene-runtime.js").SceneReleaseOptions} [options] */
  const release = (options = {}) => {
    if (releasing) return releasing;
    active = false;
    const deadlineMs = Number.isFinite(options.deadlineMs)
      ? Math.max(0, options.deadlineMs ?? 6000)
      : 6000;
    const deadlineAt = Date.now() + deadlineMs;
    // Store the promise before invoking unsubscribe/destroy hooks; even a
    // hook that reenters release gets the same teardown operation.
    releasing = Promise.resolve().then(async () => {
      try {
        if (frames.size) {
          /** @type {ReturnType<typeof setTimeout>|undefined} */
          let timer;
          try {
            const drained = await Promise.race([
              Promise.allSettled([...frames]).then(() => true),
              new Promise((resolve) => {
                timer = setTimeout(
                  () => resolve(false),
                  Math.max(0, deadlineAt - Date.now()),
                );
              }),
            ]);
            if (!drained)
              log(
                `frame drain timed out after ${deadlineMs}ms; destroying with ${frames.size} frame(s) still in flight`,
              );
          } finally {
            clearTimeout(timer);
          }
        }
        if (typeof scene.destroy === "function") await scene.destroy(context());
      } catch (error) {
        log(error);
      }
    });
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        log(error);
      }
    }
    unsubscribers.clear();
    try {
      mqtt.unsubscribeAll();
    } catch (error) {
      log(error);
    }
    return releasing;
  };
  try {
    if (deps.shadowStateDir) {
      await mkdir(deps.shadowStateDir, { recursive: true });
      for (const field of new Set([
        ...STATE_FIELD_PATTERNS,
        ...deps.resources.stateFields,
      ])) {
        // Keys may come from mounted files; encode path components rather than trusting them.
        scene[field] = join(
          deps.shadowStateDir,
          `${encodeURIComponent(ref.scene)}-${encodeURIComponent(field)}.json`,
        );
      }
    }
    if (typeof scene.init === "function") await scene.init(context());
  } catch (error) {
    await release();
    throw classify(error, "init");
  }
  return {
    ref,
    scene: ref.scene,
    device: ref.device,
    release,
    async renderFrame(surface) {
      if (!active)
        throw new SceneError(`Scene ${ref.scene} was released`, {
          ...ref,
          phase: "render",
        });
      // Register before invoking scene code, including a synchronous render
      // that asks its caller to release. Release sees every admitted frame.
      const frame = Promise.resolve().then(async () => {
        try {
          const delay = await scene.render(surface);
          return typeof delay === "number" &&
            Number.isFinite(delay) &&
            delay > 0
            ? delay
            : null;
        } catch (error) {
          throw classify(error, "render");
        }
      });
      frames.add(frame);
      try {
        return await frame;
      } finally {
        frames.delete(frame);
      }
    },
  };
}
