/**
 * Pixoo64 driver: plain HTTP JSON, POST http://<address>/post (matrix D-001 to D-037).
 *
 * Wire contract kept from v1:
 *  - init: {Command:"Draw/ResetHttpGifId"}, 100 ms pause, {Command:"Channel/SetIndex", SelectIndex:3}   (D-002)
 *  - frame: Draw/ResetHttpGifId before every frame (D-026, D-185), then
 *      {Command:"Draw/SendHttpGif", PicNum:1, PicWidth:64, PicHeight:64, PicOffset:0, PicID:<1..9999>, PicSpeed:1000, PicData:<base64 RGB888>}   (D-027, D-028, D-186)
 *    A failed reset is logged and the frame is still sent (v1).
 *  - brightness: {Command:"Channel/SetBrightness", Brightness:<1..100>}, rounded and clamped, floor 1 (D-006, D-196)
 *  - screen: {Command:"Channel/OnOffScreen", OnOff:1|0}
 *  - channel: {Command:"Channel/SetIndex", SelectIndex:n}; built-in modes use the indexes of builtin-modes.js,
 *    selectChannel(index) forwards any index a scene asks for, unchanged (D-008)
 *  - telemetry: {Command:"Channel/GetAllConf"} → Brightness, CurClockId (D-183)
 *  - success: HTTP 2xx and error_code absent, 0 or "0"; an unparseable 2xx body counts as success (D-033, D-034)
 *  - 5 s deadline per request; timeout text "Pixoo HTTP timeout after 5000ms" (D-035)
 *
 * Fixed: a deadline that fires while the body is read is a failure, not a
 * success (D-B01); `ready` is cleared on every failure (D-B02); requests are
 * serialised (D-B03); the transmitted bytes are the ones stored for the
 * preview (D-029); telemetry and driver agree on error_code (D-B22).
 *
 * Owner: drivers worker.
 */

import { DeviceError } from "../core/errors.js";
import { findBuiltin } from "./builtin-modes.js";
import { brightness, copyFrame, createTransport } from "./http-transport.js";

/** @typedef {import("./driver.js").DeviceDriver} DeviceDriver */

/**
 * @param {import("./driver.js").DriverOptions} options
 * @returns {DeviceDriver}
 */
export function createPixooDriver(options) {
  const transport = createTransport(options, "Pixoo");
  let picId = 0;
  /** @param {Record<string, unknown>} body @param {AbortSignal} [signal] @returns {Promise<Record<string, unknown>>} */
  async function post(body, signal) {
    try {
      const answer = await transport.request("/post", body, signal);
      const data = answer && typeof answer === "object" ? /** @type {Record<string, unknown>} */ (answer) : {};
      if (data.error_code !== undefined && data.error_code !== 0 && data.error_code !== "0")
        throw new DeviceError(`Pixoo error_code ${String(data.error_code)}`, { device: options.name, op: String(body.Command) });
      return data;
    } catch (error) { transport.ready = false; throw error; }
  }
  async function initialize() {
    await post({ Command: "Draw/ResetHttpGifId" });
    await transport.pause(100);
    await post({ Command: "Channel/SetIndex", SelectIndex: 3 });
    transport.ready = true;
  }
  /** @param {import('../types.js').Frame} frame */
  async function send(frame) {
    const copy = copyFrame(frame, 64, 64);
    if (!transport.ready) await initialize();
    try { await post({ Command: "Draw/ResetHttpGifId" }); }
    catch (error) { options.logger.warn(`[PixooDriver] reset failed: ${String(error)}`); }
    picId = picId % 9999 + 1;
    await post({ Command: "Draw/SendHttpGif", PicNum: 1, PicWidth: 64, PicHeight: 64, PicOffset: 0, PicID: picId, PicSpeed: 1000, PicData: Buffer.from(copy.rgb).toString("base64") });
  }
  return {
    info: { type: "pixoo", width: 64, height: 64, brightness: { min: 1, max: 100 }, drives: true },
    get ready() { return transport.ready; },
    init: () => transport.queue(initialize),
    probe: () => transport.queue(async () => { await post({ Command: "Channel/GetAllConf" }); return { at: new Date(options.clock.now()).toISOString() }; }),
    show: (output) => transport.queue(async () => {
      if (output.kind !== "frame") throw new DeviceError("Pixoo requires an RGB frame");
      await send(output.frame);
    }),
    blank: () => transport.queue(() => send({ width: 64, height: 64, rgb: new Uint8Array(64 * 64 * 3) })),
    setBrightness: (native) => transport.queue(async () => { await post({ Command: "Channel/SetBrightness", Brightness: brightness(native, 1, 100) }); }),
    setPower: (on) => transport.queue(async () => { await post({ Command: "Channel/OnOffScreen", OnOff: on ? 1 : 0 }); }),
    selectChannel: (index) => transport.queue(async () => { await post({ Command: "Channel/SetIndex", SelectIndex: index }); }),
    activateBuiltin: (key) => transport.queue(async () => {
      const mode = findBuiltin("pixoo", key);
      if (!mode) throw new DeviceError(`Unknown Pixoo built-in ${key}`);
      await post({ Command: "Channel/OnOffScreen", OnOff: key === "builtin:black" ? 0 : 1 });
      if (mode.channel !== undefined) await post({ Command: "Channel/SetIndex", SelectIndex: mode.channel });
    }),
    reclaim: () => transport.queue(async () => { await post({ Command: "Channel/OnOffScreen", OnOff: 1 }); await initialize(); }),
    readTelemetry: (readOptions) => transport.queue(async () => {
      const data = await post({ Command: "Channel/GetAllConf" }, readOptions?.signal);
      return { reachable: true, brightness: data.Brightness ?? null, cur_clock_id: data.CurClockId ?? null };
    }),
    readScreen: null, notify: null, switchApp: null,
    close: () => transport.close(),
  };
}
