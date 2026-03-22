/**
 * funkeykid — Pixoo64 scene for educational keyboard display
 *
 * Subscribes to MQTT topic `home/hsb1/funkeykid/display` and renders
 * the pressed letter large and colorful on the 64×64 display.
 *
 * Payload format: {"letter": "A", "word": "Apfel", "color": "#FF0000"}
 *
 * When idle (no keypress for timeout period), shows a gentle idle animation.
 * pidicon-light is SSOT — if user switches to another scene, this stops.
 */

const IDLE_TIMEOUT_MS = 15000; // 15s without keypress → idle mode
const MQTT_TOPIC = "home/hsb1/funkeykid/display";

// Large 8×10 pixel font for single uppercase letters (A-Z)
// Each letter is a 8-wide, 10-tall bitmap (row-major, 1=pixel on)
const BIG_FONT = {
  A: [
    0,0,1,1,1,1,0,0,
    0,1,1,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,1,1,1,1,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
  ],
  B: [
    1,1,1,1,1,1,0,0,
    1,1,0,0,0,1,1,0,
    1,1,0,0,0,1,1,0,
    1,1,0,0,0,1,1,0,
    1,1,1,1,1,1,0,0,
    1,1,0,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,1,1,0,
    1,1,1,1,1,1,0,0,
  ],
  C: [
    0,0,1,1,1,1,1,0,
    0,1,1,0,0,0,1,1,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    0,1,1,0,0,0,1,1,
    0,0,1,1,1,1,1,0,
  ],
  D: [
    1,1,1,1,1,0,0,0,
    1,1,0,0,1,1,0,0,
    1,1,0,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,1,1,0,
    1,1,0,0,1,1,0,0,
    1,1,1,1,1,0,0,0,
  ],
  E: [
    1,1,1,1,1,1,1,1,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,1,1,1,1,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,1,1,1,1,1,1,
  ],
  F: [
    1,1,1,1,1,1,1,1,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,1,1,1,1,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
  ],
  G: [
    0,0,1,1,1,1,1,0,
    0,1,1,0,0,0,1,1,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,1,1,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    0,1,1,0,0,0,1,1,
    0,0,1,1,1,1,1,0,
  ],
  H: [
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,1,1,1,1,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
  ],
  I: [
    1,1,1,1,1,1,1,1,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    1,1,1,1,1,1,1,1,
  ],
  J: [
    0,0,0,0,0,0,1,1,
    0,0,0,0,0,0,1,1,
    0,0,0,0,0,0,1,1,
    0,0,0,0,0,0,1,1,
    0,0,0,0,0,0,1,1,
    0,0,0,0,0,0,1,1,
    0,0,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    0,1,1,0,0,1,1,0,
    0,0,1,1,1,1,0,0,
  ],
  K: [
    1,1,0,0,0,1,1,0,
    1,1,0,0,1,1,0,0,
    1,1,0,1,1,0,0,0,
    1,1,1,1,0,0,0,0,
    1,1,1,0,0,0,0,0,
    1,1,1,1,0,0,0,0,
    1,1,0,1,1,0,0,0,
    1,1,0,0,1,1,0,0,
    1,1,0,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
  ],
  L: [
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,1,1,1,1,1,1,
  ],
  M: [
    1,1,0,0,0,0,1,1,
    1,1,1,0,0,1,1,1,
    1,1,1,1,1,1,1,1,
    1,1,0,1,1,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
  ],
  N: [
    1,1,0,0,0,0,1,1,
    1,1,1,0,0,0,1,1,
    1,1,1,1,0,0,1,1,
    1,1,0,1,1,0,1,1,
    1,1,0,0,1,1,1,1,
    1,1,0,0,0,1,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
  ],
  O: [
    0,0,1,1,1,1,0,0,
    0,1,1,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    0,1,1,0,0,1,1,0,
    0,0,1,1,1,1,0,0,
  ],
  P: [
    1,1,1,1,1,1,0,0,
    1,1,0,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,1,1,0,
    1,1,1,1,1,1,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
  ],
  Q: [
    0,0,1,1,1,1,0,0,
    0,1,1,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,1,0,1,1,
    0,1,1,0,0,1,1,0,
    0,0,1,1,1,1,0,1,
  ],
  R: [
    1,1,1,1,1,1,0,0,
    1,1,0,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,1,1,0,
    1,1,1,1,1,1,0,0,
    1,1,0,1,1,0,0,0,
    1,1,0,0,1,1,0,0,
    1,1,0,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
  ],
  S: [
    0,0,1,1,1,1,1,0,
    0,1,1,0,0,0,1,1,
    1,1,0,0,0,0,0,0,
    0,1,1,0,0,0,0,0,
    0,0,1,1,1,1,0,0,
    0,0,0,0,0,1,1,0,
    0,0,0,0,0,0,1,1,
    0,0,0,0,0,0,1,1,
    1,1,0,0,0,1,1,0,
    0,1,1,1,1,1,0,0,
  ],
  T: [
    1,1,1,1,1,1,1,1,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
  ],
  U: [
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    0,1,1,0,0,1,1,0,
    0,0,1,1,1,1,0,0,
  ],
  V: [
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    0,1,1,0,0,1,1,0,
    0,1,1,0,0,1,1,0,
    0,0,1,1,1,1,0,0,
    0,0,1,1,1,1,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
  ],
  W: [
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    1,1,0,1,1,0,1,1,
    1,1,1,1,1,1,1,1,
    1,1,1,0,0,1,1,1,
    1,1,0,0,0,0,1,1,
  ],
  X: [
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    0,1,1,0,0,1,1,0,
    0,0,1,1,1,1,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,1,1,1,1,0,0,
    0,1,1,0,0,1,1,0,
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
  ],
  Y: [
    1,1,0,0,0,0,1,1,
    1,1,0,0,0,0,1,1,
    0,1,1,0,0,1,1,0,
    0,0,1,1,1,1,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
    0,0,0,1,1,0,0,0,
  ],
  Z: [
    1,1,1,1,1,1,1,1,
    0,0,0,0,0,0,1,1,
    0,0,0,0,0,1,1,0,
    0,0,0,0,1,1,0,0,
    0,0,0,1,1,0,0,0,
    0,0,1,1,0,0,0,0,
    0,1,1,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,0,0,0,0,0,0,
    1,1,1,1,1,1,1,1,
  ],
};

