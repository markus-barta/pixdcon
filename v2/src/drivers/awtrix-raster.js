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

import { drawBoundedLine } from "../scenes/v1-device-facade.js";

// 3x5 cells; colon is one pixel wide. Unknown glyphs occupy a blank cell.
const GLYPHS = Object.fromEntries(
  Object.entries({
    0: "111/101/101/101/111",
    1: "010/110/010/010/111",
    2: "111/001/111/100/111",
    3: "111/001/111/001/111",
    4: "101/101/111/001/001",
    5: "111/100/111/001/111",
    6: "111/100/111/101/111",
    7: "111/001/010/010/010",
    8: "111/101/111/101/111",
    9: "111/101/111/001/111",
    ":": "0/1/0/1/0",
    " ": "000/000/000/000/000",
    A: "010/101/111/101/101",
    B: "110/101/110/101/110",
    C: "111/100/100/100/111",
    D: "110/101/101/101/110",
    E: "111/100/110/100/111",
    F: "111/100/110/100/100",
    G: "111/100/101/101/111",
    H: "101/101/111/101/101",
    I: "111/010/010/010/111",
    J: "001/001/001/101/111",
    K: "101/101/110/101/101",
    L: "100/100/100/100/111",
    M: "101/111/111/101/101",
    N: "101/111/111/111/101",
    O: "111/101/101/101/111",
    P: "111/101/111/100/100",
    Q: "111/101/101/111/001",
    R: "110/101/110/101/101",
    S: "111/100/111/001/111",
    T: "111/010/010/010/010",
    U: "101/101/101/101/111",
    V: "101/101/101/101/010",
    W: "101/101/111/111/101",
    X: "101/101/010/101/101",
    Y: "101/101/010/010/010",
    Z: "111/001/010/100/111",
    "-": "000/000/111/000/000",
    ".": "0/0/0/0/1",
    "%": "101/001/010/100/101",
  }).map(([key, rows]) => [key, rows.split("/")]),
);

/** @param {unknown} value @returns {number[]} */
function colorOf(value) {
  if (Array.isArray(value) && value.length >= 3)
    return value
      .slice(0, 3)
      .map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))));
  if (typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value)) {
    const n = parseInt(value.replace(/^#/, ""), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  return [255, 255, 255];
}

/**
 * @param {Record<string, unknown>} app AWTRIX custom-app payload as a scene passed it to drawCustom()
 * @returns {{frame: import("../types.js").Frame, unsupported: string[]}}
 */
export function rasterizeAwtrixApp(app) {
  const rgb = new Uint8Array(32 * 8 * 3);
  const unsupported = new Set(
    Object.keys(app).filter(
      (key) => !["text", "color", "center", "draw"].includes(key),
    ),
  );
  /** @param {number} x @param {number} y @param {number[]} color */
  const pixel = (x, y, color) => {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      x >= 32 ||
      y < 0 ||
      y >= 8
    )
      return;
    rgb.set(color, (y * 32 + x) * 3);
  };
  /** @param {string} value */
  const cells = (value) =>
    Array.from(value).map((ch) => GLYPHS[ch.toUpperCase()] ?? GLYPHS[" "]);
  /** @param {string} value */
  const textWidth = (value) =>
    Math.max(
      0,
      cells(value).reduce((sum, glyph) => sum + glyph[0].length + 1, 0) - 1,
    );
  /** @param {number} x @param {number} y @param {unknown} value @param {number[]} color */
  const text = (x, y, value, color) => {
    for (const glyph of cells(String(value))) {
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < glyph[row].length; col++) {
          if (glyph[row][col] === "1") pixel(x + col, y + row, color);
        }
      }
      x += glyph[0].length + 1;
    }
  };
  /** @param {number} x @param {number} y @param {number} w @param {number} h @param {number[]} color @param {boolean} fill */
  const rect = (x, y, w, h, color, fill) => {
    if (![x, y, w, h].every(Number.isSafeInteger) || w <= 0 || h <= 0) return;
    for (let row = Math.max(0, y); row < Math.min(8, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(32, x + w); col++) {
        if (
          fill ||
          row === y ||
          row === y + h - 1 ||
          col === x ||
          col === x + w - 1
        )
          pixel(col, row, color);
      }
    }
  };
  if (typeof app.text === "string") {
    text(
      app.center === false ? 0 : Math.floor((32 - textWidth(app.text)) / 2),
      1,
      app.text,
      colorOf(app.color),
    );
  }
  if (Array.isArray(app.draw)) {
    for (const command of app.draw) {
      if (!command || typeof command !== "object") {
        unsupported.add("draw");
        continue;
      }
      for (const [op, raw] of Object.entries(command)) {
        if (!Array.isArray(raw)) {
          unsupported.add(`draw.${op}`);
          continue;
        }
        const [x, y, a, b, c] = raw;
        if (op === "dp" && raw.length === 3) pixel(x, y, colorOf(a));
        else if (op === "dl" && raw.length === 5)
          drawBoundedLine([x, y], [a, b], 32, 8, (px, py) =>
            pixel(px, py, colorOf(c)),
          );
        else if ((op === "dr" || op === "df") && raw.length === 5)
          rect(x, y, a, b, colorOf(c), op === "df");
        else if (op === "dt" && raw.length === 4) text(x, y, a, colorOf(b));
        else unsupported.add(`draw.${op}`);
      }
    }
  } else if (app.draw !== undefined) unsupported.add("draw");
  return {
    frame: { width: 32, height: 8, rgb },
    unsupported: [...unsupported].sort(),
  };
}
