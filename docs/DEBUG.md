# pidicon-light — Settings & Debug Reference

All topics are **retained** — they survive container restarts and stay active until cleared.

**Broker:** `192.168.1.101:1883`  
**Auth:** `MOSQUITTO_USER` / `MOSQUITTO_PASS` from agenix

---

## Settings Topics

Device+scene scoped: `pidicon-light/<device>/<scene>/settings/<key>`

### Home scene (pixoo-159)

Brightness driven by sun elevation from HA MQTT (`homeassistant/sun/sun/elevation`).
Curve: lerp −6°→10° = night→day. Floor=1 (never 0). 5-min heartbeat re-asserts value.

| Topic                                             | Default | Range | Description                  |
| ------------------------------------------------- | ------- | ----- | ---------------------------- |
| `pidicon-light/pixoo-159/home/settings/bri_day`   | `100`   | 1–100 | Brightness at elevation ≥10° |
| `pidicon-light/pixoo-159/home/settings/bri_night` | `7`     | 1–100 | Brightness at elevation ≤−6° |

```bash
# Set day brightness to 80
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/pixoo-159/home/settings/bri_day' -m '80' -r

# Set night brightness to 5
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/pixoo-159/home/settings/bri_night' -m '5' -r

# Reset to defaults
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/pixoo-159/home/settings/bri_day' -m '' -r
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/pixoo-159/home/settings/bri_night' -m '' -r
```

**Fallback chain (no MQTT data):**

1. `sunElevation` from `homeassistant/sun/sun/elevation` → lerp curve
2. `sunAbove` from `homeassistant/sun/sun/state` → binary day/night
3. Time-based: 07:30–20:30 = day, else night

### Kids bedroom display (ulanzi-56)

| Topic                                                                    | Default | Range          | Description                                   |
| ------------------------------------------------------------------------ | ------- | -------------- | --------------------------------------------- |
| `pidicon-light/ulanzi-56/clock_with_homestats/settings/day_start_hour`   | `7`     | 0–23           | Hour day mode begins                          |
| `pidicon-light/ulanzi-56/clock_with_homestats/settings/night_start_hour` | `19`    | 0–23           | Hour night mode begins                        |
| `pidicon-light/ulanzi-56/clock_with_homestats/settings/bri_day`          | `20`    | 1–255          | Brightness in day mode                        |
| `pidicon-light/ulanzi-56/clock_with_homestats/settings/bri_night`        | `8`     | 1–255          | Brightness in night mode                      |
| `pidicon-light/ulanzi-56/clock_with_homestats/settings/show_seconds`     | `true`  | `true`/`false` | Show seconds in day mode (night always HH:MM) |

### Settings curl commands

```bash
# Set day start to 08:00
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/day_start_hour' -m '8' -r

# Set night start to 20:00
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/night_start_hour' -m '20' -r

# Set day brightness to 30
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/bri_day' -m '30' -r

# Set night brightness to 5
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/bri_night' -m '5' -r

# Reset to defaults (clear retained)
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/day_start_hour' -m '' -r
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/night_start_hour' -m '' -r
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/bri_day' -m '' -r
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/bri_night' -m '' -r

# Hide seconds in day mode (HH:MM only, shifted right like night mode)
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/show_seconds' -m 'false' -r

# Re-enable seconds
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/ulanzi-56/clock_with_homestats/settings/show_seconds' -m 'true' -r
```

---

## Device Mode Control

Per-device render loop control. Topic is **retained** — state survives restarts.

`home/hsb1/pidicon-light/<device>/mode`

| Payload | Behaviour                                                                               |
| ------- | --------------------------------------------------------------------------------------- |
| `play`  | Normal render loop (default)                                                            |
| `pause` | Render one frame, freeze. Resume on `play`.                                             |
| `stop`  | Push black frame; Ulanzi: `setPower(false)`. Resume via `play` → re-initialises driver. |

```bash
# Pause pixoo (freeze last frame)
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'home/hsb1/pidicon-light/pixoo-159/mode' -m 'pause' -r

# Stop ulanzi (black screen + power off)
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'home/hsb1/pidicon-light/ulanzi-56/mode' -m 'stop' -r

# Resume any device
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'home/hsb1/pidicon-light/ulanzi-56/mode' -m 'play' -r

# Clear retained (revert to play on next restart)
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'home/hsb1/pidicon-light/ulanzi-56/mode' -m '' -r
```

---

## Debug Override Topics

Global (not device/scene scoped — temporary testing only).  
Clear any override with empty payload `""` to revert to real/settings values.

| Topic                               | Values                                        | Description                                                 |
| ----------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `pidicon-light/debug/mode_override` | `day` / `night` / `""`                        | Force day or night mode                                     |
| `pidicon-light/debug/bri_override`  | `1–100` / `""`                                | Override brightness (beats settings). Pixoo range is 1–100. |
| `pidicon-light/debug/battery_pct`   | `0–100` / `""`                                | Override battery SOC                                        |
| `pidicon-light/debug/battery_state` | `charging` / `discharging` / `standby` / `""` | Override charge state                                       |

### Debug curl commands

```bash
# Force night mode
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/mode_override' -m 'night' -r

# Force day mode
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/mode_override' -m 'day' -r

# Clear mode override (back to time-based)
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/mode_override' -m '' -r

# Force brightness to 15
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/bri_override' -m '15' -r

# Clear brightness override
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/bri_override' -m '' -r

# Set battery to 10% discharging (test red low battery)
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_pct' -m '10' -r
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_state' -m 'discharging' -r

# Set battery to 80% charging (test green nub-top)
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_pct' -m '80' -r
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_state' -m 'charging' -r

# Clear all battery overrides
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_pct' -m '' -r
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_state' -m '' -r

# Clear ALL debug overrides at once
for topic in mode_override bri_override battery_pct battery_state; do
  mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
    -t "pidicon-light/debug/$topic" -m '' -r
done
```

