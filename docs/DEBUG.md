# pidicon-light Debug Overrides

MQTT-based runtime overrides for testing without waiting for real conditions.
All topics are **retained** — they survive restarts and stay active until cleared.

**Broker:** `192.168.1.101:1883`  
**Credentials:** from `MOSQUITTO_USER` / `MOSQUITTO_PASS`

---

## Topics

| Topic                                | Values                                 | Effect                  |
| ------------------------------------ | -------------------------------------- | ----------------------- |
| `pidicon-light/debug/night_override` | `true` / `false`                       | Force night mode on/off |
| `pidicon-light/debug/battery_pct`    | `0`–`100`                              | Override battery %      |
| `pidicon-light/debug/battery_state`  | `charging` / `discharging` / `standby` | Override battery state  |

Clear any override by publishing empty string `""` or `"null"` — reverts to real value.

---

## Curl Commands

Replace `PASS` with your MQTT password.

### Force night mode (test dim colors + HH:MM display)

```bash
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/night_override' -m 'true' -r
```

### Clear night override (back to time-based)

```bash
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/night_override' -m '' -r
```

### Set battery to 10% (test low/red)

```bash
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_pct' -m '10' -r
```

### Set battery to 75% (test mid-fill)

```bash
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_pct' -m '75' -r
```

### Set battery to 100%

```bash
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_pct' -m '100' -r
```

### Set charging state (green + nub on top)

```bash
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_state' -m 'charging' -r
```

### Set discharging state (red + nub on bottom)

```bash
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_state' -m 'discharging' -r
```

### Clear battery overrides (back to real values)

```bash
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_pct' -m '' -r

mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_state' -m '' -r
```

### Clear ALL debug overrides at once

```bash
for topic in night_override battery_pct battery_state; do
  mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
    -t "pidicon-light/debug/$topic" -m '' -r
done
```

---

## Test Night Mode + Battery Together

```bash
# Simulate: night mode, 30% charge, discharging
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/night_override' -m 'true' -r
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_pct' -m '30' -r
mosquitto_pub -h 192.168.1.101 -u smarthome -P PASS \
  -t 'pidicon-light/debug/battery_state' -m 'discharging' -r
```

Expected: HH:MM at x7, all sensor dots very dim, battery ~3/6 rows filled dim red, nub at bottom.

---

## Night Mode Spec

| Feature             | Day              | Night                   |
| ------------------- | ---------------- | ----------------------- |
| Time format         | `HH:MM:SS`       | `HH:MM`                 |
| Time x-position     | x1               | x7 (+6px right)         |
| Brightness (BRI)    | 20               | 2                       |
| Max color channel   | 255              | 30                      |
| Error/unknown color | Yellow bright    | Yellow very dim         |
| Battery fill color  | Bright green/red | Extremely dim green/red |
