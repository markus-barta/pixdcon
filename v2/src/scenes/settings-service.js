/**
 * Settings service: the values a scene sees, layer by layer.
 *
 *   schema default  <  saved in config.json  <  MQTT overlay  <  preview session
 *
 * Kept from v1 (lib/scene-settings-service.js; matrix A-083 to A-102, C-088 to C-107):
 *  - saved values live in config.json under devices[].sceneSettings[scene][key]
 *  - a value that is not valid for its field is ignored in its layer
 *  - only settings the user changed are saved ("sparse save", B-084);
 *    "Reset to default" removes the saved value (B-086)
 *  - a scene's subscribers are called only when an effective value really changed (C-103)
 *
 * New in v2 (approved spec, section 8):
 *  - Preview sessions replace v1's retained auto-overlay (B-085, S-2, C-214).
 *    A preview is a layer in this process, for one device and scene, owned by
 *    one browser page. It is never published to MQTT, so it cannot be
 *    retained. It ends on Revert, on Save, when the page leaves, and when the
 *    page's live connection is gone for longer than `previewGraceMs`.
 *  - Save writes the changed keys to config.json and clears the MQTT overlay
 *    of each saved key (overlay service). It never writes overlay values or
 *    untouched preview values.
 *  - Saved values reach the running scene at once; no restart (A-102).
 *  - A JSON field that does not parse is rejected by the API with the parse
 *    error; it is never stored as {} (S-5, B-090).
 *  - State is kept per device and scene in nested maps; names cannot collide
 *    (A-186, A-BUG-37).
 *
 * Events (EventEmitter): "settings" (SettingsState) for a device and scene whose state changed.
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").SettingsState} SettingsState */

/**
 * @typedef {object} SettingsServiceDeps
 * @property {import("../config/config-store.js").ConfigStore} config
 * @property {import("../overlay/overlay-service.js").OverlayService} overlays
 * @property {import("./scene-registry.js").SceneRegistry} registry
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 * @property {number} [previewGraceMs] default 5000
 */

export class SettingsService extends EventEmitter {
  /** @param {SettingsServiceDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /** Follow config "changed", overlay "changed" and registry "changed". */
  start() {
    return todo("SettingsService.start");
  }

  stop() {
    return todo("SettingsService.stop");
  }

  /**
   * @param {string} device
   * @param {string} scene
   * @returns {SettingsState}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_device or unknown_scene
   */
  state(device, scene) {
    return todo("SettingsService.state", device, scene);
  }

  /**
   * v1 GET /api/scene-settings: {<device>: {<its current scene>: {saved, overlay, effective}}} (A-093, A-128).
   *
   * @returns {Record<string, Record<string, {saved: Record<string, unknown>, overlay: Record<string, unknown>, effective: Record<string, unknown>}>>}
   */
  toV1() {
    return todo("SettingsService.toV1");
  }

  /**
   * Save settings for one device and scene: `set` are stored, `reset` are
   * removed from the saved set. Other saved keys stay (v1's save replaced the
   * whole set, A-137, A-190). Clears the MQTT overlay of every key in `set`
   * and ends the caller's preview session.
   *
   * @param {string} device
   * @param {string} scene
   * @param {{set?: Record<string, unknown>, reset?: string[], session?: string}} change
   * @returns {Promise<{state: SettingsState, rejected: Record<string, string>, overlaysNotCleared: string[]}>} rejected: key → reason; nothing is saved when any key is rejected
   * @throws {import("../core/errors.js").HttpError} 404, 409 config_invalid
   */
  async save(device, scene, change) {
    return todo("SettingsService.save", device, scene, change);
  }

  /**
   * Try values on the display without saving. Replaces the session's earlier
   * preview values for this device and scene.
   *
   * @param {string} device
   * @param {string} scene
   * @param {string} session id chosen by the page; tied to its live connection
   * @param {Record<string, unknown>} values only the fields the user changed
   * @returns {{state: SettingsState, rejected: Record<string, string>}}
   */
  preview(device, scene, session, values) {
    return todo("SettingsService.preview", device, scene, session, values);
  }

  /**
   * End a preview: Revert, page left, or connection lost.
   *
   * @param {string} session
   * @param {{device?: string, scene?: string}} [scope] default: everything the session previews
   * @returns {SettingsState[]} states that changed
   */
  endPreview(session, scope) {
    return todo("SettingsService.endPreview", session, scope);
  }

  /**
   * The live connection of a page opened or closed. A closed connection ends
   * the page's previews after the grace time unless it came back.
   *
   * @param {string} session
   * @param {boolean} connected
   */
  sessionConnection(session, connected) {
    return todo("SettingsService.sessionConnection", session, connected);
  }

  /**
   * v1 `ctx.settings` for a scene instance.
   *
   * @param {string} scene
   * @param {string} device
   * @returns {import("./v1-scene-adapter.js").V1SettingsContext}
   */
  runtimeContext(scene, device) {
    return todo("SettingsService.runtimeContext", scene, device);
  }

  /**
   * Drop the subscriptions of a released scene instance.
   * @param {string} scene
   * @param {string} device
   */
  releaseContext(scene, device) {
    return todo("SettingsService.releaseContext", scene, device);
  }
}
