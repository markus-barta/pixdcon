/**
 * home2 — Pixoo64 smart home dashboard with boiler day history
 *
 * 3×3 grid layout (64×64), except row 0 which is 2 cells:
 *   y 0-6:   header — HOME label + HH:MM clock
 *   y 7:     horizontal separator
 *   y 8-25:  row 0 — [Nuki VR/KE + TE terrace + OL skylights] [pool/roof temps]
 *   y 26:    horizontal separator
 *   y 27-44: row 1 — [Battery SOC] [PV↑ Cons↓] [Boiler temperature + day chart]
 *   y 45:    horizontal separator
 *   y 46-63: row 2 — [PS5] [TV] [PC]  ← device icons, syncbox ring on active PS5/PC
 *
 *   x 43: vertical separator, full height
 *   x 21: vertical separator, rows 1-2 only — row 0 is one merged 43×18 cell
 *
 * Row 0 status cell (x 0-42) encoding:
 *   Nuki VR (y 9-15) and Nuki KE (y 18-24) keep their 7×7 sprites — the artwork
 *   carries lock state, plus an amber dot when the lock's own MQTT reports it disconnected
 *   or its battery critical (PIXD-63).
 *   OL (Oberlichten = skylights, upper floor) on top and TE (terrace) below are text labels at x 20, with
 *   3×3 badges left-aligned at x 29. Labels share the temperatures' warm white; the badge
 *   carries state twice, in colour and shape: filled green = open, hollow red = closed,
 *   olive + amber checker = stale/offline. Text brightness is deliberately high:
 *   the panel sits behind palladium-coated glass and C.dimWhite (80,80,80), used
 *   by the HOME label, is not readable in daylight through it.
 *
 * Row 0 temperature cell (x 44-63): Dachterrasse (upper terrace) level with OL, pool (lower
 *   terrace) level with TE. Values are right-aligned so every degree pixel, the boiler's included,
 *   is at x 62.
 *
 * Boiler cell: thermometer gradient — each chart row has its level's colour (white-blue → blue at
 *   40 °C → violet → red at 60 °C → bright red), matching the 40/60 °C ticks; the number takes its
 *   value's colour. Only a bottom triangle marks the current bucket; it
 *   turns red while the boiler draws power, and a red dot (mixed into the bar) rises through the
 *   current bar to one row above it at 1 row/s, fades out, and restarts (heating_fps sets the FPS).
 *
 * Data sources:
 *   nuki/463F8F47/state                           numeric 1=locked 2=unlocking 3=unlocked 4=locking  (Nuki VR)
 *   nuki/4A5D18FF/state                           numeric 1=locked 2=unlocking 3=unlocked 4=locking  (Nuki Keller)
 *   z2m/wz/contact/te-door                        {contact: bool}
 *   z2m/wz/contact/te-door/availability           {state: "online"|"offline"}
 *   z2m/vk/contact/w13                            {contact: bool}
 *   z2m/vk/contact/w13/availability               {state: "online"|"offline"}
 *   z2m/vr/contact/w14                            {contact: bool}
 *   z2m/vr/contact/w14/availability               {state: "online"|"offline"}
 *   z2m/dt/motion/hueoutdoor                      {temperature} — Dachterrasse air temp.
 *     Hue outdoor sensor. The co-located Aqara (z2m/dt/temp/aqara) is NOT used: it sits in
 *     direct sun and read 40.5 °C against a 30.2 °C Graz reference over 24 h (~+10 K).
 *   z2m/te/temp/pool                              {temperature} — pool water (Sonoff probe)
 *   home/ke/sonnenbattery/status                  {USOC, BatteryCharging, BatteryDischarging, Production_W, Consumption_W}
 *   jhw2211/health/boiler                         {state, temp_c} — retained boiler temperature
 *   z2m/bz/powercontrol/boiler                    {state, power} — boiler relay; heating = power ≥ boiler_heating_w
 *   z2m/wz/plug/zisp08                            {power} — sony-tv
 *   z2m/wz/plug/zisp28                            {power} — PS5
 *   z2m/wz/plug/zisp05                            {power} — windows-pc
 *   HTTP https://192.168.1.111/api/v1/execution/  Hue Syncbox (SYNCBOX_BEARER_TOKEN env)
 *     hdmi.input: "input2"=PC  "input4"=PS5
 *
 * Brightness (elevation-based, smooth curve):
 *   homeassistant/sun/sun/elevation  float degrees → lerp(−6°..10°) → bri_night..bri_day
 *   homeassistant/sun/sun/state      above_horizon | below_horizon  (fallback if no elevation yet)
 *   pixdcon/<device>/home2/settings/bri_day    (default 100)
 *   pixdcon/<device>/home2/settings/bri_night  (default 7)
 *   pixdcon/debug/bri_override                number | "" (clears)
 *
 *   Twilight zone: elevation −6° (astro dusk) → 10° (full day), ~30–45 min natural fade.
 *   setBrightness fires on integer-level change + 5 min heartbeat.
 */

import https from "https";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { drawPixooImage, loadPixooImage } from "../../lib/pixoo-image.js";

// ── Brightness helpers ────────────────────────────────────────────────────────

const BRI_HEARTBEAT_MS = 5 * 60 * 1000;
const DEFAULT_SETTINGS = {
  briDay: 100,
  briNight: 7,
  sunElevLo: -6,
  sunElevHi: 10,
  fallbackDayStart: "07:30",
  fallbackNightStart: "20:30",
  staleMs: 300000,
  healRetryMs: 30000,
  healInitialDelayMs: 5000,
  ps5OnW: 25,
  tvOnW: 26,
  pcOnW: 10,
  syncboxHost: "192.168.1.111",
  syncboxTimeoutMs: 2500,
  syncboxPollMs: 5000,
  syncboxFreshMs: 30000,
  syncboxInputPs5: "input4",
  syncboxInputPc: "input2",
  boilerStaleMs: 30 * 60 * 1000,
  boilerHeatingW: 100,
  heatingFps: 2,
  // Battery-powered Zigbee temp sensors report on change, not on a schedule —
  // the pool probe can go 30 min between publishes. 5 min would read as stale.
  tempStaleMs: 5400000,
};
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function elevToBri(elev, night, day, low = -6, high = 10) {
  if (high <= low) return elev >= high ? day : night;
  return Math.round(
    night + (day - night) * clamp((elev - low) / (high - low), 0, 1),
  );
}

// ── Palette ───────────────────────────────────────────────────────────────────

const C = {
  open: [40, 210, 80],
  closed: [210, 30, 30],
  trans: [220, 180, 0],
  unknown: [70, 50, 0],
  // Doors / skylights
  frameGray: [160, 160, 155], // mid-gray frame outline
  doorFill: [50, 10, 10], // very dark red fill (closed door)
  doorFillOpen: [8, 35, 12], // very dark green fill (open door)
  doorHandle: [200, 100, 80], // warm highlight for handle
  // Row 0 merged status cell — hue is identity, fill is state.
  // Labels run bright: they must clear C.dimWhite (unreadable behind the glass).
  // TE / OL labels and both terrace temperatures share the clock's warm white (PIXD-62).
  rowText: [200, 200, 160],
  badgeOpen: [40, 210, 80], // filled green badge = open
  badgeClosed: [210, 30, 30], // hollow red badge = closed
  ok: [0, 200, 80],
  warn: [220, 160, 0],
  bad: [200, 30, 30],
  amber: [255, 155, 0],
  cyan: [0, 190, 220],
  dimWhite: [80, 80, 80],
  timeColor: [200, 200, 160],
  sep: [25, 25, 25],
  // Battery
  chrgGreen: [0, 200, 80],
  dischRed: [200, 50, 50],
  stbyGrey: [60, 60, 60],
  // Media
  tvColor: [60, 190, 255],
  ps5Color: [80, 120, 255],
  pcColor: [160, 160, 160],
  syncRing: [240, 220, 0],
  // Error
  errorRed: [200, 0, 0],
};

// ── Grid ──────────────────────────────────────────────────────────────────────

const COLS = [
  { x0: 0, x1: 20, cx: 10 },
  { x0: 22, x1: 42, cx: 32 },
  { x0: 44, x1: 63, cx: 53 },
];
const ROWS = [
  { y0: 8, y1: 25, cy: 16 },
  { y0: 27, y1: 44, cy: 35 },
  { y0: 46, y1: 63, cy: 54 },
];
// Row 0 is one merged 43×18 status cell, so the x=21 divider starts below it.
const V_SEP = [
  { x: 21, y0: 27 },
  { x: 43, y0: 8 },
];
const H_SEP = [7, 26, 45];

// ── Draw primitives ───────────────────────────────────────────────────────────

function hLine(d, x0, x1, y, r, g, b) {
  for (let x = x0; x <= x1; x++) d._setPixel(x, y, r, g, b);
}
function vLine(d, x, y0, y1, r, g, b) {
  for (let y = y0; y <= y1; y++) d._setPixel(x, y, r, g, b);
}
function fillRect(d, x, y, w, h, r, g, b) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) d._setPixel(x + dx, y + dy, r, g, b);
}

function drawSeparators(d) {
  const [sr, sg, sb] = C.sep;
  for (const y of H_SEP) hLine(d, 0, 63, y, sr, sg, sb);
  for (const { x, y0 } of V_SEP) vLine(d, x, y0, 63, sr, sg, sb);
}

