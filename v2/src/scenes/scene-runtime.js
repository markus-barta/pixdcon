/**
 * Scene runtime: loaded scene instances, one per (scene, device).
 *
 * Kept from v1 (lib/scene-loader.js; matrix B-003 to B-007, B-013 to B-015):
 *  - a scene file is imported with a file:// URL and a `?t=<token>` that
 *    changes when the file changed, so Node evaluates it again
 *  - each (scene, device) pair has its own instance; init() runs once per
 *    instance and is awaited before the first render
 *  - releasing an instance always removes its MQTT subscriptions and settings
 *    subscribers, also when destroy() throws (B-007, C-046). Subscriptions go
 *    immediately; destroy follows frame drain within the loop's remaining
 *    stop budget (default 6 s), warning if a hung frame outlives that budget.
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
 *    Each entry tracks handed-out, unreleased instances. Loops acquire the
 *    replacement before releasing their old instance. When the last holder
 *    leaves, the runtime retires any unacquired current replacement and
 *    fences pending init, including on scene switch, disable or removal.
 *    A replacement superseded before acquisition is released by the runtime. Loads
 *    and supersede follows keep their captured output mode; a caller from a
 *    retired mode cannot acquire the rebuilt loop's instance.
 *  - only the changed file is imported again; the file token is per file (S-18)
 *  - releaseAll() is final: pending or later acquire/invalidate calls install
 *    nothing; an instance whose init finishes afterwards is destroyed at once
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

/** Cancellation by a newer load, output mode, release or shutdown is not a scene failure. */
export class SupersededLoadError extends SceneError {
  /** @param {import("../types.js").InstanceRef} ref */
  constructor(ref) {
    super(`Scene ${ref.scene} load was superseded`, {
      ...ref,
      phase: "import",
    });
    this.superseded = true;
  }
}

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
 * @property {(options?: SceneReleaseOptions) => Promise<void>} release unsubscribe immediately, drain frames within the budget, then destroy; never rejects
 */

/**
 * @typedef {object} SceneReleaseOptions
 * @property {number} [deadlineMs] remaining frame-drain budget; default 6000 ms (the loop stop budget)
 */

