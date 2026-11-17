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
 *    overlays", C-220). The one exception is explicit and narrow:
 *    adoptDevice() writes name, type and address of a device that exists only
 *    in the blob overlay, when the user asks for exactly that (A-151).
 *  - The store holds the saved state only. What runs is the effective config
 *    (state/runtime-config.js); the output a device really has is decided
 *    there. `output` here is what the file asks for, or null.
 *  - The `mqtt` block is read once, right after the first load() and before
 *    the topics, the last will and the gateway are built (main.js). A later
 *    change of it is saved and reported in the diff (`globalChanged` has
 *    "mqtt"), and applies after a restart; main.js then sets
 *    `ControllerStatus.restartRequired`.
 *
 * Order (core/ordering.js). The saved state has a revision: `file().rev`
 * rises with every content the store applies, whoever wrote it.
 *  - Writes are one lane: each is made on the content the previous one left.
 *  - A file event is a hint that the file may have changed, nothing more.
 *    The store reads the file 500 ms after the last event and decides on
 *    what it read: content with the hash of its own last write is dropped
 *    (own write, A-066); a read that began before a write of this process
 *    finished is dropped and repeated, so an older content can never be
 *    applied over a newer one; anything else is an outside edit and is
 *    applied as a diff, with the next revision.
 *  - The polling fallback and the debounce are timers: they decide when the
 *    file is read, never what is in it.
 *
 * Events (EventEmitter):
 *  - "changed"  ({config: Config, previous: Config, diff: ConfigDiff, origin: "api"|"file"|"startup", rev: number})
 *  - "file"     (ConfigFileState)   validity, load time or warnings changed
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { open, readFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ConfigError, HttpError } from "../core/errors.js";
import { decideStamp } from "../core/ordering.js";
import { freeze } from "../core/values.js";
import { diffConfig, parseConfig, serializeConfig, validateConfig, validateDevice } from "./schema.js";

/** @typedef {import("../types.js").Config} Config */
/** @typedef {import("../types.js").DeviceConfig} DeviceConfig */
/** @typedef {import("../types.js").ConfigDiff} ConfigDiff */
/** @typedef {import("../types.js").ConfigFileState} ConfigFileState */

/**
 * @typedef {object} ConfigStoreOptions
 * @property {string} path absolute path of config.json (env PIXDCON_CONFIG_PATH, default /data/config.json)
 * @property {import("../types.js").Logger} logger
 * @property {import("../types.js").Clock} clock
 * @property {number} [debounceMs] outside edits are read this long after the last file event, default 500 (A-060)
 */

export class ConfigStore extends EventEmitter {
  /** @param {ConfigStoreOptions} options */
  constructor(options) {
    super();
    this.options = options;
    this.current = freeze(validateConfig({ devices: [], scenes: {} }).config);
    /** @type {ConfigFileState} */
    this.fileState = { path: options.path, rev: 0, valid: false, error: null, loadedAt: null, invalidSince: null, warnings: [] };
    this.text = "";
    this.ownHash = "";
    this.appliedHash = "";
    this.tail = Promise.resolve();
    this.stopped = false;
    this.watching = false;
    this.life = 0;
    /** @type {import("node:fs").FSWatcher|null} */
    this.watcher = null;
    /** @type {{cancel: () => void}|null} */
    this.poll = null;
    /** @type {AbortController|null} */
    this.debounce = null;
  }

  /**
   * Read config.json. Never throws for a bad file: with no valid config at all
   * the store holds an empty config (no devices, no scenes) and `file().valid`
   * is false, so the UI comes up and the file can be repaired there.
   *
   * @returns {Promise<ConfigFileState>}
   */
  async load() {
    return this.enqueue(() => this.read("startup"));
  }

  /** @returns {Config} the running config: the last valid one, frozen */
  get() {
    return this.current;
  }

  /** @returns {string} directory of config.json; scene paths resolve against it (A-055) */
  baseDir() {
    return dirname(this.options.path);
  }

  /** @returns {ConfigFileState} */
  file() {
    return freeze(structuredClone(this.fileState));
  }

  /**
   * Text of config.json as it is on disk, for the raw editor.
   *
   * @returns {Promise<{text: string, state: ConfigFileState}>}
   */
  async readRaw() {
    return this.enqueue(async () => {
      await this.read("file");
      return { text: this.text, state: this.file() };
    });
  }

