/**
 * Pixoo64 driver: plain HTTP JSON, POST http://<address>/post (matrix D-001 to D-037).
 *
 * Wire contract kept from v1:
 *  - init: {Command:"Draw/ResetHttpGifId"}, 100 ms pause, {Command:"Channel/SetIndex", SelectIndex:3}   (D-002)
 *  - frame: Draw/ResetHttpGifId before every frame (D-026, D-185), then
 *      {Command:"Draw/SendHttpGif", PicNum:1, PicWidth:64, PicHeight:64, PicOffset:0, PicID:<1..9999>, PicSpeed:1000, PicData:<base64 RGB888>}   (D-027, D-028, D-186)
 *    A failed reset is logged and the frame is still sent (v1).
 *  - brightness: {Command:"Channel/SetBrightness", Brightness:<1..100>}, rounded and clamped, floor 1 (D-006, D-196)
 *  - screen: {Command:"Channel/OnOffScreen", OnOff:1|0}   channel: {Command:"Channel/SetIndex", SelectIndex:n}
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

import { todo } from "../core/todo.js";

/** @typedef {import("./driver.js").DeviceDriver} DeviceDriver */

/**
 * @param {import("./driver.js").DriverOptions} options
 * @returns {DeviceDriver}
 */
export function createPixooDriver(options) {
  return todo("createPixooDriver", options);
}
