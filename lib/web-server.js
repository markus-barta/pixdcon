/**
 * pidicon-light — Web UI
 * Minimal HTTP server: serves a single-page admin UI + JSON API.
 * Stack: DaisyUI + Tailwind CDN + Alpine.js (no build step).
 *
 * Routes:
 *   GET  /                    → HTML admin page
 *   GET  /api/config          → effective config JSON
 *   GET  /api/previews        → live frame previews for all devices
 *   GET  /api/status          → {mqttConnected, version}
 *   POST /api/config/file     → write config.json (hot-reload kicks in)
 *   POST /api/device          → {name, type, ip} → add device + save file
 *   POST /api/overlay         → {deviceName, scenes} → retained MQTT overlay
 *   POST /api/overlay/clear   → {deviceName}         → clear MQTT overlay
 *   POST /api/mode            → {deviceName, mode}   → MQTT mode control
 */

import { createServer } from "http";
import { writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
).version;

export class WebServer {
  /**
   * @param {object} options
   * @param {string}   options.configPath          - absolute path to config.json
   * @param {Function} options.getEffectiveConfig  - () => currentEffectiveConfig
   * @param {Function} [options.getFramePreviews]  - () => current preview map
   * @param {object}   [options.mqttService]       - MqttService instance or null
   * @param {object}   [options.logger]
   */
  constructor(options = {}) {
    this.port = parseInt(process.env.WEB_PORT || "8080", 10);
    this.configPath = options.configPath;
    this.getEffectiveConfig = options.getEffectiveConfig;
    this.getFramePreviews = options.getFramePreviews || (() => ({}));
    this.mqttService = options.mqttService ?? null;
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

      if (method === "GET" && url.pathname === "/api/previews") {
        this._json(res, this.getFramePreviews());
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
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px 2px 10px;
      border-radius: 9999px;
      font-size: 11px; font-family: 'JetBrains Mono', 'Fira Code', monospace;
      background: rgba(99,102,241,0.15);
      border: 1px solid rgba(99,102,241,0.3);
      color: #a5b4fc;
    }
    .scene-chip button {
      display: flex; align-items: center;
      opacity: 0.5; transition: opacity 0.15s;
      padding: 0 1px;
    }
    .scene-chip button:hover { opacity: 1; }

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
    }
    input.field:focus, select.field:focus {
      border-color: rgba(99,102,241,0.6);
      box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
    }
    input.field::placeholder { color: rgba(255,255,255,0.25); }
    select.field option { background: #1e2433; }

    .toast-item {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 16px; border-radius: 10px; font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .preview-shell {
      position: relative;
      overflow: hidden;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: radial-gradient(circle at top, rgba(34,211,238,0.14), transparent 52%), linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
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
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body class="min-h-screen" x-data="app()" x-init="init()" x-cloak>

  <!-- Navbar -->
  <header class="sticky top-0 z-40 border-b border-white/5" style="background:rgba(13,17,23,0.85);backdrop-filter:blur(16px)">
    <div class="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="10" height="10" x="3" y="3" rx="2"/><rect width="10" height="10" x="13" y="3" rx="2"/><rect width="10" height="10" x="13" y="13" rx="2"/><rect width="10" height="10" x="3" y="13" rx="2"/></svg>
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
        <span x-html="icon(message.type === 'error' ? 'alert-circle' : 'check-circle-2', 16)" style="flex-shrink:0;display:flex"></span>
        <span x-text="message.text"></span>
      </div>
    </template>
  </div>

  <!-- Loading -->
  <div class="flex flex-col items-center justify-center h-64 gap-3" x-show="loading">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
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
              <div class="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
                :class="device.type === 'ulanzi' ? 'bg-amber-500/15' : 'bg-cyan-500/15'">
                <span x-html="icon(device.type === 'ulanzi' ? 'tv-2' : 'monitor', 16, device.type === 'ulanzi' ? 'color:#f59e0b' : 'color:#22d3ee')" style="display:flex"></span>
              </div>
              <div class="min-w-0">
                <div class="font-semibold text-sm text-white leading-tight" x-text="device.name"></div>
                <div class="text-xs font-mono mt-0.5" style="color:rgba(255,255,255,0.35)" x-text="device.ip"></div>
              </div>
            </div>
            <span class="text-xs font-semibold px-2 py-1 rounded-md flex-shrink-0"
              :class="device.type === 'ulanzi' ? 'text-ulanzi bg-amber-500/10' : 'text-pixoo bg-cyan-500/10'"
              x-text="device.type"></span>
          </div>

          <!-- Card body -->
          <div class="p-5 flex flex-col gap-5">

            <div>
              <div class="flex items-center justify-between mb-2 gap-3">
                <div class="section-label mb-0">Live view</div>
                <div class="text-[10px] font-mono" style="color:rgba(255,255,255,0.35)" x-text="previewLabel(device)"></div>
              </div>
              <div class="preview-shell" :style="'aspect-ratio:' + previewAspect(device)">
                <canvas class="preview-canvas"
                  :id="previewCanvasId(device.name)"
                  :width="previewDimensions(device).width"
                  :height="previewDimensions(device).height"></canvas>
                <div class="preview-overlay" x-show="!previews[device.name]">waiting for frames</div>
              </div>
            </div>

            <!-- Scenes -->
            <div>
              <div class="section-label">Active scenes</div>
              <div class="flex flex-wrap gap-1.5 min-h-6">
                <template x-for="scene in edits[device.name]?.scenes ?? []" :key="scene">
                  <div class="scene-chip">
                    <span x-text="scene"></span>
                    <button @click="removeScene(device.name, scene)" title="Remove" style="display:flex">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                  </div>
                </template>
                <span class="text-xs italic self-center" style="color:rgba(255,255,255,0.2)"
                  x-show="(edits[device.name]?.scenes ?? []).length === 0">no scenes</span>
              </div>
            </div>

            <!-- Add existing -->
            <div class="flex gap-2">
              <select class="field flex-1 text-xs font-mono" x-model="newSceneSelect[device.name]" style="padding:7px 10px">
                <option value="">Pick existing…</option>
                <template x-for="key in availableScenes(device.name)" :key="key">
                  <option :value="key" x-text="key"></option>
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
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
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
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Play
                </button>
                <button class="btn-mode flex-1" @click="setMode(device.name, 'pause')" :disabled="!mqttConnected">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/></svg> Pause
                </button>
                <button class="btn-mode flex-1" @click="setMode(device.name, 'stop')" :disabled="!mqttConnected">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg> Stop
                </button>
              </div>
            </div>

            <!-- Footer actions -->
            <div class="flex items-center gap-2 pt-1" style="border-top:1px solid rgba(255,255,255,0.06)">
              <button @click="clearOverlay(device.name)" x-show="mqttConnected"
                class="text-xs flex items-center gap-1 px-2 py-1 rounded-md transition-colors"
                style="color:rgba(255,255,255,0.3)" onmouseover="this.style.color='rgba(255,255,255,0.6)'" onmouseout="this.style.color='rgba(255,255,255,0.3)'">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>
                clear overlay
              </button>
              <div class="flex gap-2 ml-auto">
                <button @click="applyOverlay(device.name)" :disabled="!mqttConnected"
                  class="btn btn-sm btn-ghost flex items-center gap-1.5">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>
                  Overlay
                </button>
                <button @click="saveToFile(device.name)"
                  class="btn btn-sm btn-primary flex items-center gap-1.5">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>
                  Save
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
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
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
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
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          Add device
        </button>
      </div>

    </div>
  </div>

  <script>
    const ICON_PATHS = {
      'alert-circle':    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
      'check-circle-2':  '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
      'tv-2':            '<path d="M7 21h10"/><rect width="20" height="14" x="2" y="3" rx="2"/>',
      'monitor':         '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    };
    function icon(name, size = 16, colorStyle = '') {
      const paths = ICON_PATHS[name] || '';
      const style = colorStyle ? \` style="\${colorStyle}"\` : '';
      return \`<svg width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"\${style}>\${paths}</svg>\`;
    }

    function app() {
      return {
        config: null,
        mqttConnected: false,
        version: '',
        loading: true,
        previews: {},
        message: null,
        showAddDevice: false,
        newDevice: { name: '', type: 'ulanzi', ip: '' },

        edits: {},
        newSceneSelect: {},
        newSceneKey: {},
        newScenePath: {},
        _previewTimer: null,
        _previewRenderedAt: {},

        async init() {
          try {
            const [cfgRes, statusRes] = await Promise.all([
              fetch('/api/config'),
              fetch('/api/status'),
            ]);
            this.config = await cfgRes.json();
            const status = await statusRes.json();
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

        _initDeviceState() {
          for (const d of this.config.devices) {
            if (!this.edits[d.name]) {
              this.edits[d.name] = { scenes: [...d.scenes] };
              this.newSceneSelect[d.name] = '';
              this.newSceneKey[d.name] = '';
              this.newScenePath[d.name] = '';
            }
          }
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
        },

        renderPreview(deviceName, preview) {
          const canvas = document.getElementById(this.previewCanvasId(deviceName));
          if (!canvas) return;

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

        previewLabel(device) {
          const preview = this.previews[device.name];
          if (!preview) {
            return device.type === 'ulanzi' ? 'device poll 2000ms' : 'runtime mirror';
          }

          const age = Date.now() - Date.parse(preview.updatedAt || 0);
          const ageSec = Number.isFinite(age) && age >= 0 ? (age / 1000).toFixed(age >= 10000 ? 0 : 1) : '?';
          const source = preview.source === 'device' ? 'device poll' : 'runtime mirror';
          return source + ' - ' + ageSec + 's ago';
        },

        availableScenes(deviceName) {
          const known = Object.keys(this.config?.scenes ?? {});
          const active = this.edits[deviceName]?.scenes ?? [];
          return known.filter(k => !active.includes(k));
        },

        removeScene(name, scene) {
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
            if (data.ok) { this.config = cfg; this.notify('Saved — hot-reloading…'); }
            else this.notify(data.error || 'Save failed', 'error');
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
              this.config.devices.push({ name, type, ip, scenes: [] });
              this._initDeviceState();
              this.showAddDevice = false;
              this.newDevice = { name: '', type: 'ulanzi', ip: '' };
              this.notify('Device added — hot-reloading…');
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
