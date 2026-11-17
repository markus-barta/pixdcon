/**
 * v1 → v2 config migration.
 *
 * v2 reads a v1 config.json as it is (read-side translation in schema.js).
 * This module is the one-time write for a switch-over: it produces the v2
 * config.json from a copy of the live v1 file and reports every change it
 * made, so the operator can diff before and after.
 *
 * What it does:
 *  - legacy `scenes` array → `scene` (first element, A-046; a longer array is reported)
 *  - trims names and addresses, reports duplicate device names instead of guessing
 *  - `enabled: "false"` (string) → false
 *  - adds `output` per device ("shadow" unless told otherwise) and the `mqtt` block
 *    with the v1 overlay/control/settings names; controller status defaults to
 *    home/hsb1/pixdcon2 for the documented transition beside v1
 *  - refuses a shared controller status namespace in shadow unless explicitly
 *    acknowledged with --status-base-topic
 *  - keeps unknown keys
 * What it never does: read or write the live v1 file in place, touch MQTT,
 * invent devices or scenes.
 *
 * CLI: node src/config/migrate-v1.js <v1-copy.json> <v2-data-dir>
 *      [--output drive|shadow] [--status-base-topic home/hsb1/pixdcon2]
 * Container deployment: run this CLI inside the runtime image so links point
 * to /app/lib and /app/assets rather than the host checkout.
 * Writes a NEW config.json only (never overwrites), creates shared-data links
 * first, and prints a JSON change report. The input file is never changed.
 *
 * Owner: fixtures + edge lane worker.
 */

