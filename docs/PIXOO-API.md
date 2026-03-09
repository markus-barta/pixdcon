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

---

**Last Updated:** 2026-03-09  
**Validated on:** Pixoo-64 (firmware as of 2026-03)
