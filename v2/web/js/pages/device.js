/**
 * Page: Device control.
 * Approved mockups: pixd-device-{default,overridden,previewing,stale,offline,offline-ulanzi,loading,error,empty,json-error} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Facts strip, display column (preview, mode, brightness), 'Showing now' block with its five fixed rows, scene option list, settings band and rows, 'Separate copy of this scene'. After a scene switch the settings form appears only once its values are loaded (build rule 1).
 *
 * States without a mockup yet (defaults in the knowledge entry, open for Tick): a device in shadow output, and a device that exists only in the MQTT config overlay (`origin: "blob"`): its changes are applied but not saved, and one action, 'Add to config.json' (POST …/adopt), puts it into the file.
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/** @type {import("../router.js").Page} */
export const page = {
  mount(root, params) {
    return todo("pages/device.mount", root, params);
  },
  unmount() {
    return todo("pages/device.unmount");
  },
};
