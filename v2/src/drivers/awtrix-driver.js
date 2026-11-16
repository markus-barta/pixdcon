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

import { todo } from "../core/todo.js";

/** @typedef {import("./driver.js").DeviceDriver} DeviceDriver */

/**
 * @param {import("./driver.js").DriverOptions} options
 * @returns {DeviceDriver}
 */
export function createAwtrixDriver(options) {
  return todo("createAwtrixDriver", options);
}

/**
 * Convert an AWTRIX /api/screen answer to a 32×8 RGB frame, accepting the
 * shapes v1 accepts (matrix B-051). Returns null for anything else.
 *
 * @param {unknown} screen
 * @returns {import("../types.js").Frame|null}
 */
export function screenToFrame(screen) {
  return todo("screenToFrame", screen);
}
