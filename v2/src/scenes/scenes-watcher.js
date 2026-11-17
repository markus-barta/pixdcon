/**
 * Scenes watcher: tells the runtime when a scene file changed.
 *
 * Kept from v1 (lib/scenes-watcher.js; matrix B-017 to B-021):
 *  - every directory that holds a registered scene is watched, not recursively
 *  - only names ending in .js count; events are debounced 500 ms per file
 *  - a directory that is missing or was replaced is tried again every 1000 ms,
 *    so a scene directory that appears later starts reloading without a restart
 *  - when the native watch fails, the directory's file stamps are polled on
 *    the same 1000 ms timer
 *
 * Fixed:
 *  - handling a change refreshes that file's stamp, so a re-watch does not
 *    report the same edit again (B-169, S-49)
 *  - asset folders a scene names in its resources (SceneMeta.resources,
 *    e.g. scenes/pixoo/home3-assets/) are watched too, and a change there
 *    reloads the scenes that use the folder (first half of B-017's fix).
 *
 * Not fixed, on purpose: a replaced picture still needs a process restart.
 * Decoded images are cached for the life of the process inside the shared
 * helper lib/pixoo-image.js, which the scenes import directly and v2 may not
 * edit (D-045, S-19). The reload above therefore re-runs init with the old
 * picture. This is v1's behaviour; the fix belongs to the helper and is
 * deferred until v1 is retired, together with D-049.
 *
 * Owner: fixtures + edge lane worker.
 */

import { watch, statSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export class ScenesWatcher {
  /**
   * @param {{dirs: () => string[], onChange: (file: string) => Promise<void>, logger: import("../types.js").Logger, debounceMs?: number, retryMs?: number}} deps
   * `dirs` is read again on every retry tick, so registry changes are followed
   */
  constructor(deps) {
    this.deps = deps;
    this.running = false;
    this.generation = 0;
    /** @type {Map<string, {ino: number, watcher: import("node:fs").FSWatcher|null}>} */
    this.watchers = new Map();
    /** @type {Map<string, string>} */
    this.stamps = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.debounce = new Map();
    /** @type {NodeJS.Timeout|null} */
    this.retry = null;
    this.dispatch = Promise.resolve();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.poll(true);
    this.retry = setInterval(() => this.poll(false), this.deps.retryMs ?? 1000);
    this.retry.unref();
  }

  /** Cancel pending reloads and release every handle. Safe to call twice. */
  stop() {
    this.running = false;
    this.generation++;
    if (this.retry) clearInterval(this.retry);
    this.retry = null;
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    for (const entry of this.watchers.values()) entry.watcher?.close();
    this.watchers.clear();
    this.stamps.clear();
  }

  /** The retry timer reads current directories and stamps, never scene state.
   * @param {boolean} baseline */
  poll(baseline) {
    if (!this.running) return;
    const dirs = new Set(this.deps.dirs().map(dir => resolve(dir)));
    for (const [dir, entry] of this.watchers) {
      if (dirs.has(dir)) continue;
      entry.watcher?.close();
      this.watchers.delete(dir);
    }
    for (const [file, timer] of this.debounce) {
      if (!dirs.has(dirname(file))) { clearTimeout(timer); this.debounce.delete(file); }
    }
    for (const file of this.stamps.keys()) if (!dirs.has(dirname(file))) this.stamps.delete(file);
    for (const dir of dirs) {
      const previous = this.watchers.get(dir);
      let ino = 0;
      try { ino = statSync(dir).ino; } catch {}
      if (previous && previous.ino !== ino) {
        previous.watcher?.close();
        this.watchers.delete(dir);
      }
      if (ino && !this.watchers.get(dir)?.watcher) this.watchDir(dir, ino);
      const now = new Map();
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !this.accepts(dir, entry.name)) continue;
          const file = join(dir, entry.name);
          const stamp = this.stamp(file);
          if (stamp) now.set(file, stamp);
        }
      } catch {}
      const files = new Set([...now.keys(), ...[...this.stamps.keys()].filter(file => dirname(file) === dir)]);
      for (const file of files) {
        const stamp = now.get(file);
        if (baseline) { if (stamp) this.stamps.set(file, stamp); }
        else if (this.stamps.get(file) !== stamp) this.schedule(file, false);
      }
    }
  }

  /** @param {string} dir @param {string} file */
  accepts(dir, file) { return basename(dir).endsWith("-assets") || file.endsWith(".js"); }

  /** @param {string} file @returns {string|undefined} */
  stamp(file) {
    try { const stat = statSync(file); return stat.isFile() ? `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : undefined; }
    catch { return undefined; }
  }

  /** @param {string} dir @param {number} ino */
  watchDir(dir, ino) {
    try {
      const generation = this.generation;
      const watcher = watch(dir, { persistent: false }, (_event, file) => {
        if (!this.running || this.generation !== generation) return;
        if (file === null) { this.poll(false); return; }
        const name = String(file);
        if (this.accepts(dir, name)) this.schedule(join(dir, name), true);
      });
      const entry = { ino, watcher: /** @type {import("node:fs").FSWatcher|null} */ (watcher) };
      this.watchers.set(dir, entry);
      watcher.on("error", (error) => {
        if (this.watchers.get(dir) !== entry) return;
        watcher.close();
        entry.watcher = null;
        this.deps.logger.warn(`Scene watch ${dir}: ${error.message}; polling continues`);
      });
    } catch (error) {
      this.watchers.set(dir, { ino, watcher: null });
      this.deps.logger.debug(`Scene watch ${dir}: ${error instanceof Error ? error.message : String(error)}; polling continues`);
    }
  }

  /** A hint is debounced first; only an observed stamp change asks for a reload.
   * @param {string} file @param {boolean} reset */
  schedule(file, reset) {
    if (!this.running) return;
    const pending = this.debounce.get(file);
    if (pending) { if (!reset) return; clearTimeout(pending); }
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.debounce.delete(file);
      if (!this.running || this.generation !== generation) return;
      const stamp = this.stamp(file);
      if (this.stamps.get(file) === stamp) return;
      if (stamp) this.stamps.set(file, stamp); else this.stamps.delete(file);
      this.dispatch = this.dispatch.then(async () => {
        if (!this.running || this.generation !== generation) return;
        try { await this.deps.onChange(file); }
        catch (error) { this.deps.logger.error(`Scene reload ${file}: ${error instanceof Error ? error.message : String(error)}`); }
      });
    }, this.deps.debounceMs ?? 500);
    timer.unref();
    this.debounce.set(file, timer);
  }

}