/**
 * @typedef {object} SceneAcquireOptions
 * @property {import("../types.js").OutputMode} [output] caller's captured output mode; a retired mode rejects as SupersededLoadError
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
 * @property {Set<SceneInstance>} holders handed-out instances not yet released; one loop per (scene, device), acquire before release
 * @property {number} acquiring admitted acquire calls; failed/cancelled first callers cannot strand a replacement
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
   * @param {SceneAcquireOptions} [options]
   * @returns {Promise<SceneInstance>}
   * @throws {import("../core/errors.js").SceneError} unknown scene, import failed, no render(), init failed
   */
  async acquire(scene, device, options = {}) {
    if (this.closed)
      throw new SceneError("Scene runtime is stopped", {
        scene,
        device,
        phase: "import",
      });
    const key = JSON.stringify([scene, device]);
    const output = this.deps.outputOf(device);
    if (options.output !== undefined && options.output !== output)
      throw new SupersededLoadError({ scene, device, token: "" });
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        scene,
        device,
        output,
        generation: 0,
        current: null,
        pending: null,
        holders: new Set(),
        acquiring: 0,
      };
      this.entries.set(key, entry);
    } else {
      this.refreshOutput(entry, output);
    }
    entry.acquiring++;
    try {
      for (;;) {
        const instance = await (entry.current ??
          entry.pending ??
          this.load(entry));
        // This also covers callers following a superseding load. An output
        // rebuild may have retired its result before this continuation ran.
        if (
          this.closed ||
          this.entries.get(key) !== entry ||
          entry.output !== output ||
          this.deps.outputOf(device) !== output
        ) {
          if (!entry.holders.has(instance)) await this.release(instance);
          throw new SupersededLoadError(instance.ref);
        }
        if (entry.current !== instance) continue;
        entry.holders.add(instance);
        return instance;
      }
    } finally {
      entry.acquiring--;
      // invalidate may prepare another mode while the very first acquire
      // is pending. If every caller then rejects, there was no holder to
      // trigger release: retire that preparation here as well.
      if (
        entry.acquiring === 0 &&
        entry.holders.size === 0 &&
        this.entries.get(key) === entry
      ) {
        entry.generation++;
        this.entries.delete(key);
        const replacement = entry.current;
        entry.current = null;
        entry.pending = null;
        if (replacement) await this.release(replacement);
      }
    }
  }

  /** Refresh state-path policy before any load; a loop owns only handed-out instances.
   * @param {RuntimeEntry} entry @param {import("../types.js").OutputMode} output */
  refreshOutput(entry, output) {
    if (entry.output === output) return;
    entry.generation++;
    entry.output = output;
    const previous = entry.current;
    entry.current = null;
    entry.pending = null;
    if (previous && !entry.holders.has(previous)) void this.release(previous);
  }

  /**
   * Release this exact holder. When the last holder leaves, also retire
   * its entry's unacquired replacement and fence pending init. Loops must
   * acquire before releasing on reload. Unsubscribe immediately, then
   * destroy after frame drain or the loop's remaining stop budget expires.
   *
   * @param {SceneInstance} instance
   * @param {SceneReleaseOptions} [options]
   */
  async release(instance, options) {
    const key = JSON.stringify([instance.scene, instance.device]);
    const entry = this.entries.get(key);
    const wasHeld = entry?.holders.delete(instance) ?? false;
    let replacement = null;
    if (entry && (wasHeld || entry.current === instance)) {
      if (entry.current === instance) {
        entry.generation++;
        entry.current = null;
        entry.pending = null;
      }
      if (entry.holders.size === 0) {
        entry.generation++;
        this.entries.delete(key);
        replacement = entry.current;
        entry.current = null;
        entry.pending = null;
      }
    }
    // Start both releases before yielding, so every retired MQTT owner is
    // fenced immediately. Internal retirement of an unheld older instance
    // cannot evict a newer entry or its still-pending first acquire.
    const retiring = replacement ? this.release(replacement, options) : null;
    try {
      await Promise.all([instance.release(options), retiring]);
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
   * @returns {Promise<{devices: string[]}>} devices that run one of them; {devices: []} after releaseAll()
   */
  async invalidate(scenes) {
    if (this.closed) return { devices: [] };
    const changed = new Set(scenes);
    for (const scene of changed)
      this.fileTokens.set(scene, (this.fileTokens.get(scene) ?? 0) + 1);
    const devices = new Set();
    for (const entry of this.entries.values()) {
      if (!changed.has(entry.scene)) continue;
      this.refreshOutput(entry, this.deps.outputOf(entry.device));
      entry.generation++;
      const generation = entry.generation;
      devices.add(entry.device);
      void this.load(entry).catch((error) => {
        // Only the latest preparation reports its failure. Older loads may
        // follow its promise; cancellation on release is expected as well.
        if (
          error instanceof SupersededLoadError ||
          this.closed ||
          entry.generation !== generation
        )
          return;
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
      entry.generation === generation &&
      this.deps.outputOf(device) === output;
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
        if (!current()) throw new SupersededLoadError(ref);
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
          throw new SupersededLoadError(ref);
        }
        const previous = entry.current;
        entry.current = instance;
        this.instances.add(instance);
        if (previous && !entry.holders.has(previous))
          void this.release(previous);
        return instance;
      } catch (error) {
        this.deps.settings.releaseContext(ref);
        // A reload during the first init is not a scene failure. Its callers
        // follow the latest load in the same output mode, even if ready.
        // acquire records ownership before handing that followed result out.
        if (!current()) {
          if (
            !this.closed &&
            this.entries.get(key) === entry &&
            entry.output === output &&
            this.deps.outputOf(device) === output
          ) {
            if (entry.pending) return entry.pending;
            if (entry.current) return entry.current;
          }
          throw new SupersededLoadError(ref);
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
      if (entry.pending === promise) {
        entry.pending = null;
        if (
          !entry.current &&
          entry.holders.size === 0 &&
          this.entries.get(key) === entry
        ) {
          entry.generation++;
          this.entries.delete(key);
        }
      }
    };
    void promise.then(settled, settled);
    return promise;
  }

  /** Release every instance concurrently (shutdown). Final: nothing is created afterwards.
   * Apply the remaining frame-drain budget to each.
   * Pending init and mounted destroy remain uncancellable; main owns the absolute shutdown deadline.
   * @param {SceneReleaseOptions} [options] */
  async releaseAll(options) {
    this.closed = true;
    for (const entry of this.entries.values()) entry.generation++;
    this.entries.clear();
    // Fence admitted instances before yielding to pending init work. A
    // hanging init must not leave installed scenes open to another frame.
    const releases = [...this.instances].map((instance) =>
      this.release(instance, options),
    );
    await Promise.allSettled([...this.pending]);
    await Promise.all(releases);
  }
}
