Read and follow @+agents/rules/AGENTS.md — adopt the pixdcon developer role.

Before starting any task, internalize this project context:

## Project

pixdcon — minimalist pixel display controller for AWTRIX/Ulanzi (32×8) + Pixoo64 (64×64) LED matrices.
Node.js ESM, config-file driven, MQTT integration, Docker deployed on hsb1.

## Architecture

```
config.json → ConfigLoader → ConfigOverlay (MQTT retained) → RenderLoop (per device)
  → SceneLoader (dynamic import) → DeviceDriver (Ulanzi HTTP | Pixoo HTTP)
```

Key files:
- `src/index.js` — entry point, orchestration
- `src/render-loop.js` — per-device scene loop, backoff, circuit breaker, power-cycle
- `lib/pixoo-driver.js` — Pixoo64 64×64 RGB buffer + HTTP push
- `lib/ulanzi-driver.js` — AWTRIX 32×8 HTTP API
- `lib/pixoo-font.js` — 3×5 bitmap font
- `lib/pixoo-image.js` — PNG alpha-blit via sharp
- `lib/config-overlay.js` — MQTT retained overlay on top of file config
- `lib/mqtt-service.js` — publish + per-device subscribe fan-out
- `lib/scene-loader.js` — dynamic scene imports, init/destroy hooks
- `lib/web-server.js` — DaisyUI + Alpine admin UI, port 8080
- `lib/scene-settings-service.js` — schema-driven per-device/per-scene settings

## Scene Contract

Scenes export `{ name, pretty_name, deviceType, render(device), settingsSchema? }`.
`render()` returns ms until next call (or null to end scene).
Scene files live in `scenes/pixoo/` or `scenes/ulanzi/`.

## Active Scenes (in codebase)

**Pixoo64:**
- `home.js` — 3×3 smart-home dashboard (Nuki, doors, skylights, battery, PV, boiler, TV/PS5/PC)
- `health.js` — 4-tab network health (ping/RPC collectors)
- `funkeykid.js` — educational keyboard display (letter + word + color on background image)

**Ulanzi:**
- `clock_with_homestats.js` — time + Nuki/doors/skylights/battery (production)
- `clock.js` — simple HH:MM:SS
- `test-pattern.js` — animated dot for display verification

## Production Deployment (hsb1)

**Server:** hsb1 (Mac mini, 192.168.1.101, NixOS 25.11)
**Image:** `ghcr.io/markus-barta/pixdcon:latest` (CI builds on push to main)
**Secrets:** `/run/agenix/hsb1-pixdcon-env` (MOSQUITTO_HOST/USER/PASS, SONNEN_BATTERY_HOST/TOKEN)
**Network:** host mode (web UI on port 8080)
**Auto-update:** Watchtower weekly

### Container vs. Host Mount (the clean split)

```
Image (/app/)                     Host mount (/data/)
├── src/                          ├── config.json          (rw)
├── lib/                          ├── scenes/              (rw)
├── node_modules/                 │   ├── ulanzi/
└── (application code only)       │   └── pixoo/
                                  └── generated-scenes/    (rw)
```

- **Image** = application code only. Changes require CI build + pull.
- **Host mount** = all user data (config, scenes, settings). Changes hot-reload.
- Scene paths in config are **always relative**: `./scenes/ulanzi/clock.js` → resolves to `/data/scenes/ulanzi/clock.js`
- Host mount root: `~/docker/mounts/pixdcon/`

**Currently active devices** (production config in `../nixcfg/hosts/hsb1/docker/mounts/pixdcon/config.json`):
- `ulanzi-56` (192.168.1.56) → `clock_with_homestats`
- `ulanzi-57` (192.168.1.57) → `clock_with_homestats`
- Pixoo devices (159, 189) exist but are NOT in production config

## Deploy Workflows

| Change type | Deploy method | Restart? |
|------------|--------------|----------|
| `scenes/*.js` | `scp` to hsb1 mount → ScenesWatcher hot-reloads | No |
| `config.json` | `scp` to hsb1 mount → ConfigWatcher hot-reloads | No |
| `src/`, `lib/`, `package.json` | push to main → CI → `docker compose pull && up -d` | Yes |

Use `/deploy` for guided deployment.

## MQTT Topics

All under `home/hsb1/pixdcon/`:
- `health`, `state`, `config/effective` — publish (retained)
- `<device>/mode` — subscribe: `play`/`pause`/`stop`
- `overlay/device/+/scenes`, `overlay/device/+/ip`, `overlay/blob` — config overlay

## Dev Workflow

```bash
npm install && npm run dev   # --watch auto-restart
```

Scene paths are always relative: `./scenes/ulanzi/X.js` resolves against the config file's directory.

## Infrastructure Context

- **hsb1** runs: mosquitto, homeassistant, zigbee2mqtt, nodered, scrypted, plex, pixdcon
- **hsb0** (192.168.1.99): AdGuard Home DNS
- NixOS config: `../nixcfg/hosts/hsb1/`
- Docker compose: `../nixcfg/hosts/hsb1/docker/docker-compose.yml`

## Reference Docs

- `@DEVGUIDE.md` — full development guide
- `@docs/DEPLOY.md` — deployment procedures
- `@docs/AWTRIX-API.md` — AWTRIX HTTP API
- `@docs/PIXOO-API.md` — Pixoo HTTP API + icon design
- `@docs/DEBUG.md` — debugging guide

---

Do not start any task until the user explicitly asks. Greet and confirm you're ready.
