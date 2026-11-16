/**
 * Page: Devices overview.
 * Approved mockups: pixd-devices-{default,loading,empty,stale,offline,error,disconnected} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Table in config order: preview (click enlarges), device, scene select with its source lines, status, brightness, mode. 'Add device' in the title line and as the empty state.
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/** @type {import("../router.js").Page} */
export const page = {
  mount(root, params) {
    return todo("pages/devices.mount", root, params);
  },
  unmount() {
    return todo("pages/devices.unmount");
  },
};
