/**
 * pidicon-light — Web UI
 * Minimal HTTP server: serves a single-page admin UI + JSON API.
 * Stack: DaisyUI + Tailwind CDN + Alpine.js (no build step).
 *
 * Routes:
 *   GET  /                    → HTML admin page
 *   GET  /api/config          → effective config JSON
 *   GET  /api/status          → {mqttConnected, version}
 *   POST /api/config/file     → write config.json (hot-reload kicks in)
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
   * @param {object}   [options.mqttService]       - MqttService instance or null
   * @param {object}   [options.logger]
   */
  constructor(options = {}) {
    this.port = parseInt(process.env.WEB_PORT || "8080", 10);
    this.configPath = options.configPath;
    this.getEffectiveConfig = options.getEffectiveConfig;
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

      if (method === "GET" && url.pathname === "/api/status") {
        this._json(res, {
          mqttConnected: !!(this.mqttService?.connected),
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
  </style>
</head>
<body class="min-h-screen bg-base-200" x-data="app()" x-init="init()" x-cloak>

  <!-- Navbar -->
  <div class="navbar bg-base-100 shadow-lg px-4 sticky top-0 z-40">
    <div class="flex-1 gap-3">
      <span class="text-lg font-bold tracking-tight">pidicon-light</span>
      <span class="text-xs opacity-40 font-mono" x-text="'v' + version"></span>
    </div>
    <div class="flex-none">
      <div class="badge gap-1" :class="mqttConnected ? 'badge-success' : 'badge-warning'">
        <span x-text="mqttConnected ? 'MQTT' : 'no MQTT'"></span>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div class="toast toast-top toast-end z-50 pt-16" x-show="message" x-transition.opacity>
    <div class="alert shadow-lg" :class="message?.type === 'error' ? 'alert-error' : 'alert-success'">
      <span x-text="message?.text"></span>
    </div>
  </div>

  <!-- Loading -->
  <div class="flex justify-center items-center h-64" x-show="loading">
    <span class="loading loading-spinner loading-lg text-primary"></span>
  </div>

  <!-- Content -->
  <main class="container mx-auto p-4 max-w-5xl" x-show="!loading">

    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <template x-for="device in config?.devices" :key="device.name">
        <div class="card bg-base-100 shadow-md">
          <div class="card-body gap-4 p-5">

            <!-- Header -->
            <div class="flex items-start justify-between gap-2 flex-wrap">
              <h2 class="card-title text-base font-bold" x-text="device.name"></h2>
              <div class="flex gap-1 flex-shrink-0">
                <div class="badge badge-outline badge-sm" x-text="device.type"></div>
                <div class="badge badge-ghost badge-sm font-mono text-xs" x-text="device.ip"></div>
              </div>
            </div>

            <!-- Scene list -->
            <div>
              <div class="text-xs opacity-50 mb-2 uppercase tracking-wide">Scenes</div>
              <div class="flex flex-wrap gap-1 min-h-6">
                <template x-for="scene in edits[device.name]?.scenes ?? []" :key="scene">
                  <div class="badge badge-primary gap-1 pr-1">
                    <span class="font-mono text-xs" x-text="scene"></span>
                    <button
                      @click="removeScene(device.name, scene)"
                      class="ml-0.5 hover:opacity-100 opacity-60 text-xs leading-none"
                      title="Remove">✕</button>
                  </div>
                </template>
                <span
                  class="text-xs opacity-30 self-center italic"
                  x-show="(edits[device.name]?.scenes ?? []).length === 0">none</span>
              </div>
            </div>

            <!-- Add from existing scenes -->
            <div class="flex gap-2">
              <select class="select select-bordered select-sm flex-1 font-mono text-xs"
                x-model="newSceneSelect[device.name]">
                <option value="">Pick existing scene…</option>
                <template x-for="key in availableScenes(device.name)" :key="key">
                  <option :value="key" x-text="key"></option>
                </template>
              </select>
              <button
                class="btn btn-sm btn-outline"
                @click="addExistingScene(device.name)"
                :disabled="!newSceneSelect[device.name]">Add</button>
            </div>

            <!-- Add new scene (collapsible) -->
            <div class="collapse collapse-arrow bg-base-200 rounded-box">
              <input type="checkbox">
              <div class="collapse-title text-xs font-medium py-2 min-h-0 leading-6">
                + New scene
              </div>
              <div class="collapse-content pb-0">
                <div class="flex flex-col gap-2 pb-3">
                  <input
                    class="input input-bordered input-sm w-full font-mono text-xs"
                    placeholder="scene-key"
                    x-model="newSceneKey[device.name]">
                  <input
                    class="input input-bordered input-sm w-full font-mono text-xs"
                    placeholder="/app/scenes/my-scene.js"
                    x-model="newScenePath[device.name]">
                  <button
                    class="btn btn-sm btn-outline w-full"
                    @click="addNewScene(device.name)"
                    :disabled="!newSceneKey[device.name] || !newScenePath[device.name]">Add</button>
                </div>
              </div>
            </div>

            <!-- Mode control -->
            <div>
              <div class="text-xs opacity-50 mb-2 uppercase tracking-wide">Mode</div>
              <div class="join w-full">
                <button class="join-item btn btn-sm flex-1" @click="setMode(device.name, 'play')"
                  :disabled="!mqttConnected" title="Play">▶</button>
                <button class="join-item btn btn-sm flex-1" @click="setMode(device.name, 'pause')"
                  :disabled="!mqttConnected" title="Pause">⏸</button>
                <button class="join-item btn btn-sm flex-1" @click="setMode(device.name, 'stop')"
                  :disabled="!mqttConnected" title="Stop">⏹</button>
              </div>
            </div>

            <!-- Save actions -->
            <div class="flex items-center justify-between border-t border-base-300 pt-3 mt-1 gap-2">
              <button
                class="btn btn-xs btn-ghost opacity-50 hover:opacity-100"
                @click="clearOverlay(device.name)"
                x-show="mqttConnected"
                title="Clear MQTT overlay for this device">clear overlay</button>
              <div class="flex gap-2 ml-auto">
                <button
                  class="btn btn-sm btn-ghost"
                  @click="applyOverlay(device.name)"
                  :disabled="!mqttConnected"
                  title="Apply as MQTT overlay (runtime, no file change)">Overlay</button>
                <button
                  class="btn btn-sm btn-primary"
                  @click="saveToFile(device.name)"
                  title="Write to config.json (triggers hot-reload)">Save to file</button>
              </div>
            </div>

          </div>
        </div>
      </template>
    </div>
  </main>

  <script>
    function app() {
      return {
        config: null,
        mqttConnected: false,
        version: '',
        loading: true,
        message: null,

        edits: {},          // deviceName → { scenes: [] }
        newSceneSelect: {}, // deviceName → ''
        newSceneKey: {},    // deviceName → ''
        newScenePath: {},   // deviceName → ''

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

            for (const d of this.config.devices) {
              this.edits[d.name] = { scenes: [...d.scenes] };
              this.newSceneSelect[d.name] = '';
              this.newSceneKey[d.name] = '';
              this.newScenePath[d.name] = '';
            }
          } catch (e) {
            this.notify('Failed to load config: ' + e.message, 'error');
          }
          this.loading = false;
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
          if (!this.config.scenes[key]) {
            this.config.scenes[key] = { path };
          }
          if (!this.edits[name].scenes.includes(key)) {
            this.edits[name].scenes.push(key);
          }
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
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(cfg),
            });
            const data = await r.json();
            if (data.ok) {
              this.config = cfg;
              this.notify('Saved — hot-reloading…');
            } else {
              this.notify(data.error || 'Save failed', 'error');
            }
          } catch (e) {
            this.notify(e.message, 'error');
          }
        },

        async applyOverlay(name) {
          try {
            const r = await fetch('/api/overlay', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceName: name, scenes: this.edits[name].scenes }),
            });
            const data = await r.json();
            this.notify(data.ok ? 'Overlay applied' : (data.error || 'Failed'), data.ok ? 'success' : 'error');
          } catch (e) {
            this.notify(e.message, 'error');
          }
        },

        async clearOverlay(name) {
          try {
            const r = await fetch('/api/overlay/clear', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceName: name }),
            });
            const data = await r.json();
            this.notify(data.ok ? 'Overlay cleared' : (data.error || 'Failed'), data.ok ? 'success' : 'error');
          } catch (e) {
            this.notify(e.message, 'error');
          }
        },

        async setMode(name, mode) {
          try {
            const r = await fetch('/api/mode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceName: name, mode }),
            });
            const data = await r.json();
            this.notify(data.ok ? name + ': ' + mode : (data.error || 'Failed'), data.ok ? 'success' : 'error');
          } catch (e) {
            this.notify(e.message, 'error');
          }
        },

        notify(text, type = 'success') {
          this.message = { text, type };
          setTimeout(() => { this.message = null; }, 3000);
        },
      };
    }
  </script>
</body>
</html>`;
}

export default WebServer;
