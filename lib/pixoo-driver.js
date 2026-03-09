/**
 * Pixoo64 HTTP driver — ESM port of health-pixoo/lib/pixoo-http.js (RealPixoo).
 * Target: 64×64 pixel display via Draw/SendHttpGif HTTP API.
 * No pngjs dependency — drawImageWithAlpha is omitted.
 */

import { BITMAP_FONT, FONT_SPECS, measureText } from "./pixoo-font.js";

const WIDTH = 64;
const HEIGHT = 64;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function bufIdx(x, y) {
  return (y * WIDTH + x) * 3;
}

export class PixooDriver {
  constructor(ip, options = {}) {
    this.ip = ip;
    this.logger = options.logger || console;
    this.buf = new Uint8Array(WIDTH * HEIGHT * 3);
    this.picIdCounter = 1;
    this.initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Shared interface (mirrors UlanziDriver where feasible)
  // ---------------------------------------------------------------------------

  /**
   * Initialize device: reset GIF ID, switch to Custom channel (3).
   * Returns true on success, false on failure.
   */
  async initialize() {
    try {
      await this._httpPost({ Command: "Draw/ResetHttpGifId" });
      await new Promise((r) => setTimeout(r, 100));
      await this._httpPost({ Command: "Channel/SetIndex", SelectIndex: 3 });
      this.initialized = true;
      this.logger.info(`[PixooDriver] Initialized ${this.ip}`);
      return true;
    } catch (err) {
      this.logger.error(`[PixooDriver] Init failed: ${err.message}`);
      return false;
    }
  }

  /** Fill pixel buffer with black (no network call). */
  async clear() {
    this.buf.fill(0);
  }

  /** Set display brightness (0–100 for Pixoo). */
  async setBrightness(level) {
    try {
      await this._httpPost({
        Command: "Channel/SetBrightness",
        Brightness: Math.round(clamp(level, 1, 100)),
      });
      return true;
    } catch (err) {
      this.logger.error(`[PixooDriver] setBrightness failed: ${err.message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Pixoo-specific drawing (used directly by Pixoo scenes)
  // ---------------------------------------------------------------------------

  _setPixel(x, y, r, g, b) {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    const i = bufIdx(x, y);
    this.buf[i] = r;
    this.buf[i + 1] = g;
    this.buf[i + 2] = b;
  }

  _blendPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    const i = bufIdx(x, y);
    const alpha = clamp(a, 0, 255) / 255;
    this.buf[i] = Math.round(r * alpha + this.buf[i] * (1 - alpha));
    this.buf[i + 1] = Math.round(g * alpha + this.buf[i + 1] * (1 - alpha));
    this.buf[i + 2] = Math.round(b * alpha + this.buf[i + 2] * (1 - alpha));
  }

  async drawPixelRgba(pos, color) {
    const [x, y] = pos;
    const [r, g, b, a = 255] = color;
    this._blendPixel(x, y, r, g, b, a);
  }

  async drawLineRgba(start, end, color) {
    const [x0, y0] = start;
    const [x1, y1] = end;
    const [r, g, b, a = 255] = color;

    let x = x0 | 0;
    let y = y0 | 0;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    while (true) {
      this._blendPixel(x, y, r, g, b, a);
      if (x === (x1 | 0) && y === (y1 | 0)) break;
      const e2 = err * 2;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }

  async drawRectangleRgba(pos, size, color) {
    const [x0, y0] = pos;
    const [w, h] = size;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        await this.drawPixelRgba([x0 + col, y0 + row], color);
      }
    }
  }

  _textWidth(str) {
    return measureText(str).width;
  }

  /**
   * Draw text aligned to a point.
   * @param {string}   text   - Text to render
   * @param {number[]} pos    - [x, y] anchor point
   * @param {number[]} color  - [r, g, b, a?]
   * @param {string}   align  - 'left' | 'right' | 'center'
   * @returns {number} Total text width in pixels
   */
  async drawTextRgbaAligned(text, pos, color, align = "left") {
    const FONT_W = FONT_SPECS.WIDTH;
    const FONT_H = FONT_SPECS.HEIGHT;
    const CHAR_SP = FONT_SPECS.SPACING;
    const [r, g, b, a = 255] = color;
    let [x, y] = pos;
    const str = String(text ?? "");

    const totalW = this._textWidth(str);

    if (align === "right") {
      x -= totalW;
    } else if (align === "center") {
      const chars = Array.from(str);
      if (chars.length % 2 === 1) {
        const midIdx = Math.floor(chars.length / 2);
        const leftStr = chars.slice(0, midIdx).join("");
        const leftWidth =
          this._textWidth(leftStr) + (leftStr.length ? CHAR_SP : 0);
        const midWidth = this._textWidth(chars[midIdx]);
        x = x - Math.floor(midWidth / 2) - leftWidth;
      } else {
        x -= Math.round(totalW / 2);
      }
    }

    for (const ch of str) {
      const glyph = BITMAP_FONT[ch] || BITMAP_FONT[" "];
      const gw = Math.floor(glyph.length / FONT_H) || FONT_W;
      for (let i = 0; i < glyph.length; i++) {
        if (glyph[i]) {
          this._blendPixel(x + (i % gw), y + Math.floor(i / gw), r, g, b, a);
        }
      }
      x += gw + CHAR_SP;
    }

    return totalW;
  }

  // ---------------------------------------------------------------------------
  // Push frame to device
  // ---------------------------------------------------------------------------

  /**
   * Encode the pixel buffer as base64 and POST to Draw/SendHttpGif.
   * Lazy-initializes if initialize() was never called or failed.
   */
  async push() {
    if (!this.initialized) {
      try {
        await this._httpPost({ Command: "Draw/ResetHttpGifId" });
        await new Promise((r) => setTimeout(r, 100));
        await this._httpPost({ Command: "Channel/SetIndex", SelectIndex: 3 });
        this.initialized = true;
      } catch (err) {
        this.logger.warn(`[PixooDriver] Lazy init failed: ${err.message}`);
        // Continue — attempt the push anyway
      }
    }

    // Reset GIF ID before each frame
    try {
      await this._httpPost({ Command: "Draw/ResetHttpGifId" });
    } catch (err) {
      this.logger.warn(`[PixooDriver] GIF ID reset failed: ${err.message}`);
    }

    const picId = this.picIdCounter++;
    if (this.picIdCounter > 9999) this.picIdCounter = 1;

    await this._httpPost({
      Command: "Draw/SendHttpGif",
      PicNum: 1,
      PicWidth: WIDTH,
      PicHeight: HEIGHT,
      PicOffset: 0,
      PicID: picId,
      PicSpeed: 1000,
      PicData: Buffer.from(this.buf).toString("base64"),
    });

    this.logger.debug(`[PixooDriver] Pushed frame PicID=${picId}`);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  async _httpPost(body, timeoutMs = 5000) {
    const url = `http://${this.ip}/post`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const data = await res.json().catch(() => ({}));
      if (typeof data.error_code === "number" && data.error_code !== 0) {
        throw new Error(`Pixoo error_code ${data.error_code}`);
      }
      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`Pixoo HTTP timeout after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export default PixooDriver;
