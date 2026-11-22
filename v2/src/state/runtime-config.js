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
 * A blob that the current connection has not delivered again commands
 * nothing and keeps holding back what it held back (overlay/topic-fence.js
 * has the same rule for the single topics). overlayDevicePatch with
 * `confirmed: false` is that rule for one blob entry: `enabled` false
 * stays, every other key waits (`lapsed`), and an entry that carries an
 * address makes its device `held`: listed, and not started on the address
 * of config.json on the guess that the blob is gone, nor on the address the
 * blob gave. A device that exists only in the blob always carries one.
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
import { NAME_PATTERN, address, validateDevice } from "../config/schema.js";
import { decideStamp } from "../core/ordering.js";
import { NotImplementedError } from "../core/todo.js";
import { freeze, hasDiff } from "../core/values.js";
import { resolveOutput } from "./precedence.js";

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
 * Does a value of `enabled` in an overlay switch the device off? `false`,
 * and the text "false" in any case and with blanks around it (matrix C-051;
 * overlay/topic-fence.js saysOff reads the granular topic the same way).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
const saysOff = (value) =>
  value === false ||
  (typeof value === "string" && value.trim().toLowerCase() === "false");

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
 * `confirmed: false` says that the blob was delivered on an earlier
 * connection and not on the current one. What the entry commands then
 * waits; what it holds back stays:
 *
 *  - `enabled` false is still taken
 *  - every other key that would be taken is named in `lapsed` instead
 *  - `held` is true when the entry carries a usable `ip`. Its device is
 *    listed and not started: not on the address of config.json, on the
 *    guess that the blob is gone, and not on the address of the entry
 *
 * @param {Record<string, unknown>} entry one entry of the blob's `devices`
 * @param {{confirmed?: boolean}} [options] confirmed: the current connection delivered the blob, or the last one while the broker is away. Default true
 * @returns {{patch: Record<string, unknown>, ignored: string[], held: boolean, lapsed: string[]}} ignored: keys that were present and are never taken, for the overlay record. lapsed: keys that wait for the blob to be delivered again. held: the device is not started until then
 */
