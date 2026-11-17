/**
 * v2 HTTP routes: what the approved UI is built on.
 *
 * Principles (approved spec section 8, Tick's build rules 1 to 5):
 *  - Every write changes one thing on one device and answers with the applied
 *    state (DeviceView, SettingsState). No route takes a whole config from the
 *    browser except the raw editor (matrix S-1, S-3, C-220).
 *  - Every view carries `epoch` and `rev`. The page applies an answer or an
 *    event only when its epoch is the one of the snapshot it holds and its
 *    rev is newer than what it shows (B-177).
 *  - Errors are {error, code}; `error` is one sentence for a person, shown
 *    beside the control that caused it (B-175). Codes used across routes:
 *    unknown_device, unknown_scene, unknown_overlay, invalid_mode,
 *    invalid_brightness, invalid_field, invalid_config, config_invalid (file on
 *    disk), overlay_only_device, not_overlay_only, mqtt_offline,
 *    shadow_output, not_implemented.
 *  - Reads are cheap and side-effect free. The page normally needs only
 *    GET /api/v2/bootstrap and the live channel.
 *
 * Owner: API + live channel worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("./http-server.js").RouteMeta} RouteMeta */

/** @type {ReadonlyArray<{method: string, path: string} & RouteMeta>} */
export const V2_ROUTES = Object.freeze([
  // --- everything at once, and live -------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v2/bootstrap",
    summary:
      "Everything a page needs in one answer (replaces v1's five load requests, B-062)",
    ok: "Snapshot",
  },
  {
    method: "GET",
    path: "/api/v2/events",
    summary:
      "Live channel, server-sent events. Query: session=<page id>, since=<epoch>-<seq>, log=1 to include log lines. A cursor of another epoch gets a snapshot",
    ok: "text/event-stream of LiveEvent with id <epoch>-<seq>, see live-channel.js",
    rows: "A-123, B-063, B-177",
  },

  // --- devices ----------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v2/devices",
    summary: "All devices in config order",
    ok: "DeviceView[]",
  },
  {
    method: "POST",
    path: "/api/v2/devices",
    summary: "Add a device without a scene; it starts right away",
    body: "{name, type: 'ulanzi'|'pixoo', ip}",
    ok: "201 DeviceView",
    errors: "400 invalid_field {field}, 409 duplicate name, 409 config_invalid",
    rows: "A-136, B-078",
  },
  {
    method: "GET",
    path: "/api/v2/devices/:name",
    summary: "One device",
    ok: "DeviceView",
    errors: "404 unknown_device",
  },
  {
    method: "PATCH",
    path: "/api/v2/devices/:name",
    summary:
      "Device settings the UI may edit. Name, type, address and removal stay in the raw config (decision Markus)",
    body: "{displayName?, comment?, preview?: {showGrid?, pollMs?}}",
    ok: "DeviceView with the applied values",
    errors: "400 invalid_field, 404 unknown_device, 409 config_invalid",
    rows: "B-079, S-1",
  },
  {
    method: "PUT",
    path: "/api/v2/devices/:name/scene",
    summary:
      "Choose the scene: the display switches now, the choice is saved, scene overlays of the device are superseded. Not saved, but switched: config.json invalid on disk, or a device that exists only in the MQTT config overlay",
    body: "{scene: string|null}",
    ok: "{device: DeviceView, persisted: boolean, notSavedReason: 'config_invalid'|'overlay_only_device'|null}",
    errors: "400 unknown_scene, 404 unknown_device",
    rows: "A-149, A-150, B-070, A-082 (PIXD-75)",
  },
  {
    method: "POST",
    path: "/api/v2/devices/:name/adopt",
    summary:
      "'Add to config.json' for a device that exists only in the MQTT config overlay: write its name, type and address, plus the scene chosen for it here, and nothing else of the overlay",
    body: "{}",
    ok: "DeviceView with origin 'config'",
    errors: "404 unknown_device, 409 not_overlay_only, 409 config_invalid",
    rows: "A-151",
  },
  {
    method: "DELETE",
    path: "/api/v2/devices/:name/scene-overlay",
    summary:
      "'Return to <your choice>' and 'Restore': clear the scene overlay of the device",
    ok: "DeviceView",
    errors: "404 unknown_device, 503 mqtt_offline, 409 shadow_output",
    rows: "A-148, B-075",
  },
  {
    method: "PUT",
    path: "/api/v2/devices/:name/mode",
    summary: "Play, pause, stop. Play while playing re-initialises the display",
    body: "{mode: 'play'|'pause'|'stop'}",
    ok: "DeviceView",
    errors: "400 invalid_mode, 404 unknown_device, 503 mqtt_offline",
    rows: "A-152, B-036 to B-040, B-072",
  },
  {
    method: "PUT",
    path: "/api/v2/devices/:name/brightness",
    summary: "Brightness override in percent, null for 'the scene decides'",
    body: "{override: number|null}",
    ok: "DeviceView",
    errors: "400 invalid_brightness, 404 unknown_device, 503 mqtt_offline",
    rows: "A-153, B-043, B-073, B-074",
  },
  {
    method: "POST",
    path: "/api/v2/devices/:name/retry",
    summary:
      "'Retry now' in the recovery dialog: wake the render loop and re-initialise the display",
    body: "{}",
    ok: "DeviceView",
    errors: "404 unknown_device",
    rows: "B-035, B-040, B-080",
  },
  {
    method: "GET",
    path: "/api/v2/devices/:name/preview",
    summary: "The last frame as bytes: RGB888, row-major",
    ok: "application/octet-stream; headers X-Frame-Width, X-Frame-Height, X-Frame-Source, X-Frame-Received-At, X-Frame-Seq, ETag",
    errors: "404 unknown_device, 204 when there is no frame yet",
    rows: "A-129, B-049, B-050",
  },

  // --- scene settings ---------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v2/devices/:name/settings/:scene",
    summary:
      "Schema and every layer of every setting of one scene on one device",
    ok: "SettingsState",
    errors: "404 unknown_device, 404 unknown_scene",
    rows: "A-128, B-083, B-181",
  },
  {
    method: "PUT",
    path: "/api/v2/devices/:name/settings/:scene",
    summary:
      "Save: store the changed keys, remove the reset ones, clear the MQTT overlay of each saved key, and commit the page's draft: its preview ends unless it already holds a newer draft",
    body: "{set?: {key: value}, reset?: string[], session?: string, draft?: number}",
    ok: "{state: SettingsState, rejected: {}, overlaysNotCleared: string[]}",
    errors:
      "400 invalid_field {rejected: {key: reason}} and nothing is saved, 404, 409 config_invalid, 409 overlay_only_device",
    rows: "A-137, B-084, B-086, B-087, B-176, C-106",
  },
  {
    method: "PUT",
    path: "/api/v2/devices/:name/settings/:scene/preview",
    summary:
      "Try values on the display without saving. Not published to MQTT, ends with the page. draft is the page's edit counter; a request with a draft that is not newer changes nothing",
    body: "{session: string, draft: number, values: {key: value}}",
    ok: "{state: SettingsState, rejected: {key: reason}, applied: boolean}",
    errors: "404, 400 invalid_field without session or draft",
    rows: "B-085, B-176, S-2, C-214",
  },
  {
    method: "DELETE",
    path: "/api/v2/devices/:name/settings/:scene/preview",
    summary:
      "Revert: end the page's preview for this scene. Query: session=<page id>",
    ok: "SettingsState",
    errors: "404",
  },
  {
    method: "POST",
    path: "/api/v2/preview-sessions/:session/end",
    summary:
      "End every preview of a page; meant for navigator.sendBeacon when the page is left",
    body: "{}",
    ok: "{ended: number}",
  },
  {
    method: "DELETE",
    path: "/api/v2/devices/:name/settings/:scene/overlays",
    summary:
      "'Clear N overlays': clear the outside setting overlays of this scene on this device",
    ok: "{state: SettingsState, cleared: string[], failed: string[]}",
    errors: "404, 503 mqtt_offline, 409 shadow_output",
    rows: "A-139, B-088",
  },

  // --- overlays ---------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v2/overlays",
    summary:
      "Every stored overlay and retained control, with topic, value, what it replaces and when it was received",
    ok: "OverlayRecord[]",
    rows: "A-080",
  },
  {
    method: "DELETE",
    path: "/api/v2/overlays/:id",
    summary: "Clear one overlay (retained empty payload)",
    ok: "{confirmed: boolean, pending: boolean, overlays: OverlayRecord[]}",
    errors: "404 unknown_overlay, 503 mqtt_offline, 409 shadow_output",
    rows: "A-148, A-139",
  },

  // --- scenes -----------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v2/scenes",
    summary: "Registered scenes and built-in modes, kept apart",
    ok: "{scenes: SceneMeta[], builtins: {ulanzi: BuiltinMode[], pixoo: BuiltinMode[]}}",
    rows: "A-130, A-BUG-27",
  },
  {
    method: "POST",
    path: "/api/v2/scenes/:key/copy",
    summary:
      "'Separate copy of this scene': copy the file under a new key, or replace the key with the copy (the original file is backed up first). The folders named in the source's resources.assetDirs are linked beside the copy under the same names; a copy starts its own history file",
    body: "{targetKey?: string, name?: string, replace?: boolean}",
    ok: "201 {scene: SceneMeta, path: string, backup: string|null, linkedAssetDirs: string[]}",
    errors:
      "400 invalid_field, 404 unknown_scene, 409 key or file exists; the copy is imported before it is registered, a file that does not load is not registered",
    rows: "A-140 to A-146, A-195, A-196, B-091, B-182, B-183",
  },

  // --- config -----------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v2/config/raw",
    summary: "config.json as text, with its state",
    ok: "{text: string, state: ConfigFileState}",
    rows: "A-134",
  },
  {
    method: "PUT",
    path: "/api/v2/config/raw",
    summary:
      "Save the raw editor: validate, write atomically, apply per device",
    body: "{text: string}",
    ok: "{state: ConfigFileState, diff: ConfigDiff}",
    errors: "400 invalid_config {line, column}; nothing is written",
    rows: "A-135, A-155",
  },
  {
    method: "POST",
    path: "/api/v2/config/reload",
    summary: "'Reload from disk'",
    body: "{}",
    ok: "ConfigFileState",
  },

  // --- health -----------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v2/status",
    summary:
      "Controller, MQTT, config, supervision and v1 ownership status for the Health page",
    ok: "{controller: ControllerStatus, mqtt: MqttStatus, config: ConfigFileState, scheduler: {devices, loopsAlive, restarts, lastWatchdogAt, watchdogIntervalMs}, v1: {transition, known, receivedAt, devices}}",
    rows: "A-131",
  },
  {
    method: "GET",
    path: "/api/v2/log",
    summary:
      "The last lines of the process log. Query: level=warn for warnings and errors only",
    ok: "LogLine[] oldest first, at most 200",
  },
]);

/**
 * Register every v2 route. In the skeleton each one answers 501.
 *
 * @param {import("./http-server.js").HttpServer} server
 * @param {import("./routes-v1.js").ApiDeps} deps
 */
export function registerV2Routes(server, deps) {
  /** @type {Record<string, import("./http-server.js").RouteHandler>} */
  const built = {
    "GET /api/v2/bootstrap": () => ({
      ...deps.live.deps.snapshot(), epoch: deps.epoch, seq: deps.live.seq(),
    }),
    "GET /api/v2/devices": () => deps.state.views(),
    "GET /api/v2/devices/:name": (ctx) => deps.state.view(ctx.params.name),
    "GET /api/v2/events": (ctx) => deps.live.handle(ctx),
  };
  for (const { method, path, ...meta } of V2_ROUTES) {
    const handler =
      built[`${method} ${path}`] ??
      ((ctx) => todo(`${method} ${path}`, ctx, deps));
    server.route(method, path, handler, meta);
  }
}
