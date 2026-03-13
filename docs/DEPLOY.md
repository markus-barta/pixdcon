# Deploy Guide

## Server

| What       | Value                                       |
| ---------- | ------------------------------------------- |
| Host       | `hsb1` (SSH as `mba@hsb1`)                  |
| Mount root | `~/docker/mounts/pidicon-light/`            |
| Compose    | `~/docker/docker-compose.yml`               |
| Image      | `ghcr.io/markus-barta/pidicon-light:latest` |

## Volume mounts (in container)

| Host path                          | Container path           |
| ---------------------------------- | ------------------------ |
| `mounts/pidicon-light/config.json` | `/data/config.json` (rw) |
| `mounts/pidicon-light/scenes/`     | `/app/scenes/` (ro)      |

Scene paths in `config.json` use `/app/scenes/` — the mount overlay takes effect, so files in the host `scenes/` folder shadow the built-in image scenes.

---

## Deploy paths

### 1. Scene file changed (`scenes/*.js`)

```bash
scp scenes/<name>.js mba@hsb1:~/docker/mounts/pidicon-light/scenes/
# Trigger hot-reload (ConfigWatcher clears scene cache + re-imports):
ssh mba@hsb1 "touch ~/docker/mounts/pidicon-light/config.json"
```

No container restart needed.

### 2. Config changed (`config.json`)

```bash
scp config.json mba@hsb1:~/docker/mounts/pidicon-light/config.json
```

ConfigWatcher picks it up automatically. No restart needed.

Important: `config.json` must be mounted writable, because the web UI persists edits from inside the container.

### 3. Core code changed (`src/`, `lib/`, `package.json`, `Dockerfile`)

Push to `main` — GitHub Actions builds and pushes to GHCR automatically:

```bash
git push origin main
# Watch: gh run watch
```

Watchtower (weekly scope) will pull and restart the container automatically.
To deploy immediately without waiting for Watchtower:

```bash
ssh mba@hsb1 "cd ~/docker && docker compose pull pidicon-light && docker compose up -d pidicon-light"
```

Workflow: `.github/workflows/build-and-push.yml`
Image: `ghcr.io/markus-barta/pidicon-light:latest`
Platforms: `linux/amd64`, `linux/arm64`

---

## Useful ops

```bash
# Logs (live)
ssh mba@hsb1 "docker logs -f pidicon-light"

# Restart
ssh mba@hsb1 "cd ~/docker && docker compose restart pidicon-light"

# Container status
ssh mba@hsb1 "docker ps | grep pidicon"
```
