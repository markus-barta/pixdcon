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

import { isDeepStrictEqual } from "node:util";
import { ConfigError } from "../core/errors.js";
import { object } from "../core/values.js";

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
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const offset = Number(/position (\d+)/.exec(message)?.[1] ?? text.length);
    const before = text.slice(0, offset).split("\n");
    throw new ConfigError(message, {
      line: before.length,
      column: (before.at(-1)?.length ?? 0) + 1,
      cause,
    });
  }
  return validateConfig(value);
}

/**
 * Validate an already parsed object (API writes, migration).
 *
 * @param {unknown} value
 * @returns {{config: Config, warnings: string[]}}
 * @throws {import("../core/errors.js").ConfigError}
 */
export function validateConfig(value) {
  if (!object(value)) invalid("config", "expected an object");
  if (!Array.isArray(value.devices)) invalid("devices", "expected an array");
  if (!object(value.scenes)) invalid("scenes", "expected an object");
  const devices = value.devices.map((raw, index) => {
    try {
      return validateDevice(raw);
    } catch (error) {
      if (error instanceof ConfigError)
        error.path = `devices[${index}].${error.path}`;
      throw error;
    }
  });
  const names = new Set();
  for (const device of devices) {
    if (names.has(device.name))
      invalid("devices", `duplicate device name: ${device.name}`);
    names.add(device.name);
  }
  const scenes = Object.fromEntries(
    Object.entries(value.scenes).map(([key, entry]) => {
      name(key, `scenes.${key}`);
      if (
        !object(entry) ||
        typeof entry.path !== "string" ||
        !entry.path.trim()
      )
        invalid(`scenes.${key}.path`, "expected a non-empty path");
      return [key, { ...entry, path: entry.path.trim() }];
    }),
  );
  const mqtt = value.mqtt ?? {};
  if (!object(mqtt)) invalid("mqtt", "expected an object");
  const baseTopic = topic(
    mqtt.baseTopic ?? DEFAULTS.mqtt.baseTopic,
    "mqtt.baseTopic",
  );
  const health = value.health ?? {};
  if (!object(health)) invalid("health", "expected an object");
  const output = value.output ?? {};
  if (!object(output)) invalid("output", "expected an object");
  /** @type {Config} */
  const config = {
    ...structuredClone(value),
    devices,
    scenes,
    telemetryIntervalMs: positive(
      value.telemetryIntervalMs,
      DEFAULTS.telemetryIntervalMs,
      "telemetryIntervalMs",
    ),
    mqtt: {
      ...mqtt,
      baseTopic,
      statusBaseTopic: topic(
        mqtt.statusBaseTopic ?? baseTopic,
        "mqtt.statusBaseTopic",
      ),
      settingsBaseTopic: topic(
        mqtt.settingsBaseTopic ?? DEFAULTS.mqtt.settingsBaseTopic,
        "mqtt.settingsBaseTopic",
      ),
      discoveryPrefix: topic(
        mqtt.discoveryPrefix ?? DEFAULTS.mqtt.discoveryPrefix,
        "mqtt.discoveryPrefix",
      ),
      haDiscovery: boolean(mqtt.haDiscovery, true, "mqtt.haDiscovery"),
    },
    health: {
      ...health,
      staleAfterMs: positive(
        health.staleAfterMs,
        DEFAULTS.health.staleAfterMs,
        "health.staleAfterMs",
      ),
      offlineAfterMs: positive(
        health.offlineAfterMs,
        DEFAULTS.health.offlineAfterMs,
        "health.offlineAfterMs",
      ),
      probeIntervalMs: positive(
        health.probeIntervalMs,
        DEFAULTS.health.probeIntervalMs,
        "health.probeIntervalMs",
      ),
    },
    output: {
      ...output,
      default: outputMode(output.default, "output.default"),
    },
  };
  if (config.health.offlineAfterMs < config.health.staleAfterMs)
    invalid("health.offlineAfterMs", "must be at least staleAfterMs");
  const warnings = unknownKeys(
    value,
    ["devices", "scenes", "telemetryIntervalMs", "mqtt", "health", "output"],
    "config",
  );
  for (let index = 0; index < devices.length; index++) {
    const device = devices[index];
    warnings.push(
      ...unknownKeys(value.devices[index], DEVICE_KEYS, `devices[${index}]`),
    );
    if (
      device.scene &&
      !device.scene.startsWith("builtin:") &&
      !Object.hasOwn(scenes, device.scene)
    )
      warnings.push(`devices[${index}].scene: unknown scene ${device.scene}`);
  }
  return { config, warnings };
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
  if (!object(raw)) invalid("device", "expected an object");
  const deviceName = name(raw.name, "name");
  if (raw.type !== "pixoo" && raw.type !== "ulanzi")
    invalid("type", "expected pixoo or ulanzi");
  const ip = address(raw.ip);
  const scene =
    raw.scene ?? (Array.isArray(raw.scenes) ? raw.scenes[0] : null) ?? null;
  if (scene !== null && typeof scene !== "string")
    invalid("scene", "expected a scene key or null");
  if (scene && !scene.startsWith("builtin:")) name(scene, "scene");
  const preview = object(raw.preview) ? raw.preview : {};
  if (raw.sceneSettings != null && !object(raw.sceneSettings))
    invalid("sceneSettings", "expected an object");
  for (const [key, settings] of Object.entries(raw.sceneSettings ?? {})) {
    if (!object(settings))
      invalid(`sceneSettings.${key}`, "expected an object");
  }
  const poll = Number.parseInt(
    String(preview.pollMs ?? DEFAULTS.previewPollMs),
    10,
  );
  let powerCyclePlugin = null;
  if (raw.powerCyclePlugin != null) {
    if (!object(raw.powerCyclePlugin))
      invalid("powerCyclePlugin", "expected an object");
    const plugin = raw.powerCyclePlugin;
    powerCyclePlugin = {
      ...plugin,
      topic: topic(plugin.topic, "powerCyclePlugin.topic"),
      offPayload: String(plugin.offPayload ?? '{"state":"OFF"}'),
      onPayload: String(plugin.onPayload ?? '{"state":"ON"}'),
      offWaitMs: positive(
        plugin.offWaitMs,
        10000,
        "powerCyclePlugin.offWaitMs",
      ),
      onWaitMs: positive(plugin.onWaitMs, 30000, "powerCyclePlugin.onWaitMs"),
    };
  }
  /** @type {DeviceConfig["supersedes"]} */
  const supersedes = {};
  if (raw.supersedes != null && !object(raw.supersedes))
    invalid("supersedes", "expected an object");
  for (const layer of /** @type {const} */ (["granular", "blob"])) {
    const suppression = raw.supersedes?.[layer];
    if (suppression === undefined) continue;
    if (
      !object(suppression) ||
      !Number.isSafeInteger(suppression.generation) ||
      suppression.generation < 1 ||
      typeof suppression.at !== "string" ||
      !Number.isFinite(Date.parse(suppression.at)) ||
      (suppression.value !== null && typeof suppression.value !== "string") ||
      !Array.isArray(suppression.alsoStale) ||
      suppression.alsoStale.some((v) => typeof v !== "string") ||
      !["drive", "shadow"].includes(suppression.output)
    )
      invalid(`supersedes.${layer}`, "invalid suppression");
    supersedes[layer] = /** @type {import("../types.js").SceneSuppression} */ (
      structuredClone(suppression)
    );
  }
  return {
    ...structuredClone(raw),
    name: deviceName,
    type: raw.type,
    ip,
    scene: scene?.trim() || null,
    displayName:
      typeof raw.displayName === "string" ? raw.displayName.trim() : "",
    comment: typeof raw.comment === "string" ? raw.comment.trim() : "",
    preview: {
      showGrid: Boolean(preview.showGrid),
      pollMs: Number.isFinite(poll)
        ? Math.max(1000, Math.min(10000, poll))
        : 2000,
    },
    sceneSettings: structuredClone(raw.sceneSettings ?? {}),
    minFrameMs: positive(raw.minFrameMs, DEFAULTS.minFrameMs, "minFrameMs"),
    maxPowerCycles: positive(
      raw.maxPowerCycles,
      DEFAULTS.maxPowerCycles,
      "maxPowerCycles",
      true,
    ),
    powerCyclePlugin,
    cleanupLegacyApps: boolean(
      raw.cleanupLegacyApps,
      false,
      "cleanupLegacyApps",
    ),
    enabled: boolean(raw.enabled, true, "enabled"),
    output: outputMode(raw.output, "output"),
    supersedes,
  };
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
  return `${JSON.stringify(raw, null, 2)}\n`;
}

