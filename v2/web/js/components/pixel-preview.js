/* global document */
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

/** Opacity of the grid lines, as the mockups draw them. */
const GRID = 0.85;

/**
 * @param {HTMLElement} host
 * @param {{scale: number|"fit", grid: boolean, veil?: number, size?: {width: number, height: number}, label?: string}} options veil: opacity of the offline veil (0.55 table, 0.6 device page); size: the display's size, for the box before the first frame
 * @returns {{draw: (frame: {width: number, height: number, rgb: Uint8Array|null}|null, state: {veil: boolean, reason: string|null, spinner?: boolean}) => void, destroy: () => void, setGrid: (grid: boolean) => void, resize: () => void}}
 */
export function createPixelPreview(host, options) {
  const canvas = document.createElement("canvas");
  canvas.className = "pv";
  canvas.setAttribute("role", "img");
  if (options.label) canvas.setAttribute("aria-label", options.label);
  const empty = document.createElement("div");
  empty.className = "pv pv-empty";
  empty.setAttribute("role", "img");
  host.append(canvas, empty);
  let grid = options.grid;
  /** @type {{frame: any, veil: boolean, reason: string|null, spinner: boolean, scale: number}|null} */
  let last = null;

  /** @param {number} width @param {number} height @returns {number} */
  function scaleFor(width, height) {
    if (options.scale !== "fit") return options.scale;
    const rect = host.getBoundingClientRect();
    return Math.max(
      1,
      Math.floor(Math.min(rect.width / width, rect.height / height)),
    );
  }

  /**
   * @param {{width: number, height: number, rgb: Uint8Array|null}|null} frame
   * @param {{veil: boolean, reason: string|null, spinner?: boolean}} state
   */
  function draw(frame, state) {
    const size = frame ?? options.size ?? { width: 64, height: 64 };
    const scale = scaleFor(size.width, size.height);
    const spinner = Boolean(state.spinner);
    if (
      last &&
      last.frame === frame &&
      last.veil === state.veil &&
      last.reason === state.reason &&
      last.spinner === spinner &&
      last.scale === scale
    )
      return;
    last = { frame, veil: state.veil, reason: state.reason, spinner, scale };
    const usable =
      frame !== null &&
      frame.rgb instanceof Uint8Array &&
      frame.rgb.length === frame.width * frame.height * 3;
    if (!usable) {
      canvas.hidden = true;
      empty.hidden = false;
      empty.style.width = `${size.width * scale}px`;
      empty.style.height = `${size.height * scale}px`;
      const reason = frame !== null && !usable ? "bad frame" : (state.reason ?? "");
      empty.replaceChildren();
      if (spinner && size.height * scale >= 64) {
        const wrap = document.createElement("span");
        wrap.style.cssText =
          "display:flex;flex-direction:column;align-items:center;gap:8px;font-size:12px";
        wrap.innerHTML = `<svg class="i spin" aria-hidden="true"><use href="#i-spinner"/></svg>`;
        wrap.append(reason);
        empty.append(wrap);
      } else empty.append(reason);
      return;
    }
    canvas.hidden = false;
    empty.hidden = true;
    const { width, height, rgb } = /** @type {{width: number, height: number, rgb: Uint8Array}} */ (frame);
    const w = width * scale;
    const h = height * scale;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(w, h);
    const out = image.data;
    const dim = state.veil ? 1 - (options.veil ?? 0.6) : 1;
    const lines = grid && scale >= 4;
    for (let y = 0; y < h; y += 1) {
      const sy = Math.floor(y / scale);
      const lineY = lines && y % scale === 0;
      for (let x = 0; x < w; x += 1) {
        const sx = Math.floor(x / scale);
        const from = (sy * width + sx) * 3;
        let factor = dim;
        if (lineY || (lines && x % scale === 0)) factor *= 1 - GRID;
        const to = (y * w + x) * 4;
        out[to] = rgb[from] * factor;
        out[to + 1] = rgb[from + 1] * factor;
        out[to + 2] = rgb[from + 2] * factor;
        out[to + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }

  return {
    draw,
    destroy() {
      canvas.remove();
      empty.remove();
    },
    setGrid(value) {
      if (grid === value) return;
      grid = value;
      last = null;
    },
    resize() {
      last = null;
    },
  };
}