  /**
   * Change one device entry. The mutator gets the raw entry of the latest file
   * content. Validates the result, writes atomically, applies it in-process and
   * emits "changed" with the diff.
   *
   * @param {string} deviceName
   * @param {(device: Record<string, unknown>) => void} mutate
   * @returns {Promise<{config: Config, diff: ConfigDiff}>}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_device (also for a device that exists only in the blob overlay), 409 config_invalid (file on disk unusable), 400 invalid_config (result would be invalid)
   */
  async updateDevice(deviceName, mutate) {
    return this.update((raw) => {
      const devices = /** @type {Record<string, unknown>[]} */ (raw.devices);
      const device = devices.find((item) => item.name === deviceName);
      if (!device) throw new HttpError(404, "unknown_device", `Unknown device: ${deviceName}`);
      mutate(device);
    });
  }

  /**
   * Add a device without a scene (v1 POST /api/device, A-136).
   *
   * @param {{name: string, type: import("../types.js").DeviceType, ip: string}} device
   * @returns {Promise<{config: Config, diff: ConfigDiff}>}
   * @throws {import("../core/errors.js").HttpError} 400 invalid field, 409 duplicate name or config_invalid
   */
  async addDevice(device) {
    return this.adoptDevice(device);
  }

  /**
   * Adopt a device that so far exists only in the blob overlay (A-151): add
   * an entry with exactly name, type and ip, plus the scene choice and its
   * suppressions when the state store passes them, in one atomic write. This
   * is the only write that takes a value from the overlay layer, and it
   * happens only on the explicit adoption.
   *
   * @param {{name: string, type: import("../types.js").DeviceType, ip: string}} identity as the device runs
   * @param {{scene?: string|null, supersedes?: DeviceConfig["supersedes"]}} [choice]
   * @returns {Promise<{config: Config, diff: ConfigDiff}>}
   * @throws {import("../core/errors.js").HttpError} 400 invalid field, 409 duplicate name or config_invalid
   */
  async adoptDevice(identity, choice) {
    const device = validateDevice(identity);
    return this.update((raw) => {
      const devices = /** @type {Record<string, unknown>[]} */ (raw.devices);
      if (devices.some((item) => item.name === device.name)) throw new HttpError(409, "duplicate_name", `Device already exists: ${device.name}`);
      devices.push({ name: device.name, type: device.type, ip: device.ip, ...structuredClone(choice ?? {}) });
    });
  }

  /**
   * Change the whole raw object (scene registry, global keys, scene copy).
   *
   * @param {(raw: Record<string, unknown>) => void} mutate
   * @returns {Promise<{config: Config, diff: ConfigDiff}>}
   */
  async update(mutate) {
    return this.enqueue(async () => {
      // Reads and writes share the lane: a read begun before a write can
      // never finish over that write. Re-read here for an outside edit that
      // has not yet produced a watch event.
      await this.read("file");
      if (!this.fileState.valid) throw new HttpError(409, "config_invalid", "Repair config.json before saving");
      const raw = /** @type {Record<string, unknown>} */ (JSON.parse(this.text));
      mutate(raw);
      try { validateConfig(raw); }
      catch (error) {
        if (error instanceof ConfigError) throw new HttpError(400, "invalid_config", error.message, { path: error.path });
        throw error;
      }
      return this.write(serializeConfig(raw));
    });
  }

  /**
   * Replace the file with the given text (raw editor, v1 POST /api/config/file).
   *
   * @param {string} text
   * @returns {Promise<{config: Config, diff: ConfigDiff}>}
   * @throws {import("../core/errors.js").ConfigError} with line and column; nothing is written
   */
  async replaceRaw(text) {
    parseConfig(text);
    return this.enqueue(async () => {
      await this.read("file");
      return this.write(serializeConfig(JSON.parse(text)));
    });
  }

  /**
   * Re-read the file now ("Reload from disk").
   *
   * @returns {Promise<ConfigFileState>}
   */
  async reload() {
    return this.enqueue(() => this.read("file"));
  }

