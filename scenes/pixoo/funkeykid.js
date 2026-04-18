/**
 * funkeykid — Pixoo64 scene for the educational keyboard display.
 *
 * Subscribes to MQTT topic `home/hsb1/funkeykid/display` and renders:
 *   (a) letter + word + background image for keypress payloads, or
 *   (b) a vertical VU-meter overlay for volume-change payloads (FKID-2).
 *
 * Payload contract (published by the funkeykid Python server — display.py):
 *
 *   keypress:  {letter, word, image, color}
 *   volume:    {letter:"NN%", word:"lautstaerke", color, bar:true,
 *               percent, bars_total, bars_filled}
 *
 * The handler inspects `bar` to decide whether to touch letter state or
 * only the volume overlay state — volume updates must NOT pollute
 * _currentLetter / _currentWord / _currentColor, otherwise stale "NN%"
 * text would leak into the fallback render path once the overlay expires.
 *
 * Render priorities (top → bottom in render()):
 *   1. Volume overlay   — active while _volumeBar && age < 1500 ms
 *   2. Idle             — no keypress within idle_timeout_ms (default 10s)
 *   3. Active           — bg image + big letter + word
 *
 * Idle timeout, letter scale, color toggle are scene settings surfaced
 * via pixdcon's config.json → sceneSettings.funkeykid block.
 *
 * pixdcon is SSOT — when the user switches to another scene on this
 * device, this scene unsubscribes and stops rendering.
 */

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadPixooImage, drawPixooImage } from "../../lib/pixoo-image.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, "../../assets/pixoo/funkeykid");

const IDLE_TIMEOUT_MS = 10000; // 10s without keypress → show bg only
const MQTT_TOPIC = "home/hsb1/funkeykid/display";

