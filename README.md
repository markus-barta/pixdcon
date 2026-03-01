# pidicon-light

**Minimalist pixel display controller** - Config-file driven, no Web UI, just render.

## Vision

pidicon-light strips away the complexity of pidicon (3.2.1, 196 tests, Web UI, MQTT, scene manager, scheduling, etc.) and focuses on one thing:

> **Read a config file → Render scenes on pixel displays**

That's it. No Web UI, no MQTT, no scheduling, no fancy features. Just a simple render loop.

## Why

pidicon became too big for its purpose. Great idea, but maintenance overhead exceeds net-worth. pidicon-light is a back-to-basics approach:

- ✅ Config-file driven (no Web UI)
- ✅ Simple render loop
- ✅ Target: Ulanzi/AWTRIX first, then Pixoo
- ✅ Minimal dependencies
- ✅ Easy to maintain

## Initial Thoughts

### Architecture

```
config.json
  └─> Scene Loader
        └─> Render Loop
              └─> Device Driver (Ulanzi/Pixoo)
```

### Config Format (draft)

```json
{
  "devices": [
    {
      "name": "ulanzi-01",
      "type": "ulanzi",
      "ip": "192.168.1.xxx",
      "scenes": ["clock", "weather", "custom-scene-1"]
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

### Scene Contract

```javascript
module.exports = {
  name: "my-scene",
  render: async (device, config) => {
    // Draw your frame
    // Return delay in ms or null to finish
    return 1000;
  },
};
```

## Target Devices

1. **Ulanzi / AWTRIX** (32x8, MQTT or HTTP) - Priority #1
2. **Divoom Pixoo** (64x64, HTTP) - Priority #2

## Deployment

- Docker container on hsb1 (192.168.1.101)
- Config file mounted via volume
- No Web UI ports, minimal footprint

## Next Steps

- [ ] Define minimal scene API
- [ ] Implement Ulanzi driver
- [ ] Build config loader
- [ ] Create render loop
- [ ] Docker setup
- [ ] Deploy on hsb1

---

**License**: AGPL-3.0  
**Author**: Markus Barta
