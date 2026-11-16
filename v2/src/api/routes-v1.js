/**
 * v1-compatible HTTP routes.
 *
 * v1's API was written for its own page, but other things read it: the deploy
 * check reads GET /api/status (matrix A-179), scripts/preview-to-png.js reads
 * GET /api/previews (B-054), POST /api/overlay/clear was the PIXD-75
 * workaround, and nobody knows who calls POST /api/overlay (A-147). So every
 * v1 route stays, with its request and answer shape, backed by the v2 state
 * model. The v2 UI does not use these routes.
 *
 * Differences that the matrix marks as fixes are named per route. One applies
 * to all writes: they need Content-Type: application/json (http-server.js).
 * Not carried: GET /tailwind.css (A-125), v2 has no Tailwind build.
 *
 * Owner: API + live channel worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("./http-server.js").RouteMeta} RouteMeta */

/**
 * The v1 route table. `rows` are the matrix rows that describe the v1 behaviour.
 *
 * @type {ReadonlyArray<{method: string, path: string} & RouteMeta>}
 */
export const V1_ROUTES = Object.freeze([
  {
    method: "GET",
    path: "/vendor/inspr-versioning/:file",
    summary:
      "File of the pinned version presentation bundle; only the six files of its manifest",
    ok: "file bytes, no-cache, nosniff",
    errors: "404 outside the allow-list",
    rows: "A-126",
  },
  {
    method: "GET",
    path: "/api/config",
    summary: "The running config with overlays applied",
    ok: "{devices[], scenes{}, …} in the v1 shape; v2 bookkeeping keys left out",
    rows: "A-127",
  },
  {
    method: "GET",
    path: "/api/config/file",
    summary: "config.json as saved, normalised, without overlays",
    ok: "{devices[], scenes{}, …}",
    errors: "409 config_invalid when the file on disk is unreadable or invalid",
    rows: "A-134",
  },
  {
    method: "POST",
    path: "/api/config/file",
    summary: "Replace config.json with the posted config after validating it",
    body: "a complete config object",
    ok: "{ok: true}",
    errors: "400 invalid_config, 413",
    rows: "A-135",
  },
  {
    method: "GET",
    path: "/api/scenes",
    summary:
      "Scene metadata by key, plus `builtins` per device type (v1 shape; a scene key 'builtins' is hidden by it, use /api/v2/scenes)",
    ok: "{<key>: {key, path, name, pretty_name, description, deviceType, settingsSchema}, builtins: {ulanzi: [], pixoo: []}}",
    rows: "A-130",
  },
  {
    method: "GET",
    path: "/api/scene-settings",
    summary:
      "Saved, overlay and effective setting values per device for its current scene",
    ok: "{<device>: {<scene>: {saved, overlay, effective}}}",
    rows: "A-128",
  },
  {
    method: "GET",
    path: "/api/previews",
    summary: "The last frame of every device that has one",
    ok: "{<device>: {width, height, data: base64 RGB24, source: 'runtime'|'device', intervalMs, updatedAt}}",
    rows: "A-129, B-053",
  },
  {
    method: "GET",
    path: "/api/status",
    summary:
      "MQTT connection, version, and mode, brightness, health and scene per device",
    ok: "{mqttConnected, version, version_scheme, deviceModes, deviceBrightness: {<d>: {override, last}}, deviceHealth: {<d>: {online, consecutiveErrors, lastSuccessAgoMs, ip, type, apSsid}}, deviceScenes}; `online` follows the measured state (not offline)",
    rows: "A-131, A-133, C-087",
  },
  {
    method: "POST",
    path: "/api/device",
    summary: "Add a device without a scene",
    body: "{name, type, ip}",
    ok: "{ok: true}",
    errors:
      "400 missing or invalid field, 409 duplicate name, 409 config_invalid",
    rows: "A-136",
  },
  {
    method: "POST",
    path: "/api/scene",
    summary:
      "Choose a device's scene: saved, applied at once, scene overlays of the device superseded",
    body: "{deviceName, scene} (scene: string, '' or null for none)",
    ok: "{ok: true} or {ok: true, persisted: false} when config.json is invalid on disk",
    errors:
      "400 {ok: false, error} without deviceName or for an unknown scene (fix: v1 accepted any string), 404 {ok: false, error} unknown device",
    rows: "A-149, A-150, A-151, C-076",
  },
  {
    method: "POST",
    path: "/api/scene-settings/save",
    summary:
      "Replace the saved settings of one device and scene with the given values (v1 semantics; the v2 route changes single keys)",
    body: "{deviceName, sceneName, values: object}",
    ok: "{ok: true, saved: {…}}",
    errors:
      "400 values not an object (fix), 404 unknown device or scene (fix), 409 config_invalid",
    rows: "A-137, A-190",
  },
  {
    method: "POST",
    path: "/api/scene-settings/overlay",
    summary: "Store setting values as retained MQTT overlays",
    body: "{deviceName, sceneName, values}",
    ok: "{ok: true, overlay: {…}}",
    errors:
      "503 mqtt_offline (fix: v1 answered 500), 404 unknown device or scene",
    rows: "A-138, C-098",
  },
  {
    method: "POST",
    path: "/api/scene-settings/overlay/clear",
    summary: "Clear the setting overlays of one device and scene",
    body: "{deviceName, sceneName}",
    ok: "{ok: true, overlay: {…keys that could not be cleared…}}",
    errors: "503 mqtt_offline",
    rows: "A-139, C-102",
  },
  {
    method: "POST",
    path: "/api/scene/clone",
    summary:
      "Copy a scene file under a new key, or re-point the key to a generated copy",
    body: "{sceneName, targetSceneKey, targetPrettyName?, overwrite?}",
    ok: "{ok: true, sceneKey, path}",
    errors: "400 validation, 404 unknown scene, 409 key or file exists",
    rows: "A-140 to A-146, A-195, A-196",
  },
  {
    method: "POST",
    path: "/api/overlay",
    summary: "Store a retained scene overlay for a device",
    body: "{deviceName, scene}",
    ok: "{ok: true}",
    errors:
      "400 without deviceName (fix), 404 unknown device (fix), 503 mqtt_offline or publish not confirmed (fix)",
    rows: "A-147, C-074",
  },
  {
    method: "POST",
    path: "/api/overlay/clear",
    summary: "Clear a device's retained scene overlay",
    body: "{deviceName}",
    ok: "{ok: true}",
    errors: "503 mqtt_offline",
    rows: "A-148, C-075",
  },
  {
    method: "POST",
    path: "/api/mode",
    summary: "Play, pause or stop a device",
    body: "{deviceName, mode}",
    ok: "{ok: true}",
    errors: "400 invalid mode, 404 unknown device (fix), 503 mqtt_offline",
    rows: "A-152, C-072",
  },
  {
    method: "POST",
    path: "/api/brightness",
    summary: "Set or clear a device's brightness override in percent",
    body: "{deviceName, enabled, value}",
    ok: "{ok: true}",
    errors:
      "400 value outside 1 to 100 (fix), 404 unknown device (fix), 503 mqtt_offline",
    rows: "A-153, C-073",
  },
]);

