/**
 * Precedence rules: who decides what a display shows.
 *
 * Pure functions, no I/O, no clock of their own. These few functions are the
 * heart of the PIXD-75 fix and of the phase-2 contract tests
 * (test/contract/overlay-rules.test.js). Keep them small and total.
 *
 * SCENE, highest first:
 *   1. granular MQTT overlay that is not superseded        → source "overlay"
 *   2. blob overlay scene of the device, not superseded    → source "blob"
 *   3. the user's choice: a choice made in this process    → source "ui"
 *      or `scene` in config.json                           → source "config"
 *   4. nothing                                             → source "fallback", scene null (display idles)
 *
 * SUPERSEDED: a UI choice at time T supersedes every scene overlay of that
 * device that is stored at T. Stored means: received before T, or delivered
 * as a retained replay (origin "startup") while the choice marker still
 * exists. A message published live after T is a new command from the outside
 * (the Home Assistant scene toggle) and wins again; it also ends the marker.
 * This is v1's behaviour since PIXD-75 (lib/config-overlay.js clearDeviceScene),
 * with the marker saved in config.json so that a restart cannot bring a stale
 * overlay back.
 *
 * INVALID WINNERS: an overlay that names an unknown scene, or a scene for the
 * other device type, is skipped and reported on the Overlays page; the next
 * source decides. A choice that cannot run stays the answer, with `problem`
 * set, and the display idles: the UI shows it as broken instead of silently
 * showing something else (B-069).
 *
 * SETTINGS, per key, lowest first: schema default < saved < MQTT overlay < preview.
 * A value that fails the field's type is ignored in its layer (A-092, C-089).
 *
 * MODE: default "play" < retained control. BRIGHTNESS: scene request < override.
 * ADDRESS: config.json < blob overlay < granular overlay (A-073, D-188).
 *
 * Owner: core/state worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").OverlayRecord} OverlayRecord */
/** @typedef {import("../types.js").SceneResolution} SceneResolution */
/** @typedef {import("../types.js").SettingField} SettingField */
/** @typedef {import("../types.js").SettingValue} SettingValue */
/** @typedef {import("../types.js").IsoTime} IsoTime */

/**
 * @typedef {object} SceneInputs
 * @property {string|null} configScene `scene` of the device in the running config
 * @property {IsoTime} configSince when the running config was loaded
 * @property {{scene: string|null, at: IsoTime, persisted: boolean}|null} uiChoice choice made in this process
 * @property {IsoTime|null} supersedesAt `supersedes.scene` of the device in config.json, or the time of `uiChoice`
 * @property {OverlayRecord|null} granular the device-scene overlay, if one is stored
 * @property {{scene: string|null, record: OverlayRecord}|null} blob scene of this device in the blob overlay
 * @property {(scene: string) => string|null} check problem text when a scene cannot run on this device, else null
 */

/**
 * @param {SceneInputs} inputs
 * @returns {SceneResolution}
 */
export function resolveScene(inputs) {
  return todo("precedence.resolveScene", inputs);
}

/**
 * Is this scene overlay record stale with respect to the user's last choice?
 *
 * @param {OverlayRecord} record
 * @param {IsoTime|null} supersedesAt
 * @returns {boolean}
 */
export function isSuperseded(record, supersedesAt) {
  return todo("precedence.isSuperseded", record, supersedesAt);
}

/**
 * @param {SettingField} field
 * @param {{saved?: unknown, overlay?: unknown, preview?: unknown}} layers raw values per layer, absent when the layer has none
 * @returns {SettingValue}
 */
export function resolveSetting(field, layers) {
  return todo("precedence.resolveSetting", field, layers);
}

/**
 * Normalise one raw value against a schema field: the v1 rules, unchanged
 * (matrix A-085 to A-090, C-092 to C-097). Returns undefined when the value is
 * not valid for the field.
 *
 * @param {unknown} raw
 * @param {SettingField} field
 * @returns {unknown}
 */
export function normalizeSettingValue(raw, field) {
  return todo("precedence.normalizeSettingValue", raw, field);
}

/**
 * @param {string} configIp
 * @param {string|null} blobIp
 * @param {string|null} overlayIp
 * @returns {{value: string, source: "config"|"blob"|"overlay"}}
 */
export function resolveAddress(configIp, blobIp, overlayIp) {
  return todo("precedence.resolveAddress", configIp, blobIp, overlayIp);
}

/**
 * Percent (1 to 100) to the display's native brightness: Ulanzi 0 to 255,
 * Pixoo 1 to 100 (matrix C-070, D-006, D-115). Out-of-range input is clamped.
 *
 * @param {number} percent
 * @param {import("../types.js").DeviceType} type
 * @returns {number}
 */
export function percentToNative(percent, type) {
  return todo("precedence.percentToNative", percent, type);
}
