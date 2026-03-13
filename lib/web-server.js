/**
 * pidicon-light — Web UI
 * Minimal HTTP server: serves a single-page admin UI + JSON API.
 * Stack: DaisyUI + Tailwind CDN + Alpine.js (no build step).
 *
 * Routes:
 *   GET  /                    → HTML admin page
 *   GET  /api/config          → effective config JSON
 *   GET  /api/scene-settings  → scene settings state by device/scene
 *   GET  /api/scenes          → scene metadata for labels/filtering
 *   GET  /api/previews        → live frame previews for all devices
 *   GET  /api/status          → {mqttConnected, version}
 *   POST /api/config/file     → write config.json (hot-reload kicks in)
 *   POST /api/device          → {name, type, ip} → add device + save file
 *   POST /api/scene-settings/save
 *   POST /api/scene-settings/overlay
 *   POST /api/scene-settings/overlay/clear
 *   POST /api/scene/clone
 *   POST /api/overlay         → {deviceName, scenes} → retained MQTT overlay
 *   POST /api/overlay/clear   → {deviceName}         → clear MQTT overlay
 *   POST /api/mode            → {deviceName, mode}   → MQTT mode control
 */

import { createServer } from "http";
import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { basename, dirname, join, resolve } from "path";
import { normalizeSettingValue } from "./scene-settings-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
).version;

export class WebServer {
  /**
   * @param {object} options
   * @param {string}   options.configPath          - absolute path to config.json
   * @param {Function} options.getEffectiveConfig  - () => currentEffectiveConfig
   * @param {Function} [options.getSceneSettingsState] - () => current scene settings state
   * @param {Function} [options.getSceneMetadata]  - () => current scene metadata map
   * @param {Function} [options.getFramePreviews]  - () => current preview map
   * @param {object}   [options.mqttService]       - MqttService instance or null
   * @param {object}   [options.sceneSettingsService] - SceneSettingsService instance or null
   * @param {object}   [options.logger]
   */
  constructor(options = {}) {
    this.port = parseInt(process.env.WEB_PORT || "8080", 10);
    this.configPath = options.configPath;
    this.getEffectiveConfig = options.getEffectiveConfig;
    this.getSceneSettingsState = options.getSceneSettingsState || (() => ({}));
    this.getSceneMetadata = options.getSceneMetadata || (() => ({}));
    this.getFramePreviews = options.getFramePreviews || (() => ({}));
    this.mqttService = options.mqttService ?? null;
    this.sceneSettingsService = options.sceneSettingsService ?? null;
    this.logger = options.logger || console;
    this._server = null;
  }

  /** Allow swapping mqttService reference after MQTT connects. */
  setMqttService(svc) {
    this.mqttService = svc;
  }

  start() {
    this._server = createServer((req, res) => this._handle(req, res));
    this._server.listen(this.port, "0.0.0.0", () => {
      this.logger.info(`[WebServer] Listening on http://0.0.0.0:${this.port}`);
    });
  }

  stop() {
    if (this._server) this._server.close();
  }

  // ---------------------------------------------------------------------------

