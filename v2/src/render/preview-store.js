/**
 * Preview store: the last frame of every display, for the UI and the v1 route.
 *
 * Sources (matrix B-049 to B-053, D-133 to D-137):
 *  - Pixoo: the exact bytes of every frame the display accepted ("runtime")
 *  - Ulanzi, driven: the display's own screen, read back every preview.pollMs
 *    (1000 to 10000, default 2000), one request at a time ("device")
 *  - shadow output and fake devices: the rendered frame, AWTRIX apps rasterised ("simulated")
 *
 * Kept: one frame per device; `receivedAt` is when a frame was last received,
 * not when the picture changed (B-172; UI wording "last frame", build rule 5).
 * A late result of a replaced driver never overwrites a newer frame (D-136, D-137).
 *
 * Fixed: the last frame survives a restart of the device runtime (B-052); a
 * frame is validated before it is stored (B-180); events are sent only when a
 * frame changed or 1 s passed, so the live channel keeps the 1 s cadence of
 * the approved spec without resending identical bytes (B-053).
 *
 * Events (EventEmitter): "frame" (PreviewFrame).
 *
 * Owner: drivers worker.
 */

import { EventEmitter } from "node:events";
import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").PreviewFrame} PreviewFrame */
/** @typedef {import("../types.js").Frame} Frame */

export class PreviewStore extends EventEmitter {
  /** @param {{clock: import("../types.js").Clock, logger: import("../types.js").Logger}} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /**
   * Store a frame for a device.
   *
   * @param {string} device
   * @param {Frame} frame copied; the caller may reuse its buffer
   * @param {PreviewFrame["source"]} source
   */
  put(device, frame, source) {
    return todo("PreviewStore.put", device, frame, source);
  }

  /**
   * Read the screen of a driven Ulanzi back at the device's poll interval.
   *
   * @param {string} device
   * @param {import("../drivers/driver.js").DeviceDriver} driver must offer readScreen
   * @param {number} pollMs
   * @returns {() => void} stop this feed
   */
  feedFromDevice(device, driver, pollMs) {
    return todo("PreviewStore.feedFromDevice", device, driver, pollMs);
  }

  /**
   * @param {string} device
   * @returns {PreviewFrame|undefined}
   */
  get(device) {
    return todo("PreviewStore.get", device);
  }

  /** @returns {PreviewFrame[]} */
  list() {
    return todo("PreviewStore.list");
  }

  /**
   * v1 GET /api/previews: {<device>: {width, height, data (base64 RGB24), source, intervalMs, updatedAt}} (A-129, B-053).
   * "simulated" is reported as "runtime" to old readers such as scripts/preview-to-png.js.
   *
   * @returns {Record<string, {width: number, height: number, data: string, source: "runtime"|"device", intervalMs: number, updatedAt: string}>}
   */
  toV1() {
    return todo("PreviewStore.toV1");
  }

  /** Forget a device that left the config. @param {string} device */
  remove(device) {
    return todo("PreviewStore.remove", device);
  }
}
