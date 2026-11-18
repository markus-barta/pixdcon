/**
 * v1 device surface: the object a v1 scene receives in render(device).
 *
 * In v1 that object is the driver itself. The shipped scenes call these
 * members (matrix section B 4.1), and scenes on the mount may call any public
 * member of the v1 drivers (matrix section D 4), so the surface offers all of
 * them with the v1 signatures and results.
 *
 * PIXOO (lib/pixoo-driver.js; matrix D-001, D-005 to D-023):
 *   buf                         Uint8Array(64·64·3), RGB, row-major; scenes write into it directly
 *   _setPixel(x, y, r, g, b)    integer coordinates inside the panel, else ignored
 *   _blendPixel(x, y, r, g, b, a = 255)
 *   drawPixelRgba([x, y], [r, g, b, a?])            → Promise<void>
 *   drawLineRgba([x0, y0], [x1, y1], rgba)          → Promise<void>
 *   drawRectangleRgba([x, y], [w, h], rgba)         → Promise<void>   filled
 *   drawTextRgbaAligned(text, [x, y], rgba, align = "left" | "right" | "center") → Promise<number> width
 *   _textWidth(text)                                → number
 *   clear()                     → Promise<void>     zeroes buf, no network
 *   push()                      → Promise<void>     hands the frame to the display; rejects when it was not accepted
 *   setBrightness(1–100)        → Promise<boolean>
 *   setChannel(index)           → Promise<boolean>  any channel index, forwarded unchanged (D-008): driver.selectChannel
 *   setScreen(on)               → Promise<boolean>  driver.setPower
 *   ip, deviceName, initialized (read)
 *   Drawing must be pixel-identical to v1: the golden frames compare against
 *   pictures produced by the v1 driver. The font is v1's (v1-shared.js).
 *   Fixed: lines and rectangles with unsafe or non-finite coordinates are
 *   clipped or rejected and can no longer hang the process (D-015, D-016, D-B11).
 *
 * ULANZI (lib/ulanzi-driver.js; matrix D-063 to D-084):
 *   drawCustom(appData)         → Promise<true>     the scene's AWTRIX payload, unchanged; rejects when the display refused it
 *   setBrightness(0–255)        → Promise<boolean>
 *   clear()                     → Promise<true>     black frame
 *   push(frame: Uint8Array(768))→ Promise<true>
 *   switchToApp(name), showNotification(payload), setPower(on) → Promise<boolean>
 *   getStats(), getScreen({signal?, silent?})       → Promise<object|array|null>
 *   drawPixel, drawLine, drawRect, fillRect, drawCircle, fillCircle, drawText → Promise<true>, one draw command each
 *   ip, appName ("pixdcon_<device>") (read)
 *
 * What the surface adds without the scene noticing:
 *  - push() and drawCustom() give the frame to the render loop's output: the
 *    driver for a driven device, the shadow driver otherwise, and the preview
 *    store in both cases
 *  - setBrightness records what the scene asked for and applies the override
 *    when one is set (v1 did this with a proxy around the driver, B-043)
 *  - a refused frame rejects with a DeviceError, so the loop can tell it from
 *    a bug in the scene
 *
 * How the render loop gets a surface: through `Factories.createSurface`
 * (types.js), which main.js builds from the two functions below and the v1
 * font. The loop does not import this file, and this file does not import
 * the loop: the SurfaceSink type is the whole agreement between the two.
 *
 * Owner: fixtures + edge lane worker.
 */

import { DeviceError } from "../core/errors.js";

/**
 * Where a surface sends what the scene produced. Implemented by the render loop.
 *
 * @typedef {object} SurfaceSink
 * @property {(output: import("../drivers/driver.js").DeviceOutput) => Promise<void>} show rejects with DeviceError
 * @property {(native: number) => Promise<boolean>} requestBrightness the scene asks for a level; false when the display refused it
 * @property {import("../drivers/driver.js").DeviceDriver} driver for the rarely used pass-through calls (selectChannel, setPower, notify, switchApp, readTelemetry, readScreen); every one goes through the driver's request queue
 */

/**
 * The object passed to render(). Its shape depends on the device type; see the
 * tables above.
 *
 * @typedef {Record<string, unknown> & {deviceName: string}} SceneSurface
 */

/**
 * @param {{name: string, address: string}} device
 * @param {SurfaceSink} sink
 * @param {Awaited<ReturnType<typeof import("./v1-shared.js").loadV1Font>>} font
 * @returns {SceneSurface & {buf: Uint8Array}}
 */
