/**
 * Shadow driver: the display is rendered and previewed, never driven.
 *
 * Used for every device whose output is "shadow" (per device in config.json,
 * or all devices with PIXDCON2_FORCE_SHADOW=1 on the edge lane). It implements
 * the DeviceDriver interface without opening a single socket:
 *  - show() keeps the last output and passes it to the preview store
 *    (Pixoo frame as is; AWTRIX app rasterised by awtrix-raster.js, source "simulated")
 *  - init, blank, setBrightness, setPower, activateBuiltin, reclaim resolve at once and record what was asked
 *  - probe() resolves; health of a shadow device is "shadow", not measured
 *  - readTelemetry() and readScreen are not available: no read from the real
 *    display either, v1 is still polling it
 *
 * The matching rule on the MQTT side lives in the overlay service and the
 * render loop: for a shadow device nothing is published, in particular no
 * overlay clear, no control, no telemetry, no discovery and no power cycle.
 *
 * Owner: drivers worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("./driver.js").DeviceDriver} DeviceDriver */

/**
 * @param {{name: string, type: import("../types.js").DeviceType, logger: import("../types.js").Logger, clock: import("../types.js").Clock}} options
 * @returns {DeviceDriver & {recorded: () => {outputs: number, brightness: number|null, power: boolean, builtin: string|null}}}
 */
export function createShadowDriver(options) {
  return todo("createShadowDriver", options);
}
