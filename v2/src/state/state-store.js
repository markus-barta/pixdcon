/**
 * State store: desired and effective state of every device, with sources.
 *
 * The single place that answers "what is showing and why". It combines
 *   config store (saved state)  +  overlay service (retained MQTT layer)
 *   +  scene registry (can this scene run here?)
 * through state/precedence.js into a DesiredState per device, and takes what
 * the render side reports (EffectiveState, DeviceHealth). Nothing else in the
 * process keeps its own copy of "the current scene" (matrix A-082: one writer).
 *
 * Commands are applied per device, one at a time per device, and never wait
 * for another device (a slow or offline display cannot hold up the others).
 * Each command answers with the applied DeviceView.
 *
 * Events (EventEmitter):
 *  - "desired"        ({name, desired, previous, changed: string[]})  the scheduler applies it to that device only
 *  - "device"         (DeviceView)       any visible change; rev already increased
 *  - "device-added"   (DeviceView)
 *  - "device-removed" ({name})
 *
 * Transition interlock (switch-over from v1, knowledge entry section 10):
 * while `mqtt.statusBaseTopic` differs from `mqtt.baseTopic`, v1 still runs
 * beside this instance. The store then follows v1's retained
 * `<baseTopic>/config/effective` and resolves a device that v1 still lists to
 * output "shadow" with the problem "still driven by pixdcon v1", whatever
 * config.json says. Two controllers must never drive one display.
 *
 * Persistence: the store itself saves nothing. A choice is saved by the config
 * store in the same atomic write as its `supersedes` marker; mode and
 * brightness override live on the broker as retained controls (overlay
 * service) and, when MQTT is not configured at all, in memory only.
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
 * @property {import("../config/config-store.js").ConfigStore} config
 * @property {import("../overlay/overlay-service.js").OverlayService} overlays
 * @property {import("../scenes/scene-registry.js").SceneRegistry} scenes
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 * @property {boolean} forceShadow PIXDCON2_FORCE_SHADOW: every device resolves to output "shadow"
 */

export class StateStore extends EventEmitter {
  /** @param {StateStoreDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /**
   * Build the first state from the running config and the overlays known so
   * far, then follow config "changed", overlay "changed" and registry "changed".
   */
  start() {
    return todo("StateStore.start");
  }

  stop() {
    return todo("StateStore.stop");
  }

  /** @returns {DeviceState[]} in config order */
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

  /** @returns {DeviceView[]} in config order */
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

  // -------------------------------------------------------------------------
  // Commands (UI and API). All answer with the applied view.
  // -------------------------------------------------------------------------

  /**
   * The user chooses a scene: the display switches now, the choice is saved,
   * and the scene overlays of this device are superseded and cleared on the
   * broker (PIXD-75; in shadow output the broker is left alone).
   *
   * If config.json on disk is invalid the switch still happens and
   * `persisted` is false (v1 A-150). The scene must be registered, a built-in
   * mode of the device type, or null (A-BUG-19: v1 accepted any string).
   *
   * @param {string} name
   * @param {string|null} scene
   * @returns {Promise<{view: DeviceView, persisted: boolean}>}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_device, 400 unknown_scene
   */
  async chooseScene(name, scene) {
    return todo("StateStore.chooseScene", name, scene);
  }

  /**
   * "Return to <your choice>", "Restore": clear the scene overlay of a device.
   *
   * @param {string} name
   * @returns {Promise<DeviceView>}
   * @throws {import("../core/errors.js").HttpError} 503 mqtt_offline: clearing an overlay needs MQTT
   */
  async clearSceneOverlay(name) {
    return todo("StateStore.clearSceneOverlay", name);
  }

  /**
   * Play, pause, stop. Applied in-process at once and published as the
   * retained control (A-152). Sending play while playing asks for a re-init,
   * as in v1 (B-040).
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