export function createPixooSurface(device, sink, font) {
  const buf = new Uint8Array(64 * 64 * 3);
  /** @param {number} x @param {number} y @param {number} r @param {number} g @param {number} b */
  const setPixel = (x, y, r, g, b) => {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      x >= 64 ||
      y < 0 ||
      y >= 64
    )
      return;
    const i = (y * 64 + x) * 3;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
  };
  /** @param {number} x @param {number} y @param {number} r @param {number} g @param {number} b @param {number} [a] */
  const blendPixel = (x, y, r, g, b, a = 255) => {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      x >= 64 ||
      y < 0 ||
      y >= 64
    )
      return;
    const i = (y * 64 + x) * 3;
    const alpha = Math.max(0, Math.min(255, a)) / 255;
    setPixel(
      x,
      y,
      Math.round(r * alpha + buf[i] * (1 - alpha)),
      Math.round(g * alpha + buf[i + 1] * (1 - alpha)),
      Math.round(b * alpha + buf[i + 2] * (1 - alpha)),
    );
  };
  /** @param {number[]} pos @param {number[]} color */
  const pixel = async (pos, color) =>
    blendPixel(pos[0], pos[1], color[0], color[1], color[2], color[3]);
  return {
    deviceName: device.name,
    ip: device.address,
    buf,
    get initialized() {
      return sink.driver.ready;
    },
    _setPixel: setPixel,
    _blendPixel: blendPixel,
    drawPixelRgba: pixel,
    /** @param {number[]} start @param {number[]} end @param {number[]} color */
    async drawLineRgba(start, end, color) {
      drawBoundedLine(start, end, 64, 64, (x, y) =>
        blendPixel(x, y, color[0], color[1], color[2], color[3]),
      );
    },
    /** @param {number[]} pos @param {number[]} size @param {number[]} color */
    async drawRectangleRgba(pos, size, color) {
      const [x, y] = pos,
        [w, h] = size;
      if (
        ![x, y, w, h].every(Number.isFinite) ||
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        w <= 0 ||
        h <= 0
      )
        return;
      for (
        let row = Math.max(0, y);
        row < Math.min(64, y + Math.ceil(h));
        row++
      ) {
        for (
          let col = Math.max(0, x);
          col < Math.min(64, x + Math.ceil(w));
          col++
        ) {
          blendPixel(col, row, color[0], color[1], color[2], color[3]);
        }
      }
    },
    /** @param {string} text */
    _textWidth: (text) => font.measureText(text).width,
    /** @param {unknown} text @param {number[]} pos @param {number[]} color @param {string} [align] */
    async drawTextRgbaAligned(text, pos, color, align = "left") {
      const str = String(text ?? "");
      const totalW = font.measureText(str).width;
      let [x, y] = pos;
      const spacing = font.FONT_SPECS.SPACING;
      const height = font.FONT_SPECS.HEIGHT;
      if (align === "right") x -= totalW;
      else if (align === "center") {
        const chars = Array.from(str);
        if (chars.length % 2 === 1) {
          const middle = Math.floor(chars.length / 2);
          const left = chars.slice(0, middle).join("");
          x -=
            Math.floor(font.measureText(chars[middle]).width / 2) +
            font.measureText(left).width +
            (left.length ? spacing : 0);
        } else x -= Math.round(totalW / 2);
      }
      for (const ch of str) {
        const glyph = font.BITMAP_FONT[ch] || font.BITMAP_FONT[" "];
        const width =
          Math.floor(glyph.length / height) || font.FONT_SPECS.WIDTH;
        for (let i = 0; i < glyph.length; i++) {
          if (glyph[i])
            blendPixel(
              x + (i % width),
              y + Math.floor(i / width),
              color[0],
              color[1],
              color[2],
              color[3],
            );
        }
        x += width + spacing;
      }
      return totalW;
    },
    async clear() {
      buf.fill(0);
    },
    async push() {
      await sink.show({
        kind: "frame",
        frame: { width: 64, height: 64, rgb: buf.slice() },
      });
    },
    /** @param {number} level */
    setBrightness: (level) =>
      sink.requestBrightness(Math.round(Math.max(1, Math.min(100, level)))),
    /** @param {number} index */
    setChannel: (index) =>
      booleanCall(() => sink.driver.selectChannel?.(index)),
    /** @param {boolean} on */
    setScreen: (on) => booleanCall(() => sink.driver.setPower(on)),
  };
}

/**
 * @param {{name: string, address: string}} device
 * @param {SurfaceSink} sink
 * @returns {SceneSurface}
 */
