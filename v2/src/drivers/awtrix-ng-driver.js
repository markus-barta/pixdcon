/**
 * Ulanzi TC001 on AWTRIX NG firmware: plain HTTP to http://<address>/api/v1 (PIXD, OPS-653).
 *
 * AWTRIX NG (the successor of the archived AWTRIX 3) has its own API and validates every
 * payload strictly: one unknown key rejects the whole request. Scenes keep producing AWTRIX 3
 * custom-app payloads; this driver translates them at the edge (`translateApp`), so the scene
 * surface, the shadow preview and the rasterizer stay AWTRIX 3.
 *
 * Wire contract:
 *  - init: GET /api/v1/device (reachability), then PATCH /api/v1/settings {"autoTransition": false}
 *          so the firmware does not rotate away from pixdcon's app (the AWTRIX 3 clocks run ATRANS off)
 *  - app:   PUT /api/v1/apps/pushed/pixdcon_<device> with the translated payload, then
 *           PUT /api/v1/apps/active {"name": "pixdcon_<device>", "fast": true}; a failed switch is
 *           logged and does not fail the frame (as the AWTRIX 3 driver)
 *  - raw frame and blank: the same pushed app with one ["bitmap", 0, 0, 32, 8, <base64 RGB888>]
 *  - brightness: PATCH /api/v1/settings {"brightness": 0..255}; autoBrightness is left alone
 *  - power: PATCH /api/v1/display {"power": true|false}
 *  - built-in app: PUT /api/v1/apps/active {"name": "Time"|"Date"|…}
 *  - notification (facade only): POST /api/v1/notifications with the translated payload
 *  - telemetry: GET /api/v1/device, mapped to the AWTRIX 3 /api/stats field names the HA
 *    discovery uses (uid, version, uptime, bat, bat_raw, wifi_signal, ram, temp, hum, lux,
 *    messages, app, bri, matrix), NG's own fields kept beside them
 *  - screen: GET /api/v1/display/screen → {width, height, pixels: 256 decimal 0xRRGGBB}
 *  - legacy-app cleanup: not needed; NG does not keep pushed apps across a restart
 *
 * Owner: drivers worker.
 */

import { DeviceError } from "../core/errors.js";
import { findBuiltin } from "./builtin-modes.js";
import { brightness, copyFrame, createTransport } from "./http-transport.js";
import { screenToFrame } from "./awtrix-driver.js";

/** @typedef {import("./driver.js").DeviceDriver} DeviceDriver */

/**
 * @param {import("./driver.js").DriverOptions} options
 * @returns {DeviceDriver}
 */
