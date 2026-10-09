# pixdcon Development Guide

## Why pixdcon?

**pidicon** (v3.2.1, the predecessor) became too complex:

- 196 tests, Web UI (Vue 3 + Vuetify), MQTT integration
- Scene manager with scheduling, usage tracking, favorites
- Multi-device support, watchdog monitoring
- **Maintenance overhead exceeded net-worth**

**pixdcon** is a back-to-basics approach:

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
- current production use: `scenes/pixoo/home.js` uses 7×7 PNG assets for Nuki icons (open/closed/stale/transition) with a separate offline dot

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
pixdcon/
├── src/
│   ├── index.js          # Main entry: MQTT, hot reload, device startup
│   └── render-loop.js    # Per-device scene loop, backoff, circuit breaker, power-cycle
├── lib/
│   ├── collectors/
│   │   ├── ping-collector.js       # ICMP ping poller for health scenes
│   │   └── rpc-collector.js        # Shelly Gen2 RPC + HTTP liveness poller
│   ├── config-loader.js            # Config validation + loading
│   ├── config-overlay.js           # MQTT-retained overlay layer (merges on top of file config)
│   ├── config-watcher.js           # fs.watch hot reload (500ms debounce)
│   ├── mqtt-service.js             # MQTT publishing + shared scene subscription fan-out
│   ├── pixoo-driver.js             # Pixoo64 HTTP API driver (64×64 pixel buffer)
│   ├── pixoo-font.js               # Embedded 3×5 bitmap font for Pixoo
│   ├── pixoo-image.js              # PNG loader/alpha-blitter using sharp
│   ├── scene-loader.js             # Dynamic scene imports, per-device cache, init/destroy hooks
│   ├── scene-settings-service.js   # Schema-driven per-device/per-scene settings
│   ├── scenes-watcher.js           # Watches scene dirs for .js changes → hot-reload
│   ├── ulanzi-driver.js            # Ulanzi/AWTRIX HTTP API driver (32×8)
│   └── web-server.js               # Lightweight HTTP admin UI on port 8080
├── scenes/
│   ├── pixoo/
│   │   ├── home.js        # 3-row smart home dashboard: Nuki/doors/skylights/energy/media + keyboard status
│   │   ├── home2.js       # home with a boiler day chart (jhw2211/health/boiler) instead of UV; history in .state/home2-boiler.json
│   │   ├── funkeykid.js   # Educational keyboard display (letter + word on bg image)
│   │   └── health.js      # 4-tab network/device health dashboard (legacy/low priority)
│   └── ulanzi/
│       ├── clock_with_homestats.js  # Clock + Nuki/doors/battery/skylights (production)
│       ├── clock.js                 # Simple HH:MM:SS clock
│       └── test-pattern.js          # Animated dot for display verification
├── assets/
│   └── pixoo/
│       ├── nuki-closed.png          # 7×7 Nuki locked state icon
│       ├── nuki-open.png            # 7×7 Nuki unlocked state icon
│       ├── nuki-stale.png           # 7×7 Nuki unknown/stale state icon
│       ├── nuki-transition.png      # 7×7 Nuki locking/unlocking state icon
│       └── icons/
│           ├── pc-on.png            # 7×7 PC powered on
│           ├── pc-off.png           # 7×7 PC off
│           ├── ps5-on.png           # 7×7 PS5 powered on
│           ├── ps5-standby.png      # 7×7 PS5 standby
│           ├── tv-on.png            # 7×7 TV powered on
│           └── tv-standby.png       # 7×7 TV standby
├── generated-scenes/      # Cloned/detached scene copies (mounted writable on hsb1)
├── docs/
│   ├── AWTRIX-API.md      # Full AWTRIX HTTP API reference
│   ├── PIXOO-API.md       # Pixoo HTTP API + icon design notes
│   ├── DEBUG.md           # Debugging guide incl. MQTT stale-state investigation history
│   └── DEPLOY.md          # Deployment paths and ops reference
├── scripts/
│   ├── awtrix-rescue.sh        # AP-mode device re-provision
│   ├── build-and-push.sh       # Local Docker build + push (fallback)
│   └── preview-to-png.js       # Render scene preview to PNG
├── .github/workflows/
│   └── build-and-push.yml      # CI: multi-platform build → GHCR on push to main
├── +agents/              # Agent rules and slash commands
├── .env.example          # Env var reference (MOSQUITTO_*)
├── .dockerignore         # Excludes devenv, secrets, docs from image
├── devenv.nix            # Nix dev environment
├── Dockerfile            # Container build
├── docker-compose.example.yml  # Example compose with all mounts
└── config.example.json   # Config template with sceneSettings example
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
- Live overlay topics stay per-device and per-scene: `pixdcon/<device>/<scene>/settings/<key>`
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

