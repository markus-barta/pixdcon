/**
 * State store: desired and effective state of every device, with sources.
 *
 * The single place that answers "what is showing and why". It combines
 *   runtime config (the device entries as they run, with their output)
 *   +  overlay service (scene layers, suppressions, retained controls)
 *   +  scene registry (can this scene run here?)
 * through state/precedence.js into a DesiredState per device, and takes what
 * the render side reports (EffectiveState, DeviceHealth). Nothing else in the
 * process keeps its own copy of "the current scene" (matrix A-082: one writer).
 *
 * The device list is the effective one: config.json devices in file order,
 * then devices that exist only in the blob overlay (origin "blob").
 *
 * Commands are applied per device, one at a time per device, and never wait
 * for another device (a slow or offline display cannot hold up the others).
 * Each command answers with the applied DeviceView.
 *
 * Events (EventEmitter):
 *  - "desired"        ({name, desired, previous, changed: string[]})  scene, mode or brightness changed: the scheduler applies it to that device only
 *  - "device"         (DeviceView)       any visible change; rev already increased
 *  - "device-added"   (DeviceView)
 *  - "device-removed" ({name, incarnation})   incarnation: the one that left
 *  - "retry"          ({name})   explicit user wake-up, consumed by Scheduler
 *
 * Incarnations. Every device that enters the effective config has an
 * incarnation (RuntimeConfig.incarnationOf): a device that leaves and comes
 * back under the same name is another one, and counts its `rev` from 1
 * again. The store takes the number when the device is added, puts it into
 * every DeviceView, and names it in "device-removed" when that device
 * leaves. With that a page can tell the views of two devices of one name
 * apart, also when it was disconnected while one left and the other came
 * (web/js/ordering.js).
 * Changes of the device entry itself (address, output, minFrameMs, …) reach
 * the scheduler through the runtime config's "changed" event with its diff.
 *
 * The saved choice. What config.json holds as a device's `scene` reaches the
 * store as `runtime.device(name).savedScene` (types.js EffectiveDevice): at
 * start(), so a process that starts with a saved scene shows it, and with
 * every runtime "changed" event whose diff names `savedScene` for a device,
 * so an edit of config.json from outside that changes nothing but a scene
 * is followed. A choice made in this process and saved is the same value
 * arriving that way; it changes nothing, because the store applied it
 * already. The store never reads the config store for a device.
 *
 * Order (core/ordering.js).
 *  - runtime "changed": applied only when `effective.rev` is higher than
 *    the one the store holds.
 *  - overlay "changed" and registry "changed" say "compute again": the store
 *    reads the overlay service and the registry as they are then.
 *  - overlay "suppression": removes exactly the generation it names from
 *    config.json; a suppression of a newer generation in the same layer
 *    stays.
 *  - reports of the render side carry the token of the device runtime that
 *    made them. The scheduler hands out a new token whenever it builds a
 *    runtime; a report with an older token is dropped (reportEffective).
 *  - commands of one device run one at a time, in the order they arrived.
 *
 * Output. The store does not decide whether a device is driven. It shows the
 * decision of the one output policy (`runtime.device(name).output`), with the
 * reason in `desired.outputProblem`, and it acts on it: for a device in
 * shadow no clear and no control is published.
 *
 * Persistence: the store saves through the config store only.
 *  - A choice is saved in the same atomic write as the suppressions it
 *    creates (overlay service, planSupersede). When the overlay service
 *    reports that a suppression ended, the store removes it from config.json.
 *  - A device that exists only in the blob has no entry to save into. Its
 *    scene choice is applied and answered with persisted false, reason
 *    "overlay_only_device"; settings and device fields cannot be saved for
 *    it. Nothing is adopted on the side. adoptDevice() is the one, explicit
 *    way into the file (A-151, and the approved rule "Save never promotes
 *    overlays").
 *  - Mode and brightness override live on the broker as retained controls
 *    (overlay service); in memory only when MQTT is not configured at all,
 *    and for a device in shadow.
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { HttpError } from "../core/errors.js";
import { commandLane } from "../core/commands.js";
import { apply, decideStamp, drop } from "../core/ordering.js";
import { NotImplementedError } from "../core/todo.js";
import { freeze } from "../core/values.js";
import { resolveScene } from "./precedence.js";

/** @typedef {import("../types.js").DeviceState} DeviceState */
/** @typedef {import("../types.js").DeviceView} DeviceView */
/** @typedef {import("../types.js").DeviceHealth} DeviceHealth */
/** @typedef {import("../types.js").EffectiveState} EffectiveState */
/** @typedef {import("../types.js").PlaybackMode} PlaybackMode */

