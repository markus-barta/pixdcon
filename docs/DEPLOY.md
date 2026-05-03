# Deploy Guide

## Server

| What       | Value                                       |
| ---------- | ------------------------------------------- |
| Host       | `hsb1` (SSH as `mba@hsb1`)                  |
| Mount root | `~/docker/mounts/pixdcon/`            |
| Compose    | `~/docker/docker-compose.yml`               |
| Image      | `ghcr.io/markus-barta/pixdcon:latest` |

## Container vs. Host Mount

```
Image (/app/)                     Host mount (/data/)
├── src/                          ├── config.json          (rw)
├── lib/                          ├── scenes/              (rw)
├── node_modules/                 │   ├── ulanzi/
└── (application code only)       │   └── pixoo/
                                  └── generated-scenes/    (rw)
```

- **Image** (`/app/`) = application code only. Changes require CI build + pull.
- **Host mount** (`/data/`) = all user data. Changes hot-reload, no restart needed.

| Host path                                       | Container path                  | Mode |
| ------------------------------------------------ | ------------------------------- | ---- |
| `mounts/pixdcon/config.json`               | `/data/config.json`             | rw   |
| `mounts/pixdcon/scenes/`                   | `/data/scenes/`                 | rw   |
| `mounts/pixdcon/generated-scenes/`         | `/data/generated-scenes/`       | rw   |

Scene paths in `config.json` are **relative** to the config file (e.g. `./scenes/ulanzi/clock.js` resolves to `/data/scenes/ulanzi/clock.js` in the container).

---

## Source of truth — read this first

> **The live mount on `hsb1` is authoritative for `config.json` and `scenes/*.js`.**
> The repo's `config.json` is a dev sample. The repo's `scenes/*.js` are the canonical version of *committed* scenes, but the host copies can drift (web UI saves settings into `config.json`; "Clone & Detach" writes to `generated-scenes/`).

| Asset                            | Authoritative location                                         | Edited by                            |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `config.json` (effective)        | `mba@hsb1:~/docker/mounts/pixdcon/config.json`                 | Web UI saves + manual `scp`          |
| `scenes/*.js` (committed)        | Repo `scenes/`, mirrored to host on deploy                     | Editor + `scp` to live mount         |
| `generated-scenes/*.js`          | `mba@hsb1:~/docker/mounts/pixdcon/generated-scenes/`           | Web UI "Clone & Detach" only         |
| App code (`src/`, `lib/`, deps)  | Image `ghcr.io/markus-barta/pixdcon:latest`                    | CI on push to `main`                 |

**Before any change to a scene that's currently running:**

```bash
# Snapshot the live copy so you can roll back instantly
ssh mba@hsb1 "cp ~/docker/mounts/pixdcon/scenes/pixoo/home.js ~/docker/mounts/pixdcon/scenes/pixoo/home.js.bak"
```

**Before changing `config.json`:**

```bash
# Pull the live config first — it has settings the repo doesn't
scp mba@hsb1:~/docker/mounts/pixdcon/config.json /tmp/config.live.json
# Edit /tmp/config.live.json, then push back
scp /tmp/config.live.json mba@hsb1:~/docker/mounts/pixdcon/config.json
```

---

## Scene hot-reload — how it actually works

`ScenesWatcher` (`lib/scenes-watcher.js`) watches every directory returned by `SceneLoader.getSceneDirs()` (one per scene path in `config.json`). On `change`/`rename` for any `*.js`:

1. Debounce 500 ms.
2. `findScenesByFilename(filename)` → matching scene names.
3. For each match: `SceneLoader.clearScene(name)`:
   - Calls `scene.destroy(ctx)` so MQTT subs and intervals are released.
   - Removes the cache entry.
   - Sets `_reloadTokens.set(name, Date.now())`.
4. Render loop's next tick re-imports with `?t=<token>` appended to the path → ESM cache miss → fresh module → `init()` runs again.

**Implication:** `scp newfile.js` to the live mount is the entire deploy. No restart, no `touch config.json`. Container stays up.

**Failure modes:**

- New module throws on import → render loop catches, logs `[SceneLoader] Failed to load scene "<name>"`, retries with backoff (1s → 10min cap). Display shows last frame until recovery; re-`scp` a working version to fix.
- New `init()` throws → same as above; `destroy()` of the *previous* version already ran, so the previous subscriptions are gone.
- New `settingsSchema` adds keys → defaults apply automatically; existing values in `config.json` survive untouched.

---

## Deploy paths

### 1. Scene file changed (`scenes/*.js`)

```bash
scp scenes/pixoo/home.js mba@hsb1:~/docker/mounts/pixdcon/scenes/pixoo/home.js
# ScenesWatcher detects the change and hot-reloads within seconds.
# No container restart needed.

# Optional: confirm reload landed
ssh mba@hsb1 "docker logs pixdcon --tail 20 | grep -E 'evicted|Loaded scene|Failed'"
```

### 1a. Iterative scene rewrite (e.g. v2 of `home.js`)

When you're going to push many tweaks in a row, work safely:

