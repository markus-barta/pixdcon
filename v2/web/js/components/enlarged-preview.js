/**
 * Component: enlarged preview.
 * Approved mockup: pixd-device-preview-enlarged.
 *
 * Full window on the page background. Header: display name, device name,
 * scene and source; "3 of 4"; Previous, Next, Close with keycaps. Stage: the
 * largest whole-number scale. Footer: state, resolution, scale, "last frame
 * 18:42:06" with its age, pixel grid (the mockup says "updated"; the build
 * says "last frame", build rule 5). Esc, Close, a click outside the image or
 * a double click on it close the view; the arrow keys step through displays.
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/**
 * @param {string} device name of the display to start with
 * @param {HTMLElement} opener receives the focus again on close
 * @returns {{close: () => void}}
 */
export function openEnlargedPreview(device, opener) {
  return todo(
    "components/enlarged-preview.openEnlargedPreview",
    device,
    opener,
  );
}
