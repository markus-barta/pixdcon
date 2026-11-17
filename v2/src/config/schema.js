/**
 * Config schema: validation and normalisation of config.json.
 *
 * Reads every v1 config.json (matrix A-040 to A-057), a blob overlay entry
 * (the same device rules, used by state/runtime-config.js to check a merged
 * entry), and applies the fixes the matrix asks for: duplicate device names are rejected (A-054, C-223), names
 * and addresses are trimmed and checked (A-051, A-187), `enabled` is a real
 * field (A-075), unknown keys are kept and reported (A-053), a device scene
 * that matches no registered scene is a warning, not an error (A-076).
 *
 * Pure functions, no I/O. Owner: core/state worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").Config} Config */
/** @typedef {import("../types.js").DeviceConfig} DeviceConfig */
/** @typedef {import("../types.js").ConfigDiff} ConfigDiff */

/** Device names and scene keys: safe in MQTT topics, URLs, file names and as object keys. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** v1 defaults that must not move (matrix A-023, A-049, B-027, C-109). */
export const DEFAULTS = Object.freeze({
  minFrameMs: 500,
  maxPowerCycles: 10,
  previewPollMs: 2000,
  previewPollMinMs: 1000,
  previewPollMaxMs: 10000,
  telemetryIntervalMs: 60000,
  /** The v1 wire names. `statusBaseTopic` defaults to `baseTopic` (no transition). */
  mqtt: Object.freeze({
    baseTopic: "home/hsb1/pixdcon",
    statusBaseTopic: "home/hsb1/pixdcon",
    settingsBaseTopic: "pixdcon",
    discoveryPrefix: "homeassistant",
    haDiscovery: true,
  }),
  health: Object.freeze({
    staleAfterMs: 30000,
    offlineAfterMs: 120000,
    probeIntervalMs: 10000,
  }),
});

/**
 * Parse and validate the text of a config.json.
 *
 * @param {string} text
 * @returns {{config: Config, warnings: string[]}} normalised config; the input is not modified
 * @throws {import("../core/errors.js").ConfigError} with line and column for a JSON syntax error, with `path` for a structural error
 */
export function parseConfig(text) {
  return todo("schema.parseConfig", text);
}

/**
 * Validate an already parsed object (API writes, migration).
 *
 * @param {unknown} value
 * @returns {{config: Config, warnings: string[]}}
 * @throws {import("../core/errors.js").ConfigError}
 */
export function validateConfig(value) {
  return todo("schema.validateConfig", value);
}

/**
 * Validate and normalise one device entry: an entry of config.json, or such
 * an entry with a blob overlay entry merged over it (state/runtime-config.js
 * uses it so that an overlay cannot put an unusable device into the running
 * config, A-BUG-06).
 *
 * @param {unknown} raw
 * @returns {DeviceConfig}
 * @throws {import("../core/errors.js").ConfigError} with `path`
 */
export function validateDevice(raw) {
  return todo("schema.validateDevice", raw);
}

/**
 * Text to write to disk: the raw object as the user wrote it plus the change,
 * pretty-printed with two spaces and a trailing newline (A-155). Normalised
 * defaults are not written out; unknown keys survive.
 *
 * @param {Record<string, unknown>} raw
 * @returns {string}
 */
export function serializeConfig(raw) {
  return todo("schema.serializeConfig", raw);
}

/**
 * What changed between two valid configs, per device.
 *
 * @param {Config} previous
 * @param {Config} next
 * @returns {ConfigDiff}
 */
export function diffConfig(previous, next) {
  return todo("schema.diffConfig", previous, next);
}

/** @type {ReadonlyMap<string, "restart"|"apply"|"view"|"preview">} */
const CHANGE_IMPACT = new Map(
  /** @type {Array<[string, "restart"|"apply"|"view"|"preview"]>} */ ([
    ["type", "restart"],
    ["address", "restart"],
    ["output", "restart"],
    ["enabled", "restart"],
    ["held", "restart"],
    ["minFrameMs", "restart"],
    ["maxPowerCycles", "restart"],
    ["powerCyclePlugin", "restart"],
    ["cleanupLegacyApps", "restart"],
    ["sceneSettings", "apply"],
    ["displayName", "view"],
    ["comment", "view"],
    ["origin", "view"],
    ["blobKeys", "view"],
    ["addressSource", "view"],
    ["enabledSource", "view"],
    ["savedScene", "view"],
    ["preview.showGrid", "view"],
    ["preview.pollMs", "preview"],
  ]),
);

/**
 * Which change needs what. The scheduler uses this on the diff of the
 * effective config (types.js EffectiveDiff), so a key that a blob entry
 * patches counts like one changed in config.json. It gets the function
 * through `Factories.changeImpact` (main.js), not by importing this file.
 *  - "restart": the driver or the loop must be rebuilt (type, address, output, enabled, held, minFrameMs, powerCyclePlugin, maxPowerCycles, cleanupLegacyApps). `held` goes with `enabled`: a device whose address rests on an overlay that is not confirmed is listed and not started
 *  - "apply":   pushed into the running loop (sceneSettings; the scene itself arrives through the state store's "desired" event)
 *  - "view":    shown only, nothing running changes by the key itself (displayName, comment, preview.showGrid, origin, blobKeys, addressSource, enabledSource, and savedScene: the state store turns a new saved choice into a "desired" event when it changes what shows)
 *  - "preview": the preview poller is re-armed (preview.pollMs)
 * An unknown key answers "restart": the safe side.
 *
 * @param {string} key key of an EffectiveDevice, "preview.pollMs" and "preview.showGrid" for the two preview options
 * @returns {"restart"|"apply"|"view"|"preview"}
 */
export function changeImpact(key) {
  return CHANGE_IMPACT.get(key) ?? "restart";
}