Use Node 22 (matching `devenv.nix` and `node:22-alpine`).

```bash
cd ~/Code/pixdcon
npm install
npm run dev   # runs with --watch (auto-restarts on src changes)
```

### 2. Track Work in PPM

All tasks live in PPM (`pm.barta.cm`, project key `PIXD`, id 13). Create issues via the API or web UI — no repo backlog files. See `AGENTS.md` for the curl recipes. Reference issue keys in commit subjects.

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
docker logs -f pixdcon

# Live view in browser (AWTRIX built-in)
open http://192.168.1.56/screen

# Web UI
open http://hsb1.lan:8080
```

#### UPDATE a scene (on hsb1)

All user data lives on the host mount at `~/docker/mounts/pixdcon/` and is mounted into the container at `/data/`:

```
~/docker/mounts/pixdcon/     →  /data/  (in container)
├── config.json                    →  /data/config.json      (rw)
├── scenes/                        →  /data/scenes/          (rw)
│   ├── ulanzi/
│   └── pixoo/
└── generated-scenes/              →  /data/generated-scenes/ (rw)
```

Scene paths in `config.json` are relative to the config file (e.g. `./scenes/ulanzi/clock.js` → `/data/scenes/ulanzi/clock.js`).

The Docker image (`/app/`) contains only the application code (src/, lib/, node_modules/). Scenes, config, and settings all live in the mount.

**Two deploy paths:**

**Fast path — scene or config changes (no restart):**

```bash
# Scene file → ScenesWatcher hot-reloads within seconds
scp scenes/pixoo/home.js mba@hsb1.lan:~/docker/mounts/pixdcon/scenes/pixoo/home.js

# Config → ConfigWatcher hot-reloads (500ms debounce). The LIVE file is authoritative
# (web UI saves into it); never copy the repo's dev sample over it — pull, edit, push:
scp mba@hsb1.lan:~/docker/mounts/pixdcon/config.json /tmp/config.live.json
$EDITOR /tmp/config.live.json
scp /tmp/config.live.json mba@hsb1.lan:~/docker/mounts/pixdcon/config.json

# Also commit + push to keep git in sync
git add scenes/pixoo/home.js && git commit -m "..." && git push
```

**Full path — src/ or lib/ changes (needs image rebuild):**

A code change ships as a release: reserve `version.json`, PR → merge, tag `v<version>`, then OPS
pins the new image digest in nixcfg and switches hsb1 with Markus's go. See `docs/DEPLOY.md` § 3.

> Scene + config changes hot-reload via file watchers — no restart needed.
> src/ or lib/ changes require a release; hsb1 runs a pinned image, so a pull alone changes nothing.

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

> Scene paths are always relative (e.g. `./scenes/ulanzi/my-scene.js`).
> They resolve relative to the config file: locally → `./scenes/`, in Docker → `/data/scenes/`.

### 5. Deploy to hsb1

Release coordinates come only from committed `version.json`, with explicit
`version_scheme: inspr-calver-3` (INSPR-CalVer3; `inspr-calendar-v2` is the deprecated alias and invalid for new reservations). Reserve a new UTC `YYMMDDhhmmss.0.0`
coordinate at release preparation; it must be strictly later than the previous
calendar release. Never reuse a published coordinate for changed artifacts.
`package.json` and its lock retain the last legacy version `1.1.1`; existing
legacy tags/images remain unchanged. The coordinator records the legacy-to-calendar
anchor, stable channel sequence and immutable image digests in the release evidence.

CI runs `npm ci`, lint and tests on Node 22 for PRs and main/tag pushes. Only
main/tag pushes build images. A `v*` release tag must equal `v` + the version in
`version.json`; it publishes the exact coordinate with an OCI version label.
Main pushes retain `latest`. `scripts/build-and-push.sh` uses the same version
source. Deployment pin migration and exact-digest rollback verification belong
to the separate infrastructure review; repository changes alone do not complete adoption.

`GET /api/status` returns the canonical `version` and explicit `version_scheme`.
The header's single adapter uses the offline bundle in `vendor/inspr-versioning/`
(source commit and configuration/manifest SHA256 pins in
`scripts/verify-versioning-bundle.mjs`). Tests and normal CSS/Docker builds reject
missing, extra, altered or symlinked bundle payloads. Refresh the global-default
bundle with upstream `scripts/versioning-bundle.mjs` at an exact reviewed source
commit and update all three pins together. The read-only asset route serves only
the renderer, interaction helper, presentation module, config, scheme table and license;
it never fetches configuration from the editor at runtime.
The upstream bundler omits its source license: include `LICENSE` from the same
source commit in the file manifest before pinning its final digest, retaining the
upstream manifest digest as `upstreamManifestSha256`. No renderer bytes are changed.

Full procedure: `docs/DEPLOY.md` (or `/deploy`).

```bash
# Scene file change (fast — hot-reloads in seconds):
scp scenes/pixoo/home.js mba@hsb1:~/docker/mounts/pixdcon/scenes/pixoo/home.js

