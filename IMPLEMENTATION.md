# Architecture Reference

**Version:** 1.0.0

---

## Runtime flow

```
config.json + env vars
  → ConfigLoader (validates, normalizes)
    → SceneSettingsService (per-device/per-scene settings, MQTT overlay)
      → RenderLoop (per device, per scene)
        → SceneLoader (dynamic ESM import, per-device cache)
          → DeviceDriver (UlanziDriver or PixooDriver)
        → MqttService (shared client, fan-out subscriptions)
      → ScenesWatcher (inotify on scene files → hot-reload)
    → ConfigWatcher (inotify on config.json → hot-reload)
  → WebServer (HTTP admin UI, REST API)
```

---

## Key design points

**Shared MQTT client, per-topic fan-out**

All scenes share one MQTT client. `subscribe()` and `subscribeWildcard()` maintain
a shared handler per topic that fans out to all logical scene callbacks. `unsubscribeAll(sceneName)`
cleans up both exact-topic and wildcard entries. Forced retained replay (`rh: 0`) is requested
on re-subscribe so scenes always receive the broker's retained value even if the topic was
previously subscribed by another scene.

**Per-device scene cache**

`SceneLoader` caches scene instances by `${sceneName}::${deviceName}` so two devices using the
same scene file each get their own in-memory instance, own subscriptions, and own settings state.

**Self-heal loop**

On startup, `scenes/pixoo/home.js` runs a self-heal timer that re-subscribes any topic whose
state is still `null`. This compensates for cases where the broker cannot re-deliver retained
messages to a freshly-subscribed shared client. The loop stops as soon as all expected topics
resolve. See `docs/DEBUG.md` for the full investigation history.

**PNG overlays (Pixoo)**

`lib/pixoo-image.js` loads transparent PNGs via `sharp`, caches decoded RGBA in memory, and
alpha-blits onto the 64×64 raw RGB buffer per pixel. Used for Nuki lock state icons and
bottom-row media device icons.

**Scene settings**

Scenes expose a `settingsSchema`. The web UI generates a form per device/scene. Values
are saved into `device.sceneSettings[sceneName]` in `config.json`. A retained MQTT overlay
layer can override values temporarily without touching the config file.

**Hot-reload**

Two separate watchers:

- `ConfigWatcher`: monitors `config.json` (500ms debounce) → tears down and rebuilds all render loops
- `ScenesWatcher`: monitors `.js` files in scene dirs → evicts the changed scene from cache and refreshes metadata

**Error handling / power-cycle**

Each `RenderLoop` has exponential backoff (1s → 10min cap), a 10-consecutive-error circuit breaker,
and an optional `powerCyclePlugin` that can power-cycle a device via MQTT plug before retrying.

---

## Deployment split (important)

The Docker image contains core code (`src/`, `lib/`, `assets/`). Scene files and `config.json`
are host-mounted and shadow the image. This means:

| What changed                   | How to deploy                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `scenes/*.js`                  | `scp` to `~/docker/mounts/pixdcon/scenes/`; ScenesWatcher hot-reloads     |
| `assets/pixoo/*.png`           | `scp` to `~/docker/mounts/pixdcon/assets/pixoo/` + image pull             |
| `config.json`                  | `scp` to `~/docker/mounts/pixdcon/config.json`; ConfigWatcher hot-reloads |
| `lib/`, `src/`, `package.json` | Push → CI → `docker compose pull` + `up -d` on hsb1                             |

See `docs/DEPLOY.md` for the full ops reference.

---

## MQTT subscription internals

`lib/mqtt-service.js` maintains three Maps:

| Map                | Key                                  | Value                               |
| ------------------ | ------------------------------------ | ----------------------------------- |
| `_subscriptions`   | `sceneName` → `Map<topic, callback>` | Per-logical-owner subscriptions     |
| `_topicEntries`    | exact topic                          | `{ callbacks: Map, sharedHandler }` |
| `_wildcardEntries` | wildcard pattern                     | `{ callbacks: Map, sharedHandler }` |

`unsubscribeAll(sceneName)` must clean both `_topicEntries` and `_wildcardEntries` to avoid
orphaned handlers that dispatch retained messages to dead scene instances.
