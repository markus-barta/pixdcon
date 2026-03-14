# pidicon-light Development Guide

## Why pidicon-light?

**pidicon** (v3.2.1) became too complex:

- 196 tests, Web UI (Vue 3 + Vuetify), MQTT integration
- Scene manager with scheduling, usage tracking, favorites
- Multi-device support, watchdog monitoring
- **Maintenance overhead exceeded net-worth**

**pidicon-light** is a back-to-basics approach:

- Config-file driven (no heavy UI)
- Simple render loop
- Minimal dependencies
- Easy to maintain
- Target: Ulanzi/AWTRIX + Pixoo64

## Architecture

```
config.json
  -> ConfigLoader (validates + loads)
        -> ConfigOverlay (MQTT retained overlay layer)
              -> RenderLoop (per device)
                    -> SceneLoader (loads scene modules)
                          -> DeviceDriver (Ulanzi/Pixoo)
```

### Design Decisions

**Web UI (lightweight):**

- Node `http.createServer`, port 8080
- Inline SPA: DaisyUI + Alpine.js CDN (no build step)
- Per-device scene list, mode control (play/pause/stop)
- Per-device live preview: Pixoo mirrors runtime buffer, Ulanzi polls AWTRIX `/api/screen`
- Device config can also persist `displayName`, `comment`, and `preview` UI settings
- Scenes can declare `settingsSchema`; per-device per-scene values persist in `device.sceneSettings`
- Config file write + MQTT overlay support

**Simple Scene Contract:**

**Pixoo image overlays:**

- Pixoo scenes can draw transparent PNG overlays by decoding them with `sharp`
- helper: `lib/pixoo-image.js`
- intended use: preload/cache small pixel-art assets in `init()`, then alpha-blit during `render()`
- current production use: `scenes/pixoo/home.js` uses 8×8 PNG assets for Nuki icons while keeping the separate offline dot logic

```javascript
export default {
  name: "my-scene",
  settingsSchema: {
    speed_ms: {
      type: "int",
      label: "Speed (ms)",
      group: "Timing",
      default: 1000,
      min: 100,
      max: 10000,
      step: 100,
    },
  },

  async render(device) {
    await device.drawCustom({ text: "Hi", color: "#00FF00" });
    return 1000; // ms until next call, or null to end scene
  },
};
```

**Config-Driven:**

```json
{
  "devices": [
    {
      "name": "ulanzi-01",
      "type": "ulanzi",
      "ip": "192.168.1.56",
      "scenes": ["clock"],
      "sceneSettings": {
        "clock": {
          "text_color": "#00FF00",
          "show_seconds": true
        }
      },
      "minFrameMs": 500
    },
    {
      "name": "pixoo-01",
      "type": "pixoo",
      "ip": "192.168.1.159",
      "scenes": ["home"],
      "minFrameMs": 500,
      "maxPowerCycles": 10,
      "powerCyclePlugin": {
        "topic": "z2m/your/plug/set",
        "offPayload": "{\"state\":\"OFF\"}",
        "onPayload": "{\"state\":\"ON\"}",
        "offWaitMs": 10000,
        "onWaitMs": 30000
      }
    }
  ],
  "scenes": {
    "clock": { "path": "./scenes/ulanzi/clock.js" },
    "home": { "path": "./scenes/pixoo/home.js" }
  }
}
```

## Project Structure

