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
 * SUPERSEDED is decided per layer, at the moment a value is delivered, by
 * the overlay core (overlay/scene-layers.js), which knows what this file
 * cannot: on which connection a value arrived and which own writes were
 * still on their way. A UI choice creates one suppression for the granular
 * layer and one for the blob layer (types.js SceneSuppression). While the
 * suppression of a layer exists, the layer's value is not in effect. The
 * suppression ends, and the value wins again, only on evidence: a live
 * message from outside that was not processed before an own write still on
 * its way (the Home Assistant scene toggle), or a replay of a value the
 * suppression does not hide (stored while pixdcon was away). isSuperseded()
 * below is the one question about values: does this suppression hide that
 * replayed value? Nothing here looks at arrival order or at a boundary in
 * time, and the settle hint is not an input.
 *
 * DELIVERED is the second condition, and it is about the connection: a
 * layer's value is in effect only while the connection that delivered it is
 * the current one (overlay-service.js C1). After a reconnect it waits,
 * listed and without a say, until the new connection delivers it. A scene
 * overlay that was cleared while pixdcon was away therefore does not go on
 * overriding the choice (A-182). The same holds for every other overlay
 * value below (a setting, mode, brightness, an address, a scene path): the
 * overlay service hands this file only the values the current connection
 * delivered (overlay-service.js M4).
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
 * BLOB WRITER: one instance per base topic may publish to the blob overlay,
 * see resolveBlobWriter().
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
 * What one scene layer holds for a device. Built by the overlay service from
 * its mirror (overlay/scene-layers.js sceneInputs).
 *
 * @typedef {object} LayerScene
 * @property {string} scene the value stored in the layer
 * @property {boolean} inEffect false: the value decides nothing. Either a suppression of this layer exists (the user's choice replaced it), or a newer connection exists that has not delivered the value (overlay-service.js C1). The record is listed either way
 * @property {IsoTime} since when this process received the value
 * @property {string} overlayId id of the overlay record
 */

/**
 * @typedef {object} SceneInputs
 * @property {string|null} configScene the saved choice: `EffectiveDevice.savedScene`, the `scene` of the device in config.json; null for none and for a device that exists only in the blob
 * @property {IsoTime} configSince `EffectiveConfig.savedAt`: when the running config.json content was loaded or written
 * @property {{scene: string|null, at: IsoTime, persisted: boolean}|null} uiChoice choice made in this process
 * @property {LayerScene|null} granular the device-scene overlay, if one is stored
 * @property {LayerScene|null} blob scene of this device in the blob overlay, if it names one
 * @property {(scene: string) => string|null} check problem text when a scene cannot run on this device, else null
 */

/**
 * Who decides what the display shows. Total: every input has an answer.
 *
 * @param {SceneInputs} inputs
 * @returns {SceneResolution}
 */
export function resolveScene(inputs) {
  /** @type {Array<[LayerScene|null, "overlay"|"blob"]>} */
  const layers = [
    [inputs.granular, "overlay"],
    [inputs.blob, "blob"],
  ];
  for (const [layer, source] of layers) {
    // A superseded value and one that cannot run are skipped: the next
    // source decides, and the Overlays page lists the value with its reason.
    if (!layer || !layer.inEffect || inputs.check(layer.scene) !== null)
      continue;
    return {
      scene: layer.scene,
      source,
      since: layer.since,
      overlayId: layer.overlayId,
      problem: null,
    };
  }
  const choice = inputs.uiChoice
    ? { scene: inputs.uiChoice.scene, since: inputs.uiChoice.at, ui: true }
    : { scene: inputs.configScene, since: inputs.configSince, ui: false };
  if (choice.scene === null && !choice.ui)
    return {
      scene: null,
      source: "fallback",
      since: inputs.configSince,
      overlayId: null,
      problem: null,
    };
  // The user's choice stays the answer when it cannot run: `problem` says
  // why, and the display idles (B-069).
  return {
    scene: choice.scene,
    source: choice.ui ? "ui" : "config",
    since: choice.since,
    overlayId: null,
    problem: choice.scene === null ? null : inputs.check(choice.scene),
  };
}

/**
 * Does this suppression hide that delivered value of its layer? `value` is
 * the layer's value for the device: the payload of the granular topic, or
 * the device's scene inside the blob.
 *
 * Only a replay can be hidden by its value: it shows what the store held
 * when the connection subscribed. It is stale when it is the value the
 * choice replaced, a value that an own rewrite on its way at the time of the
 * choice can have put back (`alsoStale`), or anything at all when the choice
 * did not know what was stored (`value` null). A replay of another value was
 * stored while pixdcon was away: a new command.
 *
 * A live value is never hidden by its value. Whether it is a new command or
 * older than an own write still on its way is a question of order on the
 * connection, answered in overlay/scene-layers.js.
 *
 * @param {{value: string|null, origin: OverlayRecord["origin"]}} stored
 * @param {SceneSuppression|null|undefined} suppression the suppression of the same layer
 * @returns {boolean}
 */
export function isSuperseded(stored, suppression) {
  if (!suppression || stored.value === null) return false;
  if (stored.origin !== "replay") return false;
  if (suppression.value === null) return true;
  return (
    stored.value === suppression.value ||
    (suppression.alsoStale ?? []).includes(stored.value)
  );
}

/**
 * The one output policy (types.js OutputDecision). Shadow wins as soon as one
 * reason for it exists; unknown ownership during the transition is such a
 * reason. Everything that acts outward asks the result of this function and
 * nothing else: no caller looks at config.json or at an environment variable
 * on its own.
 *
 * Every input is authoritative (core/ordering.js): the environment,
 * config.json, and v1's device list as received. The overlay layer is not
 * an input. A stored MQTT message can never put a device into drive, and
 * none can take it out of shadow by disappearing: `output` is not an
 * overlay key (state/runtime-config.js overlayDevicePatch).
 *
 * @param {object} inputs
 * @param {boolean} inputs.forceShadow PIXDCON2_FORCE_SHADOW=1
 * @param {OutputMode|null} inputs.deviceOutput `output` of the device entry in config.json; null for a device that exists only in the blob. Never a value from an overlay.
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
 * Who writes the blob overlay (overlay-service.js W1). The blob is one
 * document for all displays, and a rewrite publishes all of it: two
 * controllers that rewrite it lose each other's changes and take each
 * other's rewrite for a scene command. So one instance per base topic
 * writes it, the one that owns the controller topics there:
 *   mqtt_off       no MQTT in this run: nothing is written at all
 *   force_shadow   PIXDCON2_FORCE_SHADOW=1: this instance never writes (edge)
 *   v1_writes      the transition is on: pixdcon v1 publishes the controller
 *                  topics under the base topic and rewrites the blob itself
 * Otherwise this instance is the writer. Every input is fixed for the run
 * (the environment, and the namespace that is read once at start), so the
 * answer cannot change while the process lives: v1 is taken to be alive
 * for as long as the operator has not ended the transition, whatever its
 * device list says and whether or not it arrived.
 *
 * @param {object} inputs
 * @param {boolean} inputs.mqtt the gateway exists in this run
 * @param {boolean} inputs.forceShadow PIXDCON2_FORCE_SHADOW=1
 * @param {boolean} inputs.transition `mqtt.statusBaseTopic` differs from `mqtt.baseTopic`
 * @returns {import("../types.js").BlobWriter}
 */
export function resolveBlobWriter(inputs) {
  if (!inputs.mqtt) return { writer: false, reason: "mqtt_off" };
  if (inputs.forceShadow) return { writer: false, reason: "force_shadow" };
  if (inputs.transition) return { writer: false, reason: "v1_writes" };
  return { writer: true, reason: null };
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