---

## Config Overlay

Retained MQTT layer that patches the structural config without touching `config.json`.
File is always the safe fallback. Overlay survives restarts. Cleared by empty payload `""`.

**Merge priority:** `config.json` < blob overlay < granular overlay

All topics are under `home/hsb1/pidicon-light/overlay/…`

### Granular device topics

`home/hsb1/pidicon-light/overlay/device/<name>/<field>`

| Field     | Format            | Description                           |
| --------- | ----------------- | ------------------------------------- |
| `scenes`  | JSON array string | Override which scenes the device runs |
| `ip`      | plain string      | Override device IP address            |
| `enabled` | `"false"`         | Exclude device from effective config  |

### Granular scene topics

`home/hsb1/pidicon-light/overlay/scene/<key>/path`

### Blob topic

`home/hsb1/pidicon-light/overlay/blob` → full or partial config JSON

Blob is applied before granular; granular wins. New devices via blob need `name`, `type`, `ip`.
Granular topics cannot add new devices — only patch existing ones (from file or blob).

### Observable result

`home/hsb1/pidicon-light/config/effective` — full merged config (retained, published on every reload)

```bash
PASS=YOUR_PASS
HOST=192.168.1.101
BASE="home/hsb1/pidicon-light"

# --- Granular examples ---

# Override which scenes run on ulanzi-56
mosquitto_pub -h $HOST -u smarthome -P $PASS \
  -t "$BASE/overlay/device/ulanzi-56/scenes" -m '["clock"]' -r

# Override IP of pixoo-159
mosquitto_pub -h $HOST -u smarthome -P $PASS \
  -t "$BASE/overlay/device/pixoo-159/ip" -m '192.168.1.200' -r

# Disable ulanzi-56 (excluded from effective config)
mosquitto_pub -h $HOST -u smarthome -P $PASS \
  -t "$BASE/overlay/device/ulanzi-56/enabled" -m 'false' -r

# Override a scene path
mosquitto_pub -h $HOST -u smarthome -P $PASS \
  -t "$BASE/overlay/scene/clock/path" -m './scenes/clock_v2.js' -r

# --- Blob example (add new device) ---
mosquitto_pub -h $HOST -u smarthome -P $PASS \
  -t "$BASE/overlay/blob" \
  -m '{"devices":[{"name":"ulanzi-new","type":"ulanzi","ip":"192.168.1.77","scenes":["clock"]}]}' -r

# --- Clear individual overlays ---
mosquitto_pub -h $HOST -u smarthome -P $PASS \
  -t "$BASE/overlay/device/ulanzi-56/scenes" -m '' -r
mosquitto_pub -h $HOST -u smarthome -P $PASS \
  -t "$BASE/overlay/device/ulanzi-56/enabled" -m '' -r
mosquitto_pub -h $HOST -u smarthome -P $PASS \
  -t "$BASE/overlay/blob" -m '' -r

# --- Read effective config ---
mosquitto_sub -h $HOST -u smarthome -P $PASS \
  -t "$BASE/config/effective" -C 1
```

---

## Night Mode Spec

| Feature          | Day                    | Night                   |
| ---------------- | ---------------------- | ----------------------- |
| Time format      | `HH:MM:SS`             | `HH:MM`                 |
| Time x-position  | x1                     | x7 (+6px right)         |
| Brightness       | `bri_day` (default 20) | `bri_night` (default 8) |
| Max sensor color | 255/channel            | ~40/channel             |
| Time color       | Warm white             | Dim warm red            |
| Battery fill     | Bright green/red       | Extremely dim           |

---

## Stale / Unknown State on Startup (Recurring Issue)

**Symptom:** Row 0 icons (Nuki, terrace door, skylights) show amber/unknown color after container restart, even though the sensors are online and have retained messages on the broker.

**Root cause:** pidicon-light uses a **single shared MQTT client** for all scenes. When `clock_with_homestats` and `home` both subscribe to e.g. `nuki/463F8F47/state`, the broker sees the topic already subscribed by this client and **does not re-deliver the retained message** for the second subscription. The `home` scene's handler is registered but never fires.

**Fix in place (`home.js`):** Periodic self-heal — re-subscribes any topic still `null` every 30s (also at 5s). Re-subscribing forces the broker to re-deliver retained messages. Stops automatically once all topics resolve.

**If amber icons persist >60s after restart:**

```bash
# Check what the broker actually has retained
mosquitto_sub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'z2m/wz/contact/te-door' -C 1 -W 3

# Check self-heal log lines
ssh mba@hsb1.lan "docker logs pidicon-light 2>&1 | grep 'self-heal'"

# Force scene hot-reload (copies current file, triggers reload)
scp scenes/home.js mba@hsb1.lan:~/docker/mounts/pidicon-light/scenes/home.js
```

**If broker has no retained message for a topic:** the sensor hasn't published since last broker restart. Open/close the sensor once to publish a new retained message.

**Do not "fix" by removing shared subscriptions** — topics like `nuki/463F8F47/state` must be shared between scenes (clock_with_homestats also uses Nuki state). The periodic re-heal is the correct mitigation.

---

## Priority Order

When multiple values are set, this is the priority (highest first):

```
debug override  >  settings (MQTT retained)  >  hardcoded default
```

So `bri_override=15` beats `bri_night=8` beats the default `8`.
