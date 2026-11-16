/**
 * Scene registry: which scenes exist, what they are called, whether they can run.
 *
 * Kept from v1 (lib/scene-loader.js loadSceneMetadata; matrix B-001, B-002, B-010, B-011):
 *  - the registry is the `scenes` map of config.json (key → {path}), plus
 *    scenes and paths from the overlay layer; no directory is scanned
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
   * @param {{baseDir: () => string, scenes: () => Record<string, {path: string}>, logger: import("../types.js").Logger}} deps
   * `scenes` returns the effective map: config.json plus overlay scenes and paths
   */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /** Read the metadata of every registered scene. Never throws for a bad scene. */
  async load() {
    return todo("SceneRegistry.load");
  }

  /**
   * Read the given scenes again: after a file change or a registry change.
   * @param {string[]} keys
   */
  async refresh(keys) {
    return todo("SceneRegistry.refresh", keys);
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
   * checked against drivers/builtin-modes.js.
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
