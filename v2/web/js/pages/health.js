/**
 * Page: Health.
 * Approved mockups: pixd-health-{default,mqtt-offline} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Version, MQTT, displays with last error, the recent log (last 200 lines, filter, Copy). The displays heading states the time rule (stale after 30 s, offline after 2 min), not v1's '5 failed renders'.
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/** @type {import("../router.js").Page} */
export const page = {
  mount(root, params) {
    return todo("pages/health.mount", root, params);
  },
  unmount() {
    return todo("pages/health.unmount");
  },
};
