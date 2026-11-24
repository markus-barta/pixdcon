/**
 * funkeykid — Pixoo64 scene for the educational keyboard display.
 *
 * Subscribes to MQTT topic `home/hsb1/funkeykid/display` and renders:
 *   (a) letter + word + background image for keypress payloads, or
 *   (b) a vertical VU-meter overlay for volume-change payloads (FKID-2).
 * Retained `home/hsb1/funkeykid/keyboard-info` drives the start screen:
 * searching, waking (2.6s), ready, low battery, not exclusive, offline.
 * Missing status starts offline; three missed heartbeats expire live status.
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
 *   2. Keyboard alert   — known disconnected, offline, or not exclusive
 *   3. Idle             — last image, or animated start screen before a key
 *   4. Active           — bg image + big letter + word
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
import { BITMAP_FONT } from "../../lib/pixoo-font.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(__dirname, "../../assets/pixoo/funkeykid");

const IDLE_TIMEOUT_MS = 10000; // 10s without keypress → show bg only
const MQTT_TOPIC = "home/hsb1/funkeykid/display";
const KEYBOARD_INFO_TOPIC = "home/hsb1/funkeykid/keyboard-info";
const HEARTBEAT_S = 10;
const WAKE_MS = 2600;

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
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// PIXD-122 reference pixel art: keycap mascot, 5×7 title keycaps, 7px status.
// Clamped pixels preserve the reference canvas alpha rounding on the v1 driver.
function drawStartScreen(B, state, st, t, battery, batteryLow) {
  B.fill(0);
  const put = (x, y, c, a) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x > 63 || y > 63) return;
    const i = (y * 64 + x) * 3;
    if (a === undefined || a >= 1) { B[i] = c[0]; B[i + 1] = c[1]; B[i + 2] = c[2]; return; }
    if (a <= 0) return;
    B[i] = B[i] * (1 - a) + c[0] * a;
    B[i + 1] = B[i + 1] * (1 - a) + c[1] * a;
    B[i + 2] = B[i + 2] * (1 - a) + c[2] * a;
  };
  const rect = (x, y, w, h, c, a) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c, a); };
  const bmp = (x, y, rows, c, a) => { for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) if (rows[j][i] === 'X') put(x + i, y + j, c, a); };
  const hsl = (h, s, l) => {
    h = (((h % 360) + 360) % 360) / 360; s /= 100; l /= 100;
    const f = (n) => { const k = (n + h * 12) % 12; const q = s * Math.min(l, 1 - l); return Math.round(255 * (l - q * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  };
  const mix = (a, b, k) => [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
  const dim = (c, k) => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];
  const ease = (x) => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
  const BLACK = [0, 0, 0];

  // pixdcon 3x5 font; lowercase glyphs leave the top row empty.
  const text3 = (s, cx, y, c, a) => {
    const w = s.length * 4 - 1;
    let x = Math.round(cx - w / 2);
    for (const ch of s) {
      const g = BITMAP_FONT[ch];
      if (g) for (let k = 0; k < 15; k++) if (g[k] === 1) put(x + (k % 3), y + Math.floor(k / 3), c, a);
      x += 4;
    }
  };
  const F5 = {
    F: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'X....'],
    U: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
    N: ['X...X', 'XX..X', 'XX..X', 'X.X.X', 'X..XX', 'X..XX', 'X...X'],
    K: ['X...X', 'X..X.', 'X.X..', 'XX...', 'X.X..', 'X..X.', 'X...X'],
    E: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX'],
    Y: ['X...X', 'X...X', '.X.X.', '..X..', '..X..', '..X..', '..X..'],
    I: ['XXX', '.X.', '.X.', '.X.', '.X.', '.X.', 'XXX'],
    D: ['XXXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'XXXX.']
  };

  const asleep = state === 'searching';
  const off = state === 'offline';
  const unsafe = state === 'unsafe';
  const low = state === 'lowbat';
  const waking = state === 'waking';
  const ready = state === 'ready';
  const wake = waking ? ease((st - 300) / 1300) : (asleep || off) ? 0 : 1;

  // background stars (night sky while asleep, fading out on wake)
  const STARS = [[4, 12, 0.0, 1.3], [11, 20, 1.7, 0.9], [6, 31, 3.1, 1.1], [13, 41, 0.8, 1.5], [3, 44, 2.4, 0.8], [57, 14, 4.0, 1.2], [52, 25, 0.5, 1.0], [60, 32, 2.9, 1.4], [55, 42, 1.2, 0.9], [49, 9, 3.6, 1.1], [15, 9, 2.0, 1.3], [30, 9, 5.1, 0.7], [9, 37, 4.4, 1.0], [58, 22, 1.9, 1.6]];
  const starA = off ? 0.25 : (1 - wake);
  if (starA > 0.01) {
    for (const s of STARS) {
      const k = 0.2 + 0.8 * Math.max(0, Math.sin(t / 1000 * s[3] + s[2]));
      put(s[0], s[1], [160, 175, 255], starA * k * 0.85);
    }
  }

  // mascot body: a keycap with a face
  let bob = 0;
  if (ready || low) bob = Math.floor(t / 450) % 2 ? -1 : 0;
  else if (asleep) bob = Math.sin(t / 900) > 0.55 ? -1 : 0;
  else if (waking && st > 1600 && st < 2000) bob = -2;
  const by = 14 + bob;

  const hue = (t / 35) % 360;
  let face, skirt;
  if (off) { face = [74, 74, 82]; skirt = [40, 40, 46]; }
  else if (unsafe) { const on = Math.floor(t / 400) % 2 === 0; face = on ? [235, 72, 60] : [165, 45, 40]; skirt = [92, 24, 22]; }
  else {
    face = mix([50, 60, 128], hsl(hue, 85, 62), wake);
    skirt = mix([26, 30, 76], hsl(hue, 75, 32), wake);
  }

  rect(19, by, 26, 22, skirt);
  put(19, by, BLACK); put(44, by, BLACK); put(19, by + 21, BLACK); put(44, by + 21, BLACK);
  rect(20, by + 21, 24, 1, dim(skirt, 0.7));
  rect(22, by + 1, 20, 16, face);
  put(22, by + 1, skirt); put(41, by + 1, skirt); put(22, by + 16, skirt); put(41, by + 16, skirt);
  rect(23, by + 1, 18, 1, mix(face, [255, 255, 255], 0.35));

  // legs and feet
  const legC = off ? [50, 50, 56] : mix([48, 52, 84], [205, 205, 220], wake);
  for (let y = by + 22; y <= 38; y++) { rect(24, y, 2, 1, legC); rect(38, y, 2, 1, legC); }
  rect(23, 39, 3, 1, legC); rect(38, 39, 3, 1, legC);

  // arms
  const armC = mix(skirt, [255, 255, 255], 0.25);
  if (ready || low) {
    const ph = Math.floor(t / 300) % 2;
    put(18, by + 13, armC); put(17, by + 12 - ph, armC);
    put(45, by + 13, armC); put(46, by + 11 + ph, armC);
  } else if (unsafe) {
    put(18, by + 11, armC); put(17, by + 10, armC); put(17, by + 9, armC);
    put(45, by + 11, armC); put(46, by + 10, armC); put(46, by + 9, armC);
  }

  // eyes
  const EYE = [16, 16, 26];
  const WHITE = [255, 255, 255];
  let eye = 'open';
  if (off) eye = 'dash';
  else if (asleep) eye = 'closed';
  else if (waking) eye = st < 600 ? 'closed' : st < 1000 ? 'half' : 'open';
  if (eye === 'open' && !unsafe && (t % 3200) < 130) eye = 'closed';
  if (eye === 'dash') { rect(25, by + 7, 4, 1, EYE); rect(35, by + 7, 4, 1, EYE); }
  else if (eye === 'closed') {
    put(25, by + 7, EYE); put(26, by + 8, EYE); put(27, by + 8, EYE); put(28, by + 7, EYE);
    put(35, by + 7, EYE); put(36, by + 8, EYE); put(37, by + 8, EYE); put(38, by + 7, EYE);
  } else if (eye === 'half') { rect(26, by + 7, 2, 2, EYE); rect(36, by + 7, 2, 2, EYE); }
  else if (unsafe) { rect(25, by + 5, 3, 4, EYE); rect(36, by + 5, 3, 4, EYE); put(25, by + 5, WHITE); put(36, by + 5, WHITE); }
  else { rect(26, by + 6, 2, 3, EYE); rect(36, by + 6, 2, 3, EYE); put(26, by + 6, WHITE); put(36, by + 6, WHITE); }

  // cheeks
  if (!off && !unsafe) {
    const ch = mix([90, 50, 110], [255, 120, 160], wake);
    rect(23, by + 10, 2, 1, ch); rect(39, by + 10, 2, 1, ch);
  }

  // mouth
  if (off) rect(30, by + 12, 4, 1, [50, 50, 56]);
  else if (asleep) { put(31, by + 12, EYE); put(32, by + 12, EYE); }
  else if (waking && st < 1300) rect(31, by + 11, 2, 2, EYE);
  else if (unsafe) rect(31, by + 11, 2, 3, EYE);
  else if (low) { put(29, by + 12, EYE); put(30, by + 11, EYE); put(31, by + 12, EYE); put(32, by + 11, EYE); put(33, by + 12, EYE); put(34, by + 11, EYE); }
  else { put(29, by + 11, EYE); put(34, by + 11, EYE); rect(30, by + 12, 4, 1, EYE); }

  // effects around the mascot
  if (asleep) {
    for (let i = 0; i < 3; i++) {
      const p = ((t + i * 800) % 2400) / 2400;
      bmp(Math.round(45 + p * 9), Math.round(17 - p * 9), ['XXXX', '..X.', '.X..', 'XXXX'], [175, 185, 255], Math.sin(p * Math.PI) * 0.9);
    }
  }
  if (waking && st > 450 && st < 1700) bmp(31, 8, ['XX', 'XX', 'XX', '..', 'XX'], [255, 220, 60]);
  const SPARK = [[9, 14, 0], [53, 11, 600], [11, 33, 1200], [54, 31, 300], [7, 24, 900], [48, 41, 1500]];
  if (ready || low || (waking && st > 1600)) {
    const cols = [[255, 240, 150], [255, 150, 220], [150, 230, 255]];
    SPARK.forEach((s, i) => {
      const p = ((t + s[2]) % 1800) / 1800;
      const k = waking ? 1 - (st - 1600) / 1000 : Math.max(0, Math.sin(p * Math.PI * 2));
      if (k <= 0.05) return;
      const c = cols[i % 3];
      put(s[0], s[1], c, k);
      if (k > 0.55) { put(s[0] - 1, s[1], c, k * 0.6); put(s[0] + 1, s[1], c, k * 0.6); put(s[0], s[1] - 1, c, k * 0.6); put(s[0], s[1] + 1, c, k * 0.6); }
    });
  }
  if (low) {
    const d = Math.floor(t / 250) % 3;
    bmp(46, by + 3 + d, ['.X.', 'XXX', '.X.'], [120, 200, 255]);
  }
  if (unsafe) {
    const on = Math.floor(t / 400) % 2 === 0;
    if (on) {
      const R = [255, 50, 40];
      rect(0, 8, 64, 1, R); rect(0, 63, 64, 1, R); rect(0, 8, 1, 56, R); rect(63, 8, 1, 56, R);
      rect(48, 10, 7, 7, R);
      put(48, 10, BLACK); put(54, 10, BLACK); put(48, 16, BLACK); put(54, 16, BLACK);
      bmp(51, 11, ['X', 'X', 'X', '.', 'X'], [255, 255, 255]);
    }
  }

  // title keycaps
  const CAPS = [['FUN', hsl(330, 85, 60), 1], ['KEY', hsl(45, 95, 55), 22], ['KID', hsl(190, 85, 55), 43]];
  const titleK = off ? 1 : asleep ? 0.32 : waking ? 0.32 + 0.68 * ease((st - 600) / 900) : unsafe ? 0.45 : 1;
  let pressIdx = -1;
  if (ready || low) { const c = t % 4200; if (c < 900) pressIdx = Math.floor(c / 300); }
  if (waking && st > 1500 && st < 2400) pressIdx = Math.floor((st - 1500) / 300);
  CAPS.forEach((cap, i) => {
    const word = cap[0], x0 = cap[2];
    const col = off ? [70, 70, 78] : dim(cap[1], titleK);
    const press = i === pressIdx ? 2 : 0;
    const fy = 48 + press;
    rect(x0, fy + 10, 20, 3 - press, dim(col, 0.45));
    rect(x0, fy, 20, 10, col);
    put(x0, fy, BLACK); put(x0 + 19, fy, BLACK);
    rect(x0 + 1, fy, 18, 1, mix(col, [255, 255, 255], off ? 0 : 0.3));
    let w = 0;
    for (const ch of word) w += F5[ch][0].length + 1;
    w -= 1;
    let tx = x0 + Math.round((20 - w) / 2);
    const tc = off ? [40, 40, 46] : [22, 18, 32];
    for (const ch of word) { bmp(tx, fy + 2, F5[ch], tc); tx += F5[ch][0].length + 1; }
  });

  // status bar: bluetooth, status word, battery
  const BT = ['..X..', '..XX.', 'X.X.X', '.XXX.', 'X.X.X', '..XX.', '..X..'];
  if (off) bmp(1, 0, BT, [55, 55, 62]);
  else if (asleep) { if ((t % 1400) < 900) bmp(1, 0, BT, [120, 120, 145]); }
  else if (waking && st < 1600) {
    bmp(1, 0, BT, [80, 155, 255]);
    const w1 = (st % 600) < 400, w2 = ((st + 300) % 600) < 400;
    if (w1) { put(7, 2, [80, 155, 255]); put(8, 3, [80, 155, 255]); put(7, 4, [80, 155, 255]); }
    if (w2) { put(9, 1, [80, 155, 255]); put(10, 2, [80, 155, 255]); put(10, 3, [80, 155, 255]); put(10, 4, [80, 155, 255]); put(9, 5, [80, 155, 255]); }
  } else bmp(1, 0, BT, [50, 130, 255]);

  let word = '', wc = [0, 0, 0], wa = 1;
  if (off) { word = 'offline'; wc = [95, 95, 105]; }
  else if (asleep) { word = 'suche'; wc = [140, 140, 168]; }
  else if (waking) { if (st < 1600) { word = 'verbinde'; wc = [110, 170, 255]; } else { word = 'hallo!'; wc = [255, 220, 80]; } }
  else if (unsafe) { word = 'achtung'; wc = [255, 70, 60]; wa = Math.floor(t / 400) % 2 === 0 ? 1 : 0.35; }
  else if (low) { word = 'akku!'; wc = [255, 170, 60]; }
  else { word = 'bereit'; wc = [90, 225, 130]; }
  text3(word, 32, 1, wc, wa);

  if (battery != null) {
    const bc = batteryLow ? [255, 60, 50] : battery <= 50 ? [255, 180, 40] : [70, 220, 110];
    const on = !batteryLow || (t % 800) < 500;
    const oc = batteryLow ? bc : [150, 150, 162];
    rect(52, 1, 10, 1, oc); rect(52, 5, 10, 1, oc); rect(52, 1, 1, 5, oc); rect(61, 1, 1, 5, oc); rect(62, 2, 1, 3, oc);
    if (on) rect(53, 2, Math.max(1, Math.round(battery / 100 * 8)), 3, bc);
  }
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
  // FKID-2: volume bar-graph overlay — shown when funkeykid publishes
  // {bar:true, percent, bars_total, bars_filled} instead of a letter.
  _volumeBar: null,  // { percent, bars_filled, bars_total, color:[r,g,b] }
  _volumeBarAt: 0,   // timestamp; bar shows for ~1.5s after last update

  async init(context) {
    this._bgImages = Object.create(null);
    this._messageVersion = 0;
    this._destroyed = false;
    this._keyboardInfo = null;
    this._keyboardInfoAt = null;
    this._wakingAt = null;
    this._startAt = Date.now();
    this._startPixels = new Uint8ClampedArray(64 * 64 * 3);
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

    context.mqtt.subscribe(KEYBOARD_INFO_TOPIC, (msg) => {
      if (this._destroyed) return;
      try {
        const data = JSON.parse(msg);
        if (!data || typeof data !== "object" || Array.isArray(data) ||
          typeof data.online !== "boolean" ||
          (data.online && typeof data.connected !== "boolean") ||
          (data.exclusive != null && typeof data.exclusive !== "boolean") ||
          (data.battery_low != null && typeof data.battery_low !== "boolean")) return;
        const now = Date.now();
        const wasConnected = this._keyboardOnline(now) && this._keyboardInfo.connected;
        const connected = data.online && data.connected === true;
        // An initial retained snapshot is not a connection edge. Repeated
        // heartbeats must not restart the one-shot animation; stale status is
        // disconnected, so recovery after missed beats does play it again.
        if (this._keyboardInfo && !wasConnected && connected) this._wakingAt = now;
        if (!connected || data.exclusive !== true) this._wakingAt = null;
        this._keyboardInfo = {
          online: data.online,
          connected,
          exclusive: data.exclusive === true,
          battery_low: data.battery_low === true,
          battery_level: typeof data.battery_level === "number" &&
            Number.isFinite(data.battery_level) && data.battery_level >= 0 &&
            data.battery_level <= 100 ? data.battery_level : null,
          heartbeat_s: typeof data.heartbeat_s === "number" && data.heartbeat_s > 0 &&
            Number.isFinite(data.heartbeat_s * 3000) ? data.heartbeat_s : HEARTBEAT_S,
        };
        // Use reception time: the producer's timestamp belongs to another clock.
        this._keyboardInfoAt = now;
      } catch (e) {
        context.logger.warn("[funkeykid] Bad keyboard-info payload");
      }
    });

    // Subscribe to funkeykid display topic
    context.mqtt.subscribe(MQTT_TOPIC, async (msg) => {
      try {
        const data = JSON.parse(msg);
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        if (this._destroyed) return;
        if (data.bar !== true &&
          ((data.letter != null && typeof data.letter !== "string") ||
            (data.word != null && typeof data.word !== "string"))) return;
        const total = Number.isInteger(data.bars_total) &&
          data.bars_total >= 1 && data.bars_total <= 64 ? data.bars_total : 10;
        const filled = data.bars_filled ?? 0;
        if (data.bar === true &&
          (typeof filled !== "number" || !Number.isFinite(filled))) return;
        const version = ++this._messageVersion;

        // Load image FIRST (before updating state) to prevent glitch
        const imgName = typeof data.image === "string" ? data.image : null;
        let newImage = null;
        if (imgName) {
          if (!this._bgImages[imgName]) {
            try {
              this._bgImages[imgName] = await loadPixooImage(resolve(ASSETS_DIR, imgName));
            } catch (e) { /* missing image */ }
          }
          newImage = this._bgImages[imgName] || null;
        }
        if (this._destroyed || version !== this._messageVersion) return;

        if (data.bar === true) {
          // Volume update: only touch the overlay state. Letter-rendering
          // state must stay exactly as a previous real keypress left it,
          // otherwise "60%"/"lautstaerke" leak into the fallback path
          // once the bar's TTL expires.
          this._volumeBar = {
            percent: typeof data.percent === "number" && Number.isFinite(data.percent) ? data.percent : 0,
            bars_total: total,
            bars_filled: Math.max(0, Math.min(total, filled)),
            color: parseHexColor(data.color) || [255, 204, 0],
          };
          this._volumeBarAt = Date.now();
          context.logger.info(`[funkeykid] volume bar: ${this._volumeBar.percent}% (${this._volumeBar.bars_filled}/${this._volumeBar.bars_total})`);
        } else {
          // Real letter/image update — snapshot full state, drop any overlay.
          this._currentLetter = data.letter || null;
          this._currentWord = data.word || null;
          this._currentColor = parseHexColor(data.color) || randomColor();
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

    context.logger.info(`[funkeykid] Scene initialized, listening on ${MQTT_TOPIC} and ${KEYBOARD_INFO_TOPIC}`);
  },

  _keyboardOnline(now) {
    return this._keyboardInfo?.online === true && this._keyboardInfoAt !== null &&
      now - this._keyboardInfoAt < this._keyboardInfo.heartbeat_s * 3000;
  },

  _keyboardState(now) {
    if (!this._keyboardOnline(now)) return "offline";
    if (!this._keyboardInfo.connected) return "searching";
    if (!this._keyboardInfo.exclusive) return "unsafe";
    if (this._keyboardInfo.battery_low) return "lowbat";
    if (this._wakingAt !== null && now - this._wakingAt < WAKE_MS) return "waking";
    return "ready";
  },

  async _renderStart(device, now, state) {
    const st = this._wakingAt === null ? 0 : Math.max(0, now - this._wakingAt);
    // Offline is deliberately still. Animation time is local to this instance,
    // independent of frame cadence, so the same elapsed time draws the same art.
    const t = state === "offline" ? 0 : Math.max(0, now - this._startAt);
    const battery = state === "offline" || state === "searching" ||
      (state === "waking" && st < 1600) ? null : this._keyboardInfo?.battery_level;
    drawStartScreen(this._startPixels, state, st, t, battery,
      this._keyboardInfo?.battery_low === true);
    device.buf.set(this._startPixels);
    await device.push();
    return 60;
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

    const keyboardState = this._keyboardState(now);
    if (!volumeBarActive && this._keyboardInfo &&
      ["offline", "searching", "unsafe"].includes(keyboardState)) {
      return this._renderStart(device, now, keyboardState);
    }

    if (isIdle && !volumeBarActive) {
      // Idle: show the last image (no text), or keyboard status before a key.
      const bgImg = this._currentImage || (this._lastImageName ? this._bgImages[this._lastImageName] : null);

      if (bgImg) {
        drawPixooImage(device, bgImg, 0, 0);
      } else {
        return this._renderStart(device, now, keyboardState);
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
        const w = Math.round(minW + (maxW - minW) * (segCount > 1 ? i / (segCount - 1) : 0));
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
    this._destroyed = true;
    this._messageVersion++;
    this._unsubscribeSettings?.();
    context?.mqtt?.unsubscribeAll?.();
    this._currentLetter = null;
    this._currentWord = null;
    this._lastKeypressAt = 0;
    this._keyboardInfo = null;
    this._keyboardInfoAt = null;
    this._wakingAt = null;
  },
};
