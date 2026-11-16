/**
 * Config schema: validation and normalisation of config.json.
 *
 * Reads every v1 config.json (matrix A-040 to A-057) and applies the fixes the
 * matrix asks for: duplicate device names are rejected (A-054, C-223), names
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
  mqtt: Object.freeze({
    baseTopic: "home/hsb1/pixdcon",
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
 * @param {{defaultOutput?: import("../types.js").OutputMode}} [options]
 * @returns {{config: Config, warnings: string[]}} normalised config; the input is not modified
 * @throws {import("../core/errors.js").ConfigError} with line and column for a JSON syntax error, with `path` for a structural error
 */
export function parseConfig(text, options) {
  return todo("schema.parseConfig", text, options);
}

/**
 * Validate an already parsed object (API writes, migration).
 *
 * @param {unknown} value
 * @param {{defaultOutput?: import("../types.js").OutputMode}} [options]
 * @returns {{config: Config, warnings: string[]}}
 * @throws {import("../core/errors.js").ConfigError}
 */
export function validateConfig(value, options) {
  return todo("schema.validateConfig", value, options);
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

/**
 * Which change needs what. The scheduler uses this to touch as little as possible.
 *  - "restart": the driver or the loop must be rebuilt (type, ip, output, enabled, minFrameMs, powerCyclePlugin, maxPowerCycles, cleanupLegacyApps)
 *  - "apply":   pushed into the running loop (scene, sceneSettings)
 *  - "view":    shown only, nothing running changes (displayName, comment, preview.showGrid)
 *  - "preview": the preview poller is re-armed (preview.pollMs)
 *
 * @param {string} key top-level key of a device entry
 * @returns {"restart"|"apply"|"view"|"preview"}
 */
export function changeImpact(key) {
  return todo("schema.changeImpact", key);
}