/**
 * @typedef {object} StateStoreDeps
 * @property {import("../config/config-store.js").ConfigStore} config for writes; reads go through `runtime`
 * @property {import("./runtime-config.js").RuntimeConfig} runtime
 * @property {import("../overlay/overlay-service.js").OverlayService} overlays
 * @property {import("../scenes/scene-registry.js").SceneRegistry} scenes
 * @property {import("../types.js").Factories["sizeOf"]} sizeOf pixel size per device type
 * @property {import("../types.js").Epoch} epoch stamped into every view
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

export class StateStore extends EventEmitter {
  /** @param {StateStoreDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
    this.active = false;
    this.runtimeRev = 0;
    /** @type {Map<string, DeviceState>} */
    this.states = new Map();
    /** @type {Map<string, import("../types.js").SceneChoice>} */
    this.choices = new Map();
    /** @type {Map<string, {mode?: PlaybackMode, brightness?: number|null, at: string}>} */
    this.localControls = new Map();
    /** @type {Map<string, number>} */
    this.tokens = new Map();
    /** @type {Map<string, ReturnType<typeof commandLane>>} */
    this.queues = new Map();
    /** @type {Array<() => void>} */
    this.unwire = [];
  }

  /**
   * Build the first state from the effective config (devices, their saved
   * choice and their output) and the overlays known so far, then follow
   * runtime "changed", overlay "changed" and "suppression", and registry
   * "changed".
   */
  start() {
    if (this.active) return;
    this.active = true;
    /** @param {{effective: import("../types.js").EffectiveConfig}} event */
    const runtimeChanged = ({ effective }) => {
      if (
        !this.active ||
        decideStamp(
          { source: this.deps.epoch, position: this.runtimeRev },
          { source: this.deps.epoch, position: effective.rev },
        ).action !== "apply"
      )
        return;
      this.runtimeRev = effective.rev;
      this.sync();
    };
    /** @param {{devices: string[]}} event */
    const overlayChanged = ({ devices }) => {
      if (!this.active) return;
      for (const name of devices) this.compute(name);
    };
    const registryChanged = () => {
      if (!this.active) return;
      for (const name of this.states.keys()) this.compute(name);
    };
    /** @param {{device: string, layer: import("../types.js").SceneLayer, generation: number}} event */
    const suppression = ({ device, layer, generation }) => {
      if (!this.active || !this.states.has(device)) return;
      void this.command(device, async () => {
        if (
          !this.deps.config.file().valid ||
          this.require(device).runtime.origin !== "config"
        )
          return;
        await this.deps.config.updateDevice(device, (raw) => {
          const saved =
            /** @type {import("../types.js").DeviceConfig["supersedes"]} */ (
              raw.supersedes
            );
          if (saved?.[layer]?.generation !== generation) return;
          delete saved[layer];
          if (Object.keys(saved).length === 0) delete raw.supersedes;
        });
      }).catch((error) =>
        this.deps.logger.error(
          "[State] Cannot retire saved suppression",
          error,
        ),
      );
    };
    this.deps.runtime.on("changed", runtimeChanged);
    this.deps.overlays.on("changed", overlayChanged);
    this.deps.overlays.on("suppression", suppression);
    this.deps.scenes.on("changed", registryChanged);
    this.unwire.push(
      () => this.deps.runtime.off("changed", runtimeChanged),
      () => this.deps.overlays.off("changed", overlayChanged),
      () => this.deps.overlays.off("suppression", suppression),
      () => this.deps.scenes.off("changed", registryChanged),
    );
    runtimeChanged({ effective: this.deps.runtime.get() });
  }

  stop() {
    this.active = false;
    this.tokens.clear();
    for (const lane of this.queues.values()) lane.close();
    for (const off of this.unwire.splice(0)) off();
  }

  /** @returns {DeviceState[]} config order, then blob-only devices */
  list() {
    return this.deps.runtime.get().devices.flatMap((device) => {
      const state = this.states.get(device.name);
      return state ? [state] : [];
    });
  }

  /**
   * @param {string} name
   * @returns {DeviceState|undefined}
   */
  get(name) {
    return this.states.get(name);
  }

  /** @returns {DeviceView[]} config order, then blob-only devices */
  views() {
    return this.list().map((state) => this.view(state.name));
  }

  /**
   * @param {string} name
   * @returns {DeviceView}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_device
   */
  view(name) {
    const state = this.require(name);
    const device = state.runtime;
    let settingOverlayCount = 0;
    const scene = state.desired.scene.scene;
    if (scene)
      settingOverlayCount = Object.keys(
        skeletonRead(() => this.deps.overlays.settingValues(name, scene), {}),
      ).length;
    return freeze({
      name,
      epoch: this.deps.epoch,
      incarnation: state.incarnation,
      rev: state.rev,
      displayName: device.displayName,
      comment: device.comment,
      type: device.type,
      origin: device.origin,
      size: this.deps.sizeOf(device.type),
      desired: state.desired,
      effective: state.effective,
      health: state.health,
      preview: device.preview,
      facts: {
        minFrameMs: device.minFrameMs,
        powerCyclePlugTopic: device.powerCyclePlugin?.topic ?? null,
      },
      blobKeys: device.blobKeys,
      settingOverlayCount,
      pending: null,
    });
  }

  /**
   * The running config in v1's shape (RuntimeConfig.toV1 with the scenes in
   * effect): what GET /api/config answers and what the status publisher puts
   * on <statusBase>/config/effective. Callers do not rebuild it.
   *
   * @returns {Record<string, unknown>}
   */
  runningConfigV1() {
    return this.deps.runtime.toV1(
      (name) => this.states.get(name)?.desired.scene.scene ?? null,
    );
  }

  // -------------------------------------------------------------------------
  // Commands (UI and API). All answer with the applied view.
  // -------------------------------------------------------------------------

  /**
   * The user chooses a scene: the display switches now, the choice is saved
   * together with the suppressions of both scene layers, and for a driven
   * device the stored scene overlays are cleared on the broker (PIXD-75).
   *
   * Not saved, but still switched (`persisted` false, A-150):
   *  - config.json on disk is invalid (reason "config_invalid"): the
   *    suppressions then live in memory only, like the choice
   *  - the device exists only in the blob overlay (reason "overlay_only_device")
   * The scene must be registered, a built-in mode of the device type, or null
   * (A-BUG-19: v1 accepted any string).
   *
   * @param {string} name
   * @param {string|null} scene
   * @returns {Promise<{view: DeviceView, persisted: boolean, notSavedReason: import("../types.js").SceneChoice["notSavedReason"]}>}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_device, 400 unknown_scene
   */
  async chooseScene(name, scene) {
    return this.command(name, async () => {
      const state = this.require(name);
      if (
        scene !== null &&
        (typeof scene !== "string" || this.check(scene, state.type) !== null)
      )
        throw new HttpError(400, "unknown_scene", `Scene cannot run: ${scene}`);
      const at = new Date(this.deps.clock.now()).toISOString();
      const plan = skeletonRead(
        () => this.deps.overlays.planSupersede(name, at),
        { device: name, generation: 1, at, granular: null, blob: null },
      );
      const notSavedReason =
        state.runtime.origin === "blob"
          ? "overlay_only_device"
          : !this.deps.config.file().valid
            ? "config_invalid"
            : null;
      const persisted = notSavedReason === null;
      if (persisted)
        await this.deps.config.updateDevice(name, (raw) => {
          raw.scene = scene;
          delete raw.scenes;
          raw.supersedes = {
            ...(plan.granular ? { granular: plan.granular } : {}),
            ...(plan.blob ? { blob: plan.blob } : {}),
          };
        });
      this.stillCurrent(name, state.incarnation);
      this.choices.set(name, {
        scene,
        chosenAt: at,
        persisted,
        notSavedReason,
        overridden: false,
      });
      // PIXD-91: the frozen plan crosses the saved-write await. Keep the
      // prescribed plan/apply interface; the coordinator owns its repair.
      skeletonRead(() => this.deps.overlays.applySupersede(plan), {
        superseded: [],
        clearPending: false,
      });
      this.compute(name);
      return { view: this.view(name), persisted, notSavedReason };
    });
  }

  /**
   * Adopt a device that exists only in the blob overlay: write an entry with
   * its name, type and address as they run, plus the scene choice made for it
   * in this process if there is one, in one atomic write. Nothing else of the
   * blob entry is copied; its other keys stay overlay values. Afterwards the
   * device has origin "config" and saves like any other.
   *
   * @param {string} name
   * @returns {Promise<DeviceView>}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_device, 409 not_overlay_only (the device is in config.json already), 409 config_invalid
   */
  async adoptDevice(name) {
    return this.command(name, async () => {
      const state = this.require(name);
      if (state.runtime.origin !== "blob")
        throw new HttpError(409, "not_overlay_only", "Device is already saved");
      const choice = this.choices.get(name);
      const supersedes = skeletonRead(
        () => this.deps.overlays.suppressions(name),
        { granular: null, blob: null },
      );
      await this.deps.config.adoptDevice(
        { name, type: state.type, ip: state.runtime.address },
        choice
          ? {
              scene: choice.scene,
              supersedes: {
                ...(supersedes.granular
                  ? { granular: supersedes.granular }
                  : {}),
                ...(supersedes.blob ? { blob: supersedes.blob } : {}),
              },
            }
          : undefined,
      );
      this.stillCurrent(name, state.incarnation);
      if (choice)
        this.choices.set(name, {
          ...choice,
          persisted: true,
          notSavedReason: null,
        });
      this.compute(name);
      return this.view(name);
    });
  }

  /**
   * "Return to <your choice>", "Restore": clear the scene overlay of a device.
   *
   * @param {string} name
   * @returns {Promise<DeviceView>}
   * @throws {import("../core/errors.js").HttpError} 503 mqtt_offline: clearing an overlay needs MQTT; 409 shadow_output
   */
  async clearSceneOverlay(name) {
    return this.command(name, async () => {
      const state = this.require(name);
      const inputs = this.deps.overlays.sceneInputs(name);
      const id = inputs.granular?.inEffect
        ? inputs.granular.overlayId
        : inputs.blob?.inEffect
          ? inputs.blob.overlayId
          : `device-scene:${name}`;
      await this.deps.overlays.clear(id);
      this.stillCurrent(name, state.incarnation);
      this.compute(name);
      return this.view(name);
    });
  }

  /**
   * Play, pause, stop. Applied in-process at once and, for a driven device,
   * published as the retained control (A-152). Sending play while playing
   * asks for a re-init, as in v1 (B-040).
   *
   * @param {string} name
   * @param {PlaybackMode} mode
   * @returns {Promise<DeviceView>}
   * @throws {import("../core/errors.js").HttpError} 400 invalid_mode, 404 unknown_device, 503 mqtt_offline while a configured broker is not connected
   */
  async setMode(name, mode) {
    return this.command(name, async () => {
      if (!["play", "pause", "stop"].includes(mode))
        throw new HttpError(
          400,
          "invalid_mode",
          "Expected play, pause or stop",
        );
      const state = this.require(name);
      const repeatedPlay =
        mode === "play" && state.desired.mode.value === "play";
      await this.deps.overlays.publishControl(name, { mode });
      this.stillCurrent(name, state.incarnation);
      if (
        state.runtime.output.mode === "shadow" ||
        !this.deps.overlays.deps.mqtt
      )
        this.localControls.set(name, {
          ...this.localControls.get(name),
          mode,
          at: new Date(this.deps.clock.now()).toISOString(),
        });
      this.compute(name);
      if (repeatedPlay)
        this.emit("desired", {
          name,
          desired: this.require(name).desired,
          previous: state.desired,
          changed: ["mode"],
        });
      return this.view(name);
    });
  }

  /**
   * Brightness override in percent, or null for "the scene decides".
   * On clear, the level the scene last asked for is applied again (S-12).
   *
   * @param {string} name
   * @param {number|null} percent 1 to 100
   * @returns {Promise<DeviceView>}
   * @throws {import("../core/errors.js").HttpError} 400 invalid_brightness, 404 unknown_device, 503 mqtt_offline
   */
  async setBrightness(name, percent) {
    return this.command(name, async () => {
      if (
        percent !== null &&
        (typeof percent !== "number" ||
          !Number.isFinite(percent) ||
          percent < 1 ||
          percent > 100)
      )
        throw new HttpError(
          400,
          "invalid_brightness",
          "Expected brightness from 1 to 100, or null",
        );
      const state = this.require(name);
      await this.deps.overlays.publishControl(name, { brightness: percent });
      this.stillCurrent(name, state.incarnation);
      if (
        state.runtime.output.mode === "shadow" ||
        !this.deps.overlays.deps.mqtt
      )
        this.localControls.set(name, {
          ...this.localControls.get(name),
          brightness: percent,
          at: new Date(this.deps.clock.now()).toISOString(),
        });
      this.compute(name);
      return this.view(name);
    });
  }

  /**
   * "Retry now" in the recovery dialog: wake the loop and re-initialise the display.
   *
   * @param {string} name
   * @returns {Promise<DeviceView>}
   */
  async retry(name) {
    return this.command(name, async () => {
      this.emit("retry", { name });
      return this.view(name);
    });
  }

  // -------------------------------------------------------------------------
  // Reports from the render side
  // -------------------------------------------------------------------------

  /**
   * @param {string} name
   * @param {Partial<EffectiveState>} patch
   * @param {number} token token of the device runtime that reports (Scheduler); a report of a runtime that was replaced is dropped
   * @returns {import("../core/ordering.js").Decision}
   */
  reportEffective(name, patch, token) {
    const decision = decideStamp(
      { source: this.active ? (this.tokens.get(name) ?? null) : null },
      { source: token },
    );
    if (decision.action !== "apply") return decision;
    const state = this.states.get(name);
    if (!state) return drop("unknown_device");
    this.put({ ...state, effective: { ...state.effective, ...patch } });
    return apply();
  }

  /**
   * A device runtime was built: from now on only reports with this token
   * count for the device.
   *
   * @param {string} name
   * @param {number} token higher than every token before it
   */
  runtimeStarted(name, token) {
    if (
      !this.active ||
      !this.states.has(name) ||
      decideStamp(
        { source: name, position: this.tokens.get(name) ?? -1 },
        { source: name, position: token },
      ).action !== "apply"
    )
      return;
    this.tokens.set(name, token);
  }

  /**
   * @param {string} name
   * @param {DeviceHealth} health
   */
  reportHealth(name, health) {
    if (!this.active || !this.states.has(name)) return;
    this.put({ ...this.require(name), health: structuredClone(health) });
  }

  /** @param {string} name @returns {DeviceState} */
  require(name) {
    const state = this.states.get(name);
    if (!state)
      throw new HttpError(404, "unknown_device", `Unknown device: ${name}`);
    return state;
  }

  /** @param {string} name @param {number} incarnation */
  stillCurrent(name, incarnation) {
    if (
      !this.active ||
      decideStamp(
        { source: this.require(name).incarnation },
        { source: incarnation },
      ).action !== "apply"
    )
      throw new HttpError(
        409,
        "device_replaced",
        `Device was replaced: ${name}`,
      );
  }

  /** @template T @param {string} name @param {() => Promise<T>} work @returns {Promise<T>} */
  command(name, work) {
    const incarnation = this.require(name).incarnation;
    const lane = this.queues.get(name) ?? commandLane();
    this.queues.set(name, lane);
    return lane.run(() => {
      this.stillCurrent(name, incarnation);
      return work();
    });
  }

  sync() {
    const devices = this.deps.runtime.get().devices;
    const names = new Set(devices.map((device) => device.name));
    for (const [name, old] of this.states) {
      if (
        names.has(name) &&
        this.deps.runtime.incarnationOf(name) === old.incarnation
      )
        continue;
      this.states.delete(name);
      this.choices.delete(name);
      this.localControls.delete(name);
      this.tokens.delete(name);
      this.emit("device-removed", { name, incarnation: old.incarnation });
    }
    for (const device of devices) {
      const old = this.states.get(device.name);
      const choice = this.choices.get(device.name);
      if (
        old &&
        device.savedScene !== old.runtime.savedScene &&
        choice?.scene !== device.savedScene
      )
        this.choices.delete(device.name);
      if (
        old?.runtime.output.mode === "shadow" &&
        device.output.mode === "drive"
      )
        this.localControls.delete(device.name);
      this.compute(device.name);
    }
  }

  /** @param {string} scene @param {import("../types.js").DeviceType} type @returns {string|null} */
  check(scene, type) {
    return skeletonRead(
      () => this.deps.scenes.check(scene, type),
      Object.hasOwn(this.deps.runtime.scenes(), scene) ? null : "unknown scene",
    );
  }

  /** @param {string} name */
  compute(name) {
    const device = this.deps.runtime.device(name);
    if (!this.active || !device) return;
    const old = this.states.get(name);
    const now = new Date(this.deps.clock.now()).toISOString();
    const since = this.deps.runtime.get().savedAt;
    const choice = this.choices.get(name);
    const layers = skeletonRead(() => this.deps.overlays.sceneInputs(name), {
      granular: null,
      blob: null,
    });
    const scene = resolveScene({
      configScene: device.savedScene,
      configSince: since,
      uiChoice: choice
        ? {
            scene: choice.scene,
            at: choice.chosenAt ?? since,
            persisted: choice.persisted,
          }
        : null,
      ...layers,
      check: (key) => this.check(key, device.type),
    });
    // Receipt time is visible on overlay records; an unchanged scene does
    // not cause a desired event or a frame restart merely by being replayed.
    if (
      old &&
      scene.scene === old.desired.scene.scene &&
      scene.source === old.desired.scene.source &&
      scene.problem === old.desired.scene.problem
    )
      scene.since = old.desired.scene.since;
    const controls = skeletonRead(() => this.deps.overlays.controls(name), {
      mode: null,
      brightness: null,
    });
    const local = this.localControls.get(name);
    /** @type {import("../types.js").DesiredState} */
    const desired = {
      scene,
      choice: {
        ...(choice ?? {
          scene: device.savedScene,
          persisted: true,
          notSavedReason: null,
          chosenAt: null,
        }),
        overridden: scene.source === "overlay" || scene.source === "blob",
      },
      mode: local?.mode
        ? { value: local.mode, source: "ui", since: local.at }
        : controls.mode
          ? {
              value: controls.mode.value,
              source: "mqtt",
              since: controls.mode.record.receivedAt,
            }
          : {
              value: "play",
              source: "default",
              since:
                old?.desired.mode.source === "default"
                  ? old.desired.mode.since
                  : since,
            },
      brightness:
        local && Object.hasOwn(local, "brightness")
          ? {
              override: local.brightness ?? null,
              source: "ui",
              since: local.at,
            }
          : controls.brightness
            ? {
                override: controls.brightness.percent,
                source: "mqtt",
                since: controls.brightness.record.receivedAt,
              }
            : {
                override: null,
                source: "none",
                since:
                  old?.desired.brightness.source === "none"
                    ? old.desired.brightness.since
                    : since,
              },
      address: { value: device.address, source: device.addressSource },
      enabled: device.enabled,
      output: device.output.mode,
      outputProblem:
        device.output.reason === "v1_owner"
          ? "still driven by pixdcon v1"
          : device.output.reason === "ownership_unknown"
            ? "waiting for pixdcon v1's device list"
            : device.output.reason === "force_shadow"
              ? "this instance never drives a display"
              : null,
    };
    const health = old?.health ?? {
      state:
        device.output.mode === "shadow"
          ? /** @type {const} */ ("shadow")
          : /** @type {const} */ ("starting"),
      since: now,
      lastFrameAt: null,
      lastContactAt: null,
      consecutiveErrors: 0,
      lastError: null,
      reason: /** @type {const} */ ("not_started"),
      powerCycles: {
        count: 0,
        max: device.maxPowerCycles,
        plugTopic: device.powerCyclePlugin?.topic ?? null,
      },
      apSsid: null,
    };
    this.put({
      name,
      type: device.type,
      incarnation: this.deps.runtime.incarnationOf(name) ?? 0,
      rev: old?.rev ?? 0,
      runtime: device,
      desired,
      health,
      effective: old?.effective ?? {
        scene: null,
        phase: "idle",
        showingSince: null,
        frameCount: 0,
        lastBrightness: null,
        appliedBrightness: null,
        nextRetryAt: null,
      },
    });
  }

  /** @param {DeviceState} state */
  put(state) {
    const previous = this.states.get(state.name);
    if (previous && isDeepStrictEqual(previous, state)) return;
    const next = freeze({ ...state, rev: (previous?.rev ?? 0) + 1 });
    this.states.set(state.name, next);
    if (!previous) this.emit("device-added", this.view(state.name));
    this.emit("device", this.view(state.name));
    const targets = (
      /** @type {import("../types.js").DesiredState|undefined} */ desired,
    ) => ({
      scene: [desired?.scene.scene, desired?.scene.problem],
      mode: desired?.mode.value,
      brightness: desired?.brightness.override,
      address: desired?.address.value,
      enabled: desired?.enabled,
      output: desired?.output,
    });
    const before = targets(previous?.desired),
      after = targets(next.desired);
    const changed = Object.keys(after).filter(
      (key) =>
        !isDeepStrictEqual(
          /** @type {any} */ (before)[key],
          /** @type {any} */ (after)[key],
        ),
    );
    if (changed.length)
      this.emit("desired", {
        name: state.name,
        desired: next.desired,
        previous: previous?.desired ?? null,
        changed,
      });
  }
}

/** @template T @param {() => T} read @param {T} fallback @returns {T} */
function skeletonRead(read, fallback) {
  try {
    return read();
  } catch (error) {
    if (error instanceof NotImplementedError) return fallback;
    throw error;
  }
}