export function createAwtrixNgDriver(options) {
  const transport = createTransport(options, "AWTRIX-NG");
  const appName = `pixdcon_${options.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const pushedPath = `/api/v1/apps/pushed/${encodeURIComponent(appName)}`;
  const warned = new Set();
  const warn = (/** @type {string} */ key) => {
    if (warned.has(key)) return;
    warned.add(key);
    options.logger.warn(`[UlanziNgDriver] ${options.name}: AWTRIX 3 key "${key}" has no AWTRIX NG equivalent, dropped`);
  };
  let hasApp = false;
  /** @param {AbortSignal} [signal] @returns {Promise<Record<string, unknown>>} */
  async function device(signal) {
    const data = await transport.request("/api/v1/device", undefined, signal);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new DeviceError("AWTRIX-NG invalid device answer");
    return /** @type {Record<string, unknown>} */ (data);
  }
  async function initialize() {
    const data = await device();
    await transport.request("/api/v1/settings", { autoTransition: false }, undefined, "PATCH");
    options.logger.info(`[UlanziNgDriver] Initialized ${options.address} (AWTRIX NG ${data.version ?? "?"}, battery: ${data.batteryPercent ?? "AC"}%)`);
    transport.ready = true;
  }
  /** @param {Record<string, unknown>} payload */
  async function push(payload) {
    await transport.request(pushedPath, payload, undefined, "PUT");
    hasApp = true;
    try { await transport.request("/api/v1/apps/active", { name: appName, fast: true }, undefined, "PUT"); }
    catch (error) { transport.ready = false; options.logger.warn(`[UlanziNgDriver] switchToApp failed: ${String(error)}`); }
  }
  /** @param {import('../types.js').Frame} frame */
  const bitmap = (frame) => {
    const copy = copyFrame(frame, 32, 8);
    return { draw: [["bitmap", 0, 0, 32, 8, Buffer.from(copy.rgb).toString("base64")]] };
  };
  const switchTo = (/** @type {string} */ name) => transport.request("/api/v1/apps/active", { name, fast: true }, undefined, "PUT");
  return {
    info: { type: "ulanzi", width: 32, height: 8, brightness: { min: 0, max: 255 }, drives: true },
    get ready() { return transport.ready; },
    init: () => transport.queue(initialize),
    probe: () => transport.queue(async () => { await device(); return { at: new Date(options.clock.now()).toISOString() }; }),
    show: (output) => transport.queue(async () => {
      if (!transport.ready) await initialize();
      await push(output.kind === "frame" ? bitmap(output.frame) : translateApp(output.app, warn));
    }),
    blank: () => transport.queue(() => push(bitmap({ width: 32, height: 8, rgb: new Uint8Array(32 * 8 * 3) }))),
    setBrightness: (native) => transport.queue(async () => {
      await transport.request("/api/v1/settings", { brightness: brightness(native, 0, 255) }, undefined, "PATCH");
    }),
    setPower: (on) => transport.queue(async () => { await transport.request("/api/v1/display", { power: on }, undefined, "PATCH"); }),
    activateBuiltin: (key) => transport.queue(async () => {
      const mode = findBuiltin("ulanzi", key);
      if (!mode?.app) throw new DeviceError(`Unknown AWTRIX built-in ${key}`);
      await transport.request("/api/v1/display", { power: true }, undefined, "PATCH");
      await switchTo(mode.app);
    }),
    reclaim: () => transport.queue(async () => {
      await transport.request("/api/v1/display", { power: true }, undefined, "PATCH");
      await initialize();
      // A fresh display (or one that restarted) has no pushed app; show() creates it before selecting it.
      if (hasApp) {
        try { await switchTo(appName); } catch (error) { hasApp = false; transport.ready = false; throw error; }
      }
    }),
    readTelemetry: (readOptions) => transport.queue(async () => statsFromDevice(await device(readOptions?.signal))),
    readScreen: (readOptions) => transport.queue(async () => {
      const screen = /** @type {any} */ (await transport.request("/api/v1/display/screen", undefined, readOptions?.signal));
      if (!screen || screen.width !== 32 || screen.height !== 8) return null;
      return screenToFrame(screen.pixels);
    }),
    notify: (notification) => transport.queue(async () => {
      await transport.request("/api/v1/notifications", translateApp(notification, warn), undefined, "POST");
    }),
    switchApp: (name) => transport.queue(async () => { await switchTo(name); }),
    selectChannel: null,
    close: async () => { await transport.close(); },
  };
}

/**
 * AWTRIX NG /api/v1/device → the AWTRIX 3 /api/stats names pixdcon's HA discovery and status use,
 * with every NG field kept as well.
 *
 * @param {Record<string, unknown>} d
 * @returns {Record<string, unknown>}
 */
export function statsFromDevice(d) {
  /** @type {Record<string, unknown>} */
  const mapped = {
    uid: d.uid, version: d.version, uptime: d.uptimeSeconds, bat: d.batteryPercent, bat_raw: d.batteryPinMillivolts,
    wifi_signal: d.wifiRssi, ram: d.freeHeapBytes, temp: d.temperature, hum: d.humidity, lux: d.lightLevel,
    messages: d.messageCount, app: d.currentApp, bri: d.brightness, matrix: d.matrixPower, ip_address: d.ipAddress,
    firmware: "awtrix-ng",
  };
  for (const [key, value] of Object.entries(mapped)) if (value === undefined) delete mapped[key];
  return { ...d, ...mapped };
}

const DRAW = /** @type {Record<string, string>} */ ({
  dp: "pixel", dl: "line", dr: "rect", df: "rectFill", dc: "circle", dfc: "circleFill", dt: "text", db: "bitmap",
});
const RENAME = /** @type {Record<string, string>} */ ({
  color: "textColor", background: "backgroundColor", textOffset: "textOffsetX", blinkText: "textBlinkMs",
  fadeText: "textFadeMs", bar: "barChart", line: "lineChart", autoscale: "chartAutoscale",
  progressC: "progressColor", progressBC: "progressTrackColor",
});
const KEEP = new Set(["text", "icon", "progress", "effect", "repeat", "hold", "stack", "wakeup", "sound"]);

/**
 * Translate an AWTRIX 3 custom-app or notification payload to AWTRIX NG (key map of the NG guide
 * "Coming from AWTRIX 3"). Keys without an equivalent are dropped with one warning each, because NG
 * rejects the whole payload for a single unknown key.
 *
 * @param {Record<string, unknown>} app
 * @param {(key: string) => void} [warn]
 * @returns {Record<string, unknown>}
 */
export function translateApp(app, warn = () => {}) {
  /** @type {Record<string, any>} */
  const out = {};
  /** @type {Record<string, unknown>} */
  const scroll = {};
  for (const [key, value] of Object.entries(app ?? {})) {
    if (value === undefined) continue;
    if (key === "draw") out.draw = translateDraw(value, warn);
    else if (key === "text") out.text = Array.isArray(value)
      ? value.map((f) => (f && typeof f === "object" && !Array.isArray(f)) ? { text: f.t ?? f.text ?? "", ...((f.c ?? f.color) !== undefined ? { color: f.c ?? f.color } : {}) } : f)
      : value;
    else if (key in RENAME) out[RENAME[key]] = value;
    else if (KEEP.has(key)) out[key] = key === "repeat" && value === -1 ? 0 : key === "icon" ? iconOf(value) : value;
    else if (key === "center") out.textAlign = value ? "center" : "start";
    else if (key === "textCase") out.textCase = ["inherit", "upper", "asTyped"][Number(value)] ?? "inherit";
    else if (key === "pushIcon") out.iconMode = ["fixed", "pushOnce", "push"][Number(value)] ?? "fixed";
    else if (key === "duration") out.durationMs = Number(value) * 1000;
    else if (key === "lifetime") out.lifetimeMs = Number(value) * 1000;
    else if (key === "lifetimeMode") out.lifetimeExpiry = Number(value) === 1 ? "mark" : "remove";
    else if (key === "noScroll") { if (value) scroll.mode = "static"; }
    else if (key === "scrollSpeed") scroll.speed = value;
    else if (key === "overlay") out.overlay = value === "clear" ? "" : value;
    else if (key === "rainbow") { if (value) { out.palette = "Rainbow"; out.textColor = "palette"; } }
    else if (key === "gradient") { out.palette = value; out.textColor = "palette"; }
    else if (key === "rtttl") out.sound = { rtttl: value };
    else if (key === "loopSound") { if (value) out.sound = { ...(typeof out.sound === "object" ? out.sound : { file: out.sound }), loop: true }; }
    else warn(key); // pos, save, topText, barBC, clients, effectSettings and anything unknown
  }
  if (Object.keys(scroll).length) out.scroll = scroll;
  // gradient/rainbow must keep textColor "palette" even when a plain color came first
  if (out.palette !== undefined && (app?.rainbow || app?.gradient)) out.textColor = "palette";
  return out;
}

/** @param {unknown} draw @param {(key: string) => void} warn */
function translateDraw(draw, warn) {
  if (!Array.isArray(draw)) return [];
  /** @type {unknown[]} */
  const out = [];
  for (const command of draw) {
    if (Array.isArray(command)) { out.push(command); continue; } // already NG
    if (!command || typeof command !== "object") continue;
    for (const [code, args] of Object.entries(command)) {
      const name = DRAW[code];
      if (!name || !Array.isArray(args)) { warn(`draw.${code}`); continue; }
      out.push([name, ...args]);
    }
  }
  return out;
}

/** AWTRIX 3 accepted inline base64 without a prefix; NG needs a data URL. Ids pass unchanged. */
function iconOf(/** @type {unknown} */ icon) {
  if (typeof icon !== "string" || icon.length < 64 || icon.startsWith("data:") || /^[A-Za-z0-9_-]{1,40}$/.test(icon)) return icon;
  return `data:image/gif;base64,${icon}`;
}
