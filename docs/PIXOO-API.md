# Pixoo 64 HTTP API Reference

**Device:** Divoom Pixoo-64 (64×64 LED matrix)  
**Protocol:** HTTP POST to `http://<ip>/post`  
**Content-Type:** `application/json`

---

## Key Differences vs AWTRIX

|                    | AWTRIX (Ulanzi)                 | Pixoo 64                                             |
| ------------------ | ------------------------------- | ---------------------------------------------------- |
| Endpoint           | `http://<ip>/api/*`             | `http://<ip>/post` (all commands)                    |
| Format             | REST, varied paths              | Single endpoint, `Command` field in body             |
| Brightness range   | 0–255                           | **0–100**                                            |
| Brightness command | `POST /api/settings {"BRI": n}` | `{"Command":"Channel/SetBrightness","Brightness":n}` |

---

## Validated Commands

### Brightness

```json
POST http://<ip>/post
{"Command": "Channel/SetBrightness", "Brightness": 50}
```

| Value | Effect                     |
| ----- | -------------------------- |
| 5     | Very dark (good for night) |
| 50    | Medium                     |
| 100   | Full brightness            |

**Validated 2026-03-09** against Pixoo-159 @ 192.168.1.159:

- 5 → visually very dark ✅
- 50 → visually medium ✅
- 100 → full brightness (matches app slider max) ✅

**Range: 1–100.** Never send 0 — makes screen black, looks off.  
**Wrong command:** `Device/SetBrightness` → returns `"Request data illegal json"` (silently fails).

### Draw (custom image)

```json
POST http://<ip>/post
{
  "Command": "Draw/SendHttpGif",
  "PicNum": 1,
  "PicWidth": 64,
  "PicOffset": 0,
  "PicID": 1,
  "PicSpeed": 1000,
  "PicData": "<base64 RGB888>"
}
```

Frame buffer: `64 × 64 × 3 = 12288` bytes, base64-encoded. RGB order.

### Channel / Screen

```json
{"Command": "Channel/SetIndex", "SelectIndex": 3}   // switch to custom channel
{"Command": "Draw/ResetHttpGifId"}                   // reset GIF ID counter
{"Command": "Channel/OnOffScreen", "OnOff": 0}       // screen off (NOT brightness=0)
{"Command": "Channel/OnOffScreen", "OnOff": 1}       // screen on
```

### System

```json
{"Command": "Sys/GetConf"}                           // returns device config (error_code: 0)
{"Command": "Channel/GetAllConf"}                    // returns channel config incl. Brightness field
```

---

## Response Format

Always JSON. Success: `{"error_code": 0}`. Unknown command: `{"error_code": "Request data illegal json"}`.

Note: `error_code` is a **number** on success, a **string** on failure — check type.

---

## Notes

- Brightness persists across reboots (stored in device flash).
- After ~300 `Draw/SendHttpGif` pushes the display can stop responding — firmware bug. Mitigate with `Draw/ResetHttpGifId` on init.
- No brightness read-back via API — `Device/GetDeviceSetting` and `Device/GetAllConf` return "illegal json". Use `Channel/GetAllConf` instead.
- **Never send `Brightness: 0`** — makes screen visually black but doesn't power off. Use `Channel/OnOffScreen` with `OnOff: 0` for that. Driver floor is 1.

---

## home.js Scene — Icon Design Notes

Documented here since these patterns recur in scene development.

### Nuki lock icon

Two layers (back→front):

1. **Gray disk r=4** — represents the physical lock body. Always drawn full circle regardless of open/closed state.
   - Cardinal edge pixels `(±4,0)(0,±4)` overdrawn at 50% brightness → soft antialiased edge.
2. **5×5 colored ring** — represents the LED indicator on the lock face.
   - Locked/transitioning/unknown: full ring drawn.
   - Unlocked: bottom arc only (`dy >= 0`) — shackle open at top.
   - Color: red=locked, green=unlocked, amber=transitioning, dark amber=unknown.
3. **Offline dot** — two amber pixels to the right of the lock body.
   - Shown only when ICMP ping to the lock IP currently fails.
   - Does not replace the last known MQTT lock state.

This means the Pixoo now separates:

- **state** = last known MQTT lock state
- **reachability** = current ping result

So a lock can show "locked" or "unlocked" and still carry an amber offline warning dot.

### Skylight tiles (W13, W14)

Side-by-side 4×6px tiles. Frame: mid-gray. Fill: dark red (closed) / bright green (open).

- **Closed**: full 4×6 frame + 2×4 fill.
- **Open**: panel 1px shorter (tilt effect); gray shadow row at bottom (3D depth cue).

### Sliding door (terrace)

12×9px. Frame: mid-gray. Fill: very dark red (closed) / very dark green (open).

- Handle pixel: bright red (closed) / bright green (open), inner edge of each panel at vertical center.
- Closed: panels meet at center seam, handles face inward.
- Open: panels slid to outer edges, handles face outward.

### General palette conventions

| Role             | Color                        | Notes                                          |
| ---------------- | ---------------------------- | ---------------------------------------------- |
| Frame/outline    | `[160,160,155]`              | Mid-gray — same for doors + skylights          |
| Closed fill      | dark red                     | Doors: `[50,10,10]` / Skylights: `[120,15,15]` |
| Open fill        | dark/bright green            | Doors: `[8,35,12]` / Skylights: `[30,160,50]`  |
| Handle/indicator | Matches state                | Red closed, green open — skylight fill colors  |
| Shadow/AA        | `[20,20,20]` or `[40,40,38]` | 50% black for AA; dark gray for 3D shadow      |

---

**Last Updated:** 2026-03-09  
**Validated on:** Pixoo-64 (firmware as of 2026-03)
