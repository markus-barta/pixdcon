/**
 * Page: Config.
 * Approved mockups: pixd-config-{default,edit} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Devices list with Edit (display name, comment, preview poll, pixel grid), Add device, registered scenes, theme for this browser. Name, type, address and removal stay in the raw config.
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/** @type {import("../router.js").Page} */
export const page = {
  mount(root, params) {
    return todo("pages/config.mount", root, params);
  },
  unmount() {
    return todo("pages/config.unmount");
  },
};