# Config change: pull the LIVE config, edit, push back (never copy the repo's dev sample over it):
scp mba@hsb1:~/docker/mounts/pixdcon/config.json /tmp/config.live.json   # then edit + scp back

# lib/ or src/ change = a release: version.json → PR → tag v<version> → OPS pins the
# image digest in nixcfg → hsb1 switch with Markus's go. hsb1 runs a pinned image, so
# Watchtower and `latest` no longer change what runs.

# Watch logs:
ssh mba@hsb1 "docker logs -f pixdcon"
```

## Deployment on hsb1

**Status: ✅ deployed and running**

**Server:** hsb1 (Mac mini, 192.168.1.101, NixOS 25.11)

### Infrastructure Context

hsb1 runs: mosquitto, homeassistant, zigbee2mqtt, nodered, scrypted, plex, pixdcon
hsb0 (192.168.1.99): AdGuard Home DNS
NixOS config: `../nixcfg/hosts/hsb1/`
Docker compose: `../nixcfg/hosts/hsb1/docker/docker-compose.yml`

### Currently Active Devices

Production config: `../nixcfg/hosts/hsb1/docker/mounts/pixdcon/config.json`

- `ulanzi-56` (192.168.1.56) → `clock_with_homestats`
- `ulanzi-57` (192.168.1.57) → `clock_with_homestats`
- Pixoo devices (159, 189) exist but are NOT in production config

### Container vs. Host Mount

```
Image (/app/)                     Host mount (/data/)
├── src/                          ├── config.json          (rw)
├── lib/                          ├── scenes/              (rw)
├── node_modules/                 │   ├── ulanzi/
└── (application code only)       │   └── pixoo/
                                  └── generated-scenes/    (rw)
```

- **Image** = application code. Changes require CI build + pull.
- **Host mount** = all user data (config, scenes, settings, generated scenes). Changes hot-reload.
- Scene paths in config are relative: `./scenes/ulanzi/X.js` → resolves to `/data/scenes/ulanzi/X.js`

### Locations

- Image: `ghcr.io/markus-barta/pixdcon:<version>@sha256:…`, pinned in nixcfg `hosts/hsb1/docker/compose-spec.nix` (release images come from `v<version>` tags; `:latest` from main is not deployed)
- Mount root: `~/docker/mounts/pixdcon/`
- Config: `~/docker/mounts/pixdcon/config.json`
- Scenes: `~/docker/mounts/pixdcon/scenes/{ulanzi,pixoo}/`
- Generated scenes: `~/docker/mounts/pixdcon/generated-scenes/`
- Secrets: `/run/agenix/hsb1-pixdcon-env` (MOSQUITTO_HOST/USER/PASS, SONNEN_BATTERY_HOST/TOKEN, SYNCBOX_BEARER_TOKEN)

```bash
# Logs
ssh mba@hsb1.lan "docker logs -f pixdcon"

# Restart (same image)
ssh mba@hsb1.lan "docker restart pixdcon"

# Stop (compose-hsb1.service would start it again on the next switch)
ssh mba@hsb1.lan "docker stop pixdcon"
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

All pixdcon topics are under `home/hsb1/pixdcon/`:

| Topic                       | Direction            | Description                             |
| --------------------------- | -------------------- | --------------------------------------- |
| `…/health`                  | publish (retained)   | Health status + error count             |
| `…/state`                   | publish (retained)   | Running state + per-device frame counts |
| `…/config/effective`        | publish (retained)   | Merged effective config                 |
| `…/<device>/mode`           | subscribe (retained) | `play` / `pause` / `stop` per device    |
| `…/overlay/device/+/scenes` | subscribe            | Override scenes list per device         |
| `…/overlay/device/+/ip`     | subscribe            | Override device IP                      |
| `…/overlay/blob`            | subscribe            | Full/partial config JSON overlay        |

**External topics consumed by scenes:**

| Topic | Scene | Description |
|-------|-------|-------------|
| `home/hsb1/funkeykid/display` | funkeykid | Letter + word + color from keyboard |
| `home/hsb1/funkeykid/keyboard-info` | home | Keyboard connection status (retained) |

## Testing Strategy

**Minimal for now:**

- Manual testing with real device
- Console logging for debugging
- Config validation on startup

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