```
pidicon-light/
├── src/
│   ├── index.js          # Main entry: MQTT, hot reload, device startup
│   └── render-loop.js    # Per-device scene loop, backoff, circuit breaker, power-cycle
├── lib/
│   ├── collectors/
│   │   ├── ping-collector.js   # ICMP ping poller for health scenes
│   │   └── rpc-collector.js    # Shelly Gen2 RPC + HTTP liveness poller
│   ├── config-loader.js   # Config validation + loading
│   ├── config-overlay.js  # MQTT-retained overlay layer (merges on top of file config)
│   ├── config-watcher.js  # fs.watch hot reload (500ms debounce)
│   ├── mqtt-service.js    # Health/state/config MQTT publishing + scene subscriptions
│   ├── pixoo-driver.js    # Pixoo64 HTTP API driver (64×64 pixel buffer)
│   ├── pixoo-font.js      # Embedded 3×5 bitmap font for Pixoo
│   ├── scene-loader.js    # Dynamic scene imports, ESM cache-bust, init/destroy hooks
│   ├── scenes-watcher.js  # Watches scene dirs for .js changes → hot-reload
│   ├── ulanzi-driver.js   # Ulanzi/AWTRIX HTTP API driver (32×8)
│   └── web-server.js      # Lightweight HTTP admin UI on port 8080
├── scenes/
│   ├── pixoo/
│   │   ├── home.js        # 3×3 grid smart home dashboard (production)
│   │   └── health.js      # 4-tab network/device health dashboard
│   └── ulanzi/
│       ├── clock_with_homestats.js  # Clock + Nuki/doors/battery/windows (production)
│       ├── clock.js                 # Simple HH:MM:SS clock
│       └── test-pattern.js          # Animated dot for display verification
├── docs/
│   ├── AWTRIX-API.md      # Full AWTRIX HTTP API reference
│   ├── PIXOO-API.md       # Pixoo HTTP API reference
│   ├── DEBUG.md           # Debugging tips
│   └── DEPLOY.md          # Deployment checklist
├── scripts/
│   ├── create-backlog-item.sh  # Backlog management
│   ├── lib/generate-hash.sh    # Hash generator
│   └── build-and-push.sh       # Local Docker build + push (fallback)
├── .github/workflows/
│   └── build-and-push.yml      # CI: multi-platform build → GHCR on push to main
├── +pm/backlog/          # Backlog items (auto-generated)
├── .env.example          # Env var reference (MOSQUITTO_*)
├── .dockerignore         # Excludes devenv, secrets, docs from image
├── devenv.nix            # Nix dev environment
├── Dockerfile            # Container build
└── config.example.json   # Config template
```

## Scene Scheduling — How It Works

A scene's `render()` function controls its own timing by returning the number of
milliseconds to wait before the next call:

```
render() called
  → draws to display
  → returns 1000          # sleep 1000ms (subject to minFrameMs floor)
render() called again
  → draws to display
  → returns 1000
...
render() returns null     # scene is done → advance to next scene
```

**Key points:**

- `return 1000` → redraw every second
- `return 200` → redraw ~5× per second (animation)
- `return null` → scene ends, render loop moves to next scene
- Multiple scenes cycle in order: when one returns `null`, the next starts
- On error, backoff kicks in (1s → 2s → 4s → … → 10min cap), scene retries

## Scene Settings System

- Scene modules can expose `settingsSchema` for typed UI/runtime settings
- Persisted values live under `devices[].sceneSettings[sceneName]` in `config.json`
- Effective value precedence: scene default -> persisted config -> retained MQTT overlay
- Live overlay topics stay per-device and per-scene: `pidicon-light/<device>/<scene>/settings/<key>`
- Web UI can edit persisted settings, set/clear overlay values, and clone/detach scenes into `generated-scenes/`

**Example cadences:**
| Scene | Return value | Effect |
|-------|-------------|--------|
| clock | `1000` | Redraws every second, runs forever |
| animation | `100` | ~10 FPS, runs forever |
| notification | `null` | Shows once then hands off to next scene |

## Frame-Rate Throttling (minFrameMs)

Each device has an optional `minFrameMs` setting (default: `500`). This enforces
a minimum wall-clock time between frame starts, **accounting for render time**:

```
sleepMs = max(scene_delay, max(0, minFrameMs − renderTime))
```

- Render takes 50ms, scene returns 1000ms → sleep 1000ms (scene wins)
- Render takes 50ms, scene returns 100ms, minFrameMs=500 → sleep 450ms (floor enforced)
- Render takes 600ms, minFrameMs=500 → sleep scene_delay (render already exceeded floor)

Set `minFrameMs: 0` to disable throttling entirely.

## Error Handling & Power-Cycle Recovery

### Circuit Breaker

After 10 consecutive render errors, the circuit opens. Behaviour depends on
whether `powerCyclePlugin` is configured for the device:

**Without powerCyclePlugin:**

- Sleep 10 minutes, reset counter, retry

**With powerCyclePlugin:**

