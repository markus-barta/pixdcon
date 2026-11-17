/**
 * Shadow driver: the display is rendered and previewed, never driven.
 *
 * Used for every device whose output is "shadow" (per device in config.json,
 * or all devices with PIXDCON2_FORCE_SHADOW=1 on the edge lane). It implements
 * the DeviceDriver interface without opening a single socket:
 *  - show() keeps the last output and passes it to the preview store
 *    (Pixoo frame as is; AWTRIX app rasterised with the injected
 *    `rasterizeAwtrixApp`, source "simulated")
 *    previewFrame() exposes a copy of that local raster to the loop; readScreen stays null.
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

import { DeviceError } from "../core/errors.js";
import { findBuiltin } from "./builtin-modes.js";
import { brightness, copyFrame } from "./http-transport.js";

/** @typedef {import("./driver.js").DeviceDriver} DeviceDriver */

/**
 * @param {{name: string, type: import("../types.js").DeviceType, logger: import("../types.js").Logger, clock: import("../types.js").Clock, rasterizeAwtrixApp: import("../types.js").Factories["rasterizeAwtrixApp"]}} options
 * @returns {DeviceDriver & {recorded: () => {outputs: number, brightness: number|null, power: boolean, builtin: string|null}}}
 */
export function createShadowDriver(options) {
  const pixoo = options.type === "pixoo";
  const width = pixoo ? 64 : 32;
  const height = pixoo ? 64 : 8;
  let ready = false;
  let closed = false;
  const record = { outputs: 0, brightness: /** @type {number|null} */ (null), power: true, builtin: /** @type {string|null} */ (null) };
  /** @type {import('../types.js').Frame|null} */
  let lastFrame = null;
  const check = () => { if (closed) throw new DeviceError("Shadow driver closed"); };
  return {
    info: { type: options.type, width, height, brightness: { min: pixoo ? 1 : 0, max: pixoo ? 100 : 255 }, drives: false },
    get ready() { return ready; },
    async init() { check(); ready = true; },
    async probe() { check(); return { at: new Date(options.clock.now()).toISOString() }; },
    async show(output) {
      check();
      lastFrame = output.kind === "frame" ? copyFrame(output.frame, width, height)
        : options.rasterizeAwtrixApp(output.app).frame;
      record.outputs += 1;
    },
    async blank() { check(); lastFrame = { width, height, rgb: new Uint8Array(width * height * 3) }; record.outputs += 1; },
    async setBrightness(value) { check(); record.brightness = brightness(value, pixoo ? 1 : 0, pixoo ? 100 : 255); },
    async setPower(on) { check(); record.power = on; },
    async activateBuiltin(key) { check(); if (!findBuiltin(options.type, key)) throw new DeviceError(`Unknown built-in ${key}`); record.builtin = key; record.power = key !== "builtin:black"; },
    async reclaim() { check(); record.power = true; record.builtin = null; ready = true; },
    async readTelemetry() { throw new DeviceError("Shadow telemetry unavailable"); },
    readScreen: null,
    previewFrame: () => lastFrame ? { ...lastFrame, rgb: lastFrame.rgb.slice() } : null,
    notify: pixoo ? null : async () => { check(); },
    switchApp: pixoo ? null : async (name) => { check(); record.builtin = name; },
    selectChannel: pixoo ? async (index) => { check(); record.builtin = `channel:${index}`; } : null,
    async close() { closed = true; ready = false; },
    recorded: () => ({ ...record }),
  };
}
