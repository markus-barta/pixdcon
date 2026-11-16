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
 *  - Drafts (B-176). The page numbers its edits: every preview request
 *    carries `draft`, a counter that rises with each edit on that page for
 *    that device and scene. Save names the draft it commits. The service
 *    remembers, per page, device and scene, the highest draft it has seen,
 *    previewed or committed.
 *      preview with a draft not higher than that           → ignored, the answer shows the state as it is (a late or repeated request)
 *      Save of draft n while the held preview is draft ≤ n → the preview ends
 *      Save of draft n while the held preview is draft > n → the saved keys are stored; the newer preview stays as it is,
 *                                                            because it holds what the user typed while Save was under way
 *    So a Save can never throw away an edit made after the click, and an
 *    older preview can never come back after a Save, whatever order the
 *    requests arrive in.
 *  - Save writes the changed keys to config.json and clears the MQTT overlay
 *    of each saved key (overlay service). It never writes overlay values or
 *    untouched preview values.
 *  - The saved layer a scene sees is the one of the effective config
 *    (runtime.device(name).sceneSettings): a blob entry may replace it
 *    (A-071), and the state then says `savedFrom: "blob"`. Writes always go
 *    to config.json. A device that exists only in the blob has nothing to
 *    save into: 409 overlay_only_device until it is adopted (A-151).
 *  - Subscriptions belong to a scene instance, not to a (scene, device) pair:
 *    runtimeContext() and releaseContext() take the InstanceRef. During a hot
 *    reload the running instance and its replacement both have a context;
 *    releasing one leaves the other's subscribers in place.
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
 * @property {import("../config/config-store.js").ConfigStore} config for writes
 * @property {import("../state/runtime-config.js").RuntimeConfig} runtime the saved layer as it runs, and which devices exist
 * @property {import("../overlay/overlay-service.js").OverlayService} overlays
 * @property {import("./scene-registry.js").SceneRegistry} registry
 * @property {import("../types.js").Epoch} epoch stamped into every SettingsState
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

  /** Follow runtime "changed", overlay "changed" and registry "changed". */
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
   * whole set, A-137, A-190). Clears the MQTT overlay of every key in `set`.
   * With `session` and `draft` it commits that draft of the page's preview
   * (see "Drafts" above): the preview ends unless it already holds a newer
   * draft.
   *
   * @param {string} device
   * @param {string} scene
   * @param {{set?: Record<string, unknown>, reset?: string[], session?: string, draft?: number}} change
   * @returns {Promise<{state: SettingsState, rejected: Record<string, string>, overlaysNotCleared: string[]}>} rejected: key → reason; nothing is saved when any key is rejected
   * @throws {import("../core/errors.js").HttpError} 404, 409 config_invalid, 409 overlay_only_device
   */
  async save(device, scene, change) {
    return todo("SettingsService.save", device, scene, change);
  }

  /**
   * Try values on the display without saving. Replaces the session's earlier
   * preview values for this device and scene, when `draft` is higher than
   * every draft seen from that page; otherwise nothing changes and `applied`
   * is false.
   *
   * @param {string} device
   * @param {string} scene
   * @param {{session: string, draft: number, values: Record<string, unknown>}} preview session: id chosen by the page, tied to its live connection; draft: the page's edit counter; values: only the fields the user changed
   * @returns {{state: SettingsState, rejected: Record<string, string>, applied: boolean}}
   */
  preview(device, scene, preview) {
    return todo("SettingsService.preview", device, scene, preview);
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
   * v1 `ctx.settings` for one scene instance. Subscribers registered through
   * it belong to that instance.
   *
   * @param {import("../types.js").InstanceRef} ref
   * @returns {import("./v1-scene-adapter.js").V1SettingsContext}
   */
  runtimeContext(ref) {
    return todo("SettingsService.runtimeContext", ref);
  }

  /**
   * Drop the subscribers of this instance, and of no other instance of the
   * same scene and device.
   *
   * @param {import("../types.js").InstanceRef} ref
   */
  releaseContext(ref) {
    return todo("SettingsService.releaseContext", ref);
  }
}