/**
 * What changed between two valid configs, per device.
 *
 * @param {Config} previous
 * @param {Config} next
 * @returns {ConfigDiff}
 */
export function diffConfig(previous, next) {
  const before = new Map(previous.devices.map((d) => [d.name, d]));
  const after = new Map(next.devices.map((d) => [d.name, d]));
  return {
    devicesAdded: [...after.keys()].filter((key) => !before.has(key)),
    devicesRemoved: [...before.keys()].filter((key) => !after.has(key)),
    devicesChanged: Object.fromEntries(
      [...after].flatMap(([key, device]) => {
        const old = before.get(key);
        if (!old) return [];
        const keys = [
          ...new Set([...Object.keys(old), ...Object.keys(device)]),
        ].filter(
          (field) =>
            !isDeepStrictEqual(
              /** @type {any} */ (old)[field],
              /** @type {any} */ (device)[field],
            ),
        );
        return keys.length ? [[key, keys]] : [];
      }),
    ),
    scenesAdded: Object.keys(next.scenes).filter(
      (key) => !Object.hasOwn(previous.scenes, key),
    ),
    scenesRemoved: Object.keys(previous.scenes).filter(
      (key) => !Object.hasOwn(next.scenes, key),
    ),
    scenesChanged: Object.keys(next.scenes).filter(
      (key) =>
        Object.hasOwn(previous.scenes, key) &&
        !isDeepStrictEqual(previous.scenes[key], next.scenes[key]),
    ),
    globalChanged: [
      ...new Set([...Object.keys(previous), ...Object.keys(next)]),
    ].filter(
      (key) =>
        !["devices", "scenes"].includes(key) &&
        !isDeepStrictEqual(
          /** @type {any} */ (previous)[key],
          /** @type {any} */ (next)[key],
        ),
    ),
  };
}