// Letter → bg image filename mapping (QWERTZ: Y=Ziege, Z=Yak)
const BG_IMAGES = {
  A: "a_affe.png", B: "b_biene.png", C: "c_clown.png", D: "d_donner.png",
  E: "e_elefant.png", F: "f_frosch.png", G: "g_glocke.png", H: "h_hammer.png",
  I: "i_igel.png", J: "j_jaguar.png", K: "k_katze.png", L: "l_loewe.png",
  M: "m_kuh.png", N: "n_nachtigall.png", O: "o_orgel.png", P: "p_pferd.png",
  Q: "q_quaken.png", R: "r_regen.png", S: "s_schwein.png", T: "t_telefon.png",
  U: "u_uhu.png", V: "v_vogel.png", W: "w_wasser.png", X: "x_xylophon.png",
  Y: "y_yak.png", Z: "z_ziege.png",
};

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
    color_enabled: {
      type: "boolean",
      label: "Farbige Buchstaben",
      group: "Display",
      default: true,
    },
  },

  // State
  _currentLetter: null,
  _currentWord: null,
  _currentColor: null,
  _lastKeypressAt: 0,
  _lastLetter: null,
  _currentImage: null, // Current bg image (from MQTT payload)
  _lastImageName: null, // For idle display
  _settings: null,
  _unsubscribeSettings: null,
  _bgImages: {},     // Preloaded bg images keyed by letter
  _idlePhase: 0,
  // FKID-2: volume bar-graph overlay — shown when funkeykid publishes
  // {bar:true, percent, bars_total, bars_filled} instead of a letter.
  _volumeBar: null,  // { percent, bars_filled, bars_total, color:[r,g,b] }
  _volumeBarAt: 0,   // timestamp; bar shows for ~1.5s after last update

  async init(context) {
    this._settings = context.settings.all();
    this._unsubscribeSettings = context.settings.subscribe((values) => {
      this._settings = values;
    });

    // Brightness is set in render() via device (not available in init context)
    this._needsBrightnessSet = true;

    // Preload all background images
    for (const [letter, filename] of Object.entries(BG_IMAGES)) {
      try {
        const imgPath = resolve(ASSETS_DIR, filename);
        this._bgImages[letter] = await loadPixooImage(imgPath);
        context.logger.debug(`[funkeykid] Loaded bg: ${letter} → ${filename}`);
      } catch (e) {
        context.logger.warn(`[funkeykid] Missing bg image: ${filename}`);
      }
    }
    context.logger.info(`[funkeykid] Loaded ${Object.keys(this._bgImages).length}/26 bg images`);

    // Subscribe to funkeykid display topic
    context.mqtt.subscribe(MQTT_TOPIC, async (msg) => {
      try {
        const data = JSON.parse(msg);

        // Load image FIRST (before updating state) to prevent glitch
        const imgName = data.image;
        let newImage = null;
        if (imgName) {
          if (!this._bgImages[imgName]) {
            try {
              this._bgImages[imgName] = await loadPixooImage(resolve(ASSETS_DIR, imgName));
            } catch (e) { /* missing image */ }
          }
          newImage = this._bgImages[imgName] || null;
        }

        if (data.bar === true) {
          // Volume update: only touch the overlay state. Letter-rendering
          // state must stay exactly as a previous real keypress left it,
          // otherwise "60%"/"lautstaerke" leak into the fallback path
          // once the bar's TTL expires.
          const total = Math.max(1, data.bars_total || 10);
          const filled = Math.max(0, Math.min(total, data.bars_filled ?? 0));
          this._volumeBar = {
            percent: typeof data.percent === "number" ? data.percent : 0,
            bars_total: total,
            bars_filled: filled,
            color: data.color ? parseHexColor(data.color) : [255, 204, 0],
          };
          this._volumeBarAt = Date.now();
          context.logger.info(`[funkeykid] volume bar: ${this._volumeBar.percent}% (${this._volumeBar.bars_filled}/${this._volumeBar.bars_total})`);
        } else {
          // Real letter/image update — snapshot full state, drop any overlay.
          this._currentLetter = data.letter || null;
          this._currentWord = data.word || null;
          this._currentColor = data.color ? parseHexColor(data.color) : randomColor();
          this._currentImage = newImage;
          this._lastKeypressAt = Date.now();
          if (imgName) this._lastImageName = imgName;
          if (this._currentLetter) this._lastLetter = this._currentLetter;
          this._volumeBar = null;
        }
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

    // Always 100% brightness
    if (this._needsBrightnessSet) {
      await device.setBrightness(100);
      this._needsBrightnessSet = false;
    }

    await device.clear();

    const colorEnabled = settings.color_enabled !== false; // default true

    // Helper: draw big letter with shadow at specific position
    const drawBigLetter = (letter, color, startX, startY) => {
      const glyph = BIG_FONT[letter];
      if (!glyph) return;
      const glyphW = 8, glyphH = 10;
      const c = colorEnabled ? color : [255, 255, 255];
      // Shadow
      for (let row = 0; row < glyphH; row++)
        for (let col = 0; col < glyphW; col++)
          if (glyph[row * glyphW + col])
            for (let sy = 0; sy < scale; sy++)
              for (let sx = 0; sx < scale; sx++)
                device._setPixel(startX + col*scale + sx + 1, startY + row*scale + sy + 1, 0, 0, 0);
      // Letter
      for (let row = 0; row < glyphH; row++)
        for (let col = 0; col < glyphW; col++)
          if (glyph[row * glyphW + col])
            for (let sy = 0; sy < scale; sy++)
              for (let sx = 0; sx < scale; sx++)
                device._setPixel(startX + col*scale + sx, startY + row*scale + sy, c[0], c[1], c[2]);
    };

    // Helper: draw small text with shadow at position with alignment
    const drawText = async (text, pos, color, align = "center") => {
      const c = colorEnabled ? color : [255, 255, 255];
      await device.drawTextRgbaAligned(text, [pos[0]+1, pos[1]+1], [0, 0, 0], align);
      await device.drawTextRgbaAligned(text, pos, [c[0], c[1], c[2]], align);
    };

    // FKID-2: The volume overlay wins over both idle and letter rendering
    // while its TTL is alive, so volume changes are visible even when the
    // device is otherwise idle.
    const volumeBarActive = this._volumeBar && (now - this._volumeBarAt) < 1500;

    if (isIdle && !volumeBarActive) {
      // Idle: show last image (no text), or color-cycle if no letter yet
      const bgImg = this._currentImage || (this._lastImageName ? this._bgImages[this._lastImageName] : null);

      if (bgImg) {
        drawPixooImage(device, bgImg, 0, 0);
      } else {
        // No letter pressed yet: gentle color-cycling title
        this._idlePhase = (this._idlePhase + 1) % 360;
        const hue = this._idlePhase;
        const r = Math.round(128 + 127 * Math.sin(hue * Math.PI / 180));
        const g = Math.round(128 + 127 * Math.sin((hue + 120) * Math.PI / 180));
        const b = Math.round(128 + 127 * Math.sin((hue + 240) * Math.PI / 180));
        await device.drawTextRgbaAligned("fun", [32, 20], [r, g, b], "center");
        await device.drawTextRgbaAligned("key", [32, 30], [g, b, r], "center");
        await device.drawTextRgbaAligned("kid", [32, 40], [b, r, g], "center");
        await device.push();
        return 100;
      }

      await device.push();
      return 1000; // 1 FPS when idle with bg image
    }

    // FKID-2: Volume bar overlay. Takes over the whole canvas while active.
    // Vertical VU-meter style: green narrow at bottom → red wide at top.
    // "VOLUME" label on top, percent in neutral gray at the bottom.
    if (volumeBarActive) {
      const vb = this._volumeBar;
      const segCount = vb.bars_total;            // 10
      const filledCount = vb.bars_filled;
      // Per-segment base color: green at bottom (i=0) → red at top (i=9).
      const VU_PALETTE = [
        [40, 220, 40],   // 0 green
        [90, 220, 40],
        [140, 220, 40],
        [180, 220, 40],
        [220, 200, 40], // 4 yellow-green
        [230, 160, 40],
        [240, 130, 40],
        [240, 100, 40],
        [240, 70, 40],
        [240, 40, 40],  // 9 red
      ];
      const LABEL_GRAY = [170, 170, 170];
      const VALUE_GRAY = [150, 150, 150];

      // Geometry. Bar segments stack bottom→top: i=0 is drawn at the bottom.
      const segHeight = 3;
      const segGap = 1;
      const minW = 10;   // narrowest bottom segment
      const maxW = 54;   // widest top segment
      const barTopY = 9;
      const barBotY = barTopY + segCount * segHeight + (segCount - 1) * segGap - 1;

      for (let i = 0; i < segCount; i++) {
        const filled = i < filledCount;
        const baseIdx = VU_PALETTE[i] ? i : Math.min(i, VU_PALETTE.length - 1);
        const base = colorEnabled ? VU_PALETTE[baseIdx] : [200, 200, 200];
        // Unfilled: dim shade of the segment's own base color (still hints at the gradient).
        const col = filled
          ? base
          : [Math.round(base[0] * 0.12), Math.round(base[1] * 0.12), Math.round(base[2] * 0.12)];
        // Width grows linearly with i so bottom = narrow, top = wide.
        const w = Math.round(minW + (maxW - minW) * (i / (segCount - 1)));
        const startX = Math.round((64 - w) / 2);
        // Segment y (bottom-up): i=0 lives at barBotY, i=9 at barTopY.
        const y = barBotY - (i * (segHeight + segGap) + segHeight - 1);
        // Simple 3D shading: top row lighter, bottom row darker, middle row base.
        const lighter = [
          Math.min(255, col[0] + 40),
          Math.min(255, col[1] + 40),
          Math.min(255, col[2] + 40),
        ];
        const darker = [
          Math.max(0, col[0] - 50),
          Math.max(0, col[1] - 50),
          Math.max(0, col[2] - 50),
        ];
        for (let dy = 0; dy < segHeight; dy++) {
          const shade = dy === 0 ? lighter : (dy === segHeight - 1 ? darker : col);
          for (let dx = 0; dx < w; dx++) {
            device._setPixel(startX + dx, y + dy, shade[0], shade[1], shade[2]);
          }
        }
      }

      // Top label "VOLUME" + bottom percentage, both in neutral gray.
      await device.drawTextRgbaAligned("volume", [33, 3], [0, 0, 0], "center");
      await device.drawTextRgbaAligned("volume", [32, 2], LABEL_GRAY, "center");
      const pctText = `${vb.percent}%`;
      await device.drawTextRgbaAligned(pctText, [33, 56], [0, 0, 0], "center");
      await device.drawTextRgbaAligned(pctText, [32, 55], VALUE_GRAY, "center");

      await device.push();
      return 60;
    }
    if (this._volumeBar && !volumeBarActive) {
      // Expire once the TTL is up so subsequent frames skip the check cheaply.
      this._volumeBar = null;
    }

    // Active: bg image + letter top-left + word bottom-center
    const letter = this._currentLetter;
    const word = this._currentWord;
    const color = this._currentColor || randomColor();

    // Draw background image
    const bgImg = this._currentImage;
    if (bgImg) {
      drawPixooImage(device, bgImg, 0, 0);
    }

    // Darken bottom 8px strip (50% black overlay for text readability)
    if (word) {
      for (let y = 56; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const i = (y * 64 + x) * 3;
          device.buf[i] >>= 1;
          device.buf[i + 1] >>= 1;
          device.buf[i + 2] >>= 1;
        }
      }
    }

    if (letter && BIG_FONT[letter]) {
      drawBigLetter(letter, color, 2, 2);
      if (word) {
        await drawText(word.toLowerCase(), [32, 64 - 7], color, "center");
      }
    } else if (letter) {
      // Fallback (volume %, etc.)
      await drawText(letter, [32, 2], color, "center");
      if (word) {
        await drawText(word.toLowerCase(), [32, 64 - 7], color, "center");
      }
    }

    await device.push();
    return 200;
  },

  async destroy(context) {
    this._unsubscribeSettings?.();
    context?.mqtt?.unsubscribeAll?.();
    this._currentLetter = null;
    this._currentWord = null;
    this._lastKeypressAt = 0;
  },
};
