/**
 * Device driver interface, shared by Pixoo64, Ulanzi/AWTRIX and the shadow driver.
 *
 * A driver is transport only: it turns one request into HTTP calls to one
 * display and reports the outcome. It keeps no retry loop, no backoff and no
 * precedence (matrix D-036, D-086); the render loop owns those. It never
 * returns `false` for a failure: every failed request rejects with a
 * DeviceError, so nothing can ignore it (D-B04: v1 logged a built-in mode as
 * active although the display had refused it).
 *
 * Rules for every driver:
 *  - Requests to one display run strictly one after another (D-037).
 *  - Each request has a deadline that includes reading the body (D-035, D-B01).
 *  - `probe()` is read-only and changes nothing on the display (v1 probed with
 *    initialize(), which is state-changing).
 *  - `ready` goes false on every failure and after a power cycle, so the next
 *    frame re-claims the channel or app (D-004, D-B02).
 *  - All brightness values are native units of the display.
 *
 * The same interface is what the fake devices in dev/ answer to, and what the
 * shadow driver implements without any network.
 *
 * Owner: drivers worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").Frame} Frame */
/** @typedef {import("../types.js").DeviceType} DeviceType */

/**
 * @typedef {object} DriverInfo
 * @property {DeviceType} type
 * @property {number} width
 * @property {number} height
 * @property {{min: number, max: number}} brightness native range: Pixoo 1 to 100, Ulanzi 0 to 255
 * @property {boolean} drives false for the shadow driver
 */

/**
 * What a scene may hand to a display.
 *  - "frame": a full RGB888 picture (Pixoo scenes; Ulanzi raw frame for stop blanking)
 *  - "app":   an AWTRIX custom-app payload, passed through unchanged (D-067, D-144)
 *
 * @typedef {{kind: "frame", frame: Frame} | {kind: "app", app: Record<string, unknown>}} DeviceOutput
 */

/**
 * @typedef {object} DeviceDriver
 * @property {DriverInfo} info
 * @property {boolean} ready true after a successful init() until the next failure
 * @property {() => Promise<void>} init claim the display: Pixoo resets the GIF id and selects the custom channel; Ulanzi reads stats and, when configured, runs the legacy-app cleanup
 * @property {() => Promise<{at: string}>} probe read-only liveness check
 * @property {(output: DeviceOutput) => Promise<void>} show send one frame or app; resolves when the display accepted it
 * @property {() => Promise<void>} blank show black (stop mode, D-066, D-130)
 * @property {(native: number) => Promise<void>} setBrightness
 * @property {(on: boolean) => Promise<void>} setPower Ulanzi power, Pixoo screen (B-038, B-039)
 * @property {(modeKey: string) => Promise<void>} activateBuiltin hand the display to its firmware, see builtin-modes.js; rejects for an unknown key
 * @property {() => Promise<void>} reclaim take the display back after a built-in mode (custom channel or app, screen on)
 * @property {() => Promise<Record<string, unknown>>} readTelemetry Ulanzi GET /api/stats; Pixoo Channel/GetAllConf mapped to {reachable, brightness, cur_clock_id}
 * @property {((options?: {signal?: AbortSignal}) => Promise<Frame|null>)|null} readScreen Ulanzi GET /api/screen as a 32×8 frame; null for displays without read-back
 * @property {((notification: Record<string, unknown>) => Promise<void>)|null} notify AWTRIX POST /api/notify, payload unchanged (v1 scene surface only, D-071); null for Pixoo
 * @property {((appName: string) => Promise<void>)|null} switchApp AWTRIX POST /api/switch with any app name (v1 scene surface, D-070); null for Pixoo
 * @property {() => Promise<void>} close cancel requests in flight
 */

/**
 * @typedef {object} DriverOptions
 * @property {string} name device name
 * @property {string} address host or host:port
 * @property {import("../types.js").Logger} logger
 * @property {import("../types.js").Clock} clock
 * @property {number} [timeoutMs] per request, default 5000 (D-031)
 * @property {boolean} [cleanupLegacyApps] Ulanzi only (D-055)
 */

/**
 * Build the driver for a device. Output "shadow" always yields the shadow
 * driver, whatever the type: nothing leaves the process for that device.
 *
 * @param {{name: string, type: DeviceType, address: string, output: import("../types.js").OutputMode, cleanupLegacyApps?: boolean}} device
 * @param {{logger: import("../types.js").Logger, clock: import("../types.js").Clock}} deps
 * @returns {DeviceDriver}
 */
export function createDriver(device, deps) {
  return todo("createDriver", device, deps);
}

/**
 * Pixel size per device type.
 *
 * @param {DeviceType} type
 * @returns {{width: number, height: number}}
 */
export function sizeOf(type) {
  return type === "pixoo"
    ? { width: 64, height: 64 }
    : { width: 32, height: 8 };
}