/** @param {string} path @param {string} message @returns {never} */
function invalid(path, message) {
  throw new ConfigError(`${path}: ${message}`, { path });
}
/** @param {unknown} raw @param {string} path @returns {string} */
function name(raw, path) {
  if (typeof raw !== "string" || !NAME_PATTERN.test(raw.trim()))
    invalid(path, "invalid name");
  return raw.trim();
}
/** @param {unknown} raw @param {string} path @returns {string} */
function topic(raw, path) {
  if (typeof raw !== "string" || !raw.trim() || /[+#\0\r\n]/.test(raw))
    invalid(path, "invalid MQTT topic");
  return raw.trim().replace(/^\/+|\/+$/g, "");
}
/** Validate a host[:port], without accepting a URL or path. @param {unknown} raw @returns {string} */
export function address(raw) {
  if (typeof raw !== "string" || !raw.trim() || /[\s/@?#\0]/.test(raw.trim()))
    invalid("ip", "expected host or host:port");
  const host = raw.trim();
  if (
    !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(
      host,
    )
  )
    invalid("ip", "expected host or host:port");
  const port = /:(\d+)$/.exec(host);
  if (port && (+port[1] < 1 || +port[1] > 65535)) invalid("ip", "invalid port");
  return host;
}
/** @param {unknown} raw @param {number} fallback @param {string} path @param {boolean} [zero] @returns {number} */
function positive(raw, fallback, path, zero = false) {
  if (raw === undefined) return fallback;
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < (zero ? 0 : 1)
  )
    invalid(path, "expected a positive integer");
  return raw;
}
/** @param {unknown} raw @param {boolean} fallback @param {string} path @returns {boolean} */
function boolean(raw, fallback, path) {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") invalid(path, "expected boolean");
  return raw;
}
/** @param {unknown} raw @param {string} path @returns {import("../types.js").OutputMode|null} */
function outputMode(raw, path) {
  if (raw == null) return null;
  if (raw !== "drive" && raw !== "shadow")
    invalid(path, "expected drive or shadow");
  return raw;
}
const DEVICE_KEYS = [
  "name",
  "type",
  "ip",
  "scene",
  "scenes",
  "displayName",
  "comment",
  "preview",
  "sceneSettings",
  "minFrameMs",
  "maxPowerCycles",
  "powerCyclePlugin",
  "cleanupLegacyApps",
  "enabled",
  "output",
  "supersedes",
];
/** @param {Record<string, unknown>} raw @param {string[]} known @param {string} path @returns {string[]} */
function unknownKeys(raw, known, path) {
  return Object.keys(raw)
    .filter((key) => !known.includes(key))
    .map((key) => `${path}.${key}: unknown key (preserved)`);
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
