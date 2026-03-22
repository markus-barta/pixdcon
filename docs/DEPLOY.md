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

## Deploy paths

### 1. Scene file changed (`scenes/*.js`)

```bash
scp scenes/pixoo/home.js mba@hsb1:~/docker/mounts/pixdcon/scenes/pixoo/home.js
# ScenesWatcher detects the change and hot-reloads within seconds.
# No container restart needed.
```

### 2. Config changed (`config.json`)

```bash
scp config.json mba@hsb1:~/docker/mounts/pixdcon/config.json
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
