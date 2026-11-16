/**
 * Page: Overlays.
 * Approved mockups: pixd-overlays-{default,empty} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Device overlays, scene setting overlays, mode and brightness, config overlays; each with topic, value, what it replaces, when it was received, Clear. A cleared row stays, greyed, with its time.
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/** @type {import("../router.js").Page} */
export const page = {
  mount(root, params) {
    return todo("pages/overlays.mount", root, params);
  },
  unmount() {
    return todo("pages/overlays.unmount");
  },
};
