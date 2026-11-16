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
 *  - asset folders next to a scene (e.g. scenes/pixoo/home3-assets/) are
 *    watched too and reload the scenes of that directory (B-017). Decoded
 *    images stay cached inside the shared helper lib/pixoo-image.js, which v2
 *    cannot edit: a replaced sprite still needs a process restart (S-19).
 *
 * Owner: fixtures + edge lane worker.
 */

import { todo } from "../core/todo.js";

export class ScenesWatcher {
  /**
   * @param {{dirs: () => string[], onChange: (file: string) => Promise<void>, logger: import("../types.js").Logger, debounceMs?: number, retryMs?: number}} deps
   * `dirs` is read again on every retry tick, so registry changes are followed
   */
  constructor(deps) {
    this.deps = deps;
  }

  start() {
    return todo("ScenesWatcher.start");
  }

  /** Cancel pending reloads and release every handle. Safe to call twice. */
  stop() {
    return todo("ScenesWatcher.stop");
  }
}
