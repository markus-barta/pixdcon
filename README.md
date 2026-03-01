# pidicon-light

**Minimalist pixel display controller** - Config-file driven, no Web UI, just render.

[![GitHub](https://img.shields.io/github/repo-size/markus-barta/pidicon-light)](https://github.com/markus-barta/pidicon-light)
[![License](https://img.shields.io/github/license/markus-barta/pidicon-light)](LICENSE)

## Vision

pidicon-light strips away the complexity of pidicon (3.2.1, 196 tests, Web UI, MQTT, scene manager) and focuses on one thing:

> **Read a config file -> Render scenes on pixel displays**

That it. No Web UI, no MQTT, no scheduling. Just a simple render loop.

## Why

pidicon became too big for its purpose. Great idea, but maintenance overhead exceeds net-worth. pidicon-light is back-to-basics:

- Config-file driven (no Web UI)
- Simple render loop
- Target: Ulanzi/AWTRIX first, then Pixoo
- Minimal dependencies
- Easy to maintain

## Quick Start

```bash
# Clone
git clone https://github.com/markus-barta/pidicon-light.git
cd pidicon-light

# Install
npm install

# Create config
cp config.example.json config.json
# Edit config.json with your device IP

# Run
npm start
```

## Config Example

```json
{
  "devices": [
    {
      "name": "ulanzi-01",
      "type": "ulanzi",
      "ip": "192.168.1.xxx",
      "scenes": ["clock", "weather"]
    }
  ],
  "scenes": {
    "clock": {
      "path": "./scenes/clock.js",
      "interval": 5000
    },
    "weather": {
      "path": "./scenes/weather.js",
      "interval": 10000
    }
  }
}
```

## Scene Example

```javascript
// scenes/clock.js
export default {
  name: clock,
  
  async render(device) {
    const now = new Date();
    const time = now.toLocaleTimeString();
    
    // Draw on device (32x8 matrix)
    await device.clear();
    // TODO: device.drawText(time, 0, 0);
    
    return 1000; // Update every second
  }
};
```

## Target Devices

1. **Ulanzi / AWTRIX** (32x8, HTTP API) - Priority 1
2. **Divoom Pixoo** (64x64, HTTP API) - Priority 2

## Deployment

### Docker on hsb1

```yaml
pidicon-light:
  image: ghcr.io/markus-barta/pidicon-light:latest
  container_name: pidicon-light
  network_mode: host
  restart: unless-stopped
  volumes:
    - ./config.json:/data/config.json:ro
    - ./scenes:/data/scenes:ro
```

See [DEVGUIDE.md](DEVGUIDE.md) for full deployment instructions.

## Development

```bash
# Enter dev environment (direnv auto-loads)
devenv shell

# Run in dev mode
npm run dev

# Create backlog item
./scripts/create-backlog-item.sh P50 add-feature

# Build + push Docker image
./scripts/build-and-push.sh v0.1.0
```

## Documentation

- [DEVGUIDE.md](DEVGUIDE.md) - Complete development guide
- [AGENTS.md](AGENTS.md) - Agent protocol and guidelines

## Scripts

| Script | Description |
|--------|-------------|
| `scripts/create-backlog-item.sh` | Create backlog item with unique hash |
| `scripts/build-and-push.sh` | Build and push Docker image to GHCR |

## License

AGPL-3.0 - See [LICENSE](LICENSE)

---

**Made with less code, more focus**
