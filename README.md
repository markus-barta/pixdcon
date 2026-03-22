# pixdcon

Pixel display controller for Ulanzi/AWTRIX 32×8 and Pixoo64 64×64 LED matrices.
Config-file driven, web UI included, MQTT-connected, Docker-deployed.

**Version:** 1.0.0 — running live on `hsb1`

> Successor to pidicon (v3) and pidicon-light (v2). Fresh start, same hardware.

---

## What it does

- Drives multiple pixel displays (Ulanzi/AWTRIX and Pixoo64) simultaneously
- Runs configurable scene loops per device
- Web UI on port 8080: live preview, scene management, per-device/per-scene settings
- MQTT integration: health, state, config publishing; scene overlay control
- Hot-reload: config and scene file changes apply without restart
- Per-device scene settings with schema-driven UI (brightness, show seconds, etc.)
- Transparent PNG overlay support via `sharp` for pixel-art icons on Pixoo

## Devices in use

| Device      | Type              | What it shows                        |
| ----------- | ----------------- | ------------------------------------ |
| `ulanzi-56` | Ulanzi TC001 32×8 | Clock + Nuki/doors/skylights/battery |
| `ulanzi-57` | Ulanzi TC001 32×8 | Clock + Nuki/doors/skylights/battery |
| `pixoo-159` | Pixoo64 64×64     | 3-row smart home dashboard           |

---

## Quick Start

### Local dev

```bash
npm install
cp config.example.json config.json
# edit config.json: set real device IPs
npm start
# Web UI: http://localhost:8080
```

### Docker

```bash
docker build -t pixdcon:latest .
docker run -d --name pixdcon \
  --network host \
  -e MOSQUITTO_HOST=192.168.1.101 \
  -e MOSQUITTO_USER=smarthome \
  -e MOSQUITTO_PASS=yourpassword \
  -v $(pwd)/config.json:/data/config.json \
  -v $(pwd)/scenes:/data/scenes \
  -v $(pwd)/generated-scenes:/data/generated-scenes \
  pixdcon:latest
```

---

## Configuration

### config.json

```json
{
  "devices": [
    {
      "name": "ulanzi-56",
      "type": "ulanzi",
      "ip": "192.168.1.56",
      "scenes": ["clock_with_homestats"],
      "minFrameMs": 500,
      "displayName": "Ulanzi Badezimmer",
      "sceneSettings": {
        "clock_with_homestats": {
          "bri_day": 30,
          "show_seconds": true
        }
      }
    },
    {
      "name": "pixoo-159",
      "type": "pixoo",
      "ip": "192.168.1.159",
      "scenes": ["home"],
      "minFrameMs": 500,
      "maxPowerCycles": 10,
      "powerCyclePlugin": {
        "topic": "z2m/wz/plug/zisp32/set",
        "offPayload": "{\"state\":\"OFF\"}",
        "onPayload": "{\"state\":\"ON\"}",
        "offWaitMs": 10000,
        "onWaitMs": 30000
      }
    }
  ],
  "scenes": {
    "clock_with_homestats": {
      "path": "./scenes/ulanzi/clock_with_homestats.js"
    },
    "home": { "path": "./scenes/pixoo/home.js" }
  }
}
```

Scene paths are relative to the config file. Locally: `./scenes/` → `./scenes/`. In Docker: `./scenes/` → `/data/scenes/`.

### Environment variables

| Variable                   | Default         | Description                         |
| -------------------------- | --------------- | ----------------------------------- |
| `MOSQUITTO_HOST`           | `localhost`     | MQTT broker hostname                |
| `MQTT_PORT`                | `1883`          | MQTT port                           |
| `MOSQUITTO_USER`           | `smarthome`     | MQTT username                       |
| `MOSQUITTO_PASS`           | —               | MQTT password (required)            |
| `LOG_LEVEL`                | `info`          | `error` / `warn` / `info` / `debug` |
| `TZ`                       | `Europe/Vienna` | Timezone                            |
| `SONNEN_BATTERY_HOST`      | —               | Sonnen battery API host             |
| `SONNEN_BATTERY_API_TOKEN` | —               | Sonnen battery API token            |
| `SYNCBOX_BEARER_TOKEN`     | —               | Hue Play Sync Box bearer token      |

---

## Scene contract

A scene is a plain ES module with a `render()` function. `init()` and `destroy()` are optional lifecycle hooks.

```javascript
export default {
  name: "my-scene",
  pretty_name: "My Scene",
  deviceType: "ulanzi",  // or "pixoo"
  description: "What it does",

  // Optional: expose typed settings in the web UI
  settingsSchema: {
    show_seconds: {
      type: "boolean",
      label: "Show Seconds",
      group: "Display",
      default: true,
    },
  },

  async init(context) {
    // subscribe to MQTT, preload images, etc.
    context.mqtt.subscribe("some/topic", (payload) => { ... });
  },

  async render(device) {
    await device.drawCustom({ text: "Hi", color: "#00FF00" });
    return 1000; // ms until next render, or null to end scene
  },

  async destroy(context) {
    context.mqtt.unsubscribeAll();
  },
};
```

---

## MQTT topics

All pixdcon topics are prefixed with `home/hsb1/pixdcon/`:

| Topic                         | Direction          | Description                             |
| ----------------------------- | ------------------ | --------------------------------------- |
| `.../health`                  | publish retained   | Health status + error count             |
| `.../state`                   | publish retained   | Running state + per-device frame counts |
| `.../config/effective`        | publish retained   | Merged effective config                 |
| `.../<device>/mode`           | subscribe retained | `play` / `pause` / `stop` per device    |
| `.../overlay/device/+/scenes` | subscribe          | Override scenes list per device         |

Scene settings overlay topics per device + scene:

```
pixdcon/<device>/<scene>/settings/<key>
```

---

## Deployment on hsb1

See `docs/DEPLOY.md` for the full deployment guide.

```bash
# Logs
ssh mba@hsb1 "docker logs -f pixdcon"

# Deploy after lib/src change (CI builds image):
git push origin main
gh run watch --exit-status
ssh mba@hsb1 "cd ~/docker && docker compose pull pixdcon && docker compose up -d pixdcon"

# Deploy scene file change only (hot-reload, no restart):
scp scenes/pixoo/home.js mba@hsb1:~/docker/mounts/pixdcon/scenes/pixoo/home.js
```

---

## License

AGPL-3.0 | Markus Barta
