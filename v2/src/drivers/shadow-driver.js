/**
 * Shadow driver: the display is rendered and previewed, never driven.
 *
 * Used for every device whose output is "shadow" (per device in config.json,
 * or all devices with PIXDCON2_FORCE_SHADOW=1 on the edge lane). It implements
 * the DeviceDriver interface without opening a single socket:
 *  - show() keeps the last output and passes it to the preview store
 *    (Pixoo frame as is; AWTRIX app rasterised with the injected
 *    `rasterizeAwtrixApp`, source "simulated")
 *  - init, blank, setBrightness, setPower, activateBuiltin, reclaim resolve at once and record what was asked
 *  - probe() resolves; health of a shadow device is "shadow", not measured
 *  - readTelemetry() and readScreen are not available: no read from the real
 *    display either, v1 is still polling it
 *  - selectChannel, notify and switchApp exist for the device type as on the
 *    real driver and only record the call
 *
 * The matching rule on the MQTT side: for a shadow device nothing is
 * published, in particular no overlay clear, no control, no telemetry, no
 * discovery, no availability and no power cycle. Every module that could
 * publish asks the same resolved output policy that selected this driver
 * (RuntimeConfig.outputOf), including for a device that config.json wants
 * driven and the v1 interlock holds back.
 *
 * Owner: drivers worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("./driver.js").DeviceDriver} DeviceDriver */

/**
 * @param {{name: string, type: import("../types.js").DeviceType, logger: import("../types.js").Logger, clock: import("../types.js").Clock, rasterizeAwtrixApp: import("../types.js").Factories["rasterizeAwtrixApp"]}} options
 * @returns {DeviceDriver & {recorded: () => {outputs: number, brightness: number|null, power: boolean, builtin: string|null}}}
 */
export function createShadowDriver(options) {
  return todo("createShadowDriver", options);
}
