/**
 * AWTRIX rasteriser: an AWTRIX custom-app payload → a 32×8 RGB frame.
 *
 * New in v2. v1 can only show an Ulanzi preview by reading the screen back
 * from the real display. Three places need a picture without a display:
 *  - shadow output (edge lane): the preview of an Ulanzi scene that is not driven
 *  - the fake AWTRIX device in dev/ (its /api/screen answer)
 *  - golden frames of the Ulanzi scenes (test kind 1)
 *
 * Scope: exactly what the shipped scenes send (scenes/ulanzi/*.js):
 *   text, color, center, and the draw commands df (filled rect), dp (pixel),
 *   dl (line), dr (rect), dt (text); colours as "#RRGGBB" or [r, g, b].
 * Anything else in a payload is passed to the real display unchanged and is
 * simply not drawn here; `unsupported` in the result names it. The glyphs are
 * AWTRIX's 3×5 font as far as the shipped scenes use it (digits, colon, the
 * letters of the test scenes); a missing glyph is drawn as an empty cell.
 *
 * The result is an approximation of the firmware, good enough to see what a
 * scene does. It is deterministic, so it can be compared in golden tests; the
 * exact contract with the display stays the JSON payload, which the golden
 * tests compare as well.
 *
 * Reaches its users as `Factories.rasterizeAwtrixApp` (types.js) through
 * main.js: the shadow driver, the dev runner and the test harness (which
 * hand it to the fake AWTRIX with setRaster). None of them imports this file.
 *
 * Owner: fixtures + edge lane worker.
 */

import { todo } from "../core/todo.js";

/**
 * @param {Record<string, unknown>} app AWTRIX custom-app payload as a scene passed it to drawCustom()
 * @returns {{frame: import("../types.js").Frame, unsupported: string[]}}
 */
export function rasterizeAwtrixApp(app) {
  return todo("rasterizeAwtrixApp", app);
}