  async _handle(req, res) {
    const url = new URL(req.url, `http://localhost`);
    const method = req.method;

    try {
      if (method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html());
        return;
      }

      if (method === "GET" && url.pathname === "/api/config") {
        this._json(res, this.getEffectiveConfig());
        return;
      }

      if (method === "GET" && url.pathname === "/api/scene-settings") {
        this._json(res, this.getSceneSettingsState());
        return;
      }

      if (method === "GET" && url.pathname === "/api/previews") {
        this._json(res, this.getFramePreviews());
        return;
      }

      if (method === "GET" && url.pathname === "/api/scenes") {
        this._json(res, this.getSceneMetadata());
        return;
      }

      if (method === "GET" && url.pathname === "/api/status") {
        this._json(res, {
          mqttConnected: !!this.mqttService?.connected,
          version: VERSION,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/config/file") {
        const body = await this._body(req);
        const config = JSON.parse(body);
        await writeFile(
          this.configPath,
          JSON.stringify(config, null, 2) + "\n",
          "utf-8",
        );
        this._json(res, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/device") {
        const { name, type, ip } = JSON.parse(await this._body(req));
        if (!name || !["ulanzi", "pixoo"].includes(type) || !ip) {
          this._json(
            res,
            { error: "name, type (ulanzi|pixoo), ip required" },
            400,
          );
          return;
        }
        const cfg = JSON.parse(JSON.stringify(this.getEffectiveConfig()));
        if (cfg.devices.find((d) => d.name === name)) {
          this._json(res, { error: `Device "${name}" already exists` }, 409);
          return;
        }
        cfg.devices.push({ name, type, ip, scenes: [] });
        await writeFile(
          this.configPath,
          JSON.stringify(cfg, null, 2) + "\n",
          "utf-8",
        );
        this._json(res, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/scene-settings/save") {
        const { deviceName, sceneName, values } = JSON.parse(
          await this._body(req),
        );
        const cfg = JSON.parse(JSON.stringify(this.getEffectiveConfig()));
        const device = cfg.devices.find((d) => d.name === deviceName);
        if (!device) {
          this._json(res, { error: `Unknown device "${deviceName}"` }, 404);
          return;
        }

        const schema =
          this.getSceneMetadata()?.[sceneName]?.settingsSchema || {};
        if (!device.sceneSettings || typeof device.sceneSettings !== "object") {
          device.sceneSettings = {};
        }

        const next = {};
        for (const [key, field] of Object.entries(schema)) {
          if (values?.[key] === undefined) continue;
          const normalized = normalizeSettingValue(values[key], field);
          if (normalized !== null) next[key] = normalized;
        }

        device.sceneSettings[sceneName] = next;
        await writeFile(
          this.configPath,
          JSON.stringify(cfg, null, 2) + "\n",
          "utf-8",
        );
        this._json(res, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/scene-settings/overlay") {
        const { deviceName, sceneName, values } = JSON.parse(
          await this._body(req),
        );
        if (!this.sceneSettingsService) {
          this._json(res, { error: "Scene settings service unavailable" }, 503);
          return;
        }
        await this.sceneSettingsService.applyOverlay(
          deviceName,
          sceneName,
          values || {},
        );
        this._json(res, { ok: true });
        return;
      }

      if (
        method === "POST" &&
        url.pathname === "/api/scene-settings/overlay/clear"
      ) {
        const { deviceName, sceneName } = JSON.parse(await this._body(req));
        if (!this.sceneSettingsService) {
          this._json(res, { error: "Scene settings service unavailable" }, 503);
          return;
        }
        await this.sceneSettingsService.clearOverlay(deviceName, sceneName);
        this._json(res, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/scene/clone") {
        const result = await this._cloneScene(
          JSON.parse(await this._body(req)),
        );
        this._json(res, result);
        return;
      }

      if (method === "POST" && url.pathname === "/api/overlay") {
        const { deviceName, scenes } = JSON.parse(await this._body(req));
        if (!this.mqttService?.connected) {
          this._json(res, { error: "MQTT not connected" }, 503);
          return;
        }
        this.mqttService.publish(
          `overlay/device/${deviceName}/scenes`,
          JSON.stringify(scenes),
          true,
        );
        this._json(res, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/overlay/clear") {
        const { deviceName } = JSON.parse(await this._body(req));
        if (!this.mqttService?.connected) {
          this._json(res, { error: "MQTT not connected" }, 503);
          return;
        }
        this.mqttService.publish(
          `overlay/device/${deviceName}/scenes`,
          "",
          true,
        );
        this._json(res, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/mode") {
        const { deviceName, mode } = JSON.parse(await this._body(req));
        if (!["play", "pause", "stop"].includes(mode)) {
          this._json(res, { error: "Invalid mode" }, 400);
          return;
        }
        if (!this.mqttService?.connected) {
          this._json(res, { error: "MQTT not connected" }, 503);
          return;
        }
        this.mqttService.publish(`${deviceName}/mode`, mode, true);
        this._json(res, { ok: true });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (err) {
      this.logger.error("[WebServer] Request error", err);
      this._json(res, { error: err.message }, 500);
    }
  }

  _json(res, data, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  _body(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  async _cloneScene({
    sceneName,
    targetSceneKey,
    targetPrettyName,
    overwrite,
  }) {
    const cfg = JSON.parse(JSON.stringify(this.getEffectiveConfig()));
    const sceneConfig = cfg.scenes?.[sceneName];
    if (!sceneConfig?.path) {
      throw new Error(`Unknown scene "${sceneName}"`);
    }

    const targetKey = overwrite ? sceneName : targetSceneKey?.trim();
    if (!targetKey) {
      throw new Error("targetSceneKey required when not overwriting");
    }

    const configDir = dirname(this.configPath);
    const sourcePath = resolve(configDir, sceneConfig.path);
    const backupDir = resolve(configDir, "./generated-scenes/_backups");
    const generatedDir = resolve(configDir, "./generated-scenes");
    const targetRelativePath = `./generated-scenes/${targetKey}.js`;
    const targetPath = resolve(configDir, targetRelativePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    await mkdir(backupDir, { recursive: true });
    await mkdir(generatedDir, { recursive: true });
    await copyFile(
      sourcePath,
      resolve(
        backupDir,
        `${sceneName}-${timestamp}-${basename(sceneConfig.path)}`,
      ),
    );

    let content = await readFile(sourcePath, "utf-8");
    if (targetPrettyName) {
      if (/pretty_name\s*:\s*["'`]/.test(content)) {
        content = content.replace(
          /pretty_name\s*:\s*["'`][^"'`]*["'`]/,
          `pretty_name: ${JSON.stringify(targetPrettyName)}`,
        );
      }
    }

    if (!overwrite) {
      content = content.replace(
        /name\s*:\s*["'`][^"'`]*["'`]/,
        `name: ${JSON.stringify(targetKey)}`,
      );
    }

    await writeFile(targetPath, content, "utf-8");

    cfg.scenes[targetKey] = {
      ...cfg.scenes[sceneName],
      path: targetRelativePath,
    };

    for (const device of cfg.devices || []) {
      if (!Array.isArray(device.scenes)) continue;
      if (overwrite) continue;
      if (
        device.scenes.includes(sceneName) &&
        !device.scenes.includes(targetKey)
      ) {
        device.scenes.push(targetKey);
      }
    }

    await writeFile(
      this.configPath,
      JSON.stringify(cfg, null, 2) + "\n",
      "utf-8",
    );
    return { ok: true, sceneKey: targetKey, path: targetRelativePath };
  }
}

// ---------------------------------------------------------------------------
// HTML — single-page admin UI
// ---------------------------------------------------------------------------

function html() {
  return /* html */ `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>pidicon-light</title>
  <link href="https://cdn.jsdelivr.net/npm/daisyui@4/dist/full.min.css" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script defer src="https://unpkg.com/lucide@0.542.0/dist/umd/lucide.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js"></script>
  <style>
    [x-cloak] { display: none !important; }

    body { background: #0d1117; font-family: 'Inter', system-ui, sans-serif; }

    .glass-card {
      background: linear-gradient(145deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%);
      border: 1px solid rgba(255,255,255,0.08);
      backdrop-filter: blur(12px);
    }

    .accent-ulanzi { border-left: 3px solid #f59e0b; }
    .accent-pixoo  { border-left: 3px solid #22d3ee; }
    .dot-ulanzi    { background: #f59e0b; }
    .dot-pixoo     { background: #22d3ee; }
    .text-ulanzi   { color: #f59e0b; }
    .text-pixoo    { color: #22d3ee; }

    .scene-chip {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-height: 34px;
      padding: 5px 10px 5px 8px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      background: linear-gradient(135deg, rgba(34,211,238,0.18) 0%, rgba(59,130,246,0.12) 100%);
      border: 1px solid rgba(56,189,248,0.35);
      color: #d8f4ff;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 8px 20px rgba(8,47,73,0.18);
      transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
      cursor: pointer;
    }
    .scene-chip:hover {
      transform: translateY(-1px);
      border-color: rgba(125,211,252,0.65);
      background: linear-gradient(135deg, rgba(56,189,248,0.24) 0%, rgba(59,130,246,0.16) 100%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 12px 26px rgba(8,47,73,0.24);
    }
    .scene-chip-main {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }
    .scene-chip-gear {
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 9999px;
      color: rgba(216,244,255,0.55);
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.06);
      transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }
    .scene-chip:hover .scene-chip-gear {
      color: rgba(216,244,255,0.95);
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.14);
    }
    .scene-chip-label {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      line-height: 1;
    }
    .scene-chip-remove {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 9999px;
      color: rgba(216,244,255,0.72);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
      flex-shrink: 0;
    }
    .scene-chip-remove:hover {
      color: #fff;
      background: rgba(239,68,68,0.18);
      border-color: rgba(248,113,113,0.4);
    }
    .scene-actions-stack {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      width: 100%;
    }
    .scene-actions-stack-primary {
      display: flex;
      flex: 1 1 520px;
      gap: 10px;
      min-width: 0;
    }
    @media (max-width: 720px) {
      .scene-actions-stack-primary {
        flex-direction: column;
      }
    }
    .scene-actions-stack .btn {
      width: 100%;
      justify-content: center;
    }
    .device-footer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding-top: 4px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .device-footer-actions-clear {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 38px;
      padding: 0 12px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      color: rgba(255,255,255,0.55);
      transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }
    .device-footer-actions-clear:hover {
      color: rgba(255,255,255,0.88);
      background: rgba(255,255,255,0.06);
      border-color: rgba(255,255,255,0.14);
    }
    .device-footer-actions-main {
      display: flex;
      flex: 1 1 340px;
      flex-wrap: wrap;
      gap: 10px;
      min-width: 0;
    }
    .device-footer-actions-main .btn {
      flex: 1 1 160px;
      min-width: 0;
    }
    .device-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 4px;
      padding: 1px 6px;
      border-radius: 9999px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      line-height: 1.2;
    }

    .btn-mode {
      display: flex; align-items: center; justify-content: center; gap: 5px;
      padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 500;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.7);
      transition: all 0.15s; cursor: pointer;
    }
    .btn-mode:hover:not(:disabled) {
      background: rgba(255,255,255,0.1);
      color: #fff;
      border-color: rgba(255,255,255,0.2);
    }
    .btn-mode:disabled { opacity: 0.3; cursor: not-allowed; }

    .section-label {
      font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: rgba(255,255,255,0.3);
      margin-bottom: 8px;
    }

    .add-card {
      background: rgba(255,255,255,0.02);
      border: 1px dashed rgba(255,255,255,0.1);
      transition: all 0.2s;
      cursor: pointer;
    }
    .add-card:hover {
      background: rgba(255,255,255,0.04);
      border-color: rgba(255,255,255,0.2);
    }

    input.field, select.field {
      width: 100%;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 8px 12px;
      color: #e2e8f0;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
    }
    input.field:focus, select.field:focus {
      border-color: rgba(99,102,241,0.6);
      box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
    }
    input.field::placeholder { color: rgba(255,255,255,0.25); }
    select.field option { background: #1e2433; }
    select.field {
      padding-right: 38px;
      background-image: linear-gradient(45deg, transparent 50%, rgba(255,255,255,0.45) 50%), linear-gradient(135deg, rgba(255,255,255,0.45) 50%, transparent 50%);
      background-position: calc(100% - 16px) calc(50% - 2px), calc(100% - 11px) calc(50% - 2px);
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
    }

    .toast-item {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 16px; border-radius: 10px; font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .preview-shell {
      position: relative;
      overflow: hidden;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.35);
      background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
      cursor: zoom-in;
    }
    .preview-canvas {
      width: 100%;
      height: 100%;
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      background: rgba(2, 6, 23, 0.95);
    }
    .preview-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255,255,255,0.3);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: linear-gradient(180deg, rgba(2,6,23,0.2), rgba(2,6,23,0.55));
    }
    .preview-grid {
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
      background-image:
        linear-gradient(to right, rgba(0,0,0,0.85) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(0,0,0,0.85) 1px, transparent 1px);
      background-position: top left;
    }
    .preview-grid.visible {
      opacity: 1;
    }
    .preview-lightbox {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(2, 6, 23, 0.88);
      backdrop-filter: blur(10px);
    }
    .preview-lightbox-panel {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: 14px;
      align-items: center;
      justify-content: center;
    }
    .preview-lightbox-header {
      width: min(1200px, 100%);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .preview-lightbox-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 6px;
      font-size: 11px;
      color: rgba(255,255,255,0.42);
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
    }
    .preview-lightbox-stage {
      width: min(1200px, 100%);
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
    }
    .preview-shell-zoom {
      width: 100%;
      max-width: 100%;
      max-height: 100%;
      cursor: default;
      box-shadow: 0 24px 80px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.35);
    }
    .icon-button {
      width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      color: rgba(255,255,255,0.5);
      transition: all 0.15s;
    }
    .icon-button:hover {
      color: #fff;
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.15);
    }
    textarea.field {
      min-height: 78px;
      resize: vertical;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body class="min-h-screen" x-data="app()" x-init="init()" x-cloak>

  <!-- Navbar -->
  <header class="sticky top-0 z-40 border-b border-white/5" style="background:rgba(13,17,23,0.85);backdrop-filter:blur(16px)">
    <div class="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">
          <span x-html="icon('layout-grid', 14, 'color:#fff')" style="display:flex"></span>
        </div>
        <span class="font-semibold text-white tracking-tight">pidicon-light</span>
        <span class="text-xs px-2 py-0.5 rounded-full font-mono" style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.4)" x-text="'v' + version"></span>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full" :class="mqttConnected ? 'dot-pixoo' : 'bg-amber-500'" style="box-shadow: 0 0 6px currentColor"></span>
        <span class="text-xs" :class="mqttConnected ? 'text-pixoo' : 'text-amber-400'" x-text="mqttConnected ? 'MQTT connected' : 'MQTT offline'"></span>
      </div>
    </div>
  </header>

  <!-- Toast -->
  <div class="fixed top-20 right-4 z-50 flex flex-col gap-2" style="min-width:260px">
    <template x-if="message">
      <div class="toast-item" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0 translate-x-4" x-transition:enter-end="opacity-100 translate-x-0"
        :style="message.type === 'error' ? 'background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5' : 'background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.25);color:#86efac'">
        <span x-html="icon(message.type === 'error' ? 'circle-alert' : 'circle-check-big', 16)" style="flex-shrink:0;display:flex"></span>
        <span x-text="message.text"></span>
      </div>
    </template>
  </div>

  <!-- Loading -->
  <div class="flex flex-col items-center justify-center h-64 gap-3" x-show="loading">
    <span x-html="icon('loader-circle', 28, 'color:#6366f1;animation:spin 1s linear infinite')" style="display:flex"></span>
    <span class="text-sm" style="color:rgba(255,255,255,0.3)">Loading config…</span>
  </div>

  <!-- Content -->
  <main class="max-w-6xl mx-auto px-4 py-6" x-show="!loading">

    <!-- Device grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

      <!-- Device cards -->
      <template x-for="device in config?.devices" :key="device.name">
        <div class="glass-card rounded-2xl overflow-hidden"
          :class="device.type === 'ulanzi' ? 'accent-ulanzi' : 'accent-pixoo'">

          <!-- Card header -->
          <div class="px-5 py-4 flex items-center justify-between gap-3"
            style="border-bottom:1px solid rgba(255,255,255,0.06)">
            <div class="flex items-center gap-3 min-w-0">
              <div class="flex flex-col items-center justify-center flex-shrink-0">
                <div class="w-8 h-8 rounded-xl flex items-center justify-center"
                  :class="device.type === 'ulanzi' ? 'bg-amber-500/15' : 'bg-cyan-500/15'">
                  <span x-html="icon(device.type === 'ulanzi' ? 'tv' : 'monitor', 16, device.type === 'ulanzi' ? 'color:#f59e0b' : 'color:#22d3ee')" style="display:flex"></span>
                </div>
                <span class="device-badge"
                  :class="device.type === 'ulanzi' ? 'text-ulanzi bg-amber-500/10' : 'text-pixoo bg-cyan-500/10'"
                  x-text="device.type"></span>
              </div>
              <div class="min-w-0">
                <div class="font-semibold text-sm text-white leading-tight" x-text="deviceTitle(device)"></div>
                <div class="text-xs font-mono mt-0.5" style="color:rgba(255,255,255,0.35)" x-text="device.name"></div>
                <div class="text-[11px] mt-1" style="color:rgba(255,255,255,0.35)" x-show="device.comment" x-text="device.comment"></div>
                <div class="text-xs font-mono mt-1" style="color:rgba(255,255,255,0.22)" x-text="device.ip"></div>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <button class="icon-button" @click="openDeviceSettings(device.name)" title="Device settings">
                <span x-html="icon('settings', 14)" style="display:flex"></span>
              </button>
            </div>
          </div>

          <!-- Card body -->
          <div class="p-5 flex flex-col gap-5">

            <div>
              <div class="flex items-center justify-between mb-2 gap-3">
                <div class="section-label mb-0">Live view</div>
                <div class="text-[10px] font-mono" style="color:rgba(255,255,255,0.35)" x-text="previewLabel(device)"></div>
              </div>
              <div class="preview-shell" :style="'aspect-ratio:' + previewAspect(device)" @click="openPreviewZoom(device.name)">
                <canvas class="preview-canvas"
                  :id="previewCanvasId(device.name)"
                  :width="previewDimensions(device).width"
                  :height="previewDimensions(device).height"></canvas>
                <div class="preview-grid"
                  :class="previewGridClass(device)"
                  :style="previewGridStyle(device)"></div>
                <div class="preview-overlay" x-show="!previews[device.name]">waiting for frames</div>
              </div>
            </div>

            <!-- Scenes -->
            <div>
              <div class="section-label">Active scenes</div>
              <div class="flex flex-wrap gap-2 min-h-8">
                <template x-for="scene in edits[device.name]?.scenes ?? []" :key="scene">
                  <div class="scene-chip" :title="sceneTitle(scene)" @click="openSceneSettings(device.name, scene)">
                    <div class="scene-chip-main">
                      <span class="scene-chip-gear" x-html="icon('settings', 11)"></span>
                      <span class="scene-chip-label" x-text="scenePrettyName(scene)"></span>
                    </div>
                    <button class="scene-chip-remove" @click.stop="removeScene(device.name, scene)" title="Remove scene">
                      <span x-html="icon('x', 11)" style="display:flex"></span>
                    </button>
                  </div>
                </template>
                <span class="text-xs italic self-center" style="color:rgba(255,255,255,0.2)"
                  x-show="(edits[device.name]?.scenes ?? []).length === 0">no scenes</span>
              </div>
            </div>

            <!-- Add existing -->
            <div class="flex gap-2">
              <select class="field flex-1 text-xs font-mono" x-model="newSceneSelect[device.name]" style="padding:7px 38px 7px 10px">
                <option value="">Pick existing…</option>
                <template x-for="key in availableScenes(device.name)" :key="key">
                  <option :value="key" :title="sceneTitle(key)" x-text="scenePrettyName(key)"></option>
                </template>
              </select>
              <button @click="addExistingScene(device.name)" :disabled="!newSceneSelect[device.name]"
                class="btn btn-sm btn-outline" style="min-width:52px">Add</button>
            </div>

            <!-- Add new scene -->
            <details class="group">
              <summary class="text-xs cursor-pointer select-none flex items-center gap-1.5 list-none"
                style="color:rgba(255,255,255,0.4)">
                <span class="group-open:rotate-90" style="display:flex;transition:transform 0.2s">
                  <span x-html="icon('chevron-right', 12)" style="display:flex"></span>
                </span>
                New scene definition
              </summary>
              <div class="flex flex-col gap-2 mt-3">
                <input class="field text-xs font-mono" placeholder="scene-key" x-model="newSceneKey[device.name]">
                <input class="field text-xs font-mono" placeholder="/app/scenes/pixoo/my-scene.js" x-model="newScenePath[device.name]">
                <button @click="addNewScene(device.name)" :disabled="!newSceneKey[device.name] || !newScenePath[device.name]"
                  class="btn btn-sm btn-outline w-full">Add scene</button>
              </div>
            </details>

            <!-- Mode -->
            <div>
              <div class="section-label">Playback mode</div>
              <div class="flex gap-1.5">
                <button class="btn-mode flex-1" @click="setMode(device.name, 'play')" :disabled="!mqttConnected">
                  <span x-html="icon('play', 13)" style="display:flex"></span> Play
                </button>
                <button class="btn-mode flex-1" @click="setMode(device.name, 'pause')" :disabled="!mqttConnected">
                  <span x-html="icon('pause', 13)" style="display:flex"></span> Pause
                </button>
                <button class="btn-mode flex-1" @click="setMode(device.name, 'stop')" :disabled="!mqttConnected">
                  <span x-html="icon('square', 12)" style="display:flex"></span> Stop
                </button>
              </div>
            </div>

            <!-- Footer actions -->
            <div class="device-footer-actions">
              <button @click="clearOverlay(device.name)" x-show="mqttConnected" class="device-footer-actions-clear text-xs">
                <span x-html="icon('layers', 12)" style="display:flex"></span>
                Clear Overlay
              </button>
              <div class="device-footer-actions-main">
                <button @click="applyOverlay(device.name)" :disabled="!mqttConnected"
                  class="btn btn-sm btn-ghost flex items-center gap-1.5">
                  <span x-html="icon('layers', 13)" style="display:flex"></span>
                  Set Overlay
                </button>
                <button @click="saveToFile(device.name)"
                  class="btn btn-sm btn-primary flex items-center gap-1.5">
                  <span x-html="icon('save', 13)" style="display:flex"></span>
                  Save Settings
                </button>
              </div>
            </div>

          </div>
        </div>
      </template>

      <!-- Add device card -->
      <div class="add-card rounded-2xl flex flex-col items-center justify-center gap-3 p-8 min-h-48"
        @click="showAddDevice = true">
        <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2)">
          <span x-html="icon('plus', 20, 'color:#818cf8')" style="display:flex"></span>
        </div>
        <span class="text-sm font-medium" style="color:rgba(255,255,255,0.4)">Add device</span>
      </div>

    </div>
  </main>

  <!-- Add device modal -->
  <div x-show="showAddDevice" x-transition.opacity class="fixed inset-0 z-50 flex items-center justify-center p-4"
    style="background:rgba(0,0,0,0.6);backdrop-filter:blur(4px)" @click.self="showAddDevice = false">
    <div class="glass-card rounded-2xl w-full max-w-sm p-6 flex flex-col gap-5" x-transition:enter="transition ease-out duration-200"
      x-transition:enter-start="opacity-0 scale-95" x-transition:enter-end="opacity-100 scale-100" @click.stop>

      <div class="flex items-center justify-between">
        <h2 class="font-semibold text-white">Add device</h2>
        <button @click="showAddDevice = false" class="btn-mode w-8 h-8 p-0 rounded-lg" style="display:flex;align-items:center;justify-content:center">
          <span x-html="icon('x', 15)" style="display:flex"></span>
        </button>
      </div>

      <div class="flex flex-col gap-3">
        <div>
          <div class="section-label mb-1.5">Device name</div>
          <input class="field" placeholder="ulanzi-58" x-model="newDevice.name">
        </div>
        <div>
          <div class="section-label mb-1.5">Type</div>
          <select class="field" x-model="newDevice.type">
            <option value="ulanzi">Ulanzi / AWTRIX (32×8)</option>
            <option value="pixoo">Pixoo64 (64×64)</option>
          </select>
        </div>
        <div>
          <div class="section-label mb-1.5">IP address</div>
          <input class="field font-mono" placeholder="192.168.1.xx" x-model="newDevice.ip">
        </div>
      </div>

      <div class="flex gap-2 pt-1">
        <button @click="showAddDevice = false" class="btn btn-sm btn-ghost flex-1">Cancel</button>
        <button @click="addDevice()" :disabled="!newDevice.name || !newDevice.ip"
          class="btn btn-sm btn-primary flex-1 flex items-center justify-center gap-1.5">
          <span x-html="icon('plus', 13)" style="display:flex"></span>
          Add device
        </button>
      </div>

    </div>
  </div>

  <!-- Device settings modal -->
  <div x-show="showDeviceSettings" x-transition.opacity class="fixed inset-0 z-50 flex items-center justify-center p-4"
    style="background:rgba(0,0,0,0.6);backdrop-filter:blur(4px)" @click.self="closeDeviceSettings()">
    <div class="glass-card rounded-2xl w-full max-w-lg p-6 flex flex-col gap-5" x-transition:enter="transition ease-out duration-200"
      x-transition:enter-start="opacity-0 scale-95" x-transition:enter-end="opacity-100 scale-100" @click.stop>

      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="font-semibold text-white" x-text="currentDeviceSettings ? deviceTitle(currentDeviceSettings) : 'Device settings'"></h2>
          <div class="text-xs font-mono mt-1" style="color:rgba(255,255,255,0.35)" x-text="currentDeviceSettings?.name || ''"></div>
        </div>
        <button @click="closeDeviceSettings()" class="btn-mode w-8 h-8 p-0 rounded-lg" style="display:flex;align-items:center;justify-content:center">
          <span x-html="icon('x', 15)" style="display:flex"></span>
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="md:col-span-2">
          <div class="section-label mb-1.5">Display name</div>
          <input class="field" placeholder="Living Room Pixoo" x-model="deviceSettingsForm.displayName">
        </div>
        <div class="md:col-span-2">
          <div class="section-label mb-1.5">Comment</div>
          <textarea class="field" placeholder="Main dashboard display" x-model="deviceSettingsForm.comment"></textarea>
        </div>
        <div>
          <div class="section-label mb-1.5">Ulanzi Preview Poll (ms)</div>
          <input class="field font-mono" type="number" min="1000" max="10000" step="500" x-model="deviceSettingsForm.preview.pollMs">
          <div class="text-[11px] mt-1" style="color:rgba(255,255,255,0.28)">Safe range 1000-10000.</div>
        </div>
        <div>
          <div class="section-label mb-1.5">Preview grid</div>
          <label class="flex items-center gap-3 h-[42px] px-3 rounded-lg" style="border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03)">
            <input type="checkbox" x-model="deviceSettingsForm.preview.showGrid">
            <span class="text-sm text-white/80">Show pixel separators</span>
          </label>
        </div>
      </div>

      <div class="flex gap-2 pt-1">
        <button @click="closeDeviceSettings()" class="btn btn-sm btn-ghost flex-1">Close</button>
        <button @click="saveDeviceSettings()" class="btn btn-sm btn-primary flex-1">Save Settings</button>
      </div>
    </div>
  </div>

  <!-- Scene settings modal -->
  <div x-show="showSceneSettings" x-transition.opacity class="fixed inset-0 z-50 flex items-center justify-center p-4"
    style="background:rgba(0,0,0,0.72);backdrop-filter:blur(6px)" @click.self="closeSceneSettings()">
    <div class="glass-card rounded-2xl w-full max-w-5xl max-h-[92vh] p-6 flex flex-col gap-5 overflow-hidden" @click.stop>
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="font-semibold text-white" x-text="currentSceneSettings ? scenePrettyName(currentSceneSettings.sceneName) : 'Scene Settings'"></h2>
          <div class="text-xs font-mono mt-1" style="color:rgba(255,255,255,0.35)" x-text="currentSceneSettings ? (currentSceneSettings.deviceName + ' / ' + currentSceneSettings.sceneName) : ''"></div>
        </div>
        <button @click="closeSceneSettings()" class="btn-mode w-8 h-8 p-0 rounded-lg" style="display:flex;align-items:center;justify-content:center">
          <span x-html="icon('x', 15)" style="display:flex"></span>
        </button>
      </div>

      <div class="overflow-auto pr-1 flex flex-col gap-5">
        <template x-for="group in currentSceneFieldGroups()" :key="group.name">
          <div>
            <div class="section-label" x-text="group.name"></div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <template x-for="field in group.fields" :key="field.key">
                <div :class="field.type === 'json' ? 'md:col-span-2' : ''">
                  <div class="section-label mb-1.5" x-text="field.label"></div>
                  <template x-if="field.type === 'boolean'">
                    <label class="flex items-center gap-3 h-[42px] px-3 rounded-lg" style="border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03)">
                      <input type="checkbox" x-model="sceneSettingsForm[field.key]">
                      <span class="text-sm text-white/80" x-text="field.description || field.label"></span>
                    </label>
                  </template>
                  <template x-if="field.type === 'color'">
                    <input class="field h-[42px]" type="color" x-model="sceneSettingsForm[field.key]">
                  </template>
                  <template x-if="field.type === 'time'">
                    <input class="field font-mono" type="time" x-model="sceneSettingsForm[field.key]">
                  </template>
                  <template x-if="field.type === 'enum'">
                    <select class="field" x-model="sceneSettingsForm[field.key]">
                      <template x-for="opt in (field.options || [])" :key="typeof opt === 'object' ? opt.value : opt">
                        <option :value="typeof opt === 'object' ? opt.value : opt" x-text="typeof opt === 'object' ? opt.label : opt"></option>
                      </template>
                    </select>
                  </template>
                  <template x-if="field.type === 'json'">
                    <textarea class="field font-mono" x-model="sceneSettingsJson[field.key]"></textarea>
                  </template>
                  <template x-if="['int','float'].includes(field.type)">
                    <input class="field font-mono" type="number" :min="field.min" :max="field.max" :step="field.step || 1" x-model="sceneSettingsForm[field.key]">
                  </template>
                  <template x-if="!['boolean','color','time','enum','json','int','float'].includes(field.type)">
                    <input class="field" type="text" :placeholder="field.placeholder || ''" x-model="sceneSettingsForm[field.key]">
                  </template>
                  <div class="text-[11px] mt-1" style="color:rgba(255,255,255,0.28)" x-text="sceneFieldHint(field)"></div>
                </div>
              </template>
            </div>
          </div>
        </template>

        <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:16px">
          <div class="section-label">Clone / Detach Scene</div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div class="section-label mb-1.5">Target Scene Key</div>
              <input class="field font-mono" placeholder="home-kids" x-model="sceneCloneForm.targetSceneKey">
            </div>
            <div>
              <div class="section-label mb-1.5">Pretty Name Override</div>
              <input class="field" placeholder="Home Dashboard Kids" x-model="sceneCloneForm.targetPrettyName">
            </div>
            <div class="md:col-span-2">
              <label class="flex items-center gap-3 h-[42px] px-3 rounded-lg" style="border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03)">
                <input type="checkbox" x-model="sceneCloneForm.overwrite">
                <span class="text-sm text-white/80">Overwrite current scene key using a generated scene copy (source backed up first)</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="scene-actions-stack pt-1">
        <div class="scene-actions-stack-primary">
          <button @click="clearSceneOverlay()" class="btn btn-sm btn-ghost" :disabled="!mqttConnected || !currentSceneSettings">Clear Overlay</button>
          <button @click="applySceneOverlay()" class="btn btn-sm btn-ghost" :disabled="!mqttConnected || !currentSceneSettings">Set Overlay</button>
          <button @click="saveSceneSettings()" class="btn btn-sm btn-primary" :disabled="!currentSceneSettings">Save Settings</button>
        </div>
        <button @click="cloneScene()" class="btn btn-sm btn-outline" :disabled="!currentSceneSettings">Clone Scene</button>
      </div>
    </div>
  </div>

  <!-- Preview zoom -->
  <div x-show="showPreviewZoom" x-transition.opacity class="preview-lightbox" @click.self="closePreviewZoom()" @keydown.escape.window="closePreviewZoom()" @keydown.arrow-left.window="previewZoomPrev()" @keydown.arrow-right.window="previewZoomNext()">
    <div class="preview-lightbox-panel">
      <div class="preview-lightbox-header">
        <div class="min-w-0">
          <div class="font-semibold text-white text-base" x-text="previewZoomDevice ? deviceTitle(previewZoomDevice) : 'Preview'"></div>
          <div class="text-xs font-mono mt-1" style="color:rgba(255,255,255,0.35)" x-text="previewZoomDevice?.name || ''"></div>
          <div class="preview-lightbox-meta" x-show="previewZoomDevice">
            <span x-text="previewZoomDevice ? previewLabel(previewZoomDevice) : ''"></span>
            <span x-text="previewZoomDevice ? zoomStat(previewZoomDevice) : ''"></span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button class="icon-button" @click="previewZoomPrev()" title="Previous preview">
            <span x-html="icon('chevron-left', 16)" style="display:flex"></span>
          </button>
          <button class="icon-button" @click="previewZoomNext()" title="Next preview">
            <span x-html="icon('chevron-right', 16)" style="display:flex"></span>
          </button>
          <button class="icon-button" @click="closePreviewZoom()" title="Close preview zoom">
            <span x-html="icon('x', 16)" style="display:flex"></span>
          </button>
        </div>
      </div>

      <div class="preview-lightbox-stage">
        <div class="preview-shell preview-shell-zoom" :style="previewZoomShellStyle()" @dblclick="closePreviewZoom()">
          <canvas class="preview-canvas"
            id="preview-zoom-canvas"
            :width="previewZoomDimensions().width"
            :height="previewZoomDimensions().height"></canvas>
          <div class="preview-grid"
            :class="previewZoomDevice ? previewGridClass(previewZoomDevice) : ''"
            :style="previewZoomDevice ? previewGridStyle(previewZoomDevice) : ''"></div>
          <div class="preview-overlay" x-show="showPreviewZoom && previewZoomDevice && !previews[previewZoomDevice.name]">waiting for frames</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const ICON_NAME_MAP = {
      'layout-grid': 'LayoutGrid',
      'circle-alert': 'CircleAlert',
      'circle-check-big': 'CircleCheckBig',
      tv: 'Tv',
      monitor: 'Monitor',
      settings: 'Settings',
      x: 'X',
      'chevron-right': 'ChevronRight',
      play: 'Play',
      pause: 'Pause',
      square: 'Square',
      layers: 'Layers',
      save: 'Save',
      plus: 'Plus',
      'loader-circle': 'LoaderCircle',
      'chevron-left': 'ChevronLeft',
    };

    function icon(name, size = 16, colorStyle = '') {
      const exportName = ICON_NAME_MAP[name];
      const node = exportName ? window.lucide?.[exportName] : null;
      if (!node || typeof window.lucide?.createElement !== 'function') return '';

      return window.lucide.createElement(node, {
        width: size,
        height: size,
        style: colorStyle || undefined,
        stroke: 'currentColor',
      }).outerHTML;
    }

    function app() {
      return {
        config: null,
        sceneMeta: {},
        sceneSettingsState: {},
        mqttConnected: false,
        version: '',
        loading: true,
        previews: {},
        message: null,
        showAddDevice: false,
        showDeviceSettings: false,
        showSceneSettings: false,
        showPreviewZoom: false,
        currentDeviceSettings: null,
        currentSceneSettings: null,
        previewZoomDeviceName: null,
        newDevice: { name: '', type: 'ulanzi', ip: '' },
        deviceSettingsForm: {
          displayName: '',
          comment: '',
          preview: { showGrid: false, pollMs: 2000 },
        },
        sceneSettingsForm: {},
        sceneSettingsJson: {},
        sceneCloneForm: { targetSceneKey: '', targetPrettyName: '', overwrite: false },

        edits: {},
        newSceneSelect: {},
        newSceneKey: {},
        newScenePath: {},
        _previewTimer: null,
        _previewRenderedAt: {},

        async init() {
          try {
            const statusRes = await fetch('/api/status');
            const status = await statusRes.json();
            await this.reloadUiState();
            this.mqttConnected = status.mqttConnected;
            this.version = status.version;
            this._initDeviceState();
            await this.fetchPreviews();
            this.startPreviewPolling();
          } catch (e) {
            this.notify('Failed to load config: ' + e.message, 'error');
          }
          this.loading = false;
        },

        async reloadUiState() {
          const [cfgRes, sceneRes, sceneSettingsRes] = await Promise.all([
            fetch('/api/config'),
            fetch('/api/scenes'),
            fetch('/api/scene-settings'),
          ]);
          this.config = await cfgRes.json();
          this.sceneMeta = await sceneRes.json();
          this.sceneSettingsState = await sceneSettingsRes.json();
        },

        _initDeviceState() {
          for (const d of this.config.devices) {
            this._normalizeDevice(d);
            if (!this.edits[d.name]) {
              this.edits[d.name] = { scenes: [...d.scenes] };
              this.newSceneSelect[d.name] = '';
              this.newSceneKey[d.name] = '';
              this.newScenePath[d.name] = '';
            }
          }
        },

        _normalizeDevice(device) {
          if (!device.preview || typeof device.preview !== 'object') {
            device.preview = {};
          }
          device.displayName = (device.displayName || '').trim();
          device.comment = (device.comment || '').trim();
          device.preview.showGrid = Boolean(device.preview.showGrid);
          const pollMs = parseInt(device.preview.pollMs ?? 2000, 10);
          device.preview.pollMs = Number.isFinite(pollMs)
            ? Math.max(1000, Math.min(10000, pollMs))
            : 2000;
          return device;
        },

        deviceTitle(device) {
          return (device.displayName && device.displayName.trim()) || device.name;
        },

        openSceneSettings(deviceName, sceneName) {
          this.currentSceneSettings = { deviceName, sceneName };
          const state = this.sceneSettingsState?.[deviceName]?.[sceneName] || {};
          this.sceneSettingsForm = JSON.parse(JSON.stringify(state.effective || {}));
          this.sceneSettingsJson = {};
          for (const [key, field] of Object.entries(this.currentSceneSchema())) {
            if (field.type === 'json') {
              this.sceneSettingsJson[key] = JSON.stringify(this.sceneSettingsForm[key] ?? {}, null, 2);
            }
          }
          this.sceneCloneForm = {
            targetSceneKey: sceneName + '-copy',
            targetPrettyName: this.scenePrettyName(sceneName) + ' Copy',
            overwrite: false,
          };
          this.showSceneSettings = true;
        },

        closeSceneSettings() {
          this.showSceneSettings = false;
          this.currentSceneSettings = null;
        },

        currentSceneSchema() {
          if (!this.currentSceneSettings) return {};
          return this.sceneMeta?.[this.currentSceneSettings.sceneName]?.settingsSchema || {};
        },

        currentSceneFieldGroups() {
          const groups = {};
          for (const [key, field] of Object.entries(this.currentSceneSchema())) {
            const group = field.group || 'General';
            if (!groups[group]) groups[group] = [];
            groups[group].push({ key, ...field });
          }
          return Object.entries(groups).map(([name, fields]) => ({ name, fields }));
        },

        sceneFieldHint(field) {
          const hints = [];
          if (field.description) hints.push(field.description);
          if (field.min !== undefined || field.max !== undefined) {
            hints.push([field.min, field.max].filter(v => v !== undefined).join(' - '));
          }
          return hints.join(' · ');
        },

        sceneFormPayload() {
          const payload = JSON.parse(JSON.stringify(this.sceneSettingsForm || {}));
          for (const [key, text] of Object.entries(this.sceneSettingsJson || {})) {
            try {
              payload[key] = JSON.parse(text);
            } catch {
              payload[key] = {};
            }
          }
          return payload;
        },

        async saveSceneSettings() {
          if (!this.currentSceneSettings) return;
          const { deviceName, sceneName } = this.currentSceneSettings;
          await fetch('/api/scene-settings/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName, sceneName, values: this.sceneFormPayload() }),
          });
          await this.reloadUiState();
          this._initDeviceState();
          this.notify('Scene settings saved - hot-reloading...');
        },

        async applySceneOverlay() {
          if (!this.currentSceneSettings) return;
          const { deviceName, sceneName } = this.currentSceneSettings;
          const r = await fetch('/api/scene-settings/overlay', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName, sceneName, values: this.sceneFormPayload() }),
          });
          const data = await r.json();
          this.notify(data.ok ? 'Scene overlay applied' : (data.error || 'Failed'), data.ok ? 'success' : 'error');
          if (data.ok) await this.reloadUiState();
        },

        async clearSceneOverlay() {
          if (!this.currentSceneSettings) return;
          const { deviceName, sceneName } = this.currentSceneSettings;
          const r = await fetch('/api/scene-settings/overlay/clear', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName, sceneName }),
          });
          const data = await r.json();
          this.notify(data.ok ? 'Scene overlay cleared' : (data.error || 'Failed'), data.ok ? 'success' : 'error');
          if (data.ok) {
            await this.reloadUiState();
            const state = this.sceneSettingsState?.[deviceName]?.[sceneName];
            this.sceneSettingsForm = JSON.parse(JSON.stringify(state?.effective || {}));
          }
        },

        async cloneScene() {
          if (!this.currentSceneSettings) return;
          const r = await fetch('/api/scene/clone', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sceneName: this.currentSceneSettings.sceneName,
              targetSceneKey: this.sceneCloneForm.targetSceneKey,
              targetPrettyName: this.sceneCloneForm.targetPrettyName,
              overwrite: this.sceneCloneForm.overwrite,
            }),
          });
          const data = await r.json();
          this.notify(data.ok ? 'Scene cloned - hot-reloading...' : (data.error || 'Failed'), data.ok ? 'success' : 'error');
          if (data.ok) {
            await this.reloadUiState();
            this._initDeviceState();
          }
        },

        get previewZoomDevice() {
          if (!this.previewZoomDeviceName) return null;
          return this.config?.devices?.find(d => d.name === this.previewZoomDeviceName) || null;
        },

        openPreviewZoom(deviceName) {
          this.previewZoomDeviceName = deviceName;
          this.showPreviewZoom = true;
          this.$nextTick(() => this.renderZoomPreview());
        },

        closePreviewZoom() {
          this.showPreviewZoom = false;
          this.previewZoomDeviceName = null;
        },

        previewZoomDimensions() {
          return this.previewZoomDevice
            ? this.previewDimensions(this.previewZoomDevice)
            : { width: 64, height: 64 };
        },

        previewZoomShellStyle() {
          const dims = this.previewZoomDimensions();
          return 'aspect-ratio: ' + dims.width + ' / ' + dims.height + '; width: min(92vw, calc(88vh * ' + dims.width + ' / ' + dims.height + ')); max-width: 92vw; max-height: 88vh';
        },

        previewZoomPrev() {
          if (!this.showPreviewZoom || !this.previewZoomDeviceName) return;
          const names = (this.config?.devices || []).map(d => d.name);
          if (names.length === 0) return;
          const index = names.indexOf(this.previewZoomDeviceName);
          const nextIndex = index <= 0 ? names.length - 1 : index - 1;
          this.previewZoomDeviceName = names[nextIndex];
          this.$nextTick(() => this.renderZoomPreview());
        },

        previewZoomNext() {
          if (!this.showPreviewZoom || !this.previewZoomDeviceName) return;
          const names = (this.config?.devices || []).map(d => d.name);
          if (names.length === 0) return;
          const index = names.indexOf(this.previewZoomDeviceName);
          const nextIndex = index === -1 || index === names.length - 1 ? 0 : index + 1;
          this.previewZoomDeviceName = names[nextIndex];
          this.$nextTick(() => this.renderZoomPreview());
        },

        openDeviceSettings(deviceName) {
          const device = this.config.devices.find(d => d.name === deviceName);
          if (!device) return;
          this._normalizeDevice(device);
          this.currentDeviceSettings = device;
          this.deviceSettingsForm = {
            displayName: device.displayName || '',
            comment: device.comment || '',
            preview: {
              showGrid: Boolean(device.preview?.showGrid),
              pollMs: device.preview?.pollMs ?? 2000,
            },
          };
          this.showDeviceSettings = true;
        },

        closeDeviceSettings() {
          this.showDeviceSettings = false;
          this.currentDeviceSettings = null;
        },

        async saveDeviceSettings() {
          if (!this.currentDeviceSettings) return;
          const device = this.config.devices.find(d => d.name === this.currentDeviceSettings.name);
          if (!device) return;

          this._normalizeDevice(device);
          device.displayName = this.deviceSettingsForm.displayName.trim();
          device.comment = this.deviceSettingsForm.comment.trim();
          device.preview.showGrid = Boolean(this.deviceSettingsForm.preview.showGrid);

          const pollMs = parseInt(this.deviceSettingsForm.preview.pollMs, 10);
          device.preview.pollMs = Number.isFinite(pollMs)
            ? Math.max(1000, Math.min(10000, pollMs))
            : 2000;

          delete this._previewRenderedAt[device.name];
          await this.saveToFile(device.name);
          this.closeDeviceSettings();
        },

        startPreviewPolling() {
          if (this._previewTimer) clearInterval(this._previewTimer);
          this._previewTimer = setInterval(() => {
            this.fetchPreviews();
          }, 1000);
        },

        async fetchPreviews() {
          try {
            const res = await fetch('/api/previews');
            if (!res.ok) return;
            this.previews = await res.json();
            this.$nextTick(() => this.renderAllPreviews());
          } catch {}
        },

        renderAllPreviews() {
          for (const [deviceName, preview] of Object.entries(this.previews || {})) {
            if (!preview || !preview.data) continue;
            if (this._previewRenderedAt[deviceName] === preview.updatedAt) continue;
            this.renderPreview(deviceName, preview);
            this._previewRenderedAt[deviceName] = preview.updatedAt;
          }

          this.renderZoomPreview();
        },

        renderPreview(deviceName, preview) {
          const canvas = document.getElementById(this.previewCanvasId(deviceName));
          if (!canvas) return;

          this.renderPreviewToCanvas(canvas, preview);
        },

        renderZoomPreview() {
          if (!this.showPreviewZoom || !this.previewZoomDeviceName) return;

          const preview = this.previews?.[this.previewZoomDeviceName];
          const canvas = document.getElementById('preview-zoom-canvas');
          if (!preview || !canvas) return;

          this.renderPreviewToCanvas(canvas, preview);
        },

        renderPreviewToCanvas(canvas, preview) {
          if (!canvas || !preview) return;

          const ctx = canvas.getContext('2d');
          const binary = atob(preview.data);
          const rgba = new Uint8ClampedArray(preview.width * preview.height * 4);

          for (let src = 0, dst = 0; src < binary.length; src += 3, dst += 4) {
            rgba[dst] = binary.charCodeAt(src);
            rgba[dst + 1] = binary.charCodeAt(src + 1);
            rgba[dst + 2] = binary.charCodeAt(src + 2);
            rgba[dst + 3] = 255;
          }

          canvas.width = preview.width;
          canvas.height = preview.height;
          ctx.putImageData(new ImageData(rgba, preview.width, preview.height), 0, 0);
        },

        previewCanvasId(name) {
          return 'preview-' + name.replace(/[^a-zA-Z0-9_-]/g, '_');
        },

        previewDimensions(device) {
          return device.type === 'ulanzi'
            ? { width: 32, height: 8 }
            : { width: 64, height: 64 };
        },

        previewAspect(device) {
          return device.type === 'ulanzi' ? '4 / 1' : '1 / 1';
        },

        previewGridClass(device) {
          return device.preview?.showGrid ? 'visible' : '';
        },

        previewGridStyle(device) {
          const dims = this.previewDimensions(device);
          return 'background-size: calc(100% / ' + dims.width + ') calc(100% / ' + dims.height + ')';
        },

        previewLabel(device) {
          const preview = this.previews[device.name];
          if (!preview) {
            const pollMs = device.preview?.pollMs ?? 2000;
            return device.type === 'ulanzi' ? 'device poll ' + pollMs + 'ms' : 'runtime mirror';
          }

          const age = Date.now() - Date.parse(preview.updatedAt || 0);
          const ageSec = Number.isFinite(age) && age >= 0 ? (age / 1000).toFixed(age >= 10000 ? 0 : 1) : '?';
          const source = preview.source === 'device'
            ? 'device poll ' + (preview.intervalMs || device.preview?.pollMs || 2000) + 'ms'
            : 'runtime mirror';
          return source + ' - ' + ageSec + 's ago';
        },

        zoomStat(device) {
          const dims = this.previewDimensions(device);
          const preview = this.previews[device.name];
          if (!preview) return dims.width + 'x' + dims.height + ' - no signal yet';
          return dims.width + 'x' + dims.height + ' - updated ' + (preview.updatedAt ? new Date(preview.updatedAt).toLocaleTimeString() : 'unknown');
        },

        sceneInfo(sceneKey) {
          return this.sceneMeta?.[sceneKey] || this.config?.scenes?.[sceneKey] || null;
        },

        scenePrettyName(sceneKey) {
          const info = this.sceneInfo(sceneKey);
          return info?.pretty_name || info?.name || sceneKey;
        },

        sceneTitle(sceneKey) {
          const info = this.sceneInfo(sceneKey);
          const path = info?.path || this.config?.scenes?.[sceneKey]?.path || '';
          return path ? path.split('/').pop() : sceneKey;
        },

        availableScenes(deviceName) {
          const device = this.config?.devices?.find(d => d.name === deviceName);
          const known = Object.keys(this.config?.scenes ?? {});
          const active = this.edits[deviceName]?.scenes ?? [];
          return known.filter((key) => {
            if (active.includes(key)) return false;
            const info = this.sceneInfo(key);
            return !info?.deviceType || !device?.type || info.deviceType === device.type;
          });
        },

        removeScene(name, scene) {
          const label = this.scenePrettyName(scene);
          const ok = window.confirm('Remove scene "' + label + '" from device "' + name + '"?');
          if (!ok) return;
          this.edits[name].scenes = this.edits[name].scenes.filter(s => s !== scene);
        },

        addExistingScene(name) {
          const key = this.newSceneSelect[name];
          if (key && !this.edits[name].scenes.includes(key)) {
            this.edits[name].scenes.push(key);
          }
          this.newSceneSelect[name] = '';
        },

        addNewScene(name) {
          const key = this.newSceneKey[name].trim();
          const path = this.newScenePath[name].trim();
          if (!key || !path) return;
          if (!this.config.scenes[key]) this.config.scenes[key] = { path };
          if (!this.edits[name].scenes.includes(key)) this.edits[name].scenes.push(key);
          this.newSceneKey[name] = '';
          this.newScenePath[name] = '';
        },

        _buildConfig(deviceName) {
          const cfg = JSON.parse(JSON.stringify(this.config));
          const dev = cfg.devices.find(d => d.name === deviceName);
          dev.scenes = [...this.edits[deviceName].scenes];
          return cfg;
        },

        async saveToFile(name) {
          const cfg = this._buildConfig(name);
          try {
            const r = await fetch('/api/config/file', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(cfg),
            });
            const data = await r.json();
            if (data.ok) {
              await this.reloadUiState();
              this._initDeviceState();
              this.notify('Saved - hot-reloading...');
              await this.fetchPreviews();
            } else {
              this.notify(data.error || 'Save failed', 'error');
            }
          } catch (e) { this.notify(e.message, 'error'); }
        },

        async applyOverlay(name) {
          try {
            const r = await fetch('/api/overlay', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceName: name, scenes: this.edits[name].scenes }),
            });
            const data = await r.json();
            this.notify(data.ok ? 'Overlay applied' : (data.error || 'Failed'), data.ok ? 'success' : 'error');
          } catch (e) { this.notify(e.message, 'error'); }
        },

        async clearOverlay(name) {
          try {
            const r = await fetch('/api/overlay/clear', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceName: name }),
            });
            const data = await r.json();
            this.notify(data.ok ? 'Overlay cleared' : (data.error || 'Failed'), data.ok ? 'success' : 'error');
          } catch (e) { this.notify(e.message, 'error'); }
        },

        async setMode(name, mode) {
          try {
            const r = await fetch('/api/mode', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceName: name, mode }),
            });
            const data = await r.json();
            this.notify(data.ok ? name + ': ' + mode : (data.error || 'Failed'), data.ok ? 'success' : 'error');
          } catch (e) { this.notify(e.message, 'error'); }
        },

        async addDevice() {
          const { name, type, ip } = this.newDevice;
          if (!name || !ip) return;
          try {
            const r = await fetch('/api/device', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, type, ip }),
            });
            const data = await r.json();
            if (data.ok) {
              this.config.devices.push({
                name,
                type,
                ip,
                scenes: [],
                displayName: '',
                comment: '',
                preview: { showGrid: false, pollMs: 2000 },
                sceneSettings: {},
              });
              this._initDeviceState();
              this.showAddDevice = false;
              this.newDevice = { name: '', type: 'ulanzi', ip: '' };
              this.notify('Device added - hot-reloading...');
            } else {
              this.notify(data.error || 'Failed', 'error');
            }
          } catch (e) { this.notify(e.message, 'error'); }
        },

        notify(text, type = 'success') {
          this.message = { text, type };
          setTimeout(() => { this.message = null; }, 3500);
        },
      };
    }
  </script>
</body>
</html>`;
}

export default WebServer;
