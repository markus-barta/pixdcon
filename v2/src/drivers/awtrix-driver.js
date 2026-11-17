/**
 * Ulanzi TC001 / AWTRIX driver: plain HTTP to http://<address> (matrix D-051 to D-086).
 *
 * Wire contract kept from v1:
 *  - init: GET /api/stats (reachability); with cleanupLegacyApps, once per
 *    process and device: GET /list?dir=/CUSTOMAPPS, then POST /api/custom?name=<app>
 *    with an empty body for every *.json that is not pixdcon_<device>.json (D-055 to D-062)
 *  - app:   POST /api/custom?name=pixdcon_<device> with the scene's JSON unchanged,
 *           then POST /api/switch {"name":"pixdcon_<device>"}; a failed switch
 *           is logged and does not fail the frame (D-067 to D-069, D-111)
 *  - raw frame and blank: POST /api/draw {"matrix": <base64 768 RGB bytes>} (D-063 to D-066;
 *           firmware support unverified, D-193: keep, and check on a real display before switch-over)
 *  - brightness: POST /api/settings {"BRI": <0..255>}; ABRI is left alone (D-076, D-166)
 *  - power: POST /api/power {"power": true|false}
 *  - built-in app: POST /api/switch {"name":"Time"|"Date"|"Temperature"|"Humidity"|"Battery"}
 *  - notification (facade only): POST /api/notify
 *  - telemetry: GET /api/stats, every field passed through (C-114)
 *  - screen: GET /api/screen; 768 RGB numbers, or 256 packed or hex colours, also nested (B-051, D-134)
 *  - 5 s deadline per request including the body (D-073)
 *
 * Fixed: failures reject instead of returning false; the cleanup is retried
 * until one sweep completed, and one bad entry no longer stops the sweep
 * (D-B05, D-B06); brightness is validated (D-B09); a zero battery is logged as
 * 0 %, not as "AC" (D-B15).
 *
 * Owner: drivers worker.
 */

import { DeviceError } from "../core/errors.js";
import { findBuiltin } from "./builtin-modes.js";
import { brightness, copyFrame, createTransport } from "./http-transport.js";

/** @typedef {import("./driver.js").DeviceDriver} DeviceDriver */

// A runtime rebuild must not repeat a completed flash cleanup on the same device.
const cleanedDevices = new Set();

/**
 * @param {import("./driver.js").DriverOptions} options
 * @returns {DeviceDriver}
 */
