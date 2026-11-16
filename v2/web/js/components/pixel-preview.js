/**
 * Component: pixel preview.
 *
 * A canvas at a whole-number scale with `image-rendering: pixelated`.
 * Table: Pixoo 2× (128×128), Ulanzi 4× (128×32). Device page: Pixoo 5×
 * (320×320), Ulanzi 10× (320×80). Enlarged: the largest whole-number scale
 * that fits. The pixel grid (device setting) is drawn at 4× and above.
 * Offline: the last frame under a 55 to 60 % black veil. No frame yet: a
 * black box with the reason. A frame is checked before it is drawn; a bad one
 * shows "bad frame" (matrix B-180). Each preview holds its own canvas
 * element, never an id derived from the device name (B-178).
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/**
 * @param {HTMLElement} host
 * @param {{scale: number|"fit", grid: boolean}} options
 * @returns {{draw: (frame: {width: number, height: number, rgb: Uint8Array}|null, state: {veil: boolean, reason: string|null}) => void, destroy: () => void}}
 */
export function createPixelPreview(host, options) {
  return todo("components/pixel-preview.createPixelPreview", host, options);
}
