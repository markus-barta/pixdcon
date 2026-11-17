/**
 * Scene runtime: loaded scene instances, one per (scene, device).
 *
 * Kept from v1 (lib/scene-loader.js; matrix B-003 to B-007, B-013 to B-015):
 *  - a scene file is imported with a file:// URL and a `?t=<token>` that
 *    changes when the file changed, so Node evaluates it again
 *  - each (scene, device) pair has its own instance; init() runs once per
 *    instance and is awaited before the first render
 *  - releasing an instance calls destroy(), and afterwards always removes the
 *    instance's MQTT subscriptions and settings subscribers, also when
 *    destroy() threw (B-007, C-046)
 *
 * Fixed:
 *  - Real isolation per device (B-005, S-16). v1 evaluates a scene file once
 *    and gives every device `Object.create(module)`: fields assigned on
 *    `this` are per device, but module-level variables and objects reached
 *    through the prototype are shared (scenes/pixoo/health.js keeps its glow
 *    phase in a module variable). v2 evaluates the scene file once per
 *    device: the import URL is `<file>?t=<file token>&d=<device>`. Helper
 *    modules a scene imports (lib/pixoo-image.js, the collectors) keep one
 *    URL and stay shared, as their caches are meant to be.
 *  - one pending load per (scene, device): a second caller gets the same
 *    promise, never a half-initialised instance (B-165, S-48)
 *  - hot reload keeps the last good instance running when the new file does
 *    not import or init; the scene is reported broken with the reason (B-022).
 *    For that, the replacement is created and initialised beside the running
 *    instance. The two are told apart by their InstanceRef: each has its own
 *    token, its own MQTT owner and its own settings subscribers. When init
 *    succeeded, the loop switches at its next frame boundary and the old
 *    instance is released; when import or init failed, only the
 *    replacement's subscriptions are released and the old instance never
 *    notices.
 *  - only the changed file is imported again; the file token is per file (S-18)
 *
 * The runtime knows nothing about the v1 contract itself. It asks an adapter
 * (v1-scene-adapter.js is the only one today) to turn a module into a
 * SceneInstance, so a later native v2 scene format plugs in here.
 *
 * Owner: fixtures + edge lane worker.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SceneError } from "../core/errors.js";
import { createV1Instance } from "./v1-scene-adapter.js";
import { installSharedResolution } from "./v1-shared.js";

/**
 * What the render loop drives. One instance per (scene, device).
 *
 * @typedef {object} SceneInstance
 * @property {import("../types.js").InstanceRef} ref scene key, device name and the token of this instance
 * @property {string} scene scene key (same as ref.scene)
 * @property {string} device device name (same as ref.device)
 * @property {(surface: import("./v1-device-facade.js").SceneSurface) => Promise<number|null>} renderFrame
 *   one frame. Resolves with the delay in ms the scene asked for, or null for
 *   "no delay given" (the loop then waits minFrameMs). Rejects with a
 *   DeviceError when the display refused the frame, with a SceneError for
 *   anything else.
 * @property {() => Promise<void>} release destroy and unsubscribe; never rejects
 */

/**
 * @typedef {object} SceneRuntimeDeps
 * @property {import("./scene-registry.js").SceneRegistry} registry
 * @property {import("./settings-service.js").SettingsService} settings runtimeContext(ref) and releaseContext(ref)
 * @property {(ref: import("../types.js").InstanceRef) => import("../mqtt/mqtt-gateway.js").V1MqttContext} mqttContext built by main.js: the gateway's sceneContext, or the offline stand-in when MQTT is not configured
 * @property {(device: string, scene: string) => string} settingsTopic topics.settingsRoot
 * @property {(device: string) => import("../types.js").OutputMode} outputOf the one resolved output policy; "shadow" redirects the scene's state files
 * @property {string} dataDir directory of config.json; shadow state lives in "<dataDir>/.pixdcon2/shadow-state/<device>/"
 * @property {import("../types.js").Logger} logger
 */

/**
 * @typedef {object} RuntimeEntry
 * @property {string} scene
 * @property {string} device
 * @property {import("../types.js").OutputMode} output captured before init; state paths depend on it
 * @property {number} generation
 * @property {SceneInstance|null} current
 * @property {Promise<SceneInstance>|null} pending
 */