```bash
# 1. Snapshot the live version (one time, at the start of the session)
ssh mba@hsb1 "cp ~/docker/mounts/pixdcon/scenes/pixoo/home.js ~/docker/mounts/pixdcon/scenes/pixoo/home.js.bak"

# 2. Iterate: edit local → scp → watch logs → repeat
scp scenes/pixoo/home.js mba@hsb1:~/docker/mounts/pixdcon/scenes/pixoo/home.js
ssh mba@hsb1 "docker logs pixdcon --tail 5"

# 3. Roll back fast if something goes sideways
ssh mba@hsb1 "cp ~/docker/mounts/pixdcon/scenes/pixoo/home.js.bak ~/docker/mounts/pixdcon/scenes/pixoo/home.js"

# 4. When happy, commit + push the local file (image is unchanged — repo is just history)
git add scenes/pixoo/home.js && git commit && git push
```

Notes:
- ScenesWatcher fires on every save → leave windows open and watch logs.
- Brittle changes (new MQTT topics, new image assets) need the assets in place *before* the scp lands or `init()` will throw on first load.

### 1b. Visual verification — capture the live frame

`pixdcon` already serves the live render on `GET /api/previews` (the same data the web UI shows). Use `scripts/preview-to-png.js` to fetch + decode + upscale to a PNG you can eyeball:

```bash
# Defaults: --host hsb1:8080 --device pixoo-159 --out /tmp/frame.png --scale 8
node scripts/preview-to-png.js
open /tmp/frame.png

# Other devices / scales:
node scripts/preview-to-png.js --device pixoo-189 --scale 16
node scripts/preview-to-png.js --host localhost:8080
```

The buffer captured is the exact RGB sent to the device on the last `push()`. If the device is unreachable, no frame is captured (push throws before the preview hook fires).

### 1c. Inject test state via retained MQTT

For value-specific testing without waiting for the real world (e.g. seeing what the UV tile looks like at UVI 11 in the middle of winter), scenes should expose debug-override topics under `pixdcon/debug/<key>`. Pattern: handler accepts a numeric/JSON payload to override, treats null/empty as clear.

Example — inject extreme UV state on `home`:

```bash
PASS='<MOSQUITTO_PASS>'   # from /run/agenix/hsb1-pixdcon-env on hsb1
H='192.168.1.101'

# Set: current UVI=11 + a 14-element forecast for hours 06..19
ssh mba@hsb1 "echo 11 | mosquitto_pub -h $H -u smarthome -P '$PASS' -t pixdcon/debug/uv_now_override -r -s"
ssh mba@hsb1 "echo '[0,0.5,1.5,3,5,7,9,11,11,10,8,5,2,0]' | mosquitto_pub -h $H -u smarthome -P '$PASS' -t pixdcon/debug/uv_hourly_override -r -s"

# Capture
node scripts/preview-to-png.js --out /tmp/uv-extreme.png

# Clear (use -n for a null payload — NOT -s with empty stdin, which sends "\n")
ssh mba@hsb1 "mosquitto_pub -h $H -u smarthome -P '$PASS' -t pixdcon/debug/uv_now_override -r -n"
ssh mba@hsb1 "mosquitto_pub -h $H -u smarthome -P '$PASS' -t pixdcon/debug/uv_hourly_override -r -n"
```

Existing debug-override topics on `home`:
- `pixdcon/debug/bri_override` — display brightness 1-100 (or empty to clear)
- `pixdcon/debug/uv_now_override` — current UVI float
- `pixdcon/debug/uv_hourly_override` — JSON array of 14 hourly UVI floats (06..19)

### 2. Config changed (`config.json`)

> ⚠ **Pull-before-push.** The live config is edited by the web UI and is almost always ahead of the repo's `config.json`. Overwriting it blindly will revert UI-saved settings.

```bash
# Pull → edit → push
scp mba@hsb1:~/docker/mounts/pixdcon/config.json /tmp/config.live.json
$EDITOR /tmp/config.live.json
scp /tmp/config.live.json mba@hsb1:~/docker/mounts/pixdcon/config.json
```

ConfigWatcher picks it up automatically. No restart needed.

Config is mounted rw — the web UI can persist settings edits from inside the container.

### 3. Core code changed (`src/`, `lib/`, `package.json`, `Dockerfile`)

Push to `main` — GitHub Actions builds and pushes to GHCR automatically:

```bash
git push origin main
# Watch: gh run watch
```

Watchtower (weekly scope) will pull and restart the container automatically.
To deploy immediately without waiting for Watchtower:

```bash
ssh mba@hsb1 "cd ~/docker && docker compose pull pixdcon && docker compose up -d pixdcon"
```

Workflow: `.github/workflows/build-and-push.yml`
Image: `ghcr.io/markus-barta/pixdcon:latest`
Platforms: `linux/amd64`, `linux/arm64`

---

## Initial scene seeding

On first deploy (or after adding a new scene), copy scene files from the repo to the host mount:

```bash
# Full sync (preserves directory structure):
scp -r scenes/ulanzi/ mba@hsb1:~/docker/mounts/pixdcon/scenes/ulanzi/
scp -r scenes/pixoo/ mba@hsb1:~/docker/mounts/pixdcon/scenes/pixoo/

# Create generated-scenes dir if needed:
ssh mba@hsb1 "mkdir -p ~/docker/mounts/pixdcon/generated-scenes"
```

---

## Useful ops

```bash
# Logs (live)
ssh mba@hsb1 "docker logs -f pixdcon"

# Restart
ssh mba@hsb1 "cd ~/docker && docker compose restart pixdcon"

# Container status
ssh mba@hsb1 "docker ps | grep pixdcon"
```
