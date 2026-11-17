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

/** @typedef {import("../types.js").PreviewFrame} PreviewFrame */
/** @typedef {import("../types.js").Frame} Frame */

export class PreviewStore extends EventEmitter {
  /** @param {{clock: import("../types.js").Clock, logger: import("../types.js").Logger}} deps */
  constructor(deps) {
    super();
    this.deps = deps;
    /** @type {Map<string, PreviewFrame>} */
    this.frames = new Map();
    /** @type {Map<string, number>} */
    this.emittedAt = new Map();
    /** @type {Map<string, {stop: () => void, pollMs: number}>} */
    this.feeds = new Map();
  }

  /**
   * Store a frame for a device.
   *
   * @param {string} device
   * @param {Frame} frame copied; the caller may reuse its buffer
   * @param {PreviewFrame["source"]} source
   */
  put(device, frame, source) {
    if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width <= 0 || frame.height <= 0 || !(frame.rgb instanceof Uint8Array) || frame.rgb.length !== frame.width * frame.height * 3) return;
    const previous = this.frames.get(device);
    const now = this.deps.clock.now();
    const next = { device, width: frame.width, height: frame.height, rgb: frame.rgb.slice(), source, receivedAt: new Date(now).toISOString(), seq: (previous?.seq ?? 0) + 1 };
    this.frames.set(device, next);
    const changed = !previous || previous.source !== source || previous.width !== frame.width || previous.height !== frame.height || !Buffer.from(previous.rgb).equals(next.rgb);
    if (changed || now - (this.emittedAt.get(device) ?? -Infinity) >= 1000) {
      this.emittedAt.set(device, now);
      this.emit("frame", { ...next, rgb: next.rgb.slice() });
    }
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
    this.feeds.get(device)?.stop();
    let active = true;
    let busy = false;
    const controller = new AbortController();
    const tick = async () => {
      if (!active || busy || !driver.readScreen) return;
      busy = true;
      try {
        const frame = await driver.readScreen({ signal: controller.signal });
        if (active && frame) this.put(device, frame, "device");
      } catch (error) { if (active) this.deps.logger.debug(`[Preview] ${device}: ${String(error)}`); }
      finally { busy = false; }
    };
    const timer = this.deps.clock.every(() => { void tick(); }, pollMs);
    const stop = () => { active = false; controller.abort(); timer.cancel(); if (this.feeds.get(device)?.stop === stop) this.feeds.delete(device); };
    this.feeds.set(device, { stop, pollMs });
    void tick();
    return stop;
  }

  /**
   * @param {string} device
   * @returns {PreviewFrame|undefined}
   */
  get(device) {
    const frame = this.frames.get(device);
    return frame ? { ...frame, rgb: frame.rgb.slice() } : undefined;
  }

  /** @returns {PreviewFrame[]} */
  list() {
    return [...this.frames.values()].map((frame) => ({ ...frame, rgb: frame.rgb.slice() }));
  }

  /**
   * v1 GET /api/previews: {<device>: {width, height, data (base64 RGB24), source, intervalMs, updatedAt}} (A-129, B-053).
   * "simulated" is reported as "runtime" to old readers such as scripts/preview-to-png.js.
   *
   * @returns {Record<string, {width: number, height: number, data: string, source: "runtime"|"device", intervalMs: number, updatedAt: string}>}
   */
  toV1() {
    return Object.fromEntries(this.list().map((frame) => [frame.device, {
      width: frame.width, height: frame.height, data: Buffer.from(frame.rgb).toString("base64"),
      source: frame.source === "simulated" ? "runtime" : frame.source,
      intervalMs: this.feeds.get(frame.device)?.pollMs ?? 0, updatedAt: frame.receivedAt,
    }]));
  }

  /** Forget a device that left the config. @param {string} device */
  remove(device) {
    this.feeds.get(device)?.stop();
    this.frames.delete(device);
    this.emittedAt.delete(device);
  }
}
