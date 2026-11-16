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
 *  - "device-removed" ({name})
 * Changes of the device entry itself (address, output, minFrameMs, …) reach
 * the scheduler through the runtime config's "changed" event with its diff.
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
import { todo } from "../core/todo.js";

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
  }

  /**
   * Build the first state from the effective config and the overlays known
   * so far, then follow runtime "changed", overlay "changed" and
   * "suppression", and registry "changed".
   */
  start() {
    return todo("StateStore.start");
  }

  stop() {
    return todo("StateStore.stop");
  }

  /** @returns {DeviceState[]} config order, then blob-only devices */
  list() {
    return todo("StateStore.list");
  }

  /**
   * @param {string} name
   * @returns {DeviceState|undefined}
   */
  get(name) {
    return todo("StateStore.get", name);
  }

  /** @returns {DeviceView[]} config order, then blob-only devices */
  views() {
    return todo("StateStore.views");
  }

  /**
   * @param {string} name
   * @returns {DeviceView}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_device
   */
  view(name) {
    return todo("StateStore.view", name);
  }

  /**
   * The running config in v1's shape (RuntimeConfig.toV1 with the scenes in
   * effect): what GET /api/config answers and what the status publisher puts
   * on <statusBase>/config/effective. Callers do not rebuild it.
   *
   * @returns {Record<string, unknown>}
   */
  runningConfigV1() {
    return todo("StateStore.runningConfigV1");
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
    return todo("StateStore.chooseScene", name, scene);
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
    return todo("StateStore.adoptDevice", name);
  }

  /**
   * "Return to <your choice>", "Restore": clear the scene overlay of a device.
   *
   * @param {string} name
   * @returns {Promise<DeviceView>}
   * @throws {import("../core/errors.js").HttpError} 503 mqtt_offline: clearing an overlay needs MQTT; 409 shadow_output
   */
  async clearSceneOverlay(name) {
    return todo("StateStore.clearSceneOverlay", name);
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
    return todo("StateStore.setMode", name, mode);
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
    return todo("StateStore.setBrightness", name, percent);
  }

  /**
   * "Retry now" in the recovery dialog: wake the loop and re-initialise the display.
   *
   * @param {string} name
   * @returns {Promise<DeviceView>}
   */
  async retry(name) {
    return todo("StateStore.retry", name);
  }

  // -------------------------------------------------------------------------
  // Reports from the render side
  // -------------------------------------------------------------------------

  /**
   * @param {string} name
   * @param {Partial<EffectiveState>} patch
   */
  reportEffective(name, patch) {
    return todo("StateStore.reportEffective", name, patch);
  }

  /**
   * @param {string} name
   * @param {DeviceHealth} health
   */
  reportHealth(name, health) {
    return todo("StateStore.reportHealth", name, health);
  }
}
