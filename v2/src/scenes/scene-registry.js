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
 *  - a failed refresh retains previous metadata and resources, marks the
 *    entry broken and reports the new error; a successful refresh recovers it
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
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ASSET_DIR_PATTERN,
  STATE_FIELD_PATTERNS,
  checkV1Module,
} from "./v1-scene-adapter.js";

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
    /** @type {Map<string, SceneMeta>} */
    this.entries = new Map();
    this.identity = randomUUID();
    this.sequence = 0;
  }

  /** Read the metadata of every registered scene. Never throws for a bad scene. @param {RegistryWorkOptions} [options] */
  async load(options) {
    return this.refresh(Object.keys(this.deps.scenes()), options);
  }

  /**
   * Read the given scenes again: after a file change.
   * @param {string[]} keys @param {RegistryWorkOptions} [options]
   */
  async refresh(keys, options) {
    return this.sync({ added: [], removed: [], changed: keys }, options);
  }

  /**
   * Follow a change of the effective scene map: read added keys and keys
   * whose path changed, forget removed keys.
   *
   * @param {{added: string[], removed: string[], changed: string[]}} change from the runtime config's diff @param {RegistryWorkOptions} [options]
   * @returns {Promise<{keys: string[]}>} keys whose metadata, file or existence changed; the caller invalidates their instances. No keys when the signal was aborted before the result could be committed
   */
  async sync(change, options) {
    return this.update(
      [...change.added, ...change.changed, ...change.removed],
      options,
    );
  }

  /** @returns {SceneMeta[]} in registry order */
  list() {
    return [...this.entries.values()].map((meta) => structuredClone(meta));
  }

  /**
   * @param {string} key
   * @returns {SceneMeta|undefined}
   */
  get(key) {
    const meta = this.entries.get(key);
    return meta ? structuredClone(meta) : undefined;
  }

  /**
   * @param {string} key
   * @returns {string|undefined} absolute path of the scene file
   */
  fileOf(key) {
    const meta = this.entries.get(key);
    return meta ? resolve(this.deps.baseDir(), meta.path) : undefined;
  }

  /**
   * Scene keys that are served by a file (hot reload maps a changed file back to keys, B-016).
   * @param {string} file absolute path
   * @returns {string[]}
   */
  keysOfFile(file) {
    const absolute = resolve(file);
    return [...this.entries.values()]
      .filter((meta) => {
        const ownFile = this.fileOf(meta.key);
        if (!ownFile) return false;
        if (ownFile === absolute) return true;
        return meta.resources.assetDirs.some((dir) => {
          const child = relative(resolve(dirname(ownFile), dir), absolute);
          return (
            child === "" ||
            (!isAbsolute(child) && child !== ".." && !child.startsWith("../"))
          );
        });
      })
      .map((meta) => meta.key);
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
    if (scene === null) return null;
    if (scene.startsWith("builtin:"))
      return this.deps.findBuiltin(type, scene)
        ? null
        : `Unknown built-in mode ${scene} for ${type}`;
    const meta = this.entries.get(scene);
    if (!meta) return `Unknown scene ${scene}`;
    // deviceType is a UI filter only, as in v1.
    return meta.status === "broken"
      ? (meta.error ?? `Scene ${scene} is broken`)
      : null;
  }

  /** Build privately and commit once: abort never leaves a partially updated map.
   * The caller owns serialization in main's registry lane.
   * @param {string[]} keys @param {RegistryWorkOptions} [options]
   * @returns {Promise<{keys: string[]}>} */
  async update(keys, options) {
    if (options?.signal?.aborted) return { keys: [] };
    const effective = this.deps.scenes();
    const next = new Map(this.entries);
    for (const key of new Set(keys)) {
      if (!Object.hasOwn(effective, key)) {
        next.delete(key);
        continue;
      }
      const meta = await this.readMeta(key, effective[key], options);
      if (options?.signal?.aborted) return { keys: [] };
      if (meta) next.set(key, meta);
    }
    if (options?.signal?.aborted) return { keys: [] };
    const ordered = new Map(
      Object.keys(effective).flatMap((key) => {
        const meta = next.get(key);
        return meta ? [[key, meta]] : [];
      }),
    );
    const changed = [
      ...new Set([...this.entries.keys(), ...ordered.keys()]),
    ].filter(
      (key) => !isDeepStrictEqual(this.entries.get(key), ordered.get(key)),
    );
    this.entries = ordered;
    if (changed.length) this.emit("changed", { keys: changed });
    return { keys: changed };
  }

  /** @param {string} key @param {import("../types.js").EffectiveScene} entry
   * @param {RegistryWorkOptions} [options] @returns {Promise<SceneMeta|null>} */
  async readMeta(key, entry, options) {
    const fallback = this.entries.get(key);
    /** @type {SceneMeta} */
    const meta = {
      key,
      path: entry.path,
      pathSource: entry.source,
      name: key,
      pretty_name: key,
      description: "",
      deviceType: null,
      settingsSchema: {},
      resources: { assetDirs: [], stateFields: [] },
      status: "ok",
      error: null,
    };
    try {
      if (!entry.path) throw new Error("Scene path is empty");
      const file = resolve(this.deps.baseDir(), entry.path);
      const source = await readFile(file, "utf8");
      if (options?.signal?.aborted) return null;
      const url = pathToFileURL(file);
      url.searchParams.set("meta", `${this.identity}-${++this.sequence}`);
      const namespace = await import(url.href);
      if (options?.signal?.aborted) return null;
      const checked = checkV1Module(namespace);
      if (!checked.ok) throw new Error(checked.problem);
      const scene = checked.exported;
      const normalized = normalizeSchema(scene.settingsSchema);
      for (const [name, field] of Object.entries(normalized.schema)) {
        if (field.default === undefined) continue;
        const value = this.deps.normalizeSettingValue(field.default, field);
        if (value === undefined)
          normalized.problems.push(`${name}: invalid default`);
        else field.default = value;
      }
      if (normalized.problems.length)
        throw new Error(normalized.problems.join("; "));
      meta.name =
        typeof scene.name === "string" && scene.name ? scene.name : key;
      meta.pretty_name =
        typeof scene.pretty_name === "string" && scene.pretty_name
          ? scene.pretty_name
          : meta.name;
      meta.description =
        typeof scene.description === "string" ? scene.description : "";
      meta.deviceType =
        scene.deviceType === "pixoo" || scene.deviceType === "ulanzi"
          ? scene.deviceType
          : null;
      meta.settingsSchema = normalized.schema;
      meta.resources.stateFields = STATE_FIELD_PATTERNS.filter((field) =>
        source.includes(field),
      );
      meta.resources.assetDirs = [
        ...new Set(
          [...source.matchAll(new RegExp(ASSET_DIR_PATTERN))].map(
            (match) => match[1],
          ),
        ),
      ].filter((dir) => {
        try {
          return statSync(resolve(dirname(file), dir)).isDirectory();
        } catch {
          return false;
        }
      });
      return meta;
    } catch (error) {
      if (options?.signal?.aborted) return null;
      const problem = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(`[SceneRegistry] ${key}: ${problem}`);
      return {
        ...(fallback ?? meta),
        path: entry.path,
        pathSource: entry.source,
        status: "broken",
        error: problem,
      };
    }
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
  /** @type {Record<string, SettingField>} */
  const normalized = {};
  /** @type {string[]} */
  const problems = [];
  if (schema === undefined || schema === null)
    return { schema: normalized, problems };
  if (typeof schema !== "object" || Array.isArray(schema))
    return {
      schema: normalized,
      problems: ["settingsSchema must be an object"],
    };
  const types = [
    "int",
    "float",
    "boolean",
    "enum",
    "time",
    "json",
    "color",
    "string",
  ];
  for (const [key, raw] of Object.entries(schema)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${key}: field must be an object`);
      continue;
    }
    const field = /** @type {Record<string, unknown>} */ (raw);
    const type = field.type || "string";
    if (typeof type !== "string" || !types.includes(type)) {
      problems.push(`${key}: unknown type ${String(type)}`);
      continue;
    }
    /** @type {SettingField} */
    const next = {
      type: /** @type {SettingField["type"]} */ (type),
      label: typeof field.label === "string" && field.label ? field.label : key,
      group:
        typeof field.group === "string" && field.group
          ? field.group
          : "General",
      description:
        typeof field.description === "string" ? field.description : "",
      placeholder:
        typeof field.placeholder === "string" ? field.placeholder : "",
      default: undefined,
    };
    try {
      next.default = structuredClone(field.default);
    } catch {
      problems.push(`${key}: default must be cloneable data`);
    }
    for (const bound of /** @type {const} */ (["min", "max", "step"])) {
      if (field[bound] === undefined) continue;
      if (typeof field[bound] !== "number" || !Number.isFinite(field[bound]))
        problems.push(`${key}: ${bound} must be finite`);
      else next[bound] = field[bound];
    }
    if (next.min !== undefined && next.max !== undefined && next.min > next.max)
      problems.push(`${key}: min exceeds max`);
    if (next.step !== undefined && next.step <= 0)
      problems.push(`${key}: step must be positive`);
    if (field.options !== undefined) {
      if (
        !Array.isArray(field.options) ||
        field.options.some((option) => {
          const value =
            option && typeof option === "object" ? option.value : option;
          return (
            typeof value !== "string" &&
            !(typeof value === "number" && Number.isFinite(value))
          );
        })
      )
        problems.push(
          `${key}: options must contain strings, finite numbers or value objects`,
        );
      else {
        try {
          next.options = structuredClone(field.options);
        } catch {
          problems.push(`${key}: options must be cloneable data`);
        }
      }
    }
    if (type === "enum" && !next.options?.length)
      problems.push(`${key}: enum needs options`);
    Object.defineProperty(normalized, key, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { schema: normalized, problems };
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
 * @typedef {object} RegistryWorkOptions
 * @property {AbortSignal} [signal] the registry lane's signal (main.js). Aborted = shutdown has begun: what an import brings back after that is not committed
 */