/**
 * @typedef {object} ApiDeps What route handlers may use. Built by main.js.
 * @property {import("../config/config-store.js").ConfigStore} config
 * @property {import("../state/state-store.js").StateStore} state
 * @property {import("../overlay/overlay-service.js").OverlayService} overlays
 * @property {import("../scenes/scene-registry.js").SceneRegistry} scenes
 * @property {import("../scenes/settings-service.js").SettingsService} settings
 * @property {import("../render/preview-store.js").PreviewStore} previews
 * @property {import("../render/scheduler.js").Scheduler} scheduler
 * @property {import("../health/health-model.js").HealthModel} health
 * @property {import("../health/telemetry.js").TelemetryCollector|null} telemetry
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway|null} mqtt
 * @property {import("./live-channel.js").LiveChannel} live
 * @property {ReturnType<typeof import("../core/logger.js").createLogger>} logger
 * @property {import("../types.js").Clock} clock
 * @property {() => import("../types.js").ControllerStatus} controller
 */

/**
 * Register every v1 route. In the skeleton each one answers 501.
 *
 * @param {import("./http-server.js").HttpServer} server
 * @param {ApiDeps} deps
 */
export function registerV1Routes(server, deps) {
  for (const { method, path, ...meta } of V1_ROUTES) {
    server.route(
      method,
      path,
      (ctx) => todo(`${method} ${path}`, ctx, deps),
      meta,
    );
  }
}
