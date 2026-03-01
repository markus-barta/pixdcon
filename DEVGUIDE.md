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
module.exports = {
  name: my-scene,
  render: async (device) => {
    // Draw frame
    return 1000; // ms until next frame, or null to finish
  }
};
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
│   ├── index.js          # Main entry point
│   └── render-loop.js    # Scene cycler
├── lib/
│   ├── config-loader.js  # Config validation + loading
│   ├── scene-loader.js   # Dynamic scene imports
│   └── ulanzi-driver.js  # Ulanzi/AWTRIX HTTP API
├── scenes/
│   └── clock.example.js  # Example scene
├── scripts/
│   ├── create-backlog-item.sh  # Backlog management
│   ├── lib/generate-hash.sh    # Hash generator
│   └── build-and-push.sh       # Docker build + push
├── +pm/backlog/          # Backlog items (auto-generated)
├── .envrc                # direnv (GH_TOKEN from Keychain)
├── devenv.nix            # Nix dev environment
├── Dockerfile            # Container build
└── docker-compose.example.yml  # hsb1 deployment
```

## Development Workflow

### 1. Setup

```bash
cd ~/Code/pidicon-light

# Enter dev environment (auto-loads via direnv)
devenv shell

# Or just run (direnv auto-loads)
npm install
npm run dev
```

### 2. Create Backlog Item

```bash
# High priority
./scripts/create-backlog-item.sh A10 implement-pixoo-driver

# Normal priority
./scripts/create-backlog-item.sh P50 add-config-validation
```

### 3. Develop Scene

```javascript
// scenes/my-scene.js
export default {
  name: my-scene,
  
  async render(device) {
    // Draw on 32x8 matrix
    // device.push(frame) - Uint8Array(768) for RGB
    
    await device.clear();
    return 1000; // Update every second
  }
};
```

### 4. Test Locally

```bash
# Create config.json
cat > config.json <<JSONEOF
{
  devices: [
    {
      name: test-ulanzi,
      type: ulanzi,
      ip: 192.168.1.xxx,
      scenes: [my-scene]
    }
  ],
  scenes: {
    my-scene: { path: ./scenes/my-scene.js }
  }
}
JSONEOF

# Run
npm start
```

### 5. Build + Deploy

```bash
# Build and push to GHCR
./scripts/build-and-push.sh v0.1.0

# Deploy on hsb1
ssh mba@hsb1.lan
cd ~/Code/nixcfg/hosts/hsb1/docker
# Add pidicon-light to docker-compose.yml
docker compose up -d pidicon-light
```

## Deployment on hsb1

### 1. Add to docker-compose.yml

```yaml
pidicon-light:
  image: ghcr.io/markus-barta/pidicon-light:latest
  container_name: pidicon-light
  network_mode: host
  restart: unless-stopped
  environment:
    - TZ=Europe/Vienna
    - PIDICON_CONFIG_PATH=/data/config.json
  volumes:
    - ./mounts/pidicon-light/config.json:/data/config.json:ro
    - ./mounts/pidicon-light/scenes:/data/scenes:ro
  labels:
    - com.centurylinklabs.watchtower.enable=true
    - com.centurylinklabs.watchtower.scope=weekly
```

### 2. Create Config on hsb1

```bash
ssh mba@hsb1.lan
mkdir -p ~/Code/nixcfg/hosts/hsb1/docker/mounts/pidicon-light
```

### 3. Deploy

```bash
# On hsb1
cd ~/Code/nixcfg/hosts/hsb1/docker
docker compose up -d pidicon-light

# Check logs
docker logs -f pidicon-light
```

## Device Drivers

### Ulanzi/AWTRIX (32x8)

**API:** HTTP POST to `http://<ip>/api/draw`

**Frame Format:** Base64-encoded Uint8Array (32 * 8 * 3 = 768 bytes RGB)

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

## Next Steps

1. Repo created + pushed
2. Basic structure in place
3. Implement Ulanzi driver (test with real device)
4. Add Pixoo driver
5. Deploy on hsb1
6. Write first real scenes (clock, weather)

---

**License:** AGPL-3.0  
**Author:** Markus Barta  
**Created:** 2026-03-01
