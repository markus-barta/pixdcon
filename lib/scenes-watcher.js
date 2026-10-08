/**
 * ScenesWatcher — watches a directory for .js file changes and calls back
 * with the changed filename (debounced, 500 ms).
 *
 * Non-fatal: missing/replaced directories are retried so generated scenes
 * created after startup can hot-reload too.
 */

import { watch, statSync, readdirSync } from "fs";
import { join } from "path";

export class ScenesWatcher {
  /**
   * @param {string[]}  dirs             - Absolute paths to watch
   * @param {Function}  onSceneFile      - async (filename: string, directory: string) => void
   * @param {Object}    options
   * @param {Object}    options.logger
   */
  constructor(dirs, onSceneFile, options = {}) {
    this.dirs = dirs;
    this.onSceneFile = onSceneFile;
    this.logger = options.logger || console;
    this.watchers = new Map(); // directory → { watcher, ino }
    this.debounceTimers = new Map(); // full path → timer
    this.retryTimer = null;
    this.fileStamps = new Map();
    this.failedWatches = new Map();
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    for (const dir of this.dirs) {
      this._watchDir(dir);
    }
    this.retryTimer = setInterval(() => {
      for (const dir of this.dirs) {
        const entry = this.watchers.get(dir);
        if (entry) {
          try {
            if (statSync(dir).ino === entry.ino) continue;
          } catch {}
          entry.watcher.close();
          this.watchers.delete(dir);
        }
        this._watchDir(dir, true);
      }
    }, 1000);
    this.retryTimer.unref();
  }

  _watchDir(dir, retry = false) {
    if (!this.running || this.watchers.has(dir)) return;
    try {
      const ino = statSync(dir).ino;
      const previous = this.fileStamps.get(dir) || new Map();
      const stamps = new Map();
      for (const filename of readdirSync(dir)) {
        if (!filename.endsWith(".js")) continue;
        try {
          const stat = statSync(join(dir, filename));
          stamps.set(filename, `${stat.ino}:${stat.mtimeMs}:${stat.size}`);
        } catch {}
      }
      this.fileStamps.set(dir, stamps);
      if (retry) {
        for (const filename of new Set([...previous.keys(), ...stamps.keys()])) {
          if (stamps.get(filename) !== previous.get(filename)) this._schedule(filename, dir);
        }
      }
      // A failed native watch falls back to change detection on the retry timer.
      if (this.failedWatches.get(dir) === ino) return;
      const watcher = watch(dir, { persistent: false }, (eventType, filename) => {
        if (!this.running) return;
        if (!filename || !filename.endsWith(".js")) return;
        if (eventType === "change" || eventType === "rename") {
          this._schedule(filename, dir);
        }
      });

      watcher.on("error", (err) => {
        this.logger.error(`[ScenesWatcher] Watch error on ${dir}: ${err.message}`);
        watcher.close();
        this.watchers.delete(dir);
        this.failedWatches.set(dir, ino);
      });

      this.watchers.set(dir, { watcher, ino });
      this.logger.info(`[ScenesWatcher] Watching ${dir}`);
    } catch (err) {
      if (!retry) {
        this.logger.warn(`[ScenesWatcher] Cannot watch ${dir}: ${err.message} — will retry`);
      }
    }
  }

  _schedule(filename, directory) {
    if (!this.running) return;
    const key = `${directory}/${filename}`;
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key));
    }

    this.debounceTimers.set(
      key,
      setTimeout(async () => {
        this.debounceTimers.delete(key);
        if (!this.running) return;
        this.logger.info(`[ScenesWatcher] Changed: ${filename}`);
        try {
          await this.onSceneFile(filename, directory);
        } catch (err) {
          this.logger.error(`[ScenesWatcher] Handler error for ${filename}`, err);
        }
      }, 500),
    );
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.retryTimer);
    this.retryTimer = null;

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();

    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.fileStamps.clear();
    this.failedWatches.clear();

    this.logger.info("[ScenesWatcher] Stopped");
  }
}

export default ScenesWatcher;
