/**
 * Runtime config: the config as it runs.
 *
 *   config.json (config store)
 *     + structural overlays (overlay service: blob devices and scenes,
 *       granular scene paths, ip and enabled overlays)
 *     + v1 ownership and the shadow switches (output policy)
 *   = EffectiveConfig (types.js): typed devices and scenes, each value with
 *     its source, each device with its resolved output.
 *
 * Why it is a module of its own. In v1 the merged config is one object that
 * everybody reads (lib/config-overlay.js merge()). In the round-1 skeleton of
 * v2 it had no home: the scheduler and the status publisher were handed the
 * saved config, which knows nothing of a blob entry that patches
 * `minFrameMs`, `powerCyclePlugin` or `cleanupLegacyApps`, and nothing of a
 * device that exists only in the blob (A-071, C-055); granular scene paths
 * were dropped on the way to the scene registry (A-069, C-052); and "is this
 * device driven" was answered from config.json alone in some places. Now
 * there is one object and one answer:
 *
 *   scheduler, drivers, telemetry      device(name), "changed" with a diff
 *   scene registry                     scenes()
 *   settings service                   device(name).sceneSettings (the saved layer as it runs)
 *   overlay service, scene runtime,
 *   status publisher, render loop      outputOf(name)
 *   state store                        everything, plus the scene precedence on top;
 *                                      the saved choice is device(name).savedScene
 *   GET /api/config, <statusBase>/config/effective   toV1()
 *
 * Merge rules (v1's, matrix A-067 to A-075), per device:
 *   config.json entry  <  blob entry of the same name (shallow)  <  granular ip, granular enabled
 *   a blob entry with name, type and ip and no config.json entry adds a device (origin "blob")
 *   `scene` and legacy `scenes` are not merged here; they go through the scene precedence
 * Per scene key:  config.json  <  blob `scenes`  <  granular path overlay; an overlay may add a key.
 * Global keys (telemetry interval, mqtt, health) come from config.json only.
 * What v2 does differently: a disabled device stays in the list with
 * enabled false instead of disappearing (A-075); a merged entry that is not
 * valid (e.g. the blob sets an unusable type) keeps the config.json entry
 * and the overlay record is marked invalid (A-BUG-06).
 *
 * An overlay never widens what config.json and the environment allow
 * (overlayDevicePatch below, finished code):
 *   `output`      is not an overlay key. The output policy reads config.json,
 *                 the environment and v1's device list, nothing else, so no
 *                 stored message can put a device into drive and none can
 *                 release one by going missing.
 *   `enabled`     an overlay can switch a device off (false), not on.
 *   `supersedes`  is v2's bookkeeping in config.json, never read from a blob.
 * Such keys of a blob entry are ignored and named in the overlay record.
 *
 * The saved choice. `scene` of a device in config.json is not merged with
 * overlays (the scene has its own precedence), and it is not lost either:
 * every effective device carries it as `savedScene`. The state store takes
 * it from there at its first build (a process that starts with a saved
 * scene shows that scene) and with every "changed" event whose diff names
 * `savedScene` (an edit of config.json from outside that changes nothing
 * but a scene). `savedAt` of the effective config is its "since".
 *
 * Order (core/ordering.js). The effective config has a revision. Every
 * build is a pure function of the three inputs as they are at that moment,
 * so the events of the three sources can arrive in any order: the last
 * build is always the newest. A consumer applies a "changed" event only
 * when its `effective.rev` is higher than the one it holds.
 *
 * Nothing here is ever written to config.json ("Save never promotes
 * overlays"). The one way a blob-only device gets an entry in the file is the
 * explicit adoption in the state store (A-151).
 *
 * Start order: after the overlay service and the ownership feed, before the
 * scene registry. Before start(), outputOf() answers "shadow" for every
 * name, so nothing can publish early.
 *
 * Events (EventEmitter): "changed" ({effective: EffectiveConfig, previous: EffectiveConfig, diff: EffectiveDiff}).
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").EffectiveConfig} EffectiveConfig */
/** @typedef {import("../types.js").EffectiveDevice} EffectiveDevice */
/** @typedef {import("../types.js").EffectiveScene} EffectiveScene */
/** @typedef {import("../types.js").EffectiveDiff} EffectiveDiff */
/** @typedef {import("../types.js").OutputMode} OutputMode */

