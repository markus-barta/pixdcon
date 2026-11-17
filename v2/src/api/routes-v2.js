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
 *    shadow_output, blob_not_writer, not_implemented.
 *  - Reads are cheap and side-effect free. The page normally needs only
 *    GET /api/v2/bootstrap and the live channel.
 *
 * Owner: API + live channel worker.
 */

import { HttpError } from "../core/errors.js";
import { HANDLED } from "./http-server.js";
import {
  deviceCommand,
  devicePatch,
  draft,
  invalid,
  keys,
  newDevice,
  object,
  requireDrive,
  text,
} from "./commands.js";
import { copyScene } from "./scene-copy.js";

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
    errors: "404 unknown_overlay, 503 mqtt_offline, 409 shadow_output, 409 blob_not_writer (the config overlay, while this instance is not its writer)",
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
    ok: "{controller: ControllerStatus, mqtt: MqttStatus, config: ConfigFileState, scheduler: {devices, loopsAlive, restarts, lastWatchdogAt, watchdogIntervalMs}, v1: {transition, known, receivedAt, connection, devices}}",
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
 * Register every v2 route; command results come from the applied store view.
 *
 * @param {import("./http-server.js").HttpServer} server
 * @param {import("./routes-v1.js").ApiDeps} deps
 */
export function registerV2Routes(server, deps) {
  /** @type {Record<string, import("./http-server.js").RouteHandler>} */
  const built = {
    "GET /api/v2/bootstrap": () => server.answer({
      ...deps.live.deps.snapshot(),
      epoch: deps.epoch,
      seq: deps.live.seq(),
    }),
    "GET /api/v2/devices": () => server.answer(deps.state.views()),
    "GET /api/v2/devices/:name": (ctx) => server.answer(deps.state.view(ctx.params.name)),
    "GET /api/v2/events": (ctx) => deps.live.handle(ctx),
    "POST /api/v2/devices": async (ctx) => {
      const body = await ctx.body();
      keys(body, ["name", "type", "ip"]);
      const entry = newDevice(body);
      await deps.config.addDevice(entry);
      return { status: 201, body: deps.state.view(entry.name) };
    },
    "PATCH /api/v2/devices/:name": (ctx) =>
      deviceCommand(deps, ctx.params.name, async () => {
        const view = deps.state.view(ctx.params.name);
        if (view.origin === "blob")
          throw new HttpError(
            409,
            "overlay_only_device",
            "Add this device to config.json first",
          );
        const patch = devicePatch(await ctx.body());
        await deps.config.updateDevice(ctx.params.name, (device) => {
          for (const [key, value] of Object.entries(patch))
            device[key] =
              key === "preview"
                ? {
                    ...object(device.preview ?? {}, "preview"),
                    ...object(value, "preview"),
                  }
                : value;
        });
        return deps.state.view(ctx.params.name);
      }),
    "PUT /api/v2/devices/:name/scene": (ctx) =>
      deviceCommand(deps, ctx.params.name, async () => {
        const body = await ctx.body();
        keys(body, ["scene"]);
        if (body.scene !== null && typeof body.scene !== "string")
          invalid("scene", "scene must be a string or null");
        const result = await deps.state.chooseScene(
          ctx.params.name,
          /** @type {string|null} */ (body.scene),
        );
        return {
          device: result.view,
          persisted: result.persisted,
          notSavedReason: result.notSavedReason,
        };
      }),
    "POST /api/v2/devices/:name/adopt": (ctx) =>
      deviceCommand(deps, ctx.params.name, async () => {
        keys(await ctx.body(), []);
        return deps.state.adoptDevice(ctx.params.name);
      }),
    "DELETE /api/v2/devices/:name/scene-overlay": (ctx) =>
      deviceCommand(deps, ctx.params.name, () =>
        deps.state.clearSceneOverlay(ctx.params.name),
      ),
    "PUT /api/v2/devices/:name/mode": (ctx) =>
      deviceCommand(deps, ctx.params.name, async () => {
        const body = await ctx.body();
        keys(body, ["mode"]);
        if (
          typeof body.mode !== "string" ||
          !["play", "pause", "stop"].includes(body.mode)
        )
          throw new HttpError(
            400,
            "invalid_mode",
            "Choose play, pause or stop",
          );
        return deps.state.setMode(
          ctx.params.name,
          /** @type {import("../types.js").PlaybackMode} */ (body.mode),
        );
      }),
    "PUT /api/v2/devices/:name/brightness": (ctx) =>
      deviceCommand(deps, ctx.params.name, async () => {
        const body = await ctx.body();
        keys(body, ["override"]);
        if (
          body.override !== null &&
          (typeof body.override !== "number" ||
            !Number.isFinite(body.override) ||
            body.override < 1 ||
            body.override > 100)
        )
          throw new HttpError(
            400,
            "invalid_brightness",
            "Brightness must be from 1 to 100, or null",
          );
        return deps.state.setBrightness(
          ctx.params.name,
          /** @type {number|null} */ (body.override),
        );
      }),
    "POST /api/v2/devices/:name/retry": (ctx) =>
      deviceCommand(deps, ctx.params.name, async () => {
        keys(await ctx.body(), []);
        return deps.state.retry(ctx.params.name);
      }),
    "GET /api/v2/devices/:name/preview": (ctx) => {
      deps.state.view(ctx.params.name);
      const frame = deps.previews.get(ctx.params.name);
      if (!frame) {
        ctx.res.writeHead(204);
        ctx.res.end();
        return HANDLED;
      }
      const etag = `"${deps.epoch}-${frame.seq}"`;
      if (ctx.req.headers["if-none-match"] === etag) {
        ctx.res.writeHead(304, { ETag: etag });
        ctx.res.end();
        return HANDLED;
      }
      ctx.res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache",
        ETag: etag,
        "X-Frame-Width": frame.width,
        "X-Frame-Height": frame.height,
        "X-Frame-Source": frame.source,
        "X-Frame-Received-At": frame.receivedAt,
        "X-Frame-Seq": frame.seq,
      });
      ctx.res.end(Buffer.from(frame.rgb));
      return HANDLED;
    },
    "GET /api/v2/devices/:name/settings/:scene": (ctx) =>
      server.answer(deps.settings.state(ctx.params.name, ctx.params.scene)),
    "PUT /api/v2/devices/:name/settings/:scene": (ctx) =>
      deviceCommand(deps, ctx.params.name, async () => {
        const body = await ctx.body();
        keys(body, ["set", "reset", "session", "draft"]);
        const change = {};
        if ("set" in body)
          Object.assign(change, { set: object(body.set, "set") });
        if ("reset" in body) {
          if (
            !Array.isArray(body.reset) ||
            body.reset.some((key) => typeof key !== "string")
          )
            invalid("reset", "reset must be an array of keys");
          Object.assign(change, { reset: body.reset });
        }
        if ("session" in body || "draft" in body)
          Object.assign(change, draft(body));
        const result = await deps.settings.save(
          ctx.params.name,
          ctx.params.scene,
          change,
        );
        if (Object.keys(result.rejected).length)
          throw new HttpError(
            400,
            "invalid_field",
            "Some settings are invalid",
            {
              rejected: result.rejected,
            },
          );
        return result;
      }),
    "PUT /api/v2/devices/:name/settings/:scene/preview": async (ctx) => {
      const body = await ctx.body();
      keys(body, ["session", "draft", "values"]);
      return deps.settings.preview(ctx.params.name, ctx.params.scene, {
        ...draft(body),
        values: object(body.values, "values"),
      });
    },
    "DELETE /api/v2/devices/:name/settings/:scene/preview": (ctx) => {
      const session = text(ctx.query.get("session"), "session");
      deps.settings.state(ctx.params.name, ctx.params.scene);
      deps.settings.endPreview(session, {
        device: ctx.params.name,
        scene: ctx.params.scene,
      });
      return server.answer(deps.settings.state(ctx.params.name, ctx.params.scene));
    },
    "POST /api/v2/preview-sessions/:session/end": async (ctx) => {
      keys(await ctx.body(), []);
      return server.answer({ ended: deps.settings.endPreview(ctx.params.session).length });
    },
    "DELETE /api/v2/devices/:name/settings/:scene/overlays": async (ctx) => {
      requireDrive(deps, ctx.params.name);
      deps.settings.state(ctx.params.name, ctx.params.scene);
      const result = await deps.overlays.clearSettings(
        ctx.params.name,
        ctx.params.scene,
      );
      return server.answer({
        state: deps.settings.state(ctx.params.name, ctx.params.scene),
        ...result,
      });
    },
    "GET /api/v2/overlays": () => server.answer(deps.overlays.list()),
    "DELETE /api/v2/overlays/:id": async (ctx) => {
      const result = await deps.overlays.clear(ctx.params.id);
      return server.answer({
        confirmed: result.confirmed,
        pending: result.pending,
        overlays: deps.overlays.list(),
      });
    },
    "GET /api/v2/scenes": () => server.answer({
      scenes: deps.scenes.list(),
      builtins: deps.builtinModes,
    }),
    "POST /api/v2/scenes/:key/copy": async (ctx) =>
      server.answer(await copyScene(deps, ctx.params.key, await ctx.body()), 201),
    "GET /api/v2/config/raw": async () => server.answer(await deps.config.readRaw()),
    "PUT /api/v2/config/raw": async (ctx) => {
      const body = await ctx.body();
      keys(body, ["text"]);
      if (typeof body.text !== "string")
        invalid("text", "text must be a string");
      const result = await deps.config.replaceRaw(
        /** @type {string} */ (body.text),
      );
      return server.answer({ state: deps.config.file(), diff: result.diff });
    },
    "POST /api/v2/config/reload": async (ctx) => {
      keys(await ctx.body(), []);
      return server.answer(await deps.config.reload());
    },
    "GET /api/v2/status": () => server.answer({
      controller: deps.controller(),
      mqtt: deps.mqtt?.status() ?? {
        state: "disabled",
        url: null,
        since: null,
        connection: 0,
        lastError: null,
        settled: false,
      },
      config: deps.config.file(),
      scheduler: deps.scheduler.status(),
      v1: deps.ownership.status(),
    }),
    "GET /api/v2/log": (ctx) =>
      server.answer(deps.logger
        .ring()
        .filter(
          (line) =>
            ctx.query.get("level") !== "warn" ||
            ["WARN", "ERROR"].includes(line.level),
        )
        .slice(-200)),
  };
  for (const { method, path, ...meta } of V2_ROUTES) {
    const handler = built[`${method} ${path}`];
    server.route(method, path, handler, meta);
  }
}
