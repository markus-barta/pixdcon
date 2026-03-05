/**
 * ScenesWatcher — watches a directory for .js file changes and calls back
 * with the changed filename (debounced, 500 ms).
 *
 * Non-fatal: if the directory doesn't exist or can't be watched, logs a
 * warning and no-ops. Hot-reload simply won't work for that dir.
 */

import { watch } from "fs";

export class ScenesWatcher {
  /**
   * @param {string[]}  dirs             - Absolute paths to watch
   * @param {Function}  onSceneFile      - async (filename: string) => void
   * @param {Object}    options
   * @param {Object}    options.logger
   */
  constructor(dirs, onSceneFile, options = {}) {
    this.dirs = dirs;
    this.onSceneFile = onSceneFile;
    this.logger = options.logger || console;
    this.watchers = [];
    this.debounceTimers = new Map(); // filename → timer
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    for (const dir of this.dirs) {
      try {
        const watcher = watch(dir, { persistent: false }, (eventType, filename) => {
          if (!filename || !filename.endsWith(".js")) return;
          if (eventType === "change" || eventType === "rename") {
            this._schedule(filename);
          }
        });

        watcher.on("error", (err) => {
          this.logger.error(`[ScenesWatcher] Watch error on ${dir}: ${err.message}`);
        });

        this.watchers.push(watcher);
        this.logger.info(`[ScenesWatcher] Watching ${dir}`);
      } catch (err) {
        this.logger.warn(
          `[ScenesWatcher] Cannot watch ${dir}: ${err.message} — scene hot-reload disabled for this dir`,
        );
      }
    }
  }

  _schedule(filename) {
    if (this.debounceTimers.has(filename)) {
      clearTimeout(this.debounceTimers.get(filename));
    }

    this.debounceTimers.set(
      filename,
      setTimeout(async () => {
        this.debounceTimers.delete(filename);
        this.logger.info(`[ScenesWatcher] Changed: ${filename}`);
        try {
          await this.onSceneFile(filename);
        } catch (err) {
          this.logger.error(`[ScenesWatcher] Handler error for ${filename}`, err);
        }
      }, 500),
    );
  }

  stop() {
    if (!this.running) return;
    this.running = false;

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();

    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];

    this.logger.info("[ScenesWatcher] Stopped");
  }
}

export default ScenesWatcher;