/**
 * @typedef {object} RuntimeConfigDeps
 * @property {import("../config/config-store.js").ConfigStore} config
 * @property {import("../overlay/overlay-service.js").OverlayService} overlays
 * @property {import("./v1-ownership.js").V1Ownership} ownership
 * @property {import("../types.js").MqttConfig} mqtt the namespace the process started with
 * @property {boolean} forceShadow PIXDCON2_FORCE_SHADOW=1
 * @property {OutputMode} envDefaultOutput PIXDCON2_DEFAULT_OUTPUT, else "drive"
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

/** Keys of a blob device entry that an overlay may not set. */
export const NOT_OVERLAY_KEYS = Object.freeze(["output", "supersedes"]);

/**
 * What a blob entry may change of a device: every key v1's merge takes,
 * except what would widen the output. Finished code; buildEffectiveConfig
 * merges `patch` over the config.json entry and nothing else of the entry.
 *
 *  - `name` is the identity, not a patch
 *  - `scene` and the legacy `scenes` go through the scene precedence
 *  - `output` and `supersedes` are never taken from an overlay
 *  - `enabled` is taken only when it switches the device off
 *
 * @param {Record<string, unknown>} entry one entry of the blob's `devices`
 * @returns {{patch: Record<string, unknown>, ignored: string[]}} ignored: keys that were present and not taken, for the overlay record
 */
export function overlayDevicePatch(entry) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  /** @type {string[]} */
  const ignored = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === "name" || key === "scene" || key === "scenes") continue;
    if (NOT_OVERLAY_KEYS.includes(key)) {
      ignored.push(key);
      continue;
    }
    if (key === "enabled") {
      if (value === false || value === "false") patch.enabled = false;
      else ignored.push(key);
      continue;
    }
    patch[key] = value;
  }
  return { patch, ignored };
}

/**
 * The merge as a pure function, so the rules above can be tested without a
 * broker: same inputs, same EffectiveConfig (without `rev`).
 *
 * @param {import("../types.js").Config} config the running config
 * @param {import("../types.js").StructuralOverlays} structural
 * @param {(device: {name: string, output: OutputMode|null}) => import("../types.js").OutputDecision} decide the output policy, already bound to the instance switches and the ownership feed. `output` is the one of the config.json entry, null for a device that exists only in the blob; never a value from an overlay
 * @param {import("../types.js").MqttConfig} mqtt
 * @param {import("../types.js").IsoTime} savedAt when `config` was loaded or written
 * @returns {{effective: Omit<EffectiveConfig, "rev">, rejected: Array<{overlay: "blob"|"ip"|"enabled"|"scene-path", name: string, problem: string}>}}
 */
export function buildEffectiveConfig(
  config,
  structural,
  decide,
  mqtt,
  savedAt,
) {
  return todo(
    "buildEffectiveConfig",
    config,
    structural,
    decide,
    mqtt,
    savedAt,
  );
}

/**
 * Keys of one effective device that differ. The two preview options are
 * reported by their own names, because they need different things
 * (config/schema.js changeImpact).
 *
 * @param {EffectiveDevice} previous
 * @param {EffectiveDevice} next
 * @returns {string[]}
 */
function changedDeviceKeys(previous, next) {
  /** @type {string[]} */
  const keys = [];
  const names = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of names) {
    const before = /** @type {Record<string, unknown>} */ (previous)[key];
    const after = /** @type {Record<string, unknown>} */ (next)[key];
    if (isDeepStrictEqual(before, after)) continue;
    if (key === "preview") {
      if (previous.preview?.pollMs !== next.preview?.pollMs)
        keys.push("preview.pollMs");
      if (previous.preview?.showGrid !== next.preview?.showGrid)
        keys.push("preview.showGrid");
    } else keys.push(key);
  }
  return keys;
}

