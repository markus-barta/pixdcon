/**
 * Scene registry: which scenes exist, what they are called, whether they can run.
 *
 * Kept from v1 (lib/scene-loader.js loadSceneMetadata; matrix B-001, B-002, B-010, B-011):
 *  - the registry is the effective scene map (state/runtime-config.js
 *    scenes()): the `scenes` map of config.json, then blob overlay scenes,
 *    then granular path overlays, which may replace a path or add a key
 *    (A-069, A-072, C-052); no directory is scanned
 *  - a path resolves against the directory of config.json
 *  - metadata is read by importing the file: default export, or the module
 *    namespace when there is no default; name, pretty_name, description,
 *    deviceType, settingsSchema; missing values fall back as in v1
 *    (name → key, pretty_name → name → key)
 *
 * Fixed:
 *  - a scene whose import fails, that has no render() function, or whose
 *    settingsSchema is not usable is listed with status "broken" and the
 *    reason; it stays visible instead of turning into a nameless placeholder
 *    (B-010, B-166, A-183, A-BUG-39)
 *  - schema defaults are run through the same normalisation as values, bounds
 *    are checked (A-184, A-185)
 *  - only the scene whose file changed is imported again (v1 re-imported every
 *    scene on every change, S-18)
 *  - the answer to GET /api/v2/scenes keeps scenes and built-in modes apart
 *    (A-BUG-27: a scene key "builtins" collided)
 *  - a change of the effective scene map is followed: main.js calls
 *    sync() on every runtime "changed" whose diff names scenes, so a path
 *    overlay that arrives or goes reloads exactly the scenes it touches
 *  - every scene reports the files it uses beside its own
 *    (`SceneMeta.resources`, types.js SceneResources), read from the content
 *    of the file with the two patterns in v1-scene-adapter.js. The shadow
 *    redirect of state files and the copy route work from that, so they hold
 *    for an alias key and for a copy as well (B-183)
 *
 * Order (core/ordering.js). load(), refresh() and sync() import files and
 * take time. main.js calls them from one lane, one at a time, in the order
 * they were asked for (the first load, then every change of the effective
 * scene map and every changed file), so no two of them run at once and an
 * earlier, slower import cannot finish after a later one. Each reads the
 * effective scene map when it runs. Nothing else calls them. list(), get(),
 * fileOf(), keysOfFile() and check() answer from what the last finished call
 * left. At shutdown their signal is aborted: see SHUTDOWN at the end.
 *
 * Schema defaults are normalised with the injected `normalizeSettingValue`
 * (state/precedence.js through main.js), the same function that judges
 * setting values; this file does not import it.
 *
 * Events (EventEmitter): "changed" ({keys: string[]}) when metadata or status of scenes changed.
 *
 * Owner: fixtures + edge lane worker.
 */

import { EventEmitter } from "node:events";
import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").SceneMeta} SceneMeta */
/** @typedef {import("../types.js").SettingField} SettingField */

export class SceneRegistry extends EventEmitter {
  /**
   * @param {{baseDir: () => string, scenes: () => Record<string, import("../types.js").EffectiveScene>, findBuiltin: import("../types.js").Factories["findBuiltin"], normalizeSettingValue: import("../types.js").Factories["normalizeSettingValue"], logger: import("../types.js").Logger}} deps
   * `scenes` returns the effective map (RuntimeConfig.scenes); `findBuiltin` answers whether a device type has a built-in mode; `normalizeSettingValue` judges schema defaults
   */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /** Read the metadata of every registered scene. Never throws for a bad scene. @param {RegistryWorkOptions} [options] */
  async load(options) {
    return todo("SceneRegistry.load", options);
  }

  /**
   * Read the given scenes again: after a file change.
   * @param {string[]} keys @param {RegistryWorkOptions} [options]
   */
  async refresh(keys, options) {
    return todo("SceneRegistry.refresh", keys, options);
  }

  /**
   * Follow a change of the effective scene map: read added keys and keys
   * whose path changed, forget removed keys.
   *
   * @param {{added: string[], removed: string[], changed: string[]}} change from the runtime config's diff @param {RegistryWorkOptions} [options]
   * @returns {Promise<{keys: string[]}>} keys whose metadata, file or existence changed; the caller invalidates their instances. No keys when the signal was aborted before the result could be committed
   */
  async sync(change, options) {
    return todo("SceneRegistry.sync", change, options);
  }

  /** @returns {SceneMeta[]} in registry order */
  list() {
    return todo("SceneRegistry.list");
  }

  /**
   * @param {string} key
   * @returns {SceneMeta|undefined}
   */
  get(key) {
    return todo("SceneRegistry.get", key);
  }

  /**
   * @param {string} key
   * @returns {string|undefined} absolute path of the scene file
   */
  fileOf(key) {
    return todo("SceneRegistry.fileOf", key);
  }

  /**
   * Scene keys that are served by a file (hot reload maps a changed file back to keys, B-016).
   * @param {string} file absolute path
   * @returns {string[]}
   */
  keysOfFile(file) {
    return todo("SceneRegistry.keysOfFile", file);
  }

  /**
   * Can this scene be chosen for a device of this type? Built-in modes are
   * checked with the injected `findBuiltin`.
   *
   * @param {string|null} scene
   * @param {import("../types.js").DeviceType} type
   * @returns {string|null} problem text, or null when it can run
   */
  check(scene, type) {
    return todo("SceneRegistry.check", scene, type);
  }
}

/**
 * Normalise a scene's settingsSchema to the v1 field shape (matrix A-084):
 * type "string", label = key, group "General", description "", placeholder "".
 *
 * @param {unknown} schema
 * @returns {{schema: Record<string, SettingField>, problems: string[]}}
 */
export function normalizeSchema(schema) {
  return todo("normalizeSchema", schema);
}

/**
 * SHUTDOWN. An import cannot be cancelled, and shutdown does not wait for
 * one for ever: main.js closes the registry lane, which aborts the signal
 * that load(), refresh() and sync() are given, waits a bounded time, and
 * goes on to release the scenes. So each of the three checks
 * `options.signal?.aborted` after every await, before it changes the
 * registry. Once the signal is aborted the call commits nothing (the
 * registry stays as the last finished call left it), emits no "changed",
 * and resolves with no keys; the module that was imported is dropped. This
 * check is the fence. A caller that waited long enough is not one.
 *
 * (These lines stand at the end of the file so that the three skeleton
 * markers above keep their line numbers in the inventory.)
 *
 * @typedef {object} RegistryWorkOptions
 * @property {AbortSignal} [signal] the registry lane's signal (main.js). Aborted = shutdown has begun: what an import brings back after that is not committed
 */