export class SceneRuntime {
  /** @param {SceneRuntimeDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, RuntimeEntry>} */
    this.entries = new Map();
    /** @type {Set<SceneInstance>} */
    this.instances = new Set();
    /** @type {Set<Promise<SceneInstance>>} */
    this.pending = new Set();
    this.closed = false;
    this.counter = 0;
    this.identity = randomUUID();
    /** @type {Map<string, number>} */
    this.fileTokens = new Map();
    installSharedResolution({ extraDirs: [deps.dataDir] });
  }

  /**
   * Get the instance to render with for a scene on a device, loading and
   * initialising it when needed. After a hot reload this is the replacement,
   * once its init succeeded; until then, and when it failed, the instance
   * that was running.
   *
   * @param {string} scene
   * @param {string} device
   * @returns {Promise<SceneInstance>}
   * @throws {import("../core/errors.js").SceneError} unknown scene, import failed, no render(), init failed
   */
  async acquire(scene, device) {
    if (this.closed)
      throw new SceneError("Scene runtime is stopped", {
        scene,
        device,
        phase: "import",
      });
    const key = JSON.stringify([scene, device]);
    const output = this.deps.outputOf(device);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        scene,
        device,
        output,
        generation: 0,
        current: null,
        pending: null,
      };
      this.entries.set(key, entry);
    } else if (entry.output !== output) {
      // A rebuilt runtime must never inherit the old mode's state paths.
      // Its old instance stays owned by the old loop until that loop releases it.
      entry.generation++;
      entry.output = output;
      entry.current = null;
      return this.load(entry);
    }
    if (entry.current) return entry.current;
    return entry.pending ?? this.load(entry);
  }

  /**
   * Release this instance, and no other instance of the same scene and
   * device, after its frame in flight has finished: destroy(), then its MQTT
   * owner and its settings subscribers go.
   *
   * @param {SceneInstance} instance
   */
  async release(instance) {
    const key = JSON.stringify([instance.scene, instance.device]);
    const entry = this.entries.get(key);
    if (entry?.current === instance) {
      entry.generation++;
      entry.current = null;
      this.entries.delete(key);
    }
    try {
      await instance.release();
    } finally {
      this.instances.delete(instance);
      this.deps.settings.releaseContext(instance.ref);
    }
  }

  /**
   * Is this still the instance to render with? False once a replacement is
   * ready: the loop then acquires again and releases the one it holds.
   * @param {SceneInstance} instance
   * @returns {boolean}
   */
  isCurrent(instance) {
    return (
      !this.closed &&
      this.entries.get(JSON.stringify([instance.scene, instance.device]))
        ?.current === instance
    );
  }

  /**
   * The file of these scenes changed: mark them for reload. Devices running
   * them get a replacement instance, initialised beside the running one, and
   * switch to it at their next frame boundary (see "hot reload" above).
   * Returns after scheduling: mounted scene init must not hold the registry
   * lane. Until a replacement is ready the last good instance stays current.
   *
   * @param {string[]} scenes
   * @returns {Promise<{devices: string[]}>} devices that run one of them
   */
  async invalidate(scenes) {
    if (this.closed) return { devices: [] };
    const changed = new Set(scenes);
    for (const scene of changed)
      this.fileTokens.set(scene, (this.fileTokens.get(scene) ?? 0) + 1);
    const devices = new Set();
    for (const entry of this.entries.values()) {
      if (!changed.has(entry.scene)) continue;
      entry.generation++;
      devices.add(entry.device);
      void this.load(entry).catch((error) => {
        this.deps.logger.warn(
          `Scene ${entry.scene} reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return { devices: [...devices] };
  }

  /** Prepare a replacement beside the running instance; only its generation may install it.
   * @param {RuntimeEntry} entry
   * @returns {Promise<SceneInstance>}
   */
  load(entry) {
    const { scene, device, output, generation } = entry;
    const key = JSON.stringify([scene, device]);
    const fileToken = `${this.identity}-${this.fileTokens.get(scene) ?? 0}`;
    const ref = { scene, device, token: `${fileToken}.${++this.counter}` };
    const current = () =>
      !this.closed &&
      this.entries.get(key) === entry &&
      entry.generation === generation;
    /** @type {Promise<SceneInstance>} */
    const promise = (async () => {
      /** @type {SceneInstance|null} */
      let instance = null;
      try {
        const file = this.deps.registry.fileOf(scene);
        const meta = this.deps.registry.get(scene);
        if (!file || !meta)
          throw new SceneError(`Unknown scene ${scene}`, {
            ...ref,
            phase: "import",
          });
        const url = pathToFileURL(file);
        url.searchParams.set("t", fileToken);
        url.searchParams.set("d", device);
        const moduleNamespace = await import(url.href);
        if (!current())
          throw new SceneError(`Scene ${scene} load was superseded`, {
            ...ref,
            phase: "import",
          });
        instance = await createV1Instance(
          { ref, moduleNamespace },
          {
            settingsContext: (owner) =>
              this.deps.settings.runtimeContext(owner),
            mqttContext: this.deps.mqttContext,
            settingsTopic: this.deps.settingsTopic,
            resources: meta.resources,
            shadowStateDir:
              output === "shadow"
                ? join(
                    this.deps.dataDir,
                    ".pixdcon2/shadow-state",
                    encodeURIComponent(device),
                  )
                : null,
            logger: this.deps.logger,
          },
        );
        if (!current()) {
          await instance.release();
          throw new SceneError(`Scene ${scene} load was superseded`, {
            ...ref,
            phase: "import",
          });
        }
        entry.current = instance;
        this.instances.add(instance);
        return instance;
      } catch (error) {
        this.deps.settings.releaseContext(ref);
        // A reload during the first init is not a scene failure. Its callers
        // follow the latest load, even if that load already finished. Stop or
        // release removes the entry and must still reject the stale caller.
        if (!this.closed && this.entries.get(key) === entry && !current()) {
          if (entry.pending) return entry.pending;
          if (entry.current) return entry.current;
        }
        if (error instanceof SceneError) throw error;
        throw new SceneError(
          `Scene ${scene} import: ${error instanceof Error ? error.message : String(error)}`,
          { ...ref, phase: "import", cause: error },
        );
      }
    })();
    entry.pending = promise;
    this.pending.add(promise);
    // Register cleanup without creating an unhandled rejected finally() promise.
    const settled = () => {
      this.pending.delete(promise);
      if (entry.pending === promise) entry.pending = null;
    };
    void promise.then(settled, settled);
    return promise;
  }

  /** Release every instance (shutdown). */
  async releaseAll() {
    this.closed = true;
    for (const entry of this.entries.values()) entry.generation++;
    this.entries.clear();
    // Fence admitted instances before yielding to pending init work. A
    // hanging init must not leave installed scenes open to another frame.
    const releases = [...this.instances].map((instance) =>
      this.release(instance),
    );
    await Promise.allSettled([...this.pending]);
    await Promise.all(releases);
  }
}