/**
 * What changed between two effective configs. Finished code: the feed of
 * every consumer that applies changes per device, and of the saved choice
 * (`savedScene`).
 *
 * @param {Omit<EffectiveConfig, "rev">} previous
 * @param {Omit<EffectiveConfig, "rev">} next
 * @returns {EffectiveDiff}
 */
export function diffEffectiveConfig(previous, next) {
  const before = new Map(
    previous.devices.map((device) => [device.name, device]),
  );
  const after = new Map(next.devices.map((device) => [device.name, device]));
  /** @type {Record<string, string[]>} */
  const devicesChanged = {};
  for (const [name, device] of after) {
    const earlier = before.get(name);
    if (!earlier) continue;
    const keys = changedDeviceKeys(earlier, device);
    if (keys.length > 0) devicesChanged[name] = keys;
  }
  const sceneKeys = Object.keys(next.scenes);
  const earlierSceneKeys = Object.keys(previous.scenes);
  return {
    devicesAdded: [...after.keys()].filter((name) => !before.has(name)),
    devicesRemoved: [...before.keys()].filter((name) => !after.has(name)),
    devicesChanged,
    scenesAdded: sceneKeys.filter(
      (key) => !Object.hasOwn(previous.scenes, key),
    ),
    scenesRemoved: earlierSceneKeys.filter(
      (key) => !Object.hasOwn(next.scenes, key),
    ),
    scenesChanged: sceneKeys.filter(
      (key) =>
        Object.hasOwn(previous.scenes, key) &&
        previous.scenes[key].path !== next.scenes[key].path,
    ),
    globalChanged: /** @type {const} */ ([
      "telemetryIntervalMs",
      "mqtt",
      "health",
    ]).filter((key) => !isDeepStrictEqual(previous[key], next[key])),
  };
}

export class RuntimeConfig extends EventEmitter {
  /** @param {RuntimeConfigDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /**
   * Build the first effective config and follow config "changed", overlay
   * "changed" and ownership "changed". Each of the three only says "build
   * again": the build reads all three sources as they are then, raises
   * `rev`, and emits "changed" when the diff is not empty.
   */
  start() {
    return todo("RuntimeConfig.start");
  }

  stop() {
    return todo("RuntimeConfig.stop");
  }

  /** @returns {EffectiveConfig} frozen */
  get() {
    return todo("RuntimeConfig.get");
  }

  /**
   * @param {string} name
   * @returns {EffectiveDevice|undefined} also for a disabled device and for a blob-only device
   */
  device(name) {
    return todo("RuntimeConfig.device", name);
  }

  /** @returns {Record<string, EffectiveScene>} the effective scene registry: config.json, blob scenes, granular paths */
  scenes() {
    return todo("RuntimeConfig.scenes");
  }

  /**
   * The one resolved output policy. "shadow" for a name that is not in the
   * effective config and before start(). null asks for the instance as a
   * whole (an overlay that belongs to no single device, the controller
   * topics): "drive" when at least one enabled device is driven.
   *
   * @param {string|null} name
   * @returns {OutputMode}
   */
  outputOf(name) {
    return todo("RuntimeConfig.outputOf", name);
  }

  /**
   * The running config in v1's shape, for GET /api/config and for
   * <statusBase>/config/effective: `devices` (enabled ones only, with the
   * scene that is in effect) and `scenes`; v2 bookkeeping keys left out. It
   * contains no secrets by construction: the config has none.
   *
   * @param {(device: string) => string|null} sceneOf the scene in effect per device (state store)
   * @returns {Record<string, unknown>}
   */
  toV1(sceneOf) {
    return todo("RuntimeConfig.toV1", sceneOf);
  }
}