// Child-friendly bright colors
const COLORS = [
  [255, 0, 0],     // Red
  [0, 200, 0],     // Green
  [0, 100, 255],   // Blue
  [255, 140, 0],   // Orange
  [200, 0, 200],   // Purple
  [0, 200, 200],   // Cyan
  [255, 200, 0],   // Yellow
  [255, 50, 150],  // Pink
  [100, 50, 255],  // Violet
  [50, 200, 50],   // Lime
];

function parseHexColor(hex) {
  if (!hex || !hex.startsWith("#")) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export default {
  name: "funkeykid",
  pretty_name: "FunKeyKid",
  deviceType: "pixoo",
  description: "Educational keyboard display — shows pressed letters",

  settingsSchema: {
    idle_timeout_ms: {
      type: "int",
      label: "Idle Timeout (ms)",
      group: "Timing",
      default: 15000,
      min: 5000,
      max: 60000,
      step: 1000,
    },
    brightness: {
      type: "int",
      label: "Brightness",
      group: "Display",
      default: 100,
      min: 1,
      max: 100,
      step: 5,
    },
    letter_scale: {
      type: "int",
      label: "Letter Scale",
      group: "Display",
      default: 3,
      min: 2,
      max: 5,
      step: 1,
    },
  },

  // State
  _currentLetter: null,
  _currentWord: null,
  _currentColor: null,
  _lastKeypressAt: 0,
  _settings: null,
  _unsubscribeSettings: null,
  _idlePhase: 0,

  async init(context) {
    this._settings = context.settings.all();
    this._unsubscribeSettings = context.settings.subscribe((values) => {
      this._settings = values;
    });

    // Brightness is set in render() via device (not available in init context)
    this._needsBrightnessSet = true;

    // Subscribe to funkeykid display topic
    context.mqtt.subscribe(MQTT_TOPIC, (msg) => {
      try {
        const data = JSON.parse(msg);
        this._currentLetter = data.letter || null;
        this._currentWord = data.word || null;
        this._currentColor = data.color ? parseHexColor(data.color) : randomColor();
        this._lastKeypressAt = Date.now();
      } catch (e) {
        context.logger.error(`[funkeykid] Bad MQTT payload: ${e.message}`);
      }
    });

    context.logger.info(`[funkeykid] Scene initialized, listening on ${MQTT_TOPIC}`);
  },

  async render(device) {
    const settings = this._settings || {};
    const idleTimeout = settings.idle_timeout_ms || IDLE_TIMEOUT_MS;
    const scale = settings.letter_scale || 3;
    const now = Date.now();
    const isIdle = !this._lastKeypressAt || (now - this._lastKeypressAt > idleTimeout);

    // Always 100% brightness — no day/night dimming for this scene
    if (this._needsBrightnessSet) {
      await device.setBrightness(100);
      this._needsBrightnessSet = false;
    }

    await device.clear();

    if (isIdle) {
      // Idle animation: gentle color-cycling "funkeykid" text
      this._idlePhase = (this._idlePhase + 1) % 360;
      const hue = this._idlePhase;
      const r = Math.round(128 + 127 * Math.sin(hue * Math.PI / 180));
      const g = Math.round(128 + 127 * Math.sin((hue + 120) * Math.PI / 180));
      const b = Math.round(128 + 127 * Math.sin((hue + 240) * Math.PI / 180));

      // Draw "fun" centered
      await device.drawTextRgbaAligned("fun", [32, 20], [r, g, b], "center");
      // Draw "key" centered
      await device.drawTextRgbaAligned("key", [32, 30], [g, b, r], "center");
      // Draw "kid" centered
      await device.drawTextRgbaAligned("kid", [32, 40], [b, r, g], "center");

      await device.push();
      return 100; // ~10 FPS for smooth color cycling
    }

    // Active: draw the big letter centered
    const letter = this._currentLetter;
    const word = this._currentWord;
    const color = this._currentColor || randomColor();

    if (letter && BIG_FONT[letter]) {
      const glyph = BIG_FONT[letter];
      const glyphW = 8;
      const glyphH = 10;
      const scaledW = glyphW * scale;
      const scaledH = glyphH * scale;
      const startX = Math.floor((64 - scaledW) / 2);
      const startY = Math.floor((64 - scaledH - 10) / 2); // Leave room for word below

      // Draw scaled letter
      for (let row = 0; row < glyphH; row++) {
        for (let col = 0; col < glyphW; col++) {
          if (glyph[row * glyphW + col]) {
            // Draw scale×scale block
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                device._setPixel(
                  startX + col * scale + sx,
                  startY + row * scale + sy,
                  color[0], color[1], color[2]
                );
              }
            }
          }
        }
      }

      // Draw word below the letter using built-in small font
      if (word) {
        const wordY = startY + scaledH + 3;
        await device.drawTextRgbaAligned(
          word.toLowerCase(),
          [32, wordY],
          [color[0], color[1], color[2]],
          "center"
        );
      }
    } else if (letter) {
      // Fallback: use built-in font for unknown letters
      await device.drawTextRgbaAligned(letter, [32, 25], [color[0], color[1], color[2]], "center");
      if (word) {
        await device.drawTextRgbaAligned(word.toLowerCase(), [32, 40], [color[0], color[1], color[2]], "center");
      }
    }

    await device.push();
    return 200; // 5 FPS when showing a letter
  },

  async destroy(context) {
    this._unsubscribeSettings?.();
    context?.mqtt?.unsubscribeAll?.();
    this._currentLetter = null;
    this._currentWord = null;
    this._lastKeypressAt = 0;
  },
};