export function overlayDevicePatch(entry, options = {}) {
  const confirmed = options.confirmed !== false;
  /** @type {Record<string, unknown>} */
  const patch = {};
  /** @type {string[]} */
  const ignored = [];
  /** @type {string[]} */
  const lapsed = [];
  let held = false;
  for (const [key, value] of Object.entries(entry)) {
    if (key === "name" || key === "scene" || key === "scenes") continue;
    if (NOT_OVERLAY_KEYS.includes(key)) {
      ignored.push(key);
      continue;
    }
    if (key === "enabled") {
      // A restriction: kept, confirmed or not.
      if (saysOff(value)) patch.enabled = false;
      else ignored.push(key);
      continue;
    }
    if (confirmed) {
      patch[key] = value;
      continue;
    }
    lapsed.push(key);
    if (key === "ip" && typeof value === "string" && value.trim() !== "")
      held = true;
  }
  return { patch, ignored, held, lapsed };
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
  /** @type {ReturnType<typeof buildEffectiveConfig>["rejected"]} */
  const rejected = [];
  const blobs = new Map(
    structural.blobDevices.map((entry) => [entry.name, entry]),
  );
  const saved = new Map(config.devices.map((entry) => [entry.name, entry]));
  /** @type {EffectiveDevice[]} */
  const devices = [];
  for (const name of new Set([...saved.keys(), ...blobs.keys()])) {
    const base = saved.get(name);
    const blob = blobs.get(name);
    const patch = blob ? overlayDevicePatch(blob).patch : {};
    let device;
    let blobKeys = Object.keys(patch);
    try {
      device = validateDevice({ ...base, ...patch, name });
    } catch (error) {
      rejected.push({ overlay: "blob", name, problem: String(error) });
      if (!base) continue;
      device = base;
      blobKeys = [];
    }
    /** @type {EffectiveDevice["addressSource"]} */
    let addressSource = blobKeys.includes("ip") ? "blob" : "config";
    const overlayIp = structural.deviceIps[name];
    if (Object.hasOwn(structural.deviceIps, name)) {
      try {
        device = { ...device, ip: address(overlayIp) };
        addressSource = "overlay";
      } catch (error) {
        rejected.push({ overlay: "ip", name, problem: String(error) });
      }
    }
    const held = structural.deviceHeld.includes(name);
    const disabled =
      Object.hasOwn(structural.deviceEnabled, name) &&
      structural.deviceEnabled[name] === false;
    const enabled =
      (base?.enabled ?? true) && device.enabled && !disabled && !held;
    devices.push({
      name,
      type: device.type,
      origin: base ? "config" : "blob",
      address: device.ip,
      addressSource,
      enabled,
      held,
      enabledSource:
        disabled || (held && !blobKeys.includes("ip"))
          ? "overlay"
          : blobKeys.includes("enabled") || held
            ? "blob"
            : "config",
      savedScene: base?.scene ?? null,
      output: decide({ name, output: base?.output ?? null }),
      displayName: device.displayName,
      comment: device.comment,
      preview: device.preview,
      minFrameMs: device.minFrameMs,
      maxPowerCycles: device.maxPowerCycles,
      powerCyclePlugin: device.powerCyclePlugin,
      cleanupLegacyApps: device.cleanupLegacyApps,
      firmware: device.firmware,
      sceneSettings: device.sceneSettings,
      blobKeys,
    });
  }
  /** @type {Record<string, EffectiveScene>} */
  const scenes = Object.fromEntries(
    Object.entries(config.scenes).map(([key, entry]) => [
      key,
      { path: entry.path, source: "config" },
    ]),
  );
  for (const [entries, source] of /** @type {const} */ ([
    [structural.blobScenes, "blob"],
    [structural.scenePaths, "overlay"],
  ])) {
    for (const [key, entry] of Object.entries(entries)) {
      const path = typeof entry === "string" ? entry : entry?.path;
      if (!NAME_PATTERN.test(key) || typeof path !== "string" || !path.trim()) {
        rejected.push({
          overlay: source === "blob" ? "blob" : "scene-path",
          name: key,
          problem: "Invalid scene path",
        });
        continue;
      }
      Object.defineProperty(scenes, key, {
        value: { path: path.trim(), source },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return {
    effective: {
      savedAt,
      devices,
      scenes,
      mqtt: { ...mqtt },
      health: { ...config.health },
      telemetryIntervalMs: config.telemetryIntervalMs,
    },
    rejected,
  };
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
    /** @type {EffectiveConfig|null} */
    this.effective = null;
    this.active = false;
    this.counter = 0;
    /** @type {Map<string, number>} */
    this.lives = new Map();
    /** @type {Array<() => void>} */
    this.unwire = [];
  }

  /**
   * Build the first effective config and follow config "changed", overlay
   * "changed" and ownership "changed". Each of the three only says "build
   * again": the build reads all three sources as they are then, raises
   * `rev`, and emits "changed" when the diff is not empty.
   */
  start() {
    if (this.active) return;
    this.active = true;
    const rebuild = () => {
      if (!this.active) return;
      this.rebuild();
    };
    for (const source of [
      this.deps.config,
      this.deps.overlays,
      this.deps.ownership,
    ]) {
      source.on("changed", rebuild);
      this.unwire.push(() => source.off("changed", rebuild));
    }
    this.rebuild();
  }

  stop() {
    this.active = false;
    for (const off of this.unwire.splice(0)) off();
  }

  /** @returns {EffectiveConfig} frozen */
  get() {
    if (!this.effective) throw new Error("Runtime config has not started");
    return this.effective;
  }

  /**
   * @param {string} name
   * @returns {EffectiveDevice|undefined} also for a disabled device and for a blob-only device
   */
  device(name) {
    return this.effective?.devices.find((device) => device.name === name);
  }

  /** @returns {Record<string, EffectiveScene>} the effective scene registry: config.json, blob scenes, granular paths */
  scenes() {
    return this.effective?.scenes ?? {};
  }

  /**
   * Which life of its name a device is in. Every device that enters the
   * effective config gets the next number of one counter for all devices,
   * rising inside one run of the process (the first device is 1). A device
   * that leaves and comes back under the same name gets a new one. The
   * state store puts it into every DeviceView and the settings service
   * into every SettingsState, so that a page can tell the two devices
   * apart (types.js DeviceState.incarnation).
   *
   * @param {string} name
   * @returns {number|undefined} undefined for a name that is not in the effective config
   */
  incarnationOf(name) {
    return this.lives.get(name);
  }

  /** @returns {number} the highest incarnation handed out so far in this run; 0 before the first device (`Snapshot.incarnations`) */
  incarnations() {
    return this.counter;
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
    if (!this.active) return "shadow";
    if (name === null)
      return this.effective?.devices.some(
        (device) => device.enabled && device.output.mode === "drive",
      )
        ? "drive"
        : "shadow";
    return this.device(name)?.output.mode ?? "shadow";
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
    return {
      devices: this.get()
        .devices.filter((device) => device.enabled)
        .map((device) => ({
          name: device.name,
          type: device.type,
          ip: device.address,
          scene: sceneOf(device.name),
          displayName: device.displayName,
          comment: device.comment,
          preview: device.preview,
          minFrameMs: device.minFrameMs,
          maxPowerCycles: device.maxPowerCycles,
          powerCyclePlugin: device.powerCyclePlugin,
          cleanupLegacyApps: device.cleanupLegacyApps,
          firmware: device.firmware,
          sceneSettings: device.sceneSettings,
        })),
      scenes: Object.fromEntries(
        Object.entries(this.scenes()).map(([key, entry]) => [
          key,
          { path: entry.path },
        ]),
      ),
    };
  }

  rebuild() {
    const {
      config,
      overlays,
      ownership,
      mqtt,
      forceShadow,
      envDefaultOutput,
      clock,
    } = this.deps;
    /** @type {import("../types.js").StructuralOverlays} */
    let structural;
    try {
      structural = overlays.structural();
    } catch (error) {
      if (!(error instanceof NotImplementedError)) throw error;
      structural = {
        blobDevices: [],
        blobScenes: {},
        scenePaths: {},
        deviceIps: {},
        deviceEnabled: {},
        deviceHeld: [],
      };
    }
    const { effective, rejected } = buildEffectiveConfig(
      config.get(),
      structural,
      (device) =>
        resolveOutput({
          forceShadow,
          deviceOutput: device.output,
          configDefault: config.get().output.default,
          envDefault: envDefaultOutput,
          transition: mqtt.statusBaseTopic !== mqtt.baseTopic,
          owner: ownership.owner(device.name),
        }),
      mqtt,
      config.file().loadedAt ?? new Date(clock.now()).toISOString(),
    );
    for (const rejection of rejected)
      this.deps.logger.warn(
        `[Config] Rejected ${rejection.overlay} for ${rejection.name}: ${rejection.problem}`,
      );
    const previous = this.effective;
    const empty = { ...effective, devices: [], scenes: {} };
    const diff = diffEffectiveConfig(previous ?? empty, effective);
    if (previous && !hasDiff(diff)) return;
    const rev = (previous?.rev ?? 0) + 1;
    if (
      decideStamp(
        { source: "effective", position: previous?.rev ?? 0 },
        { source: "effective", position: rev },
      ).action !== "apply"
    )
      return;
    for (const name of diff.devicesRemoved) this.lives.delete(name);
    for (const name of diff.devicesAdded) this.lives.set(name, ++this.counter);
    this.effective = freeze({ ...effective, rev });
    this.emit("changed", {
      effective: this.effective,
      previous: previous ?? freeze({ ...empty, rev: 0 }),
      diff,
    });
  }
}
