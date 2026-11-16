/**
 * Precedence rules: who decides what a display shows, and whether this
 * instance may touch it.
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
 * SUPERSEDED is decided per layer. A UI choice creates one suppression for
 * the granular layer and one for the blob layer (types.js SceneSuppression;
 * life cycle in overlay/overlay-service.js, rules S1 to S5). A layer's value
 * is superseded while the suppression of that layer exists and the value is
 * what the choice replaced: the record that was in the mirror at the choice,
 * or a replay (retain flag set) of the same value, or any replay when the
 * replaced value is not known. A value that arrived live after the choice is
 * a new command from the outside (the Home Assistant scene toggle) and is
 * never superseded; so is a replay with another value (stored while pixdcon
 * was away). Nothing here looks at arrival order or at a boundary in time.
 *
 * The two layers are independent: a new granular command ends the granular
 * suppression and leaves the blob suppression in place, so when that granular
 * overlay is cleared later, the choice shows and not the stale blob scene.
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
 * OUTPUT: one policy for everything that acts outward, see resolveOutput().
 *
 * Owner: core/state worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").OverlayRecord} OverlayRecord */
/** @typedef {import("../types.js").SceneResolution} SceneResolution */
/** @typedef {import("../types.js").SettingField} SettingField */
/** @typedef {import("../types.js").SettingValue} SettingValue */
/** @typedef {import("../types.js").IsoTime} IsoTime */
/** @typedef {import("../types.js").SceneSuppression} SceneSuppression */
/** @typedef {import("../types.js").OutputMode} OutputMode */

/**
 * @typedef {object} SceneInputs
 * @property {string|null} configScene `scene` of the device in the running config; null for a device that exists only in the blob
 * @property {IsoTime} configSince when the running config was loaded
 * @property {{scene: string|null, at: IsoTime, persisted: boolean}|null} uiChoice choice made in this process
 * @property {{record: OverlayRecord, suppression: SceneSuppression|null}|null} granular the device-scene overlay, if one is stored, and the suppression of the granular layer
 * @property {{scene: string|null, record: OverlayRecord, suppression: SceneSuppression|null}|null} blob scene of this device in the blob overlay, and the suppression of the blob layer
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
 * Is this value of a scene layer stale with respect to the user's choice?
 * See SUPERSEDED above. `value` is the layer's value for the device: the
 * payload of the granular record, or the device's scene inside the blob.
 *
 * @param {{value: string|null, origin: OverlayRecord["origin"], receivedAt: IsoTime}} stored
 * @param {SceneSuppression|null} suppression the suppression of the same layer
 * @returns {boolean}
 */
export function isSuperseded(stored, suppression) {
  return todo("precedence.isSuperseded", stored, suppression);
}

/**
 * The one output policy (types.js OutputDecision). Shadow wins as soon as one
 * reason for it exists; unknown ownership during the transition is such a
 * reason. Everything that acts outward asks the result of this function and
 * nothing else: no caller looks at config.json or at an environment variable
 * on its own.
 *
 * @param {object} inputs
 * @param {boolean} inputs.forceShadow PIXDCON2_FORCE_SHADOW=1
 * @param {OutputMode|null} inputs.deviceOutput `output` of the device entry as it runs
 * @param {OutputMode|null} inputs.configDefault `output.default` of config.json
 * @param {OutputMode} inputs.envDefault PIXDCON2_DEFAULT_OUTPUT, else "drive"
 * @param {boolean} inputs.transition `mqtt.statusBaseTopic` differs from `mqtt.baseTopic`
 * @param {import("../types.js").V1Owner} inputs.owner from state/v1-ownership.js
 * @returns {import("../types.js").OutputDecision}
 */
export function resolveOutput(inputs) {
  const requested =
    inputs.deviceOutput ?? inputs.configDefault ?? inputs.envDefault;
  if (inputs.forceShadow)
    return { mode: "shadow", requested, reason: "force_shadow" };
  if (requested === "shadow")
    return { mode: "shadow", requested, reason: "config" };
  if (inputs.transition && inputs.owner === "v1")
    return { mode: "shadow", requested, reason: "v1_owner" };
  if (inputs.transition && inputs.owner !== "free")
    return { mode: "shadow", requested, reason: "ownership_unknown" };
  return { mode: "drive", requested, reason: null };
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
