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
