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
 *   setChannel(index), setScreen(on) → Promise<boolean>
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
 * Owner: fixtures + edge lane worker.
 */

import { todo } from "../core/todo.js";

/**
 * Where a surface sends what the scene produced. Implemented by the render loop.
 *
 * @typedef {object} SurfaceSink
 * @property {(output: import("../drivers/driver.js").DeviceOutput) => Promise<void>} show rejects with DeviceError
 * @property {(native: number) => Promise<boolean>} requestBrightness the scene asks for a level; false when the display refused it
 * @property {import("../drivers/driver.js").DeviceDriver} driver for the rarely used pass-through calls
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
  return todo("createPixooSurface", device, sink, font);
}

/**
 * @param {{name: string, address: string}} device
 * @param {SurfaceSink} sink
 * @returns {SceneSurface}
 */
export function createUlanziSurface(device, sink) {
  return todo("createUlanziSurface", device, sink);
}