1. Publish `offPayload` to the z2m plug topic → wait `offWaitMs` (default 10s)
2. Publish `onPayload` → wait `onWaitMs` (default 30s, device reboot time)
3. Mark driver as uninitialized → reset error counter → retry render
4. On successful render: `powerCycleCount` resets (device healthy again)
5. After `maxPowerCycles` (default 10) failed cycles with no recovery: device
   marked `"dead"`, render loop stops permanently

### powerCyclePlugin config

```json
"powerCyclePlugin": {
  "topic":      "z2m/wz/plug/zisp32/set",
  "offPayload": "{\"state\":\"OFF\"}",
  "onPayload":  "{\"state\":\"ON\"}",
  "offWaitMs":  10000,
  "onWaitMs":   30000
}
```

Requires `mqttService` to be connected. If MQTT is unavailable, power-cycle is
skipped and the loop falls back to the 10-minute sleep.

---

## Development Workflow

### 1. Setup

```bash
cd ~/Code/pidicon-light
npm install
npm run dev   # runs with --watch (auto-restarts on src changes)
```

### 2. Create Backlog Item

```bash
./scripts/create-backlog-item.sh A10 implement-pixoo-driver  # high priority
./scripts/create-backlog-item.sh P50 add-weather-scene       # normal priority
```

### 3. Scene CRUD

#### CREATE a scene

1. Create `scenes/pixoo/my-scene.js` or `scenes/ulanzi/my-scene.js`:

```javascript
export default {
  name: "my-scene",
  description: "What this scene does",

  async render(device) {
    await device.drawCustom({
      text: "Hello!",
      color: "#00FF00",
      center: true,
    });

    return 1000; // redraw every second (or null to end scene)
  },
};
```

2. Register it in `config.json`:

```json
{
  "devices": [
    {
      "name": "ulanzi-56",
      "type": "ulanzi",
      "ip": "192.168.1.56",
      "scenes": ["clock", "my-scene"],
      "minFrameMs": 500
    }
  ],
  "scenes": {
    "clock": { "path": "./scenes/ulanzi/clock.js" },
    "my-scene": { "path": "./scenes/ulanzi/my-scene.js" }
  }
}
```

3. Config watcher hot-reloads `config.json` automatically (500ms debounce).
   Scene _files_ hot-reload via ScenesWatcher — scp is instant on hsb1.

#### READ / inspect a scene

```bash
# Watch logs to see which scene is active and frame count
docker logs -f pidicon-light

# Live view in browser (AWTRIX built-in)
open http://192.168.1.56/screen

# Web UI
open http://hsb1.lan:8080
```

#### UPDATE a scene (on hsb1)

**Important:** scenes on hsb1 are **host-mounted** (`~/docker/mounts/pidicon-light/scenes/`), not baked into the image. The image contains the default scenes as fallback, but the mount overrides them.

Two deploy paths:

**Fast path — scene file only (no lib/ changes):**

```bash
# Edit locally, then scp directly → ScenesWatcher hot-reloads within seconds
scp scenes/pixoo/home.js mba@hsb1.lan:~/docker/mounts/pidicon-light/scenes/pixoo/home.js

# Also commit + push to keep git in sync
git add scenes/pixoo/home.js && git commit -m "..." && git push
```

**Full path — lib/ or src/ changes:**

```bash
git add . && git commit -m "..." && git push
# Wait for CI to finish (gh run watch), then:
ssh mba@hsb1.lan "cd ~/docker && docker compose pull pidicon-light && docker compose up -d pidicon-light"
```

> Config changes **hot-reload** without restart (500ms debounce).
> Scene file changes hot-reload via ScenesWatcher — scp is instant.
> lib/ or src/ changes require a new image build + pull.

Live preview notes:

- Pixoo preview is exact: captured from the in-memory RGB buffer after successful `push()`
- Ulanzi preview is device-reported: polled from AWTRIX `/api/screen` every ~2s
- Web UI refreshes preview data every 1s and renders pixelated canvases per device
- Per-device preview settings (`pollMs`, `showGrid`) plus `displayName` / `comment` persist in config

#### DELETE a scene

1. Remove scene name from `device.scenes` array in `config.json`
2. Remove the `scenes` map entry and delete the `.js` file
3. Commit + push → CI builds → pull on hsb1

### 4. Test Locally

