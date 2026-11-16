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
 *   state store                        everything, plus the scene precedence on top
 *   GET /api/config, <statusBase>/config/effective   toV1()
 *
 * Merge rules (v1's, matrix A-067 to A-075), per device:
 *   config.json entry  <  blob entry of the same name (shallow, every key)  <  granular ip, granular enabled
 *   a blob entry with name, type and ip and no config.json entry adds a device (origin "blob")
 *   `scene` and legacy `scenes` are not merged here; they go through the scene precedence
 * Per scene key:  config.json  <  blob `scenes`  <  granular path overlay; an overlay may add a key.
 * Global keys (telemetry interval, mqtt, health) come from config.json only.
 * What v2 does differently: a disabled device stays in the list with
 * enabled false instead of disappearing (A-075); a merged entry that is not
 * valid (e.g. the blob sets an unusable type) keeps the config.json entry
 * and the overlay record is marked invalid (A-BUG-06).
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

/**
 * The merge as a pure function, so the rules above can be tested without a
 * broker: same inputs, same EffectiveConfig (without `rev`).
 *
 * @param {import("../types.js").Config} config the running config
 * @param {import("../types.js").StructuralOverlays} structural
 * @param {(device: {name: string, output: OutputMode|null}) => import("../types.js").OutputDecision} decide the output policy, already bound to the instance switches and the ownership feed
 * @param {import("../types.js").MqttConfig} mqtt
 * @returns {{effective: Omit<EffectiveConfig, "rev">, rejected: Array<{overlay: "blob"|"ip"|"enabled"|"scene-path", name: string, problem: string}>}}
 */
export function buildEffectiveConfig(config, structural, decide, mqtt) {
  return todo("buildEffectiveConfig", config, structural, decide, mqtt);
}

/**
 * @param {EffectiveConfig} previous
 * @param {EffectiveConfig} next
 * @returns {EffectiveDiff}
 */
export function diffEffectiveConfig(previous, next) {
  return todo("diffEffectiveConfig", previous, next);
}

export class RuntimeConfig extends EventEmitter {
  /** @param {RuntimeConfigDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /** Build the first effective config and follow config "changed", overlay "changed" and ownership "changed". */
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