export function createAwtrixDriver(options) {
  const transport = createTransport(options, "AWTRIX");
  const appName = `pixdcon_${options.name}`;
  const appPath = (/** @type {string} */ name) => `/api/custom?name=${encodeURIComponent(name)}`;
  const cleanupKey = `${options.name}@${options.address}`;
  let cleanupDone = cleanedDevices.has(cleanupKey);
  let hasApp = false;
  /** @param {AbortSignal} [signal] @returns {Promise<Record<string, unknown>>} */
  async function stats(signal) {
    const data = await transport.request("/api/stats", undefined, signal);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new DeviceError("AWTRIX invalid stats");
    return /** @type {Record<string, unknown>} */ (data);
  }
  async function initialize() {
    const data = await stats();
    options.logger.info(`[UlanziDriver] Initialized ${options.address} (battery: ${data.bat ?? "AC"}%)`);
    if (options.cleanupLegacyApps && !cleanupDone) {
      try {
        const files = await transport.request("/list?dir=/CUSTOMAPPS");
        if (!Array.isArray(files)) throw new DeviceError("AWTRIX invalid app list");
        let complete = true;
        for (const file of files) {
          if (file?.type !== "file" || typeof file.name !== "string" || !file.name.endsWith(".json") || file.name === `${appName}.json`) continue;
          try { await transport.request(appPath(file.name.slice(0, -5)), ""); }
          catch (error) { complete = false; options.logger.warn(`[UlanziDriver] cleanup: ${String(error)}`); }
        }
        cleanupDone = complete;
        if (complete) cleanedDevices.add(cleanupKey);
      } catch (error) { options.logger.warn(`[UlanziDriver] cleanup: ${String(error)}`); }
    }
    // An incomplete sweep is retried by the next lazy init; frames can still be sent.
    transport.ready = !options.cleanupLegacyApps || cleanupDone;
  }
  /** @param {import('../types.js').Frame} frame */
  async function send(frame) {
    const copy = copyFrame(frame, 32, 8);
    await transport.request("/api/draw", { matrix: Buffer.from(copy.rgb).toString("base64") });
  }
  return {
    info: { type: "ulanzi", width: 32, height: 8, brightness: { min: 0, max: 255 }, drives: true },
    get ready() { return transport.ready; },
    init: () => transport.queue(initialize),
    probe: () => transport.queue(async () => { await stats(); return { at: new Date(options.clock.now()).toISOString() }; }),
    show: (output) => transport.queue(async () => {
      if (!transport.ready) await initialize();
      if (output.kind === "frame") await send(output.frame);
      else {
        await transport.request(appPath(appName), output.app);
        hasApp = true;
        try { await transport.request("/api/switch", { name: appName }); }
        catch (error) { transport.ready = false; options.logger.warn(`[UlanziDriver] switchToApp failed: ${String(error)}`); }
      }
    }),
    blank: () => transport.queue(() => send({ width: 32, height: 8, rgb: new Uint8Array(32 * 8 * 3) })),
    setBrightness: (native) => transport.queue(async () => { await transport.request("/api/settings", { BRI: brightness(native, 0, 255) }); }),
    setPower: (on) => transport.queue(async () => { await transport.request("/api/power", { power: on }); }),
    activateBuiltin: (key) => transport.queue(async () => {
      const mode = findBuiltin("ulanzi", key);
      if (!mode) throw new DeviceError(`Unknown AWTRIX built-in ${key}`);
      await transport.request("/api/power", { power: true });
      await transport.request("/api/switch", { name: mode.app });
    }),
    reclaim: () => transport.queue(async () => {
      await transport.request("/api/power", { power: true });
      await initialize();
      // A fresh display may have no custom app yet; show() creates it before selecting it.
      if (hasApp) await transport.request("/api/switch", { name: appName });
    }),
    readTelemetry: (readOptions) => transport.queue(() => stats(readOptions?.signal)),
    readScreen: (readOptions) => transport.queue(async () => screenToFrame(await transport.request("/api/screen", undefined, readOptions?.signal))),
    notify: (notification) => transport.queue(async () => { await transport.request("/api/notify", notification); }),
    switchApp: (name) => transport.queue(async () => { await transport.request("/api/switch", { name }); }),
    selectChannel: null,
    close: () => transport.close(),
  };
}

/**
 * Convert an AWTRIX /api/screen answer to a 32×8 RGB frame, accepting the
 * shapes v1 accepts (matrix B-051). Returns null for anything else.
 *
 * @param {unknown} screen
 * @returns {import("../types.js").Frame|null}
 */
export function screenToFrame(screen) {
  if (!Array.isArray(screen)) return null;
  const flat = screen.flat(Infinity);
  const rgb = new Uint8Array(32 * 8 * 3);
  if (flat.length === rgb.length) {
    if (!flat.every((v) => typeof v === "number")) return null;
    rgb.set(flat.map((v) => Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0));
  } else if (flat.length === 256) {
    for (let i = 0; i < flat.length; i++) {
      const color = typeof flat[i] === "string" ? flat[i].trim() : flat[i];
      const value = typeof color === "string" && /^(?:#|0x)?[0-9a-f]{6}$/i.test(color)
        ? Number.parseInt(color.replace(/^(#|0x)/i, ""), 16) : color;
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      rgb[i * 3] = value >> 16;
      rgb[i * 3 + 1] = (value >> 8) & 255;
      rgb[i * 3 + 2] = value & 255;
    }
  } else return null;
  return { width: 32, height: 8, rgb };
}