export function createUlanziSurface(device, sink) {
  /** @param {Record<string, unknown>} app */
  const drawCustom = async (app) => {
    await sink.show({ kind: "app", app });
    return true;
  };
  return {
    deviceName: device.name,
    ip: device.address,
    appName: `pixdcon_${device.name}`,
    drawCustom,
    /** @param {Uint8Array} rgb */
    async push(rgb) {
      if (!(rgb instanceof Uint8Array) || rgb.length !== 768)
        throw new DeviceError("Ulanzi frame must contain 768 RGB bytes", {
          device: device.name,
        });
      await sink.show({
        kind: "frame",
        frame: { width: 32, height: 8, rgb: rgb.slice() },
      });
      return true;
    },
    async clear() {
      await sink.show({
        kind: "frame",
        frame: { width: 32, height: 8, rgb: new Uint8Array(768) },
      });
      return true;
    },
    /** @param {number} level */
    setBrightness: (level) =>
      sink.requestBrightness(Math.round(Math.max(0, Math.min(255, level)))),
    /** @param {string} name */
    switchToApp: (name) => booleanCall(() => sink.driver.switchApp?.(name)),
    /** @param {Record<string, unknown>} payload */
    showNotification: (payload) =>
      booleanCall(() => sink.driver.notify?.(payload)),
    /** @param {boolean} on */
    setPower: (on) => booleanCall(() => sink.driver.setPower(on)),
    async getStats() {
      try {
        return await sink.driver.readTelemetry();
      } catch {
        return null;
      }
    },
    /** @param {{signal?: AbortSignal, silent?: boolean}} [options] */
    async getScreen(options) {
      try {
        const frame = await sink.driver.readScreen?.(options);
        if (!frame) return null;
        return Array.from(
          { length: frame.width * frame.height },
          (_, i) =>
            (frame.rgb[i * 3] << 16) |
            (frame.rgb[i * 3 + 1] << 8) |
            frame.rgb[i * 3 + 2],
        );
      } catch {
        return null;
      }
    },
    /** @param {number} x @param {number} y @param {unknown} color */
    drawPixel: (x, y, color) => drawCustom({ draw: [{ dp: [x, y, color] }] }),
    /** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {unknown} color */
    drawLine: (x0, y0, x1, y1, color) =>
      drawCustom({ draw: [{ dl: [x0, y0, x1, y1, color] }] }),
    /** @param {number} x @param {number} y @param {number} w @param {number} h @param {unknown} color */
    drawRect: (x, y, w, h, color) =>
      drawCustom({ draw: [{ dr: [x, y, w, h, color] }] }),
    /** @param {number} x @param {number} y @param {number} w @param {number} h @param {unknown} color */
    fillRect: (x, y, w, h, color) =>
      drawCustom({ draw: [{ df: [x, y, w, h, color] }] }),
    /** @param {number} x @param {number} y @param {number} r @param {unknown} color */
    drawCircle: (x, y, r, color) =>
      drawCustom({ draw: [{ dc: [x, y, r, color] }] }),
    /** @param {number} x @param {number} y @param {number} r @param {unknown} color */
    fillCircle: (x, y, r, color) =>
      drawCustom({ draw: [{ dfc: [x, y, r, color] }] }),
    /** @param {string} text @param {number} x @param {number} y @param {unknown} color */
    drawText: (text, x, y, color) =>
      drawCustom({ draw: [{ dt: [x, y, text, color] }] }),
  };
}

/** v1 control calls return false on refusal; frame calls always reject.
 * @param {() => Promise<void>|undefined} call */
async function booleanCall(call) {
  try {
    const result = call();
    if (!result) return false;
    await result;
    return true;
  } catch {
    return false;
  }
}

/** Bresenham's major-axis form skips invisible pixels without walking huge lines.
 * The strict tie matches v1's `e2 > -dy` / `e2 < dx` for both directions.
 * Unsafe integers and non-finite inputs are rejected.
 * @param {number[]} start @param {number[]} end @param {number} width @param {number} height
 * @param {(x: number, y: number) => void} pixel
 */
export function drawBoundedLine(start, end, width, height, pixel) {
  const [x0, y0] = start.map(Math.trunc),
    [x1, y1] = end.map(Math.trunc);
  if (![x0, y0, x1, y1].every(Number.isSafeInteger)) return;
  const dx = Math.abs(x1 - x0),
    dy = Math.abs(y1 - y0);
  if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy)) return;
  const sx = x0 < x1 ? 1 : -1,
    sy = y0 < y1 ? 1 : -1;
  if (dx === 0 && dy === 0) {
    pixel(x0, y0);
    return;
  }
  const majorX = dx >= dy;
  const major = majorX ? dx : dy,
    minor = majorX ? dy : dx;
  const origin = majorX ? x0 : y0,
    step = majorX ? sx : sy,
    bound = majorX ? width : height;
  const from = Math.max(0, step > 0 ? -origin : origin - bound + 1);
  const to = Math.min(major, step > 0 ? bound - 1 - origin : origin);
  for (let i = from; i <= to; i++) {
    // Integer arithmetic avoids accumulated error and preserves the half-pixel tie.
    const offset = Number(
      (BigInt(i) * BigInt(minor) * 2n + BigInt(major) - 1n) /
        (BigInt(major) * 2n),
    );
    const x = majorX ? x0 + sx * i : x0 + sx * offset;
    const y = majorX ? y0 + sy * offset : y0 + sy * i;
    if (x >= 0 && x < width && y >= 0 && y < height) pixel(x, y);
  }
}
