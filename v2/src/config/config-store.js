/**
 * Config store: the one saved state.
 *
 * config.json is the only thing pixdcon 2 saves. It is written atomically
 * (temporary file in the same directory, fsync, rename, fsync of the
 * directory), which is why v2 runs with a directory mount and not with v1's
 * single-file bind mount (matrix A-155, A-176, A-BUG-08). The previous version
 * is kept as config.json.bak.
 *
 * Rules:
 *  - Every write is one change to the latest file content, serialised with all
 *    other writes (A-154). The browser never posts a whole config back except
 *    through the raw editor.
 *  - A write of this process is applied in-process and is not treated as an
 *    outside edit (A-066); only a real outside edit triggers a reload.
 *  - An invalid file on disk never stops anything: the last valid config keeps
 *    running, also at process start (A-007, A-031, A-BUG-10), and the state
 *    says what is wrong and where.
 *  - Nothing from the overlay layer is ever written here ("Save never promotes
 *    overlays", C-220).
 *
 * Events (EventEmitter):
 *  - "changed"  ({config: Config, previous: Config, diff: ConfigDiff, origin: "api"|"file"|"startup"})
 *  - "file"     (ConfigFileState)   validity, load time or warnings changed
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").Config} Config */
/** @typedef {import("../types.js").DeviceConfig} DeviceConfig */
/** @typedef {import("../types.js").ConfigDiff} ConfigDiff */
/** @typedef {import("../types.js").ConfigFileState} ConfigFileState */

/**
 * @typedef {object} ConfigStoreOptions
 * @property {string} path absolute path of config.json (env PIXDCON_CONFIG_PATH, default /data/config.json)
 * @property {import("../types.js").Logger} logger
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").OutputMode} [defaultOutput] used when neither the device nor `output.default` says otherwise
 * @property {number} [debounceMs] outside edits are read this long after the last file event, default 500 (A-060)
 */

export class ConfigStore extends EventEmitter {
  /** @param {ConfigStoreOptions} options */
  constructor(options) {
    super();
    this.options = options;
  }

  /**
   * Read config.json. Never throws for a bad file: with no valid config at all
   * the store holds an empty config (no devices, no scenes) and `file().valid`
   * is false, so the UI comes up and the file can be repaired there.
   *
   * @returns {Promise<ConfigFileState>}
   */
  async load() {
    return todo("ConfigStore.load");
  }

  /** @returns {Config} the running config: the last valid one, frozen */
  get() {
    return todo("ConfigStore.get");
  }

  /** @returns {string} directory of config.json; scene paths resolve against it (A-055) */
  baseDir() {
    return todo("ConfigStore.baseDir");
  }

  /** @returns {ConfigFileState} */
  file() {
    return todo("ConfigStore.file");
  }

  /**
   * Text of config.json as it is on disk, for the raw editor.
   *
   * @returns {Promise<{text: string, state: ConfigFileState}>}
   */
  async readRaw() {
    return todo("ConfigStore.readRaw");
  }

  /**
   * Change one device entry. The mutator gets the raw entry of the latest file
   * content. Validates the result, writes atomically, applies it in-process and
   * emits "changed" with the diff.
   *
   * @param {string} deviceName
   * @param {(device: Record<string, unknown>) => void} mutate
   * @returns {Promise<{config: Config, diff: ConfigDiff}>}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_device, 409 config_invalid (file on disk unusable), 400 invalid_config (result would be invalid)
   */
  async updateDevice(deviceName, mutate) {
    return todo("ConfigStore.updateDevice", deviceName, mutate);
  }

  /**
   * Add a device without a scene (v1 POST /api/device, A-136).
   *
   * @param {{name: string, type: import("../types.js").DeviceType, ip: string}} device
   * @returns {Promise<{config: Config, diff: ConfigDiff}>}
   * @throws {import("../core/errors.js").HttpError} 400 invalid field, 409 duplicate name or config_invalid
   */
  async addDevice(device) {
    return todo("ConfigStore.addDevice", device);
  }

  /**
   * Change the whole raw object (scene registry, global keys, scene copy).
   *
   * @param {(raw: Record<string, unknown>) => void} mutate
   * @returns {Promise<{config: Config, diff: ConfigDiff}>}
   */
  async update(mutate) {
    return todo("ConfigStore.update", mutate);
  }

  /**
   * Replace the file with the given text (raw editor, v1 POST /api/config/file).
   *
   * @param {string} text
   * @returns {Promise<{config: Config, diff: ConfigDiff}>}
   * @throws {import("../core/errors.js").ConfigError} with line and column; nothing is written
   */
  async replaceRaw(text) {
    return todo("ConfigStore.replaceRaw", text);
  }

  /**
   * Re-read the file now ("Reload from disk").
   *
   * @returns {Promise<ConfigFileState>}
   */
  async reload() {
    return todo("ConfigStore.reload");
  }

  /**
   * Watch the directory for outside edits (scp, editor, deploy script). Falls
   * back to polling when the native watch fails (A-059, A-063, A-064).
   *
   * @returns {Promise<void>}
   */
  async start() {
    return todo("ConfigStore.start");
  }

  /** Stop watching, finish a write in flight. Safe to call twice (A-065). */
  async stop() {
    return todo("ConfigStore.stop");
  }
}
