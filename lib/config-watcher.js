/**
 * Config file watcher with hot-reload support.
 *
 * Uses fs.watch() with a 500 ms debounce.  When the file stabilises,
 * reads the content and calls onChange(content).
 *
 * The previous mtime-based dedup was broken (used Date.now() instead of
 * the real mtime).  We now track content hash via a simple string compare
 * so we only fire when content actually changed.
 */

import { watch } from "fs";
import { readFile, stat } from "fs/promises";

export class ConfigWatcher {
  /**
   * @param {string}   configPath - Absolute path to config file
   * @param {Function} onChange   - async (content: string) => void
   * @param {Object}   options
   * @param {Object}   options.logger
   */
  constructor(configPath, onChange, options = {}) {
    this.configPath = configPath;
    this.onChange = onChange;
    this.logger = options.logger || console;
    this.watcher = null;
    this.debounceTimer = null;
    this.lastContent = null; // Track last-seen content to skip no-op writes
    this.running = false;
  }

  async start() {
    if (this.running) {
      this.logger.warn("[ConfigWatcher] Already running");
      return;
    }

    this.running = true;
    // Read initial content so the first real change is detectable
    try {
      this.lastContent = await readFile(this.configPath, "utf-8");
    } catch (error) {
      this.logger.warn(
        `[ConfigWatcher] Could not read initial config for baseline: ${error.message}`,
      );
    }

    if (!this.running) return;
    this.logger.info(`[ConfigWatcher] Watching ${this.configPath}`);

    try {
      this._armWatch();
    } catch (error) {
      this.running = false;
      this.logger.error(`[ConfigWatcher] Failed to start: ${error.message}`);
      throw error;
    }
  }

  _armWatch() {
    if (!this.running || this.watcher) return;
    this.watcher = watch(
      this.configPath,
      { persistent: false },
      (eventType) => {
        // 'rename' fires on some editors (atomic save); 'change' on others
        if (eventType === "rename") {
          this.watcher?.close();
          this.watcher = null;
        }
        if (eventType === "change" || eventType === "rename") {
          this._scheduleReload();
        }
      },
    );

    this.watcher.on("error", (error) => {
      this.logger.error(`[ConfigWatcher] Watch error: ${error.message}`);
      this.watcher?.close();
      this.watcher = null;
      this._scheduleReload();
    });
  }

  _scheduleReload() {
    if (!this.running) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      if (!this.running) return;

      // Verify the file still exists and is readable (editors may briefly delete it)
      try {
        await stat(this.configPath);
      } catch {
        this.logger.warn(
          "[ConfigWatcher] Config file temporarily missing, skipping reload",
        );
        this._scheduleReload(); // atomic saves may recreate the file later
        return;
      }

      try {
        this._armWatch(); // bind the replacement inode before reading its content
      } catch (error) {
        this.logger.warn(`[ConfigWatcher] Could not re-arm watch: ${error.message}`);
        this._scheduleReload();
        return;
      }

      let content;
      try {
        content = await readFile(this.configPath, "utf-8");
      } catch (error) {
        this.logger.error(
          `[ConfigWatcher] Could not read config: ${error.message}`,
        );
        return;
      }

      if (!this.running) return;
      // Skip if content hasn't actually changed (handles duplicate fs events)
      if (content === this.lastContent) {
        this.logger.debug(
          "[ConfigWatcher] File event fired but content unchanged, skipping",
        );
        return;
      }

      this.lastContent = content;
      this.logger.info("[ConfigWatcher] Config changed, triggering reload...");

      try {
        await this.onChange(content);
      } catch (error) {
        this.logger.error(
          "[ConfigWatcher] onChange callback threw an error",
          error,
        );
      }
    }, 500);
  }

  async stop() {
    if (!this.running) return;

    this.running = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.logger.info("[ConfigWatcher] Stopped");
  }
}

export default ConfigWatcher;