  /**
   * Watch the directory for outside edits (scp, editor, deploy script). Falls
   * back to polling when the native watch fails (A-059, A-063, A-064).
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.watching || this.stopped) return;
    this.watching = true;
    const life = ++this.life;
    const current = () => decideStamp({ source: this.life }, { source: life }).action === "apply" && !this.stopped;
    const hint = () => {
      if (!current()) return;
      this.debounce?.abort();
      const mine = this.debounce = new AbortController();
      void this.options.clock.sleep(this.options.debounceMs ?? 500, mine.signal).then(async (elapsed) => {
        if (!current() || !elapsed || mine.signal.aborted) return;
        await this.reload();
      }).catch((error) => this.options.logger.error("[Config] Reload failed", error));
    };
    try {
      this.watcher = watch(this.baseDir(), (_event, file) => {
        if (!current()) return;
        if (file === null || String(file) === basename(this.options.path)) hint();
      });
      this.watcher.on("error", (error) => {
        if (!current()) return;
        this.options.logger.warn(`[Config] Watch failed; polling: ${error.message}`);
        this.watcher?.close();
        this.watcher = null;
      });
      this.watcher.unref();
    } catch (error) {
      this.options.logger.warn(`[Config] Watch unavailable; polling: ${String(error)}`);
    }
    // Polling also catches an inode replacement or a lost native event.
    this.poll = this.options.clock.every(() => {
      if (!current()) return;
      void this.reload().catch((error) => this.options.logger.error("[Config] Poll failed", error));
    }, 1000);
  }

  /** Stop watching, finish a write in flight. Safe to call twice (A-065). */
  async stop() {
    this.stopped = true;
    this.life += 1;
    this.debounce?.abort();
    this.poll?.cancel();
    this.watcher?.close();
    this.watcher = null;
    await this.tail;
  }

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  enqueue(work) {
    const result = this.tail.then(() => {
      if (this.stopped) throw new HttpError(503, "stopping", "Config store is stopped");
      return work();
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  /** @param {"startup"|"file"} origin @returns {Promise<ConfigFileState>} */
  async read(origin) {
    try {
      const text = await readFile(this.options.path, "utf8");
      if (this.stopped) return this.file();
      this.text = text;
      const hash = digest(text);
      if (hash === this.appliedHash && this.fileState.valid) return this.file();
      const { config, warnings } = parseConfig(text);
      this.accept(text, config, warnings, origin);
    } catch (error) {
      if (this.stopped) return this.file();
      const message = error instanceof Error ? error.message : String(error);
      this.fileState = { ...this.fileState, valid: false,
        invalidSince: this.fileState.invalidSince ?? new Date(this.options.clock.now()).toISOString(),
        error: { message, line: error instanceof ConfigError ? error.line : null, column: error instanceof ConfigError ? error.column : null } };
      this.emit("file", this.file());
    }
    return this.file();
  }

  /** @param {string} text @param {Config} config @param {string[]} warnings @param {"startup"|"file"|"api"} origin */
  accept(text, config, warnings, origin) {
    const previous = this.current;
    const changed = digest(text) !== this.appliedHash;
    this.text = text;
    this.appliedHash = digest(text);
    this.current = freeze(config);
    this.fileState = { ...this.fileState, valid: true, error: null, invalidSince: null, warnings,
      rev: this.fileState.rev + (changed ? 1 : 0), loadedAt: new Date(this.options.clock.now()).toISOString() };
    if (changed) this.emit("changed", { config: this.current, previous, diff: diffConfig(previous, config), origin, rev: this.fileState.rev });
    this.emit("file", this.file());
  }

  /** @param {string} text @returns {Promise<{config: Config, diff: ConfigDiff}>} */
  async write(text) {
    const { config, warnings } = parseConfig(text);
    const previous = this.current;
    const unique = randomBytes(6).toString("hex");
    const temp = join(this.baseDir(), `.${basename(this.options.path)}.${unique}.tmp`);
    if (this.text) {
      const backup = await open(`${temp}.bak`, "wx", 0o600);
      try { await backup.writeFile(this.text); await backup.sync(); }
      finally { await backup.close(); }
      await rename(`${temp}.bak`, `${this.options.path}.bak`);
    }
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, this.options.path);
    const dir = await open(this.baseDir(), "r");
    try { await dir.sync(); } finally { await dir.close(); }
    this.ownHash = digest(text);
    // An admitted write finishes before stop returns. It is applied here,
    // never again by the file watcher (appliedHash is the own-write fence).
    this.accept(text, config, warnings, "api");
    return { config: this.current, diff: diffConfig(previous, config) };
  }
}

/** @param {string} text @returns {string} */
function digest(text) { return createHash("sha256").update(text).digest("hex"); }