import {
  open,
  mkdir,
  realpath,
  readFile,
  lstat,
  link,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "../core/errors.js";
import { ensureDataLinks } from "../scenes/v1-shared.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** @param {string} path @param {string} message @returns {never} */
function invalid(path, message) {
  throw new ConfigError(`${path}: ${message}`, { path });
}

/**
 * @param {string} v1Text content of a v1 config.json
 * @param {{output?: import("../types.js").OutputMode, statusBaseTopic?: string}} [options]
 * @returns {{text: string, changes: string[], warnings: string[]}} v2 file content and a human-readable change list
 * @throws {import("../core/errors.js").ConfigError} when the v1 file is not usable
 */
export function migrateV1Config(v1Text, options) {
  const requested = options?.output ?? "shadow";
  if (requested !== "drive" && requested !== "shadow")
    invalid("output", "expected drive or shadow");
  let raw;
  try {
    raw = JSON.parse(v1Text);
  } catch (error) {
    throw new ConfigError("Invalid config JSON", { cause: error });
  }
  if (!object(raw)) invalid("config", "expected an object");
  if (!Array.isArray(raw.devices)) invalid("devices", "expected an array");
  if (!object(raw.scenes)) invalid("scenes", "expected a scene map");
  const scenes = raw.scenes;
  const changes = [],
    warnings = [];
  const names = new Set();
  for (const [key, entry] of Object.entries(raw.scenes)) {
    if (!NAME.test(key)) invalid(`scenes.${key}`, "invalid scene key");
    if (!object(entry) || typeof entry.path !== "string" || !entry.path.trim())
      invalid(`scenes.${key}.path`, "expected a non-empty path");
  }
  raw.devices = raw.devices.map((entry, index) => {
    const at = `devices[${index}]`;
    if (!object(entry)) invalid(at, "expected an object");
    if (typeof entry.name !== "string" || !NAME.test(entry.name.trim()))
      invalid(`${at}.name`, "invalid device name");
    const name = entry.name.trim();
    if (names.has(name))
      invalid(`${at}.name`, `duplicate device name ${name}; no output written`);
    names.add(name);
    if (entry.name !== name) {
      entry.name = name;
      changes.push(`${at}.name: trimmed`);
    }
    if (entry.type !== "pixoo" && entry.type !== "ulanzi")
      invalid(`${at}.type`, "expected pixoo or ulanzi");
    if (
      typeof entry.ip !== "string" ||
      !entry.ip.trim() ||
      /[\s/#?]/.test(entry.ip.trim())
    )
      invalid(`${at}.ip`, "expected a host or host:port");
    if (entry.ip !== entry.ip.trim()) {
      entry.ip = entry.ip.trim();
      changes.push(`${at}.ip: trimmed`);
    }
    if (entry.scenes !== undefined) {
      if (!Array.isArray(entry.scenes))
        invalid(`${at}.scenes`, "expected a legacy scene array");
      if (!entry.scene) entry.scene = entry.scenes[0] ?? null;
      if (entry.scenes.length > 1)
        warnings.push(
          `${name}: legacy scenes has ${entry.scenes.length} entries; ${entry.scene === entry.scenes[0] ? "only the first is used" : "the explicit scene choice is kept"}`,
        );
      delete entry.scenes;
      changes.push(`${name}: legacy scenes array replaced by scene`);
    }
    if (
      entry.scene !== undefined &&
      entry.scene !== null &&
      typeof entry.scene !== "string"
    )
      invalid(`${at}.scene`, "expected a string or null");
    if (
      typeof entry.scene === "string" &&
      entry.scene &&
      !entry.scene.startsWith("builtin:") &&
      !Object.hasOwn(scenes, entry.scene)
    )
      warnings.push(`${name}: chosen scene is not registered`);
    if (entry.enabled === "false" || entry.enabled === "true") {
      entry.enabled = entry.enabled === "true";
      changes.push(`${name}: enabled string converted to boolean`);
    } else if (
      entry.enabled !== undefined &&
      typeof entry.enabled !== "boolean"
    )
      invalid(`${at}.enabled`, "expected a boolean");
    if (entry.sceneSettings !== undefined && !object(entry.sceneSettings))
      invalid(`${at}.sceneSettings`, "expected an object");
    if (entry.output !== requested) {
      entry.output = requested;
      changes.push(`${name}: output set to ${requested}`);
    }
    return entry;
  });
  if (raw.mqtt !== undefined && !object(raw.mqtt))
    invalid("mqtt", "expected an object");
  const mqtt = { .../** @type {Record<string, unknown>} */ (raw.mqtt ?? {}) };
  /** @type {Record<string, unknown>} */
  const defaults = {
    baseTopic: "home/hsb1/pixdcon",
    statusBaseTopic: options?.statusBaseTopic ?? "home/hsb1/pixdcon2",
    settingsBaseTopic: "pixdcon",
    discoveryPrefix: "homeassistant",
    haDiscovery: true,
  };
  if (
    options?.statusBaseTopic !== undefined &&
    mqtt.statusBaseTopic !== options.statusBaseTopic
  ) {
    mqtt.statusBaseTopic = options.statusBaseTopic;
    changes.push("mqtt.statusBaseTopic: set explicitly");
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (mqtt[key] === undefined) {
      mqtt[key] = value;
      changes.push(`mqtt.${key}: added`);
    }
    if (key === "haDiscovery") {
      if (typeof mqtt[key] !== "boolean")
        invalid(`mqtt.${key}`, "expected a boolean");
    } else if (
      typeof mqtt[key] !== "string" ||
      !String(mqtt[key]).trim() ||
      /[+#]/.test(String(mqtt[key])) ||
      String(mqtt[key]).includes("\0")
    )
      invalid(`mqtt.${key}`, "expected a non-empty topic without wildcards");
  }
  raw.mqtt = mqtt;
  if (raw.output !== undefined && !object(raw.output))
    invalid("output", "expected an object");
  const output = /** @type {Record<string, unknown>} */ (raw.output ?? {});
  if (output.default !== requested) {
    output.default = requested;
    changes.push(`output.default: set to ${requested}`);
  }
  raw.output = output;
  if (mqtt.statusBaseTopic === mqtt.baseTopic) {
    if (requested === "shadow" && options?.statusBaseTopic === undefined)
      invalid(
        "mqtt.statusBaseTopic",
        "shadow controller status shares v1's base topic; provide --status-base-topic explicitly",
      );
    warnings.push(
      "Controller status shares v1's base topic; use a separate statusBaseTopic while v1 runs",
    );
  }
  return { text: `${JSON.stringify(raw, null, 2)}\n`, changes, warnings };
}

/** Standalone migration file contract; no broker or device module is constructed.
 * @param {string[]} args */
export async function migrateV1Cli(args) {
  const usage =
    "Usage: node src/config/migrate-v1.js <v1-copy.json> <v2-data-dir> [--output drive|shadow] [--status-base-topic TOPIC]";
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const [source, target, ...flags] = args;
  if (!source || !target || source.startsWith("--") || target.startsWith("--"))
    throw new Error(usage);
  /** @type {{output?: import("../types.js").OutputMode, statusBaseTopic?: string}} */
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i],
      value = flags[i + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    if (flag === "--output" && (value === "drive" || value === "shadow"))
      options.output = value;
    else if (flag === "--status-base-topic") options.statusBaseTopic = value;
    else throw new Error(usage);
  }
  const input = await realpath(resolve(source));
  const migrated = migrateV1Config(await readFile(input, "utf8"), options);
  const dataDir = resolve(target),
    output = join(dataDir, "config.json");
  if (input === output)
    throw new ConfigError("Input and output must be different files");
  await mkdir(dataDir, { recursive: true });
  try {
    await lstat(output);
    throw new ConfigError(
      "Output config.json already exists; refusing to overwrite",
    );
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT")
      throw error;
  }
  await ensureDataLinks(dataDir, {
    debug() {},
    info() {},
    warn() {},
    error() {},
  });
  const temporary = join(dataDir, `.migrate-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(migrated.text);
      await file.sync();
    } finally {
      await file.close();
    }
    // An atomic hard link exposes a complete file and cannot replace an existing
    // config or symlink, even when another process won the race after lstat.
    await link(temporary, output);
  } finally {
    await unlink(temporary);
  } // only the temporary file created above
  process.stdout.write(
    `${JSON.stringify({ input, output, changes: migrated.changes, warnings: migrated.warnings }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await migrateV1Cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
