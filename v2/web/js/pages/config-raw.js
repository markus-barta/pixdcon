/**
 * Page: Raw config.json.
 * Approved mockups: pixd-config-{raw,error} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Line-number gutter and textarea, validity bar, 'Reload from disk', Save; the error line is marked and its message sits in a reserved line under the editor.
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/** @type {import("../router.js").Page} */
export const page = {
  mount(root, params) {
    return todo("pages/config-raw.mount", root, params);
  },
  unmount() {
    return todo("pages/config-raw.unmount");
  },
};
