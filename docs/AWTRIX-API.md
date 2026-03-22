# AWTRIX 3 HTTP/MQTT API Reference

**Source:** https://github.com/Blueforcer/awtrix3/blob/main/docs/api.md  
**Device:** Ulanzi TC001 / AWTRIX 32x8 LED Matrix  
**Protocol:** HTTP (http://[IP]/api/\*) or MQTT

---

## Quick Reference

### Base URLs

- **HTTP:** `http://[IP]/api/<endpoint>`
- **MQTT:** `[PREFIX]/<topic>`

### Common Endpoints

| Function          | HTTP URL                 | MQTT Topic              | Method |
| ----------------- | ------------------------ | ----------------------- | ------ |
| Stats             | `/api/stats`             | `[PREFIX]/stats`        | GET    |
| Custom App        | `/api/custom?name=<app>` | `[PREFIX]/custom/<app>` | POST   |
| Notify            | `/api/notify`            | `[PREFIX]/notify`       | POST   |
| Switch App        | `/api/switch`            | `[PREFIX]/switch`       | POST   |
| Draw (raw)        | `/api/draw`              | -                       | POST   |
| Power             | `/api/power`             | `[PREFIX]/power`        | POST   |
| Settings          | `/api/settings`          | `[PREFIX]/settings`     | POST   |
| Screen (LiveView) | `/api/screen`            | `[PREFIX]/sendscreen`   | GET    |

---

## Custom Apps & Notifications

### JSON Properties (All Optional)

| Key              | Type         | Description                          | Custom | Notify |
| ---------------- | ------------ | ------------------------------------ | ------ | ------ |
| `text`           | string       | Text to display                      | ✅     | ✅     |
| `textCase`       | int          | 0=global, 1=uppercase, 2=as sent     | ✅     | ✅     |
| `topText`        | bool         | Draw text on top                     | ✅     | ✅     |
| `textOffset`     | int          | X position offset                    | ✅     | ✅     |
| `center`         | bool         | Center short text                    | ✅     | ✅     |
| `color`          | string/array | Text/bar/line color                  | ✅     | ✅     |
| `gradient`       | array        | Two-color gradient                   | ✅     | ✅     |
| `blinkText`      | int          | Blink interval (ms)                  | ✅     | ✅     |
| `fadeText`       | int          | Fade interval (ms)                   | ✅     | ✅     |
| `background`     | string/array | Background color                     | ✅     | ✅     |
| `rainbow`        | bool         | Rainbow text effect                  | ✅     | ✅     |
| `icon`           | string       | Icon ID/filename/Base64              | ✅     | ✅     |
| `pushIcon`       | int          | 0=static, 1=move+hide, 2=move+repeat | ✅     | ✅     |
| `repeat`         | int          | Scroll repeats (-1=infinite)         | ✅     | ✅     |
| `duration`       | int          | Display duration (seconds)           | ✅     | ✅     |
| `hold`           | bool         | Hold notification until dismissed    | ❌     | ✅     |
| `sound`          | string       | RTTTL filename or MP3 number         | ❌     | ✅     |
| `rtttl`          | string       | RTTTL sound string                   | ❌     | ✅     |
| `loopSound`      | bool         | Loop sound                           | ❌     | ✅     |
| `bar`            | array        | Bar graph (max 16 values)            | ✅     | ✅     |
| `line`           | array        | Line chart (max 16 values)           | ✅     | ✅     |
| `autoscale`      | bool         | Auto-scale bar/line                  | ✅     | ✅     |
| `barBC`          | string/array | Bar background color                 | ✅     | ✅     |
| `progress`       | int          | Progress bar (0-100)                 | ✅     | ✅     |
| `progressC`      | string/array | Progress bar color                   | ✅     | ✅     |
| `progressBC`     | string/array | Progress background                  | ✅     | ✅     |
| `pos`            | int          | Position in loop (0=first)           | ✅     | ❌     |
| `draw`           | array        | Draw commands                        | ✅     | ✅     |
| `lifetime`       | int          | Auto-remove after X seconds          | ✅     | ❌     |
| `lifetimeMode`   | int          | 0=delete, 1=mark stale               | ✅     | ❌     |
| `stack`          | bool         | Stack notifications                  | ❌     | ✅     |
| `wakeup`         | bool         | Wake matrix if off                   | ❌     | ✅     |
| `noScroll`       | bool         | Disable scrolling                    | ✅     | ✅     |
| `clients`        | array        | Forward to other devices             | ❌     | ✅     |
| `scrollSpeed`    | int          | Speed % (100=default)                | ✅     | ✅     |
| `effect`         | string       | Background effect                    | ✅     | ✅     |
| `effectSettings` | object       | Effect color/speed                   | ✅     | ✅     |
| `save`           | bool         | Save to flash (use sparingly!)       | ✅     | ❌     |
| `overlay`        | string       | Effect overlay                       | ✅     | ✅     |

### Overlay Effects

- `"clear"`
- `"snow"`
- `"rain"`
- `"drizzle"`
- `"storm"`
- `"thunder"`
- `"frost"`

---

## Draw Commands

**Warning:** Complex drawings use RAM. Too many objects can cause freezes/reboots.

| Command | Values                 | Description           |
| ------- | ---------------------- | --------------------- |
| `dp`    | `[x, y, cl]`           | Draw pixel            |
| `dl`    | `[x0, y0, x1, y1, cl]` | Draw line             |
| `dr`    | `[x, y, w, h, cl]`     | Draw rectangle        |
| `df`    | `[x, y, w, h, cl]`     | Draw filled rectangle |
| `dc`    | `[x, y, r, cl]`        | Draw circle           |
| `dfc`   | `[x, y, r, cl]`        | Draw filled circle    |
| `dt`    | `[x, y, t, cl]`        | Draw text             |
| `db`    | `[x, y, w, h, [bmp]]`  | Draw RGB888 bitmap    |

### Example: Draw Commands

```json
{
  "draw": [
    { "dc": [28, 4, 3, "#FF0000"] },
    { "dr": [20, 4, 4, 4, "#0000FF"] },
    { "dt": [0, 0, "Hello", "#00FF00"] }
  ]
}
```

---

## Built-in App Names

Use these with `/api/switch`:

- `Time`
- `Date`
- `Temperature`
- `Humidity`
- `Battery`

---

## Settings API

### Key Settings

| Key         | Type   | Description            | Range      | Default |
| ----------- | ------ | ---------------------- | ---------- | ------- |
| `ATIME`     | int    | App duration (seconds) | 1+         | 7       |
| `TEFF`      | int    | Transition effect      | 0-10       | 1       |
| `TSPEED`    | int    | Transition speed (ms)  | 1+         | 500     |
| `BRI`       | int    | Brightness             | 0-255      | -       |
| `ABRI`      | bool   | Auto brightness        | true/false | -       |
| `ATRANS`    | bool   | Auto transition        | true/false | -       |
| `UPPERCASE` | bool   | Uppercase text         | true/false | true    |
| `SSPEED`    | int    | Scroll speed %         | 1+         | 100     |
| `OVERLAY`   | string | Global effect overlay  | see above  | -       |

### Time Formats

- `%H:%M:%S` - 24h with seconds
- `%l:%M:%S` - 12h with seconds
- `%H:%M` - 24h
- `%l:%M` - 12h
- `%l:%M %p` - 12h with AM/PM

### Transition Effects

| Code | Effect   |
| ---- | -------- |
| 0    | Random   |
| 1    | Slide    |
| 2    | Dim      |
| 3    | Zoom     |
| 4    | Rotate   |
| 5    | Pixelate |
| 6    | Curtain  |
| 7    | Ripple   |
| 8    | Blink    |
| 9    | Reload   |
| 10   | Fade     |

---

## Power & System Commands

| Action                | HTTP URL             | Method                     |
| --------------------- | -------------------- | -------------------------- |
| Power On/Off          | `/api/power`         | POST `{power: true/false}` |
| Sleep Mode            | `/api/sleep`         | POST `{sleep: seconds}`    |
| Reboot                | `/api/reboot`        | POST                       |
| Erase (Factory Reset) | `/api/erase`         | POST                       |
| Reset Settings        | `/api/resetSettings` | POST                       |
| Update Firmware       | `/api/doupdate`      | POST                       |

---

## Color Formats

Colors can be:

- Hex string: `"#FF0000"` or `"#32a852"`
- RGB array: `[255, 0, 0]` or `[155, 38, 182]`
- Black shorthand: `"0"` or `[0, 0, 0]`

---

## Example Requests

### 1. Show Rainbow Text Notification

```bash
curl -X POST http://192.168.1.56/api/notify \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello AWTRIX!", "rainbow":true, "duration":10}'
```

### 2. Create Persistent Custom App with Draw

```bash
curl -X POST "http://192.168.1.56/api/custom?name=myscene" \
  -H "Content-Type: application/json" \
  -d '{"draw":[{"dp":[16,4,3,"#FF0000"]},{"dt":[0,0,"Test","#00FF00"]}]}'
```

### 3. Set Brightness

```bash
curl -X POST http://192.168.1.56/api/settings \
  -H "Content-Type: application/json" \
  -d '{"BRI":128}'
```

### 4. Switch to Built-in Time App

```bash
curl -X POST http://192.168.1.56/api/switch \
  -H "Content-Type: application/json" \
  -d '{"name":"Time"}'
```

---

## MQTT Prefix

Default MQTT prefix is `awtrix`. Change in device settings if needed.

Example MQTT topics:

- `awtrix/stats`
- `awtrix/custom/myapp`
- `awtrix/notify`
- `awtrix/switch`

---

**Last Updated:** 2026-03-01  
**For pixdcon development**
