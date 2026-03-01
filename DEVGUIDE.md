# pidicon-light Development Guide

## Why pidicon-light?

**pidicon** (v3.2.1) became too complex:

- 196 tests, Web UI (Vue 3 + Vuetify), MQTT integration
- Scene manager with scheduling, usage tracking, favorites
- Multi-device support, watchdog monitoring
- **Maintenance overhead exceeded net-worth**

**pidicon-light** is a back-to-basics approach:

- Config-file driven (no Web UI)
- Simple render loop
- Minimal dependencies
- Easy to maintain
- Target: Ulanzi/AWTRIX first, Pixoo later

## Architecture

```
config.json
  -> ConfigLoader (validates + loads)
        -> RenderLoop (per device)
              -> SceneLoader (loads scene modules)
                    -> DeviceDriver (Ulanzi/Pixoo)
```

### Design Decisions

**No Web UI:**

- pidicon Web UI was 80% of complexity
- Config files are version-controlled, testable, deployable
- No state management, no WebSocket sync, no UI bugs

**Simple Scene Contract:**

```javascript
export default {
  name: "my-scene",
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
      "scenes": ["clock"]
    }
  ],
  "scenes": {
    "clock": { "path": "./scenes/clock.js" }
  }
}
```

**Config-Driven:**

```json
{
  devices: [
    {
      name: ulanzi-01,
      type: ulanzi,
      ip: 192.168.1.xxx,
      scenes: [clock, weather]
    }
  ],
  scenes: {
    clock: { path: ./scenes/clock.js, interval: 5000 }
  }
}
```

## Project Structure

```
pidicon-light/
├── src/
│   ├── index.js          # Main entry point, MQTT init, hot reload
│   └── render-loop.js    # Per-device scene loop, backoff, circuit breaker
├── lib/
│   ├── config-loader.js  # Config validation + loading
│   ├── config-watcher.js # fs.watch hot reload (500ms debounce)
│   ├── mqtt-service.js   # Health/state/config MQTT publishing
│   ├── scene-loader.js   # Dynamic scene imports, caching
│   └── ulanzi-driver.js  # Ulanzi/AWTRIX HTTP API driver
├── scenes/
│   ├── clock.js          # HH:MM:SS green clock, 1s updates
│   └── test-pattern.js   # Animated dot, display verification
├── docs/
│   └── AWTRIX-API.md     # Full AWTRIX HTTP API reference
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
  → returns 1000          # sleep 1000ms
render() called again
  → draws to display
  → returns 1000          # sleep 1000ms
...
render() returns null     # scene is done → advance to next scene
```

**Key points:**

- `return 1000` → redraw every second
- `return 200` → redraw ~5× per second (animation)
- `return null` → scene ends, render loop moves to next scene in device's list
- There is **no fixed interval** — each scene decides its own cadence per frame
- Multiple scenes cycle in order: when one returns `null`, the next starts
- On error, backoff kicks in (1s → 2s → 4s → … → 10min cap), scene retries

**Example cadences:**
| Scene | Return value | Effect |
|-------|-------------|--------|
| clock | `1000` | Redraws every second, runs forever |
| animation | `100` | ~10 FPS, runs forever |
| notification | `null` | Shows once then hands off to next scene |

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

1. Create `scenes/my-scene.js`:

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
      "scenes": ["clock", "my-scene"]
    }
  ],
  "scenes": {
    "clock": { "path": "./scenes/clock.js" },
    "my-scene": { "path": "./scenes/my-scene.js" }
  }
}
```

3. Config watcher hot-reloads `config.json` automatically (500ms debounce).
   Scene _files_ require a container restart to reload from disk.

#### READ / inspect a scene

```bash
# Watch logs to see which scene is active and frame count
docker logs -f pidicon-light

# Live view in browser (AWTRIX built-in)
open http://192.168.1.56/screen
```

#### UPDATE a scene (on hsb1)

Scenes are **baked into the Docker image** — source of truth is the git repo.

```bash
# 1. Edit scene locally in scenes/my-scene.js
# 2. Commit and push → CI builds new image automatically
git add scenes/my-scene.js
git commit -m "fix(my-scene): ..."
git push

# 3. On hsb1: pull new image (or wait for Watchtower weekly)
ssh mba@hsb1.lan "cd ~/docker && docker compose pull pidicon-light && docker compose up -d pidicon-light"
```

> **Config** (`config.json`) is the only mounted file — edit on hsb1 directly or via nixcfg repo.
> Config changes **hot-reload** without restart.
> Scene changes require a new image build + pull.

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
      "scenes": ["my-scene"]
    }
  ],
  "scenes": {
    "my-scene": { "path": "./scenes/my-scene.js" }
  }
}
EOF

npm start
```

> On hsb1 the config uses absolute paths (`/app/scenes/`) since scenes live in the image.
> Locally use relative paths (`./scenes/`) — both work via SceneLoader path resolution.

### 5. Deploy to hsb1

```bash
# Scene or code change:
git add scenes/my-scene.js && git commit -m "..." && git push
# → CI builds image → pull on hsb1:
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

**Frame Format:** Base64-encoded Uint8Array (32 _ 8 _ 3 = 768 bytes RGB)

### Pixoo (64x64) - TODO

**API:** HTTP POST to `http://<ip>/post`

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

## Next Steps / Backlog

- Add Pixoo driver (64x64)
- Write more scenes: weather, HA sensor data, etc.
- Scene scheduling (show scene X for N seconds then rotate)

---

**License:** AGPL-3.0  
**Author:** Markus Barta  
**Created:** 2026-03-01