// Blinking 3×3 ✗ in top-right corner of a cell.
function drawErrorMark(d, col, row, frame) {
  if ((frame & 1) === 0) return;
  const x = COLS[col].x1 - 3;
  const y = ROWS[row].y0 + 1;
  const [r, g, b] = C.errorRed;
  d._setPixel(x, y, r, g, b);
  d._setPixel(x + 2, y, r, g, b);
  d._setPixel(x + 1, y + 1, r, g, b);
  d._setPixel(x, y + 2, r, g, b);
  d._setPixel(x + 2, y + 2, r, g, b);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const NUKI_IMAGE_PATHS = {
  unknown: resolve(__dirname, "../../assets/pixoo/nuki-unknown.png"),
  open: resolve(__dirname, "../../assets/pixoo/nuki-open.png"),
  closed: resolve(__dirname, "../../assets/pixoo/nuki-closed.png"),
  transition: resolve(__dirname, "../../assets/pixoo/nuki-transition.png"),
};
const MEDIA_IMAGE_PATHS = {
  ps5On: resolve(__dirname, "../../assets/pixoo/icons/ps5-on.png"),
  ps5Standby: resolve(__dirname, "../../assets/pixoo/icons/ps5-standby.png"),
  tvOn: resolve(__dirname, "../../assets/pixoo/icons/tv-on.png"),
  tvStandby: resolve(__dirname, "../../assets/pixoo/icons/tv-standby.png"),
  pcOn: resolve(__dirname, "../../assets/pixoo/icons/pc-on.png"),
  pcOff: resolve(__dirname, "../../assets/pixoo/icons/pc-off.png"),
};

function drawNukiIcon(d, image, cx, cy, alive) {
  // 7×7 icons: anchor at floor(7/2)=3 left and 3 up from center
  drawPixooImage(d, image, cx - 3, cy - 3);
  if (!alive) {
    // Attention dot (disconnected or battery critical): 1px right of icon edge (cx+4)
    const [dr, dg, db] = [255, 190, 40];
    d._setPixel(cx + 4, cy - 1, dr, dg, db);
    d._setPixel(cx + 4, cy, dr, dg, db);
  }
}

// ── Cell: merged door/lock status (row 0, x 0..42) ────────────────────────────

// 3×3 badge: filled `bright` = open, hollow `outline` = closed (home2 passes green / red, so
// shape and colour both carry state), olive + amber checker = stale/offline. Stale must never look like closed — a sensor that
// dropped off while a window was open is the failure that matters.
function drawOpeningBadge(d, x, y, open, online, bright, outline) {
  if (open === null || online === false) {
    const [ur, ug, ub] = C.unknown;
    fillRect(d, x, y, 3, 3, ur, ug, ub);
    const [tr, tg, tb] = C.trans;
    for (const [dx, dy] of [
      [0, 0],
      [2, 0],
      [1, 1],
      [0, 2],
      [2, 2],
    ])
      d._setPixel(x + dx, y + dy, tr, tg, tb);
    return;
  }
  if (open) {
    const [r, g, b] = bright;
    fillRect(d, x, y, 3, 3, r, g, b);
    return;
  }
  const [r, g, b] = outline;
  hLine(d, x, x + 2, y, r, g, b);
  hLine(d, x, x + 2, y + 2, r, g, b);
  d._setPixel(x, y + 1, r, g, b);
  d._setPixel(x + 2, y + 1, r, g, b);
}

// ── Cell: stacked temperatures (row 0, x 44..63) ──────────────────────────────

// Value + degree pixel. Same kerning trick as drawKwTight: the decimal point is
// a hand-placed pixel on the baseline rather than a font glyph, so "32.3" fits
// in 13px instead of the 15px the 3×5 face would need.
// Every temperature's degree pixel, the boiler's included, sits in this column.
const DEGREE_X = COLS[2].x1 - 1; // x=62

// Right-aligned on DEGREE_X, right to left: ° | gap | fraction (3px) | gap | dot | gap | integer.
async function drawTempValue(d, cellX0, y, value, color) {
  const [r, g, b] = color;
  if (value === null) {
    await d.drawTextRgbaAligned("--", [DEGREE_X + 1, y], C.dimWhite, "right");
    return;
  }

  const [intStr, fracStr] = value.toFixed(1).split(".");
  const intW = intStr.length * 4 - 1; // 4n-1 glyph run
  const fracX = DEGREE_X - 4;
  const dotX = fracX - 2;
  const minX = cellX0 + 1; // keep a 1px margin from the x43 separator
  if (dotX - 1 - intW >= minX) {
    await d.drawTextRgbaAligned(intStr, [dotX - 1 - intW, y], color, "left");
    d._setPixel(dotX, y + 4, r, g, b);
    await d.drawTextRgbaAligned(fracStr, [fracX, y], color, "left");
  } else if (DEGREE_X - 1 - intW >= minX) {
    // Too wide for the decimal: the integer alone, then the same gap and degree.
    await d.drawTextRgbaAligned(intStr, [DEGREE_X - 1 - intW, y], color, "left");
  } else {
    // Not even the integer fits (implausible reading): never spill into the next cell.
    await d.drawTextRgbaAligned("--", [DEGREE_X + 1, y], C.dimWhite, "right");
    return;
  }
  d._setPixel(DEGREE_X, y, r, g, b);
}

function drawMediaIcon(d, image, cx, cy) {
  const x = cx - Math.floor(image.width / 2);
  const y = cy - Math.floor(image.height / 2);
  drawPixooImage(d, image, x, y);
}

function drawPcIcon(d, image, cx, cy) {
  const x = cx - Math.floor(image.width / 2);
  const y = cy - Math.floor(image.height / 2) - 1;
  drawPixooImage(d, image, x, y);
}

function drawPowerStatusDot(d, cx, cy, color) {
  const [r, g, b] = color;
  d._setPixel(cx, cy + 7, r, g, b);
}

function drawSyncboxStatusLine(d, cx, cy, mode) {
  if (mode === "active") {
    hLine(d, cx - 2, cx + 2, cy + 9, 60, 140, 255);
    return;
  }
  const [r, g, b] = mode === "standby" ? [235, 235, 235] : [50, 50, 50];
  hLine(d, cx - 1, cx + 1, cy + 9, r, g, b);
}

// ── Cell: Battery — horizontal bar (SOC% above) ───────────────────────────────
//
// 16px wide bar, 5px tall (3px fill + 1px border top/bottom).
// Gradient fill: red (left) → yellow (mid) → green (right) regardless of state.
// Border: dark grey outline (1px top, bottom, left; nub on right).
// Discharge animation: bright pixel travels right→left through filled section,
//   colored to match the gradient at that position.
// State dim: charging=full brightness / standby=60% / off=25%.

function _gradientColor(i, total) {
  // i in [0, total-1] → red (left) → yellow (mid) → green (right)
  const t = total <= 1 ? 1 : i / (total - 1); // 0..1
  if (t < 0.5) {
    const u = t * 2;
    return [200, Math.round(200 * u), 0]; // red → yellow
  } else {
    const u = (t - 0.5) * 2;
    return [Math.round(200 * (1 - u)), 200, 0]; // yellow → green
  }
}

async function drawBattery(d, cx, cy, pct, state, frame) {
  const isDischarging = state === "discharging";
  const dim =
    state === "discharging" || state === "charging"
      ? 1.0
      : state === "standby"
        ? 0.6
        : 0.25;

  const BAR_W = 16; // outer width (1px border each side → 14px inner fill)
  const BAR_H = 6; // outer height (1px border each side → 4px inner fill)
  const INNER = BAR_W - 2; // 14 — visible fill columns
  const x0 = cx - Math.floor(BAR_W / 2);
  const barY = cy + 2; // moved down 2px

  const BORDER = [90, 90, 90];
  const fillX0 = x0 + 1;
  const filledPx =
    pct === null ? 0 : Math.max(0, Math.round((pct / 100) * INNER));

  // Full outline (all 4 sides)
  hLine(d, x0, x0 + BAR_W - 1, barY, ...BORDER);
  hLine(d, x0, x0 + BAR_W - 1, barY + BAR_H - 1, ...BORDER);
  vLine(d, x0, barY, barY + BAR_H - 1, ...BORDER);
  vLine(d, x0 + BAR_W - 1, barY, barY + BAR_H - 1, ...BORDER);

  // Inner fill (14 columns × 6 rows)
  for (let i = 0; i < INNER; i++) {
    const base = _gradientColor(i, INNER);
    const dimmed = base.map((v) => Math.round(v * dim));
    const empty = base.map((v) => Math.round(v * dim * 0.25));
    const [r, g, b] = i < filledPx ? dimmed : empty;
    vLine(d, fillX0 + i, barY + 1, barY + BAR_H - 2, r, g, b);
  }

  // Animation: 30% white overlay sweeping through filled area
  // Discharge: right→left. Charge: left→right.
  const isCharging = state === "charging";
  if ((isDischarging || isCharging) && filledPx > 1) {
    const phase = Math.floor(frame / 2) % filledPx;
    const animX = isCharging ? fillX0 + phase : fillX0 + filledPx - 1 - phase;
    const base = _gradientColor(animX - fillX0, INNER).map((v) =>
      Math.round(v * dim),
    );
    const [hr, hg, hb] = base.map((v) =>
      Math.min(255, Math.round(v + (255 - v) * 0.3)),
    );
    vLine(d, animX, barY + 1, barY + BAR_H - 2, hr, hg, hb);
  }

  // Nub on right: 2px tall, centered (rows 2+3 of 0-indexed 0..5)
  d._setPixel(x0 + BAR_W, barY + 2, ...BORDER);
  d._setPixel(x0 + BAR_W, barY + 3, ...BORDER);

  // % text: color matches current SOC gradient position; 1px higher than bar
  if (pct !== null) {
    const labelColor = _gradientColor(Math.max(0, filledPx - 1), INNER).map(
      (v) => Math.round(v * dim),
    );
    await d.drawTextRgbaAligned(
      `${Math.round(pct)}%`,
      [cx, barY - 8],
      labelColor,
      "center",
    );
  }
}

// ── PV/Cons glyphs (3px wide) ─────────────────────────────────────────────────
//
// Plus (production):   . X .    row y+1    (shifted +1px down vs old arrow)
//                      X X X    row y+2
//                      . X .    row y+3
// Minus (consumption): X X X    row y+2    (shifted -1px up vs old arrow)

function drawPlus(d, x0, y, r, g, b) {
  d._setPixel(x0 + 1, y + 1, r, g, b);
  d._setPixel(x0, y + 2, r, g, b);
  d._setPixel(x0 + 1, y + 2, r, g, b);
  d._setPixel(x0 + 2, y + 2, r, g, b);
  d._setPixel(x0 + 1, y + 3, r, g, b);
}

function drawMinus(d, x0, y, r, g, b) {
  d._setPixel(x0, y + 2, r, g, b);
  d._setPixel(x0 + 1, y + 2, r, g, b);
  d._setPixel(x0 + 2, y + 2, r, g, b);
}

// ── Tight fractional kW renderer ──────────────────────────────────────────────
//
// Always 13px wide, centered at cx.
// <10 kW  → N(3) gap(1) dot(1) gap(1) F(3) gap(1) F(3)   e.g. "9.67"
// ≥10 kW  → NN(7) gap(1) dot(1) gap(1) F(3)               e.g. "10.2"
// dot = 1px at font baseline (y+4); null → "---" via normal text.

async function drawKwTight(d, cx, cy, value, color) {
  if (value === null) {
    await d.drawTextRgbaAligned("---", [cx, cy], color, "center");
    return;
  }

  const kw = value / 1000;
  const s2 = kw.toFixed(2);
  const int2 = s2.split(".")[0];
  let intStr, fracStr;
  if (int2.length === 1) {
    [intStr, fracStr] = s2.split("."); // "9.68" → "9", "68"
  } else {
    [intStr, fracStr] = kw.toFixed(1).split("."); // "10.2" → "10", "2"
  }

  // Total = 13px; left edge at cx-6
  const x0 = cx - 6;
  const intW = intStr.length === 1 ? 3 : 7; // 4n-1 for n=1,2
  const dotX = x0 + intW + 1; // 1px gap after int
  const [r, g, b] = color;

  await d.drawTextRgbaAligned(intStr, [x0, cy], color, "left");
  d._setPixel(dotX, cy + 4, r, g, b); // dot at baseline

  let fracX = dotX + 2; // 1px dot + 1px gap
  for (const ch of fracStr) {
    await d.drawTextRgbaAligned(ch, [fracX, cy], color, "left");
    fracX += 4;
  }
}

// ── Cell: PV production + home consumption ────────────────────────────────────

async function drawPvCons(d, cx, cy, productionW, consumptionW) {
  // Arrow glyphs at cell left edge (x=COLS[1].x0+1=23), independent of number
  const ax = COLS[1].x0 + 1;

  // Production: grey if 0/null (no sun), bright yellow if generating
  const pvColor = !productionW ? C.dimWhite : [255, 220, 0];
  drawPlus(d, ax, cy - 6, ...pvColor);
  await drawKwTight(d, cx + 1, cy - 6, productionW, pvColor);

  // Consumption: dark-red → red → bright-red by kW tier
  const cons = consumptionW ?? 0;
  const consColor =
    cons < 500 ? [120, 20, 20] : cons <= 1000 ? [200, 40, 40] : [255, 60, 60];
  drawMinus(d, ax, cy + 2, ...consColor);
  await drawKwTight(d, cx + 1, cy + 2, consumptionW, consColor);
}

// ── Boiler day history / chart ───────────────────────────────────────────────

// 16 buckets of 90 min: 6 h is exactly 4 px, so the 00/06/12/18/24 ticks sit evenly (PIXD-62).
// Until 2026-10-09 the day had 18 × 80-min buckets; such a state file is re-binned on load.
const BOILER_BUCKETS = 16;
const BOILER_BUCKET_MIN = 90;
const BOILER_LEGACY_BUCKETS = 18;
const BOILER_LEGACY_BUCKET_MIN = 80;
const BOILER_SAMPLE_MS = 60000;
const BOILER_SAVE_MS = 5 * 60000;
const BOILER_STATE_PATH = resolve(__dirname, ".state", "home2-boiler.json");

function boilerLocalDate(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function boilerBucket(now) {
  // Wall-clock minutes, not elapsed time: DST repeats/skips within fixed bins.
  return clamp(Math.floor((now.getHours() * 60 + now.getMinutes()) / BOILER_BUCKET_MIN), 0, BOILER_BUCKETS - 1);
}

// Re-bin a day of {sum, count} buckets to BOILER_BUCKETS by minute overlap. Each new bucket keeps
// the overlap-weighted average of the old ones, with an integer count (≥ 1 when anything overlaps).
function rebinBoilerBuckets(old, oldMinutes) {
  return Array.from({ length: BOILER_BUCKETS }, (_, j) => {
    const [b0, b1] = [j * BOILER_BUCKET_MIN, (j + 1) * BOILER_BUCKET_MIN];
    let sum = 0;
    let weight = 0;
    old.forEach((bucket, i) => {
      const overlap = Math.min(b1, (i + 1) * oldMinutes) - Math.max(b0, i * oldMinutes);
      if (overlap <= 0 || bucket.count === 0) return;
      sum += bucket.sum * (overlap / oldMinutes);
      weight += bucket.count * (overlap / oldMinutes);
    });
    if (weight === 0) return { sum: 0, count: 0 };
    const count = Math.max(1, Math.round(weight));
    return { sum: (sum / weight) * count, count };
  });
}

function emptyBoilerDay(now) {
  return {
    date: boilerLocalDate(now),
    buckets: Array.from({ length: BOILER_BUCKETS }, () => ({ sum: 0, count: 0 })),
  };
}

// Thermometer scale (Markus, PIXD-64): every chart row has the colour of its level, so each bar is
// a gradient from white-blue at the bottom up to its height. 40 °C (below it a shower feels cold) is
// the blue of the 40 °C tick, 60 °C (scalds within seconds) the red of the 60 °C tick; violet sits
// between, bright red above. Never green: the battery uses green for "good". The big number takes
// the colour of its value; past bars are dimmed.
const BOILER_COLOR_STOPS = [
  [25, [190, 215, 255]], // bottom row — white-blue
  [40, [40, 90, 255]], // 40 °C tick — blue
  [50, [170, 50, 220]], // violet
  [60, [230, 25, 15]], // 60 °C tick — red
  [70, [255, 70, 45]], // top row — bright red
];

// ── Heating dot (PIXD-61) ─────────────────────────────────────────────────────
// While heating, a red dot rises through the current bar at 1 row/s and ends one row above it
// ("heating past the current temperature"), holds there fading out, then restarts at the bottom.
// It is red mixed into whatever is behind it (bar or black): a sub-pixel split across the two
// rows it straddles, plus a faint tail, makes it glide even at 2 fps. Time-based, so the speed
// does not depend on the frame rate (heating_fps).
const HEAT_DOT_ROWS_PER_S = 1;
const HEAT_DOT_FADE_S = 1;
const HEAT_DOT_MIX = 0.7; // red share at full strength
const HEAT_DOT_TAIL = 0.3; // tail strength, one row below the dot
const HEAT_DOT_TOP_ROW = 8; // y33: never the digits' bottom row (y32)
const HEAT_RED = [255, 40, 25];
const HEAT_RED_PALE = [255, 150, 130]; // for orange/red bars, where red would vanish

// CIELAB (D65) of an sRGB colour, for perceptual colour distance (red on blue has similar
// luminance but is obviously visible; a luminance-only measure would call it invisible).
function _lab(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function _deltaE(a, b) {
  const [p, q] = [_lab(a), _lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function _mix(bg, fg, alpha) {
  return bg.map((v, j) => Math.round(v + (fg[j] - v) * alpha));
}

// The red the dot mixes in over this background: heating red, or pale hot red where that stands
// out more (red rows). Above the bar, on black, it is always heating red.
function _heatDotRed(bg) {
  if (bg.every((v) => v === 0)) return HEAT_RED;
  const full = (red) => _deltaE(_mix(bg, red, HEAT_DOT_MIX), bg);
  return full(HEAT_RED_PALE) > full(HEAT_RED) ? HEAT_RED_PALE : HEAT_RED;
}

const heatCycleMs = (top) => (top / HEAT_DOT_ROWS_PER_S + HEAT_DOT_FADE_S) * 1000;

// Seconds into the current cycle. A cycle keeps the top it started with, so a bar that grows or
// shrinks mid-rise never makes the dot jump backwards; the new top applies from the next cycle.
function _heatDotPhase(cycle, nowMs, top) {
  if (cycle.start === null) Object.assign(cycle, { start: nowMs, top });
  else if (nowMs - cycle.start >= heatCycleMs(cycle.top)) {
    const next = cycle.start + heatCycleMs(cycle.top);
    Object.assign(cycle, { start: nowMs - next < heatCycleMs(top) ? next : nowMs, top });
  }
  return Math.max(0, (nowMs - cycle.start) / 1000);
}

// rows: 0 = y41 (just above the baseline). The bar fills rows 0..height-1 in rowColor(row).
function drawHeatDot(d, x, baselineY, height, rowColor, cycle, nowMs) {
  const tau = _heatDotPhase(cycle, nowMs, Math.min(height, HEAT_DOT_TOP_ROW));
  const top = Math.min(cycle.top, HEAT_DOT_TOP_ROW);
  const rise = top / HEAT_DOT_ROWS_PER_S;
  const pos = tau < rise ? tau * HEAT_DOT_ROWS_PER_S : top;
  const strength = tau < rise ? 1 : Math.max(0, 1 - (tau - rise) / HEAT_DOT_FADE_S);
  const alpha = new Map();
  const add = (row, a) => {
    if (row >= 0 && a > 0) alpha.set(row, (alpha.get(row) ?? 0) + a);
  };
  // Rows below 0 are clipped one by one, so the tail slides in smoothly from under the baseline.
  const splat = (p, a) => {
    const row = Math.floor(p);
    const frac = p - row;
    add(row, a * (1 - frac));
    add(row + 1, a * frac);
  };
  splat(pos, strength);
  splat(pos - 1, strength * HEAT_DOT_TAIL);
  for (const [row, a] of alpha) {
    if (row > top || a <= 0) continue;
    const bg = row < height ? rowColor(row) : [0, 0, 0];
    d._setPixel(x, baselineY - 1 - row, ..._mix(bg, _heatDotRed(bg), Math.min(1, a) * HEAT_DOT_MIX));
  }
}

function _boilerTempColor(tempC) {
  if (tempC === null) return C.dimWhite;
  const stops = BOILER_COLOR_STOPS;
  if (tempC <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [t0, c0] = stops[i - 1];
    const [t1, c1] = stops[i];
    if (tempC <= t1) {
      const u = (tempC - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + u * (c1[j] - v)));
    }
  }
  return stops[stops.length - 1][1];
}

// Chart row k (0 = y41) shows level 25 + 5k °C: row 3 (y38) is 40 °C, row 7 (y34) is 60 °C.
const _boilerRowColor = (row) => _boilerTempColor(25 + 5 * row);

async function drawBoiler(d, cellX0, cellY0, current, buckets, nowBucket, heating = false, heatCycle = null, nowMs = Date.now()) {
  const baselineY = cellY0 + 15; // y=42; chart rows y=32..41 (5°C/px)
  const tickRowY = cellY0 + 16; // y=43
  const yTickX = cellX0 + 2; // x=46
  const curveX0 = cellX0 + 3; // x=47..62: all 16 day buckets, ending under the degree column
  const rightX = cellX0 + 19; // exclusive text anchor, same as the UV value
  const textY = cellY0 + 1; // y=28
  const dimGray = [60, 60, 60];
  const nowX = curveX0 + nowBucket;

  // Only the bottom triangle marks the current bucket. The column line home's UV chart draws
  // above it ran behind the digits and is gone (PIXD-60).

  hLine(d, yTickX, curveX0 + BOILER_BUCKETS - 1, baselineY, ...dimGray);
  // Y ticks at temperatures that mean something, in the chart's own colours for those rows:
  // 40 °C, below which a shower feels cold (blue), and 60 °C, which scalds within seconds and keeps
  // legionella down (red).
  d._setPixel(yTickX, baselineY - (40 - 20) / 5, ..._boilerTempColor(40));
  d._setPixel(yTickX, baselineY - (60 - 20) / 5, ..._boilerTempColor(60));
  // Time ticks every 6 h at the start of the bucket beginning at 00/06/12/18, and 24:00 just
  // past the last bucket: x47, 51, 55, 59, 63.
  for (let hour = 0; hour <= 24; hour += 6) {
    d._setPixel(curveX0 + (hour * 60) / BOILER_BUCKET_MIN, tickRowY, ...dimGray);
  }

  for (let i = 0; i <= nowBucket; i++) {
    const { sum, count } = buckets[i];
    const average = count > 0 ? sum / count : null;
    const value = i === nowBucket ? current ?? average : average;
    if (value === null) continue;
    const height = clamp(Math.round((value - 20) / 5), 0, 10);
    const past = i !== nowBucket;
    for (let row = 0; row < height; row++) {
      const color = _boilerRowColor(row);
      d._setPixel(curveX0 + i, baselineY - 1 - row, ...(past ? color.map((v) => Math.round(v * 0.65)) : color));
    }
    if (heating && heatCycle && !past) drawHeatDot(d, nowX, baselineY, height, _boilerRowColor, heatCycle, nowMs);
  }

  // Current-time triangle: red while the boiler is heating.
  const arrowColor = heating ? [230, 30, 20] : [200, 200, 205];
  d._setPixel(nowX, tickRowY, ...arrowColor);
  // The final bucket touches x=63: clip the arrow base to its own cell.
  hLine(d, Math.max(cellX0, nowX - 1), Math.min(cellX0 + 19, nowX + 1), cellY0 + 17, ...arrowColor);

  // Text last: full-height bars (≥ 67.5 °C) reach the digits' bottom row (y32).
  const text = current === null ? null : String(Math.round(current));
  // Like the terrace temperatures: a reading too wide to keep the x45 margin (5 glyphs) is
  // implausible, so it reads as "--" rather than spilling past the x43 separator.
  if (text === null || DEGREE_X - 1 - (text.length * 4 - 1) < cellX0 + 1) {
    await d.drawTextRgbaAligned("--", [rightX, textY], C.dimWhite, "right");
  } else {
    const color = _boilerTempColor(current);
    await d.drawTextRgbaAligned(text, [DEGREE_X - 1, textY], color, "right");
    d._setPixel(DEGREE_X, textY, ...color); // last digit x=60, gap x=61, ° x=62
  }
}

// ── Media icons ───────────────────────────────────────────────────────────────
//
// Dot: on=green, standby/off=amber, stale=gray.
// Icon body: on=green@60%, off/standby/stale=gray@60% (dot is the color signal).

const POWER_ON = [0, 200, 80];
const POWER_STANDBY = [255, 155, 0];
const MEDIA_STALE = [60, 60, 60];

function _mediaColors(isOn, stale) {
  const dot = stale ? MEDIA_STALE : isOn ? POWER_ON : POWER_STANDBY;
  const icon = (isOn && !stale ? POWER_ON : MEDIA_STALE).map((v) =>
    Math.round(v * 0.6),
  );
  return { dot, icon };
}

// Syncbox offline — red X at bottom-right of TV cell (permanent, no blink)
function drawSyncboxOffline(d) {
  const ex = COLS[1].x1 - 4; // x 38
  const ey = ROWS[2].y1 - 3; // y 60
  const [r, g, b] = C.errorRed;
  d._setPixel(ex, ey, r, g, b);
  d._setPixel(ex + 2, ey, r, g, b);
  d._setPixel(ex + 1, ey + 1, r, g, b);
  d._setPixel(ex, ey + 2, r, g, b);
  d._setPixel(ex + 2, ey + 2, r, g, b);
}

// ── Staleness / Nuki ping ──────────────────────────────────────────────────────

const STALE_MS = 5 * 60 * 1000;
const isStale = (ts, staleMs = STALE_MS) =>
  ts === null || Date.now() - ts > staleMs;

// Nuki MQTT booleans arrive as "true" / "false"; anything else leaves the last value.
function parseNukiBool(msg) {
  const text = String(msg).trim().toLowerCase();
  return text === "true" ? true : text === "false" ? false : null;
}

// ── Scene export ──────────────────────────────────────────────────────────────

export { BOILER_COLOR_STOPS, _boilerTempColor as boilerTempColor, _boilerRowColor as boilerRowColor, _heatDotRed as heatDotRed, _deltaE as deltaE, _mix as mix };

export default {
  name: "home2",
  pretty_name: "Home Dashboard 2",
  deviceType: "pixoo",

  settingsSchema: {
    bri_day: {
      type: "int",
      label: "Day Brightness",
      group: "Brightness",
      default: 100,
      min: 1,
      max: 100,
      step: 1,
    },
    bri_night: {
      type: "int",
      label: "Night Brightness",
      group: "Brightness",
      default: 7,
      min: 1,
      max: 100,
      step: 1,
    },
    sun_elev_lo: {
      type: "float",
      label: "Sun Elevation Night",
      group: "Brightness",
      default: -6,
      min: -20,
      max: 20,
      step: 0.5,
    },
    sun_elev_hi: {
      type: "float",
      label: "Sun Elevation Day",
      group: "Brightness",
      default: 10,
      min: -20,
      max: 20,
      step: 0.5,
    },
    fallback_day_start: {
      type: "time",
      label: "Fallback Day Start",
      group: "Brightness",
      default: "07:30",
    },
    fallback_night_start: {
      type: "time",
      label: "Fallback Night Start",
      group: "Brightness",
      default: "20:30",
    },
    stale_ms: {
      type: "int",
      label: "Stale Timeout (ms)",
      group: "Timing",
      default: 300000,
      min: 1000,
      max: 3600000,
      step: 1000,
    },
    heal_retry_ms: {
      type: "int",
      label: "Self-Heal Retry (ms)",
      group: "Polling",
      default: 30000,
      min: 1000,
      max: 600000,
      step: 1000,
    },
    heal_initial_delay_ms: {
      type: "int",
      label: "Self-Heal Initial Delay (ms)",
      group: "Polling",
      default: 5000,
      min: 0,
      max: 600000,
      step: 500,
    },
    ps5_on_w: {
      type: "int",
      label: "PS5 On Threshold (W)",
      group: "Thresholds",
      default: 25,
      min: 0,
      max: 500,
      step: 1,
    },
    tv_on_w: {
      type: "int",
      label: "TV On Threshold (W)",
      group: "Thresholds",
      default: 26,
      min: 0,
      max: 500,
      step: 1,
    },
    pc_on_w: {
      type: "int",
      label: "PC On Threshold (W)",
      group: "Thresholds",
      default: 10,
      min: 0,
      max: 500,
      step: 1,
    },
    boiler_heating_w: {
      type: "int",
      label: "Boiler Heating Threshold (W)",
      group: "Thresholds",
      default: 100,
      min: 0,
      max: 5000,
      step: 10,
    },
    syncbox_host: {
      type: "string",
      label: "Syncbox Host",
      group: "Sources",
      default: "192.168.1.111",
    },
    syncbox_timeout_ms: {
      type: "int",
      label: "Syncbox Timeout (ms)",
      group: "Polling",
      default: 2500,
      min: 500,
      max: 10000,
      step: 100,
    },
    syncbox_poll_ms: {
      type: "int",
      label: "Syncbox Poll (ms)",
      group: "Polling",
      default: 5000,
      min: 1000,
      max: 60000,
      step: 500,
    },
    syncbox_fresh_ms: {
      type: "int",
      label: "Syncbox Freshness (ms)",
      group: "Timing",
      default: 30000,
      min: 1000,
      max: 600000,
      step: 1000,
    },
    syncbox_input_ps5: {
      type: "string",
      label: "Syncbox Input for PS5",
      group: "Sources",
      default: "input4",
    },
    syncbox_input_pc: {
      type: "string",
      label: "Syncbox Input for PC",
      group: "Sources",
      default: "input2",
    },
    heating_fps: {
      type: "int",
      label: "Heating Animation FPS (device minFrameMs must be ≤ 1000/fps)",
      group: "Timing",
      default: 2,
      min: 2,
      max: 4,
      step: 1,
    },
    boiler_stale_ms: {
      type: "int",
      label: "Boiler Stale Timeout (ms)",
      group: "Timing",
      default: 1800000,
      min: 60000,
      max: 21600000,
      step: 60000,
    },
    temp_stale_ms: {
      type: "int",
      label: "Temperature Stale Timeout (ms)",
      group: "Timing",
      default: 5400000,
      min: 300000,
      max: 21600000,
      step: 300000,
    },
  },

  async init(context) {
    this._frame = 0;
    this._logger = context.logger;
    this._nukiImages = {
      unknown: await loadPixooImage(NUKI_IMAGE_PATHS.unknown),
      open: await loadPixooImage(NUKI_IMAGE_PATHS.open),
      closed: await loadPixooImage(NUKI_IMAGE_PATHS.closed),
      transition: await loadPixooImage(NUKI_IMAGE_PATHS.transition),
    };
    this._mediaImages = {
      ps5On: await loadPixooImage(MEDIA_IMAGE_PATHS.ps5On),
      ps5Standby: await loadPixooImage(MEDIA_IMAGE_PATHS.ps5Standby),
      tvOn: await loadPixooImage(MEDIA_IMAGE_PATHS.tvOn),
      tvStandby: await loadPixooImage(MEDIA_IMAGE_PATHS.tvStandby),
      pcOn: await loadPixooImage(MEDIA_IMAGE_PATHS.pcOn),
      pcOff: await loadPixooImage(MEDIA_IMAGE_PATHS.pcOff),
    };
    // The sliding-door and skylight PNGs are no longer loaded: TE/OL badges
    // replaced them. The asset files are kept on disk for the previous layout.

    this._cfg = this._mapSettings(context.settings.all());
    this._traceWildcard = true;
    this._unsubscribeSettings = context.settings.subscribe((values) => {
      const prev = this._cfg;
      this._cfg = this._mapSettings(values);
      if (this._bri) {
        this._bri.day = this._cfg.briDay;
        this._bri.night = this._cfg.briNight;
      }
      this._lastBriSet = 0;

      if (
        prev.syncboxHost !== this._cfg.syncboxHost ||
        prev.syncboxTimeoutMs !== this._cfg.syncboxTimeoutMs ||
        prev.syncboxPollMs !== this._cfg.syncboxPollMs
      ) {
        this._stopSyncboxPoll();
        this._startSyncboxPoll(context.logger);
      }
      if (
        this._healRunner &&
        (prev.healRetryMs !== this._cfg.healRetryMs ||
          prev.healInitialDelayMs !== this._cfg.healInitialDelayMs)
      ) {
        if (this._healTimer) clearInterval(this._healTimer);
        if (this._healTimeout) clearTimeout(this._healTimeout);
        this._healTimer = setInterval(this._healRunner, this._cfg.healRetryMs);
        this._healTimeout = setTimeout(this._healRunner, this._cfg.healInitialDelayMs);
      }
    });

    // Brightness state
    this._bri = {
      day: this._cfg.briDay,
      night: this._cfg.briNight,
      override: null,
    };
    this._lastBriSet = 0;
    this._lastBriVal = null;

    this._s = {
      // Header — funkeykid keyboard
      kbConnected: false,
      // Sun
      sunElevation: null, // float degrees, from HA MQTT
      sunAbove: null, // bool fallback (above_horizon)
      // Row 0 — contact sensors (availability-tracked)
      nukiVrState: null,
      nukiVrAlive: true, // Nuki VR (front door): MQTT connected
      nukiVrBattCritical: false,
      nukiKeState: null,
      nukiKeAlive: true, // Nuki Keller (basement): MQTT connected
      nukiKeBattCritical: false,
      terraceOpen: null,
      terraceOnline: null,
      w13Open: null,
      w13Online: null,
      w14Open: null,
      w14Online: null,
      // Row 0 — temperatures
      roofTempC: null,
      roofTempSeen: null,
      poolTempC: null,
      poolTempSeen: null,
      // Row 1 — energy
      battPct: null,
      battState: null,
      battSeen: null,
      productionW: null,
      consumptionW: null,
      energySeen: null,
      // Boiler — latest finite MQTT reading, independently freshness-tracked.
      boilerTempC: null,
      boilerTempSeen: null,
      // Boiler relay draw (W): heating while fresh and ≥ boiler_heating_w.
      boilerPowerW: null,
      boilerPowerSeen: null,
      // Row 2 — media (power in watts)
      tvPower: null,
      tvSeen: null,
      ps5Power: null,
      ps5Seen: null,
      pcPower: null,
      pcSeen: null,
      syncInput: null,
      syncSeen: null,
      syncEnabled: false,
    };

    await this._startBoilerHistory();

    const parseContact = (msg) => {
      try {
        const contact = JSON.parse(msg)?.contact;
        return typeof contact === "boolean" ? contact === false : null;
      } catch {
        return null;
      }
    };
    const parseAvailability = (msg) => {
      try {
        const state = JSON.parse(msg)?.state;
        return state === "online" ? true : state === "offline" ? false : null;
      } catch {
        return null;
      }
    };
    const parseTemperature = (msg) => {
      try {
        const t = JSON.parse(msg).temperature;
        return typeof t === "number" && Number.isFinite(t) ? t : null;
      } catch {
        return null;
      }
    };
    const parsePower = (msg) => {
      try {
        const d = JSON.parse(msg);
        return typeof d.power === "number" && Number.isFinite(d.power) ? d.power : null;
      } catch {
        return null;
      }
    };

    // Subscribe + store handler refs for self-heal re-subscription
    const _h = {};
    const sub = (topic, fn) => {
      _h[topic] = fn;
      if ((topic.includes("#") || topic.includes("+")) && context.mqtt.subscribeWildcard) {
        context.mqtt.subscribeWildcard(topic, fn);
      } else {
        context.mqtt.subscribe(topic, fn);
      }
    };

    sub("pixdcon/debug/bri_override", (msg) => {
      const s = msg.trim();
      if (s === "") {
        this._bri.override = null;
      } else {
        const v = parseInt(s, 10);
        if (!isNaN(v) && v >= 1 && v <= 100) {
          this._bri.override = v;
          this._lastBriSet = 0;
        }
      }
    });

    // ── Sun elevation (drives brightness curve) ───────────────────────────────
    sub("homeassistant/sun/sun/elevation", (msg) => {
      const v = parseFloat(msg.trim());
      if (!isNaN(v)) {
        this._s.sunElevation = v;
        this._logger.info(`[home2] sun elevation = ${v}°`);
      }
    });
    sub("homeassistant/sun/sun/state", (msg) => {
      this._s.sunAbove = msg.trim() === "above_horizon";
      this._logger.info(`[home2] sun state = ${msg.trim()}`);
    });

    const NUKI = { 1: "locked", 2: "unlocking", 3: "unlocked", 4: "locking" };
    // Each lock's own MQTT also says whether it is connected (retained; the lock's last will
    // turns it false) and whether its battery is critical. That drives the amber dot. ICMP ping
    // did before PIXD-63, but the Keller lock's Wi-Fi power-save ignores pings while connected.
    const nukiHandler = (id, key) => (msg, topic) => {
      const field = topic.slice(`nuki/${id}/`.length);
      if (field === "state") {
        this._s[`${key}State`] = NUKI[parseInt(msg.trim())] ?? null;
        return;
      }
      const flag = field === "connected" ? "Alive" : field === "batteryCritical" ? "BattCritical" : null;
      if (!flag) return;
      const value = parseNukiBool(msg);
      if (value !== null) this._s[`${key}${flag}`] = value;
    };
    sub("nuki/463F8F47/#", nukiHandler("463F8F47", "nukiVr"));
    sub("nuki/4A5D18FF/#", nukiHandler("4A5D18FF", "nukiKe"));

    sub("z2m/wz/contact/te-door/#", (msg, topic) => {
      if (topic === "z2m/wz/contact/te-door") {
        this._s.terraceOpen = parseContact(msg);
      } else if (topic === "z2m/wz/contact/te-door/availability") {
        this._s.terraceOnline = parseAvailability(msg);
      }
    });

    sub("z2m/vk/contact/w13/#", (msg, topic) => {
      if (topic === "z2m/vk/contact/w13") {
        this._s.w13Open = parseContact(msg);
      } else if (topic === "z2m/vk/contact/w13/availability") {
        this._s.w13Online = parseAvailability(msg);
      }
    });

    sub("z2m/vr/contact/w14/#", (msg, topic) => {
      if (topic === "z2m/vr/contact/w14") {
        this._s.w14Open = parseContact(msg);
      } else if (topic === "z2m/vr/contact/w14/availability") {
        this._s.w14Online = parseAvailability(msg);
      }
    });

    // Self-heal: shared MQTT client means the broker won't re-deliver retained
    // messages if another scene already holds the same subscription. Re-subscribe
    // any topic still null every 30s until healed, then stop.
    // Root cause: broker sees topic already subscribed by this client → skips
    // retained delivery. Re-subscribing forces a new retained message delivery.
    const nullChecks = [
      ["nuki/463F8F47/#", () => this._s.nukiVrState !== null],
      ["nuki/4A5D18FF/#", () => this._s.nukiKeState !== null],
      [
        "z2m/wz/contact/te-door/#",
        () => this._s.terraceOpen !== null && this._s.terraceOnline !== null,
      ],
      [
        "z2m/vk/contact/w13/#",
        () => this._s.w13Open !== null && this._s.w13Online !== null,
      ],
      [
        "z2m/vr/contact/w14/#",
        () => this._s.w14Open !== null && this._s.w14Online !== null,
      ],
    ];
    const heal = () => {
      const pending = nullChecks.filter(([, isHealed]) => !isHealed());
      if (pending.length === 0) {
        clearInterval(this._healTimer);
        this._healTimer = null;
        clearTimeout(this._healTimeout);
        this._healTimeout = null;
        context.logger.info("[home2] self-heal: all topics resolved, stopping");
        return;
      }
      for (const [topic] of pending) {
        if (_h[topic]) {
          if ((topic.includes("#") || topic.includes("+")) && context.mqtt.subscribeWildcard) {
            context.mqtt.subscribeWildcard(topic, _h[topic]);
          } else {
            context.mqtt.subscribe(topic, _h[topic]);
          }
          context.logger.info(`[home2] self-heal: re-subscribed ${topic}`);
        }
      }
    };
    this._healRunner = heal;
    this._healTimer = setInterval(heal, this._cfg.healRetryMs);
    // Also run once at 5s — catches the common fast-broker case
    this._healTimeout = setTimeout(heal, this._cfg.healInitialDelayMs);

    // Dachterrasse air temp — Hue outdoor motion sensor's temperature channel.
    // Deliberately NOT z2m/dt/temp/aqara: that one bakes in direct sun (+10 K).
    context.mqtt.subscribe("z2m/dt/motion/hueoutdoor", (msg) => {
      const v = parseTemperature(msg);
      if (v !== null) {
        this._s.roofTempC = v;
        this._s.roofTempSeen = Date.now();
      }
    });

    context.mqtt.subscribe("z2m/te/temp/pool", (msg) => {
      const v = parseTemperature(msg);
      if (v !== null) {
        this._s.poolTempC = v;
        this._s.poolTempSeen = Date.now();
      }
    });

    context.mqtt.subscribe("home/ke/sonnenbattery/status", (msg) => {
      try {
        const d = JSON.parse(msg);
        this._s.battPct = typeof d.USOC === "number" && Number.isFinite(d.USOC) ? d.USOC : null;
        this._s.battState = d.BatteryCharging
          ? "charging"
          : d.BatteryDischarging
            ? "discharging"
            : "standby";
        this._s.productionW =
          typeof d.Production_W === "number" && Number.isFinite(d.Production_W) ? d.Production_W : null;
        this._s.consumptionW =
          typeof d.Consumption_W === "number" && Number.isFinite(d.Consumption_W) ? d.Consumption_W : null;
        this._s.battSeen = Date.now();
        this._s.energySeen = Date.now();
      } catch {}
    });

    // Node-RED ("Boiler 24 [bz]") republishes this retained every 60 s. temp_c carries the
    // Shelly reading, which arrives as a numeric STRING ("52.37"); state is Node-RED's own
    // verdict on the underlying reading (ok | stale after 15 min | error), checked_at its time.
    sub("jhw2211/health/boiler", (msg) => {
      if (!this._boilerSampling) return;
      try {
        const d = JSON.parse(msg);
        if (d?.state === "stale" || d?.state === "error") {
          this._s.boilerTempSeen = null; // no current value until Node-RED reports ok again
          return;
        }
        const raw = d?.temp_c;
        const temp = typeof raw === "number" ? raw
          : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
        if (!Number.isFinite(temp)) return;
        // Freshness from when Node-RED checked (same host clock), so an old retained message
        // from a publisher that has since died does not count as fresh after a restart.
        const checkedAt = Date.parse(d?.checked_at);
        this._s.boilerTempC = temp;
        this._s.boilerTempSeen = Number.isFinite(checkedAt) ? Math.min(checkedAt, Date.now()) : Date.now();
      } catch {}
    });

    // Boiler relay (Zigbee power meter; Node-RED's state machine switches it via .../set).
    // Its measured draw, not the state machine's decision, says whether the element heats:
    // the boiler's own thermostat cuts it while the relay stays ON.
    context.mqtt.subscribe("z2m/bz/powercontrol/boiler", (msg) => {
      this._s.boilerPowerW = parsePower(msg);
      // z2m's last_seen dates the reading, so a retained ON payload from a relay that has since
      // gone quiet does not count as fresh after a restart; receipt time is the fallback.
      // z2m emits it as an ISO string or, with last_seen: epoch, as milliseconds.
      let lastSeen = NaN;
      try {
        const raw = JSON.parse(msg)?.last_seen;
        lastSeen = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
      } catch {}
      this._s.boilerPowerSeen = Number.isFinite(lastSeen) ? Math.min(lastSeen, Date.now()) : Date.now();
    });

    context.mqtt.subscribe("z2m/wz/plug/zisp08", (msg) => {
      this._s.tvPower = parsePower(msg);
      this._s.tvSeen = Date.now();
    });
    context.mqtt.subscribe("z2m/wz/plug/zisp28", (msg) => {
      this._s.ps5Power = parsePower(msg);
      this._s.ps5Seen = Date.now();
    });
    context.mqtt.subscribe("z2m/wz/plug/zisp05", (msg) => {
      this._s.pcPower = parsePower(msg);
      this._s.pcSeen = Date.now();
    });

    // funkeykid keyboard status (retained)
    sub("home/hsb1/funkeykid/keyboard-info", (msg) => {
      try {
        const d = JSON.parse(msg);
        this._s.kbConnected = !!d.connected;
      } catch {}
    });

    this._startSyncboxPoll(context.logger);
    context.logger.info("[home2] Scene initialized");
  },

  async destroy(context) {
    this._unsubscribeSettings?.();
    this._stopSyncboxPoll();
    if (this._healTimer) {
      clearInterval(this._healTimer);
      this._healTimer = null;
    }
    if (this._healTimeout) {
      clearTimeout(this._healTimeout);
      this._healTimeout = null;
    }
    context.mqtt.unsubscribeAll();
    await this._stopBoilerHistory();
    context.logger.info("[home2] Scene destroyed");
  },

  async render(device) {
    if (!this._s) return 500;
    const frameStart = Date.now();
    const heating = this._boilerHeating();
    const fps = heating ? this._cfg.heatingFps : 2;
    // _frame drives the battery sweep and the error blink. At the normal pace it advances once per
    // render, as always. While heating_fps runs faster, it advances by elapsed 500 ms steps
    // instead, so those keep their pace whatever cadence the device's minFrameMs allows.
    if (fps <= 2 || this._tickAt === undefined) {
      this._frame++;
      this._tickAt = frameStart;
    } else {
      const steps = Math.floor((frameStart - this._tickAt) / 500);
      if (steps > 0) {
        this._frame += steps;
        this._tickAt += steps * 500;
      }
    }
    if (!heating) this._heatCycle = null;
    else this._heatCycle ??= { start: null, top: 0 };
    const s = this._s;

    // ── Brightness (elevation-based smooth curve) ─────────────────────────────
    {
      const { day, night, override } = this._bri;
      let targetBri;
      if (override !== null) {
        targetBri = override;
      } else if (s.sunElevation !== null) {
        targetBri = elevToBri(
          s.sunElevation,
          night,
          day,
          this._cfg.sunElevLo,
          this._cfg.sunElevHi,
        );
      } else if (s.sunAbove !== null) {
        // elevation not yet received but state is known
        targetBri = s.sunAbove ? day : night;
      } else {
        // no MQTT from HA at all — time-based fallback
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        const { fallbackDayStartMins: dayStart, fallbackNightStartMins: nightStart } = this._cfg;
        targetBri =
          (dayStart <= nightStart
            ? mins >= dayStart && mins < nightStart
            : mins >= dayStart || mins < nightStart)
            ? day
            : night;
      }
      const briChanged = targetBri !== this._lastBriVal;
      const briHeartbeat = Date.now() - this._lastBriSet >= BRI_HEARTBEAT_MS;
      if (briChanged || briHeartbeat) {
        await device.setBrightness(targetBri);
        this._lastBriVal = targetBri;
        this._lastBriSet = Date.now();
        this._logger.info(
          `[home2] setBrightness(${targetBri}) elev=${s.sunElevation} above=${s.sunAbove}`,
        );
      }
    }

    device.clear();

    // ── Header ───────────────────────────────────────────────────────────────
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    await device.drawTextRgbaAligned("HOME", [1, 1], C.dimWhite, "left");
    await device.drawTextRgbaAligned(
      `${hh}:${mm}`,
      [63, 1],
      C.timeColor,
      "right",
    );
    // Keyboard status: 3 dots between HOME and clock
    // Connected: "..." green, Disconnected: ". ." gray (dots at x=30,33,36 omit middle)
    {
      const kbY = 3;
      if (s.kbConnected) {
        device._setPixel(30, kbY, 0, 200, 80);
        device._setPixel(33, kbY, 0, 200, 80);
        device._setPixel(36, kbY, 0, 200, 80);
      } else {
        device._setPixel(30, kbY, 60, 60, 60);
        device._setPixel(36, kbY, 60, 60, 60);
      }
    }

    drawSeparators(device);

    // ── Row 0: merged status cell (x 0..42) ──────────────────────────────────

    // NUKI — two 7×7 sprites stacked at the cell's left edge: VR (front) top,
    // Keller (basement) bottom. Positions unchanged from the 3-cell layout.
    const cx0 = COLS[0].cx;
    const nukiImage = (state) => {
      if (state === null) return this._nukiImages.unknown;
      if (state === "unlocked") return this._nukiImages.open;
      if (state === "locking" || state === "unlocking")
        return this._nukiImages.transition;
      return this._nukiImages.closed;
    };
    drawNukiIcon(
      device,
      nukiImage(s.nukiVrState),
      cx0,
      ROWS[0].y0 + 4,
      s.nukiVrAlive && !s.nukiVrBattCritical,
    );
    drawNukiIcon(
      device,
      nukiImage(s.nukiKeState),
      cx0,
      ROWS[0].y1 - 4,
      s.nukiKeAlive && !s.nukiKeBattCritical,
    );

    // TE (terrace door) and OL (Oberlichten) share a label x; the leftmost badge
    // of each row shares a second x, so the two rows read as aligned statements.
    // Rows sit centred in y8..25 (2 px top, 4 px gap, 2 px bottom), upper floor on top (PIXD-64):
    // OL (skylights) y10..14, TE (terrace) y19..23.
    await device.drawTextRgbaAligned("OL", [20, 10], C.rowText, "left");
    drawOpeningBadge(
      device,
      29,
      11,
      s.w13Open,
      s.w13Online,
      C.badgeOpen,
      C.badgeClosed,
    );
    drawOpeningBadge(
      device,
      34,
      11,
      s.w14Open,
      s.w14Online,
      C.badgeOpen,
      C.badgeClosed,
    );

    await device.drawTextRgbaAligned("TE", [20, 19], C.rowText, "left");
    drawOpeningBadge(
      device,
      29,
      20,
      s.terraceOpen,
      s.terraceOnline,
      C.badgeOpen,
      C.badgeClosed,
    );

    // Temperatures (x 44..63), level with their labels: Dachterrasse (upper terrace) beside OL,
    // pool (lower terrace) beside TE.
    await drawTempValue(
      device,
      COLS[2].x0,
      10,
      isStale(s.roofTempSeen, this._cfg.tempStaleMs) ? null : s.roofTempC,
      C.rowText,
    );
    await drawTempValue(
      device,
      COLS[2].x0,
      19,
      isStale(s.poolTempSeen, this._cfg.tempStaleMs) ? null : s.poolTempC,
      C.rowText,
    );

    // ── Row 1: Energy ────────────────────────────────────────────────────────

    await drawBattery(
      device,
      COLS[0].cx,
      ROWS[1].cy,
      s.battPct,
      s.battState ?? "standby",
      this._frame,
    );
    if (isStale(s.battSeen, this._cfg.staleMs))
      drawErrorMark(device, 0, 1, this._frame);

    await drawPvCons(
      device,
      COLS[1].cx,
      ROWS[1].cy,
      s.productionW,
      s.consumptionW,
    );
    if (isStale(s.energySeen, this._cfg.staleMs))
      drawErrorMark(device, 1, 1, this._frame);

    // Boiler cell — fixed local calendar day, 16 buckets of 90 minutes.
    this._ensureBoilerDay(now);
    const boilerCurrent = this._boilerCurrent(now.getTime());
    await drawBoiler(
      device, COLS[2].x0, ROWS[1].y0, boilerCurrent,
      this._boilerHistory.buckets, boilerBucket(now),
      heating, this._heatCycle, frameStart,
    );
    if (boilerCurrent === null) drawErrorMark(device, 2, 1, this._frame);

    // ── Row 2: Media ─────────────────────────────────────────────────────────

    // on = >threshold watts; everything else = amber (standby/off treated same)
    const ps5On = (s.ps5Power ?? 0) > this._cfg.ps5OnW;
    const tvOn = (s.tvPower ?? 0) > this._cfg.tvOnW;
    const pcOn = (s.pcPower ?? 0) > this._cfg.pcOnW;
    const ps5Stale = isStale(s.ps5Seen, this._cfg.staleMs);
    const tvStale = isStale(s.tvSeen, this._cfg.staleMs);
    const pcStale = isStale(s.pcSeen, this._cfg.staleMs);

    const cy2 = ROWS[2].cy;
    drawMediaIcon(
      device,
      ps5On ? this._mediaImages.ps5On : this._mediaImages.ps5Standby,
      COLS[0].cx,
      cy2,
    );
    drawPowerStatusDot(
      device,
      COLS[0].cx,
      cy2,
      _mediaColors(ps5On, ps5Stale).dot,
    );
    drawMediaIcon(
      device,
      tvOn ? this._mediaImages.tvOn : this._mediaImages.tvStandby,
      COLS[1].cx,
      cy2,
    );
    drawPowerStatusDot(
      device,
      COLS[1].cx,
      cy2,
      _mediaColors(tvOn, tvStale).dot,
    );
    drawPcIcon(
      device,
      pcOn ? this._mediaImages.pcOn : this._mediaImages.pcOff,
      COLS[2].cx,
      cy2,
    );
    drawPowerStatusDot(
      device,
      COLS[2].cx,
      cy2,
      _mediaColors(pcOn, pcStale).dot,
    );

    // Syncbox: online=lines, offline=red X in TV cell, not configured=nothing
    const syncOnline =
      s.syncEnabled &&
      s.syncSeen !== null &&
      Date.now() - s.syncSeen < this._cfg.syncboxFreshMs;
    if (s.syncEnabled && !syncOnline) {
      drawSyncboxOffline(device);
    } else if (syncOnline) {
      const ps5Targeted = s.syncInput === this._cfg.syncboxInputPs5;
      const pcTargeted = s.syncInput === this._cfg.syncboxInputPc;
      const ps5SyncMode = ps5Targeted
        ? s.syncActive && ps5On
          ? "active"
          : "standby"
        : "idle";
      const pcSyncMode = pcTargeted
        ? s.syncActive && pcOn
          ? "active"
          : "standby"
        : "idle";
      drawSyncboxStatusLine(device, COLS[0].cx, cy2, ps5SyncMode);
      drawSyncboxStatusLine(device, COLS[2].cx, cy2, pcSyncMode);
    }

    if (ps5Stale) drawErrorMark(device, 0, 2, this._frame);
    if (tvStale) drawErrorMark(device, 1, 2, this._frame);
    if (pcStale) drawErrorMark(device, 2, 2, this._frame);

    await device.push();
    // Not heating: unchanged 500 ms frames. Heating: aim for 1000/heating_fps from frame start;
    // the device's minFrameMs still floors the cadence.
    // Never 0: the render loop applies minFrameMs only to a positive delay.
    if (!heating) return 500;
    return Math.max(1, Math.round(1000 / fps) - (Date.now() - frameStart));
  },

  // ── Syncbox HTTP poll (self-signed cert) ──────────────────────────────────

  _startSyncboxPoll(logger) {
    const token = process.env.SYNCBOX_BEARER_TOKEN;
    if (!token) {
      logger.warn(
        "[home2] SYNCBOX_BEARER_TOKEN not set — syncbox input tracking disabled",
      );
      return;
    }
    this._s.syncEnabled = true;
    const requests = new Set();
    this._syncRequests = requests;

    const poll = () =>
      new Promise((resolve) => {
        const req = https.request(
          {
            hostname: this._cfg.syncboxHost,
            path: "/api/v1/execution/",
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
            rejectUnauthorized: false,
            timeout: this._cfg.syncboxTimeoutMs,
          },
          (res) => {
            let body = "";
            res.on("data", (c) => {
              body += c;
            });
            res.on("end", () => {
              if (this._syncRequests !== requests || res.statusCode !== 200) {
                resolve();
                return;
              }
              try {
                const d = JSON.parse(body);
                this._s.syncInput = d.hdmiSource ?? null;
                this._s.syncActive = d.syncActive === true;
                this._s.syncHdmiActive = d.hdmiActive === true;
                this._s.syncSeen = Date.now();
              } catch {}
              resolve();
            });
            res.on("error", resolve);
          },
        );
        requests.add(req);
        req.on("close", () => {
          requests.delete(req);
          resolve();
        });
        req.on("error", resolve);
        req.on("timeout", () => {
          req.destroy();
          resolve();
        });
        req.end();
      });

    const run = async () => {
      try {
        await poll();
      } catch (err) {
        logger.warn(`[home2] Syncbox poll failed: ${err.message}`);
      }
    };
    run();
    this._syncPoll = setInterval(run, this._cfg.syncboxPollMs);
    logger.info(
      `[home2] Syncbox polling started (every ${this._cfg.syncboxPollMs}ms)`,
    );
  },

  _stopSyncboxPoll() {
    if (this._syncPoll) {
      clearInterval(this._syncPoll);
      this._syncPoll = null;
    }
    const requests = this._syncRequests;
    this._syncRequests = null;
    for (const req of requests || []) req.destroy();
  },

  // ── Boiler sampling and atomic, best-effort persistence ───────────────────

  async _startBoilerHistory() {
    const now = new Date();
    this._boilerHistory = emptyBoilerDay(now);
    this._boilerBucketIndex = boilerBucket(now);
    this._boilerRevision = 0;
    this._boilerDirty = false;
    this._boilerLastSaveAt = now.getTime();
    this._boilerSave = Promise.resolve();
    this._boilerStateWarned = new Set();
    this._boilerStatePath ??= BOILER_STATE_PATH;
    try {
      const saved = JSON.parse(await fs.readFile(this._boilerStatePath, "utf8"));
      if (saved?.date === boilerLocalDate(now)) {
        const length = saved.buckets?.length;
        if (!Array.isArray(saved.buckets) ||
          (length !== BOILER_BUCKETS && length !== BOILER_LEGACY_BUCKETS) ||
          !saved.buckets.every((b) => b && Number.isFinite(b.sum) &&
            Number.isSafeInteger(b.count) && b.count >= 0 && (b.count > 0 || b.sum === 0))) {
          throw new Error("invalid boiler history");
        }
        if (length === BOILER_LEGACY_BUCKETS) {
          // Today's history from the 18 × 80-min layout: keep it, re-binned, and save the new form.
          this._boilerHistory = {
            date: saved.date,
            buckets: rebinBoilerBuckets(saved.buckets, BOILER_LEGACY_BUCKET_MIN),
          };
          this._boilerDirty = true;
          this._boilerRevision++;
        } else {
          this._boilerHistory = saved;
        }
      }
    } catch (err) {
      // No file yet (first run) is normal; anything else is worth one warning.
      if (err.code !== "ENOENT") this._warnBoilerState(err, "load");
    }
    this._ensureBoilerDay(new Date());
    this._boilerSampling = true;
    this._boilerTimer = setInterval(() => { void this._sampleBoiler(); }, BOILER_SAMPLE_MS);
  },

  _warnBoilerState(err, kind) {
    // One warning per kind (load / save) per instance, so a failed load does not hide a later write error.
    if (this._boilerStateWarned.has(kind)) return;
    this._boilerStateWarned.add(kind);
    this._logger.warn(`[home2] Boiler history ${kind} failed: ${err.message}; continuing in memory`);
  },

  _ensureBoilerDay(now) {
    if (this._boilerHistory.date === boilerLocalDate(now)) return false;
    this._boilerHistory = emptyBoilerDay(now);
    this._boilerDirty = true;
    this._boilerRevision++;
    return true;
  },

  _boilerCurrent(ms = Date.now()) {
    const { boilerTempC, boilerTempSeen } = this._s;
    return Number.isFinite(boilerTempC) && boilerTempSeen !== null &&
      ms - boilerTempSeen <= this._cfg.boilerStaleMs ? boilerTempC : null;
  },

  _boilerHeating() {
    const { boilerPowerW, boilerPowerSeen } = this._s;
    return Number.isFinite(boilerPowerW) && !isStale(boilerPowerSeen, this._cfg.staleMs) &&
      boilerPowerW >= this._cfg.boilerHeatingW;
  },

  async _sampleBoiler() {
    if (!this._boilerSampling) return;
    const now = new Date();
    const newDay = this._ensureBoilerDay(now);
    const index = boilerBucket(now);
    const bucketChanged = index !== this._boilerBucketIndex;
    this._boilerBucketIndex = index;
    const current = this._boilerCurrent(now.getTime());
    if (current !== null) {
      const bucket = this._boilerHistory.buckets[index];
      bucket.sum += current;
      bucket.count++;
      this._boilerDirty = true;
      this._boilerRevision++;
    }
    await this._saveBoilerHistory(newDay || bucketChanged);
  },

  _saveBoilerHistory(force = false) {
    // Serialize writes; snapshot inside the queue so a flush includes new samples.
    this._boilerSave = this._boilerSave.then(async () => {
      if (!force && (!this._boilerDirty || Date.now() - this._boilerLastSaveAt < BOILER_SAVE_MS)) return;
      const revision = this._boilerRevision;
      const body = JSON.stringify(this._boilerHistory);
      const tempPath = `${this._boilerStatePath}.${randomUUID()}.tmp`;
      this._boilerLastSaveAt = Date.now();
      try {
        await fs.mkdir(dirname(this._boilerStatePath), { recursive: true });
        await fs.writeFile(tempPath, body, "utf8");
        await fs.rename(tempPath, this._boilerStatePath);
        if (this._boilerRevision === revision) this._boilerDirty = false;
      } catch (err) {
        this._warnBoilerState(err, "save");
        try { await fs.unlink(tempPath); } catch {}
      }
    });
    return this._boilerSave;
  },

  async _stopBoilerHistory() {
    this._boilerSampling = false;
    if (this._boilerTimer) clearInterval(this._boilerTimer);
    this._boilerTimer = null;
    if (!this._boilerSave) return; // init failed before the history started
    await this._saveBoilerHistory(true);
  },

  _mapSettings(values) {
    const fallbackDayStart =
      values.fallback_day_start ?? DEFAULT_SETTINGS.fallbackDayStart;
    const fallbackNightStart =
      values.fallback_night_start ?? DEFAULT_SETTINGS.fallbackNightStart;
    const [dayH, dayM] = fallbackDayStart
      .split(":")
      .map((v) => parseInt(v, 10));
    const [nightH, nightM] = fallbackNightStart
      .split(":")
      .map((v) => parseInt(v, 10));
    return {
      briDay: values.bri_day ?? DEFAULT_SETTINGS.briDay,
      briNight: values.bri_night ?? DEFAULT_SETTINGS.briNight,
      sunElevLo: values.sun_elev_lo ?? DEFAULT_SETTINGS.sunElevLo,
      sunElevHi: values.sun_elev_hi ?? DEFAULT_SETTINGS.sunElevHi,
      fallbackDayStartMins: dayH * 60 + dayM,
      fallbackNightStartMins: nightH * 60 + nightM,
      staleMs: values.stale_ms ?? DEFAULT_SETTINGS.staleMs,
      healRetryMs: values.heal_retry_ms ?? DEFAULT_SETTINGS.healRetryMs,
      healInitialDelayMs:
        values.heal_initial_delay_ms ?? DEFAULT_SETTINGS.healInitialDelayMs,
      ps5OnW: values.ps5_on_w ?? DEFAULT_SETTINGS.ps5OnW,
      tvOnW: values.tv_on_w ?? DEFAULT_SETTINGS.tvOnW,
      pcOnW: values.pc_on_w ?? DEFAULT_SETTINGS.pcOnW,
      syncboxHost: values.syncbox_host ?? DEFAULT_SETTINGS.syncboxHost,
      syncboxTimeoutMs:
        values.syncbox_timeout_ms ?? DEFAULT_SETTINGS.syncboxTimeoutMs,
      syncboxPollMs: values.syncbox_poll_ms ?? DEFAULT_SETTINGS.syncboxPollMs,
      syncboxFreshMs:
        values.syncbox_fresh_ms ?? DEFAULT_SETTINGS.syncboxFreshMs,
      syncboxInputPs5:
        values.syncbox_input_ps5 ?? DEFAULT_SETTINGS.syncboxInputPs5,
      syncboxInputPc:
        values.syncbox_input_pc ?? DEFAULT_SETTINGS.syncboxInputPc,
      boilerStaleMs: values.boiler_stale_ms ?? DEFAULT_SETTINGS.boilerStaleMs,
      boilerHeatingW: values.boiler_heating_w ?? DEFAULT_SETTINGS.boilerHeatingW,
      heatingFps: values.heating_fps ?? DEFAULT_SETTINGS.heatingFps,
      tempStaleMs: values.temp_stale_ms ?? DEFAULT_SETTINGS.tempStaleMs,
    };
  },
};
