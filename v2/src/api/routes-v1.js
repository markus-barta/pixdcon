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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../core/errors.js";
import { NotImplementedError } from "../core/todo.js";
import { HANDLED } from "./http-server.js";
import {
  deviceCommand,
  devicePatch,
  invalid,
  newDevice,
  object,
  text,
} from "./commands.js";
import { copyScene } from "./scene-copy.js";

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
    path: "/api/device/save",
    summary: "Merge editable device fields into config.json (v1 compatibility)",
    body: "{deviceName, patch: {displayName?, comment?, ip?, scene?, enabled?, preview?}}",
    ok: "{ok: true, device: saved device}",
    errors:
      "400 invalid_field, 404 unknown_device, 409 config_invalid or overlay_only_device",
    rows: "B-079, S-1",
  },
  {
    method: "POST",
    path: "/api/scene",
    summary:
      "Choose a device's scene: saved, applied at once, scene overlays of the device superseded",
    body: "{deviceName, scene} (scene: string, '' or null for none)",
    ok: "{ok: true}, or {ok: true, persisted: false} when config.json is invalid on disk or the device exists only in the MQTT config overlay (fix: v1 copied such a device into the file; v2 adopts only on POST /api/v2/devices/:name/adopt)",
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
      "400 values not an object (fix), 404 unknown device or scene (fix), 409 config_invalid, 409 overlay_only_device (fix: v1 copied the device into the file)",
    rows: "A-137, A-151, A-190",
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
 * @property {string} [versioningDir] injected shared-path seam for the pinned presentation assets
 * @property {import("../types.js").Epoch} epoch
 * @property {import("../config/config-store.js").ConfigStore} config
 * @property {import("../state/runtime-config.js").RuntimeConfig} runtime
 * @property {import("../state/v1-ownership.js").V1Ownership} ownership
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
 * @property {import("../types.js").Factories["builtinModes"]} builtinModes for the snapshot and GET /api/v2/scenes
 * @property {ReturnType<typeof import("../core/logger.js").createLogger>} logger
 * @property {import("../types.js").Clock} clock
 * @property {() => import("../types.js").ControllerStatus} controller
 */

/**
 * Register the v1 wire adapters. The stores remain the source of applied state.
 *
 * @param {import("./http-server.js").HttpServer} server
 * @param {ApiDeps} deps
 */
export function registerV1Routes(server, deps) {
  /** @type {Record<string, import("./http-server.js").RouteHandler>} */
  const built = {
    "GET /vendor/inspr-versioning/:file": async (ctx) => {
      const types = {
        "version.js": "text/javascript; charset=utf-8",
        "presentation.js": "text/javascript; charset=utf-8",
        "version-interaction.js": "text/javascript; charset=utf-8",
        "display.json": "application/json",
        "schemes.json": "application/json",
        LICENSE: "text/plain; charset=utf-8",
      };
      if (!Object.hasOwn(types, ctx.params.file))
        throw new HttpError(404, "not_found", "Not found");
      if (!deps.versioningDir)
        throw new NotImplementedError("ApiDeps.versioningDir");
      const content = await readFile(join(deps.versioningDir, ctx.params.file));
      ctx.res.writeHead(200, {
        "Content-Type":
          types[/** @type {keyof typeof types} */ (ctx.params.file)],
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      ctx.res.end(content);
      return HANDLED;
    },
    "GET /api/config": () => deps.state.runningConfigV1(),
    "GET /api/config/file": () => {
      if (!deps.config.file().valid)
        throw new HttpError(
          409,
          "config_invalid",
          "config.json is invalid on disk",
        );
      return deps.config.get();
    },
    "POST /api/config/file": async (ctx) => {
      await deps.config.replaceRaw(JSON.stringify(await ctx.body()));
      return { ok: true };
    },
    "GET /api/scenes": () => ({
      ...Object.fromEntries(
        deps.scenes.list().map((scene) => [
          scene.key,
          {
            key: scene.key,
            path: scene.path,
            name: scene.name,
            pretty_name: scene.pretty_name,
            description: scene.description,
            deviceType: scene.deviceType,
            settingsSchema: scene.settingsSchema,
          },
        ]),
      ),
      builtins: deps.builtinModes,
    }),
    "GET /api/scene-settings": () => deps.settings.toV1(),
    "GET /api/previews": () => deps.previews.toV1(),
    "GET /api/status": () => statusV1(deps),
    "POST /api/device": async (ctx) => {
      await deps.config.addDevice(newDevice(await ctx.body()));
      return { ok: true };
    },
    "POST /api/device/save": async (ctx) => {
      const body = await ctx.body();
      const name = text(body.deviceName, "deviceName");
      const patch = devicePatch(object(body.patch, "patch"), true);
      return deviceCommand(deps, name, async () => {
        const view = deps.state.view(name);
        if (view.origin === "blob")
          throw new HttpError(
            409,
            "overlay_only_device",
            "Add this device to config.json first",
          );
        const scene = /** @type {string|null} */ (patch.scene || null);
        if ("scene" in patch) {
          const problem = deps.scenes.check(scene, view.type);
          if (problem) throw new HttpError(400, "unknown_scene", problem);
        }
        await deps.config.updateDevice(name, (device) => {
          for (const [key, value] of Object.entries(patch)) {
            if (key === "scene") continue;
            device[key] =
              key === "preview"
                ? {
                    ...object(device.preview ?? {}, "preview"),
                    ...object(value, "preview"),
                  }
                : value;
          }
        });
        if ("scene" in patch) await deps.state.chooseScene(name, scene);
        return {
          ok: true,
          device: deps.config
            .get()
            .devices.find((device) => device.name === name),
        };
      });
    },
    "POST /api/scene": async (ctx) => {
      try {
        const body = await ctx.body();
        const name = text(body.deviceName, "deviceName");
        if (
          body.scene !== undefined &&
          body.scene !== null &&
          typeof body.scene !== "string"
        )
          invalid("scene", "scene must be a string or null");
        return await deviceCommand(deps, name, async () => {
          const result = await deps.state.chooseScene(
            name,
            /** @type {string|null} */ (body.scene || null),
          );
          return {
            ok: true,
            ...(result.persisted ? {} : { persisted: false }),
          };
        });
      } catch (error) {
        if (error instanceof HttpError)
          throw new HttpError(error.statusCode, error.code, error.message, {
            ...error.extra,
            ok: false,
          });
        throw error;
      }
    },
    "POST /api/scene-settings/save": async (ctx) => {
      const body = await ctx.body();
      const device = text(body.deviceName, "deviceName"),
        scene = text(body.sceneName, "sceneName");
      const values = object(body.values, "values");
      return deviceCommand(deps, device, async () => {
        const before = deps.settings.state(device, scene);
        // v1 keeps schema keys whose values normalise and replaces the
        // saved set. The v2 save validates all keys before applying anything.
        let set = Object.fromEntries(
          Object.entries(values).filter(([key]) =>
            Object.hasOwn(before.schema, key),
          ),
        );
        const resets = () =>
          Object.keys(before.values).filter(
            (key) => "saved" in before.values[key] && !Object.hasOwn(set, key),
          );
        let result = await deps.settings.save(device, scene, {
          set,
          reset: resets(),
        });
        if (Object.keys(result.rejected).length) {
          set = Object.fromEntries(
            Object.entries(set).filter(
              ([key]) => !Object.hasOwn(result.rejected, key),
            ),
          );
          result = await deps.settings.save(device, scene, {
            set,
            reset: resets(),
          });
        }
        if (Object.keys(result.rejected).length)
          throw new HttpError(
            400,
            "invalid_field",
            "Some settings are invalid",
            { rejected: result.rejected },
          );
        return {
          ok: true,
          saved: Object.fromEntries(
            Object.entries(result.state.values)
              .filter(([, value]) => "saved" in value)
              .map(([key, value]) => [key, value.saved]),
          ),
        };
      });
    },
    "POST /api/scene-settings/overlay": async (ctx) => {
      const body = await ctx.body();
      const device = text(body.deviceName, "deviceName"),
        scene = text(body.sceneName, "sceneName");
      deps.settings.state(device, scene);
      const result = await deps.overlays.publishSettings(
        device,
        scene,
        object(body.values, "values"),
      );
      if (result.rejected.length)
        throw new HttpError(400, "invalid_field", "Some settings are invalid", {
          rejected: result.rejected,
        });
      if (result.failed.length)
        throw new HttpError(
          503,
          "mqtt_offline",
          "Some overlays were not confirmed",
          { failed: result.failed },
        );
      return { ok: true, overlay: deps.overlays.settingValues(device, scene) };
    },
    "POST /api/scene-settings/overlay/clear": async (ctx) => {
      const body = await ctx.body();
      const device = text(body.deviceName, "deviceName"),
        scene = text(body.sceneName, "sceneName");
      deps.settings.state(device, scene);
      const result = await deps.overlays.clearSettings(device, scene);
      if (result.failed.length)
        throw new HttpError(
          503,
          "mqtt_offline",
          "Some overlays were not cleared",
          { failed: result.failed },
        );
      return { ok: true, overlay: deps.overlays.settingValues(device, scene) };
    },
    "POST /api/scene/clone": async (ctx) => {
      const body = await ctx.body();
      const options = {
        targetKey: body.targetSceneKey,
        name: body.targetPrettyName,
        replace: body.overwrite,
      };
      for (const key of Object.keys(options))
        if (options[/** @type {keyof typeof options} */ (key)] === undefined)
          delete options[/** @type {keyof typeof options} */ (key)];
      const result = await copyScene(
        deps,
        text(body.sceneName, "sceneName"),
        options,
        { backupSource: true },
      );
      return { ok: true, sceneKey: result.scene.key, path: result.path };
    },
    "POST /api/overlay": async (ctx) => {
      const body = await ctx.body();
      const name = text(body.deviceName, "deviceName");
      deps.state.view(name);
      if (body.scene !== null && typeof body.scene !== "string")
        invalid("scene", "scene must be a string or null");
      const result = await deps.overlays.publishSceneOverlay(
        name,
        /** @type {string|null} */ (body.scene || null),
      );
      if (!result.confirmed)
        throw new HttpError(
          503,
          "mqtt_offline",
          "The scene overlay was not confirmed",
        );
      return { ok: true };
    },
    "POST /api/overlay/clear": async (ctx) => {
      const body = await ctx.body();
      await deps.state.clearSceneOverlay(text(body.deviceName, "deviceName"));
      return { ok: true };
    },
    "POST /api/mode": async (ctx) => {
      const body = await ctx.body();
      const name = text(body.deviceName, "deviceName");
      if (
        typeof body.mode !== "string" ||
        !["play", "pause", "stop"].includes(body.mode)
      )
        throw new HttpError(400, "invalid_mode", "Choose play, pause or stop");
      await deviceCommand(deps, name, () =>
        deps.state.setMode(
          name,
          /** @type {import("../types.js").PlaybackMode} */ (body.mode),
        ),
      );
      return { ok: true };
    },
    "POST /api/brightness": async (ctx) => {
      const body = await ctx.body();
      const name = text(body.deviceName, "deviceName");
      if (typeof body.enabled !== "boolean")
        invalid("enabled", "enabled must be boolean");
      if (
        body.enabled &&
        (typeof body.value !== "number" ||
          !Number.isFinite(body.value) ||
          body.value < 1 ||
          body.value > 100)
      )
        throw new HttpError(
          400,
          "invalid_brightness",
          "Brightness must be from 1 to 100",
        );
      await deviceCommand(deps, name, () =>
        deps.state.setBrightness(
          name,
          body.enabled ? Math.round(Number(body.value)) : null,
        ),
      );
      return { ok: true };
    },
  };
  for (const { method, path, ...meta } of V1_ROUTES)
    server.route(method, path, built[`${method} ${path}`], meta);
}

/** The fields consumed by the v1 UI and deploy scripts; brightness stays percent.
 * @param {ApiDeps} deps
 */
export function statusV1(deps) {
  const controller = deps.controller();
  const devices = deps.state.list();
  return {
    mqttConnected: deps.mqtt?.status().state === "connected",
    version: controller.version,
    version_scheme: controller.version_scheme,
    deviceModes: Object.fromEntries(
      devices.map((d) => [d.name, d.desired.mode.value]),
    ),
    deviceBrightness: Object.fromEntries(
      devices.map((d) => [
        d.name,
        {
          override: d.desired.brightness.override,
          last: d.effective.lastBrightness,
        },
      ]),
    ),
    deviceHealth: Object.fromEntries(
      devices.map((d) => [
        d.name,
        {
          online: d.health.state !== "offline",
          consecutiveErrors: d.health.consecutiveErrors,
          lastSuccessAgoMs: d.health.lastFrameAt
            ? Math.max(0, deps.clock.now() - Date.parse(d.health.lastFrameAt))
            : null,
          ip: d.runtime.address,
          type: d.type,
          apSsid: d.health.apSsid,
        },
      ]),
    ),
    deviceScenes: Object.fromEntries(
      devices.map((d) => [d.name, d.effective.scene]),
    ),
  };
}
