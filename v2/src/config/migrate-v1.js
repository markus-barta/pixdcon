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
 *    with the v1 topic names, so nothing on the wire moves
 *  - keeps unknown keys
 * What it never does: read or write the live v1 file in place, touch MQTT,
 * invent devices or scenes.
 *
 * CLI (phase 3): node src/config/migrate-v1.js <v1 config.json> <v2 data dir> [--output drive|shadow]
 *
 * Owner: fixtures + edge lane worker.
 */

import { todo } from "../core/todo.js";

/**
 * @param {string} v1Text content of a v1 config.json
 * @param {{output?: import("../types.js").OutputMode, statusBaseTopic?: string}} [options]
 * @returns {{text: string, changes: string[], warnings: string[]}} v2 file content and a human-readable change list
 * @throws {import("../core/errors.js").ConfigError} when the v1 file is not usable
 */
export function migrateV1Config(v1Text, options) {
  return todo("migrateV1Config", v1Text, options);
}