```bash
# Point config at local device (relative paths work locally)
cat > config.json << 'EOF'
{
  "devices": [
    {
      "name": "ulanzi-56",
      "type": "ulanzi",
      "ip": "192.168.1.56",
      "scenes": ["my-scene"],
      "minFrameMs": 500
    }
  ],
  "scenes": {
    "my-scene": { "path": "./scenes/ulanzi/my-scene.js" }
  }
}
EOF

npm start
```

> On hsb1 the config uses absolute paths (`/app/scenes/`) since scenes live in the image.
> Locally use relative paths (`./scenes/`) — both work via SceneLoader path resolution.

### 5. Deploy to hsb1

```bash
# Scene file change (fast — hot-reloads in seconds):
scp scenes/pixoo/home.js mba@hsb1.lan:~/docker/mounts/pidicon-light/scenes/pixoo/home.js
git add scenes/pixoo/home.js && git commit -m "..." && git push

# lib/ or src/ change (needs CI build):
git add . && git commit -m "..." && git push
gh run watch --exit-status   # wait for CI
ssh mba@hsb1.lan "cd ~/docker && docker compose pull pidicon-light && docker compose up -d pidicon-light"

# Config-only change (hot-reloads, no restart needed):
scp config.json mba@hsb1.lan:~/docker/mounts/pidicon-light/config.json

# Watch logs:
ssh mba@hsb1.lan "docker logs -f pidicon-light"

# Watchtower handles weekly auto-updates automatically.
```

## Deployment on hsb1

**Status: ✅ deployed and running**

- Image: `ghcr.io/markus-barta/pidicon-light:latest` (built by GitHub Actions on push to main)
- Config: `~/docker/mounts/pidicon-light/config.json`
- Scenes: `~/docker/mounts/pidicon-light/scenes/`
- Secrets: `/run/agenix/hsb1-pidicon-light-env` (MOSQUITTO_HOST/USER/PASS via agenix)

```bash
# Logs
ssh mba@hsb1.lan "docker logs -f pidicon-light"

# Restart
ssh mba@hsb1.lan "cd ~/docker && docker compose restart pidicon-light"

# Stop
ssh mba@hsb1.lan "cd ~/docker && docker compose stop pidicon-light"
```

## Device Drivers

### Ulanzi/AWTRIX (32x8)

**API:** HTTP POST to `http://<ip>/api/draw`

**Frame Format:** Base64-encoded Uint8Array (32 × 8 × 3 = 768 bytes RGB)

### Pixoo64 (64x64)

**API:** HTTP POST to `http://<ip>/post`

**Frame Format:** `Draw/SendHttpGif` with base64 RGB buffer (64 × 64 × 3 = 12288 bytes)

**Known issue:** Pixoo HTTP stack can hang (TCP accepts no connections) after extended
uptime while ICMP/ARP remain responsive. Fix: power cycle via `powerCyclePlugin`.

## MQTT Topics

All pidicon-light topics are under `home/hsb1/pidicon-light/`:

| Topic                       | Direction            | Description                             |
| --------------------------- | -------------------- | --------------------------------------- |
| `…/health`                  | publish (retained)   | Health status + error count             |
| `…/state`                   | publish (retained)   | Running state + per-device frame counts |
| `…/config/effective`        | publish (retained)   | Merged effective config                 |
| `…/<device>/mode`           | subscribe (retained) | `play` / `pause` / `stop` per device    |
| `…/overlay/device/+/scenes` | subscribe            | Override scenes list per device         |
| `…/overlay/device/+/ip`     | subscribe            | Override device IP                      |
| `…/overlay/blob`            | subscribe            | Full/partial config JSON overlay        |

## Testing Strategy

**Minimal for now:**

- Manual testing with real device
- Console logging for debugging
- Config validation on startup

## Backlog Management

**Priority Schema:** `[A-Z][0-9]{2}`

- `A00` = Critical (drop everything)
- `P50` = Normal (default)
- `Z99` = Nice-to-have

## Secrets Management

**Never commit:**

- `.env` files with real values
- API keys, tokens, passwords

**Safe to commit:**

- `.env.example` with placeholders
- Config examples (with fake IPs)

---

**License:** AGPL-3.0
**Author:** Markus Barta
**Created:** 2026-03-01
