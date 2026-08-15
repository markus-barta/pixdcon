/**
 * home — Pixoo64 smart home dashboard
 *
 * 3×3 grid layout (64×64), except row 0 which is 2 cells:
 *   y 0-6:   header — HOME label + HH:MM clock
 *   y 7:     horizontal separator
 *   y 8-25:  row 0 — [Nuki VR/KE + TE terrace + OL skylights] [roof/pool temps]
 *   y 26:    horizontal separator
 *   y 27-44: row 1 — [Battery SOC] [PV↑ Cons↓] [UV index + curve]
 *   y 45:    horizontal separator
 *   y 46-63: row 2 — [PS5] [TV] [PC]  ← device icons, syncbox ring on active PS5/PC
 *
 *   x 43: vertical separator, full height
 *   x 21: vertical separator, rows 1-2 only — row 0 is one merged 43×18 cell
 *
 * Row 0 status cell (x 0-42) encoding:
 *   Nuki VR (y 9-15) and Nuki KE (y 18-24) keep their 7×7 sprites — the artwork
 *   carries lock state, plus an amber offline dot when the ping stops answering.
 *   TE (terrace) and OL (Oberlichten = skylights) are text labels at x 20, with
 *   3×3 badges left-aligned at x 29. Hue identifies the opening — green terrace,
 *   blue skylights — and fill carries state: hollow = closed, filled = open,
 *   olive + amber checker = stale/offline. Label brightness is deliberately high:
 *   the panel sits behind palladium-coated glass and C.dimWhite (80,80,80), used
 *   by the HOME label, is not readable in daylight through it.
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
 *   HTTPS https://air-quality-api.open-meteo.com/v1/air-quality  UV current + hourly (no API key)
 *     params: latitude, longitude, current=uv_index, hourly=uv_index, timezone=auto, forecast_days=1
 *     CAMS-based: cloud-aware biologically-effective UVI (vs. GFS approximation on /v1/forecast)
 *   homeassistant/weather/forecast_home/uv_index  numeric — met.no via HA. CLEAR-SKY UVI (cloud-blind,
 *     hour-granular, retained) — last-resort fallback only
 *   pixdcon/debug/uv_now_override                 number | "" (clears) — for testing
 *   pixdcon/debug/uv_hourly_override              JSON [h6..h19] | "" (clears) — for testing
 *   z2m/wz/plug/zisp08                            {power} — sony-tv
 *   z2m/wz/plug/zisp28                            {power} — PS5
 *   z2m/wz/plug/zisp05                            {power} — windows-pc
 *   HTTP https://192.168.1.111/api/v1/execution/  Hue Syncbox (SYNCBOX_BEARER_TOKEN env)
 *     hdmi.input: "input2"=PC  "input4"=PS5
 *
 * Brightness (elevation-based, smooth curve):
 *   homeassistant/sun/sun/elevation  float degrees → lerp(−6°..10°) → bri_night..bri_day
 *   homeassistant/sun/sun/state      above_horizon | below_horizon  (fallback if no elevation yet)
 *   pixdcon/<device>/home/settings/bri_day    (default 100)
 *   pixdcon/<device>/home/settings/bri_night  (default 7)
 *   pixdcon/debug/bri_override                number | "" (clears)
 *
 *   Twilight zone: elevation −6° (astro dusk) → 10° (full day), ~30–45 min natural fade.
 *   setBrightness fires on integer-level change + 5 min heartbeat.
 */

import https from "https";
import { exec } from "child_process";
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
  nukiVrIp: "192.168.1.186",
  nukiKeIp: "192.168.1.244",
  nukiPingMs: 60000,
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
  uvLat: 47.1,
  uvLon: 15.47,
  uvPollMs: 900000,
  uvTimeoutMs: 5000,
  uvStaleMs: 3600000,
  // Battery-powered Zigbee temp sensors report on change, not on a schedule —
  // the pool probe can go 30 min between publishes. 5 min would read as stale.
  tempStaleMs: 5400000,
};
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function elevToBri(elev, night, day, low = -6, high = 10) {
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
  teLabel: [90, 240, 125], // terrace — bright green
  teOutline: [26, 120, 50], // terrace closed (hollow badge)
  olLabel: [110, 185, 255], // Oberlichten — bright blue
  olOutline: [34, 88, 150], // skylight closed (hollow badge)
  tempRoof: [200, 200, 160], // Dachterrasse value + identity dot
  tempPool: [0, 190, 220], // pool value + identity dot
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
    // Offline dot: 1px right of icon edge (cx+4)
    const [dr, dg, db] = [255, 190, 40];
    d._setPixel(cx + 4, cy - 1, dr, dg, db);
    d._setPixel(cx + 4, cy, dr, dg, db);
  }
}

// ── Cell: merged door/lock status (row 0, x 0..42) ────────────────────────────

// 3×3 badge. Hue is passed in by the caller and means "which opening"; this
// function only encodes state: hollow = closed, filled = open, olive + amber
// checker = stale/offline. Stale must never look like closed — a sensor that
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

// Identity dot + value. Same kerning trick as drawKwTight: the decimal point is
// a hand-placed pixel on the baseline rather than a font glyph, so "32.3" fits
// in 13px instead of the 15px the 3×5 face would need.
async function drawTempValue(d, cellX0, y, value, color) {
  const [r, g, b] = color;
  d._setPixel(cellX0 + 1, y + 2, r, g, b); // identity dot

  const x0 = cellX0 + 3;
  if (value === null) {
    await d.drawTextRgbaAligned("--", [x0, y], C.dimWhite, "left");
    return;
  }

  const [intStr, fracStr] = value.toFixed(1).split(".");
  await d.drawTextRgbaAligned(intStr, [x0, y], color, "left");
  const dotX = x0 + intStr.length * 4 - 1 + 1; // 4n-1 glyph run, then a 1px gap
  d._setPixel(dotX, y + 4, r, g, b);
  await d.drawTextRgbaAligned(fracStr, [dotX + 2, y], color, "left");
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

// ── UV index — color bands (WHO standard) ────────────────────────────────────
//
// 0-2  Low       → green
// 3-5  Moderate  → yellow
// 6-7  High      → orange
// 8-10 Very High → red
// 11+  Extreme   → violet

const UV_BANDS = [
  [2, [40, 200, 80]],
  [5, [230, 200, 40]],
  [7, [255, 140, 0]],
  [10, [230, 40, 40]],
  [Infinity, [180, 80, 220]],
];

function uvBandColor(uvi) {
  if (uvi == null || !Number.isFinite(uvi) || uvi < 0) return C.dimWhite;
  for (const [maxV, color] of UV_BANDS) if (uvi <= maxV) return color;
  return UV_BANDS[UV_BANDS.length - 1][1];
}

// ── Cell: UV index + 14-hour forecast curve ───────────────────────────────────
//
// Layout (cell anchored at cellX0, cellY0; 20w × 18h):
//   y 28-32 (5 rows): current UV value, right-aligned, color = current uvBand
//   y 32-41 (10 rows): curve area, 1px per UVI unit (cap 11)
//   y 42:    x-axis baseline (dim gray)
//   y 43:    x-tick row (dots at 06:00, 12:00, 18:00)
//   x 46:    y-tick column (dots at UVI 0, 5, 10)
//   x 47-60: 14 hourly bars (06..19), each height = round(uvi[h]) capped at 11
//   Now markers: axis-gray bg column behind the now col (drawn first, full cell
//   height), bright-gray up-arrow at the cell bottom (y43 tip, y44 3px base)
//
// Per-hour bar at 50% RGB (cell bg is black). The "now" column draws at 100%
// using the current UVI (interpolated between CAMS hourly points, see
// uvInterpNow). Upcoming-hour bars draw their top (peak) pixel at 100% to
// highlight the forecast curve.

// ── Tight fractional UVI renderer ─────────────────────────────────────────────
//
// Same kerning idea as drawKwTight: hand-placed 1px decimal dot instead of the
// 3px-wide "." font glyph (which wastes 2 blank columns). Right-aligned so the
// value hugs the cell's right edge like the previous integer display.
// <10  → N(3) gap(1) dot(1) gap(1) F(3) = 9px   e.g. "4.3"
// ≥10  → integer via normal text ("11" — no dot needed)
// 0    → bare "0"; null → "--"

async function drawUvValueTight(d, rightX, y, uvi, color) {
  if (uvi == null || !Number.isFinite(uvi)) {
    await d.drawTextRgbaAligned("--", [rightX, y], color, "right");
    return;
  }
  if (uvi < 0.05) {
    await d.drawTextRgbaAligned("0", [rightX, y], color, "right");
    return;
  }
  if (uvi >= 9.95) {
    await d.drawTextRgbaAligned(
      String(Math.round(uvi)),
      [rightX, y],
      color,
      "right",
    );
    return;
  }
  const [intStr, fracStr] = uvi.toFixed(1).split("."); // "4.3" → "4", "3"
  const intX = rightX - 9; // int(3) gap(1) dot(1) gap(1) frac(3) ends at rightX-1
  const [r, g, b] = color;
  await d.drawTextRgbaAligned(intStr, [intX, y], color, "left");
  d._setPixel(intX + 4, y + 4, r, g, b); // dot at font baseline
  await d.drawTextRgbaAligned(fracStr, [intX + 6, y], color, "left");
}

// Linear interpolation between the two CAMS hourly points around `now`.
// hourly24 = 24 values starting 00:00 local. Returns null if unusable.
function uvInterpNow(hourly24, now) {
  if (!Array.isArray(hourly24) || hourly24.length !== 24) return null;
  const h = now.getHours();
  const v0 = Number(hourly24[h]);
  const v1 = Number(hourly24[h + 1] ?? hourly24[h]); // 23:xx → hold last hour
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return null;
  return v0 + (v1 - v0) * (now.getMinutes() / 60);
}

async function drawUv(d, cellX0, cellY0, currentUvi, hourlyUvi, nowDate) {
  const baselineY = cellY0 + 15; // y=42 — x-axis
  const tickRowY = cellY0 + 16; // y=43 — x-tick markers below axis
  const yTickX = cellX0 + 2; // x=46 — y-tick column (1px left of curve)
  const curveX0 = cellX0 + 3; // x=47 — first hour col (06:00)
  const HOURS = 14; // 06..19 inclusive (half-open up to 20)
  const TEXT_RIGHT_X = cellX0 + 19; // x=63 — cell right edge
  const TEXT_TOP_Y = cellY0 + 1; // y=28 — 1px below cell top for visual breathing room
  const dimGray = [60, 60, 60];

  // Now-col offset (round-to-nearest hour, in window iff 06:00..19:30)
  const nowH = nowDate.getHours() + nowDate.getMinutes() / 60;
  const nowColOffset = Math.round(nowH - 6);
  const nowInWindow = nowColOffset >= 0 && nowColOffset < HOURS;
  const nowX = curveX0 + nowColOffset;

  // Now-col background line — full cell height in axis gray, drawn FIRST so
  // the value text, bars, curve and now-line all paint on top of it.
  if (nowInWindow) {
    vLine(d, nowX, cellY0, cellY0 + 17, ...dimGray);
  }

  // Number (right-aligned at top-right) — tight-kerned 1 decimal below 10
  // ("4.3"), integer above ("11"), bare "0" at night to keep the cell quiet.
  const nowColor = uvBandColor(currentUvi);
  await drawUvValueTight(d, TEXT_RIGHT_X, TEXT_TOP_Y, currentUvi, nowColor);

  // X-axis baseline (full width of plot area incl. y-tick col)
  hLine(d, yTickX, curveX0 + HOURS - 1, baselineY, ...dimGray);

  // Y-axis tick column — UVI 0, 5, 10
  d._setPixel(yTickX, baselineY, ...dimGray); // already on baseline; reinforces
  d._setPixel(yTickX, baselineY - 5, ...dimGray);
  d._setPixel(yTickX, baselineY - 10, ...dimGray);

  // X-axis tick row — 06:00 (col 0), 12:00 (col 6), 18:00 (col 12)
  d._setPixel(curveX0 + 0, tickRowY, ...dimGray);
  d._setPixel(curveX0 + 6, tickRowY, ...dimGray);
  d._setPixel(curveX0 + 12, tickRowY, ...dimGray);

  // Hourly bars at 50% RGB; skip the now-col (drawn fully below).
  // Upcoming hours (i > nowColOffset) get their top pixel at 100%; the curve
  // pass at the end bridges vertical gaps between adjacent tops so the peak
  // line reads as connected instead of dotted.
  const tops = new Array(HOURS).fill(null); // per-column peak y (upcoming + now)
  if (Array.isArray(hourlyUvi) && hourlyUvi.length === HOURS) {
    for (let i = 0; i < HOURS; i++) {
      if (nowInWindow && i === nowColOffset) continue;
      const v = Number(hourlyUvi[i]);
      if (!Number.isFinite(v) || v <= 0) continue;
      const h = Math.min(11, Math.round(v));
      const [r, g, b] = uvBandColor(v);
      const x = curveX0 + i;
      const topY = baselineY - h;
      const isUpcoming = i > nowColOffset;
      const bodyTop = isUpcoming ? topY + 1 : topY;
      if (bodyTop <= baselineY - 1) {
        vLine(d, x, bodyTop, baselineY - 1, r >> 1, g >> 1, b >> 1);
      }
      if (isUpcoming) {
        d._setPixel(x, topY, r, g, b);
        tops[i] = topY;
      }
    }
  }

  // Now-line at 100% — height from live current value
  if (nowInWindow && currentUvi != null && Number.isFinite(currentUvi)) {
    const h = Math.min(11, Math.round(currentUvi));
    if (h > 0) {
      vLine(
        d,
        curveX0 + nowColOffset,
        baselineY - h,
        baselineY - 1,
        ...nowColor,
      );
      tops[nowColOffset] = baselineY - h;
    }
  }

  // Curve smoothing — a ≥2px jump between adjacent peaks leaves a vertical gap
  // that reads as a dotted line. Fill the in-between rows at 65% brightness,
  // split between the two columns (each side carries the half nearest its own
  // peak — poor-man's anti-aliasing). Connectors sit strictly between the two
  // peak pixels, so they never overwrite a 100% pixel.
  if (Array.isArray(hourlyUvi) && hourlyUvi.length === HOURS) {
    const dim65 = (c) => c.map((v) => Math.round(v * 0.65));
    const start = Math.max(0, nowInWindow ? nowColOffset : 0);
    for (let i = start; i < HOURS - 1; i++) {
      const ta = tops[i];
      const tb = tops[i + 1];
      if (ta == null || tb == null) continue;
      if (Math.abs(tb - ta) < 2) continue;
      const step = ta < tb ? 1 : -1; // walk rows from ta toward tb
      const between = [];
      for (let y = ta + step; y !== tb; y += step) between.push(y);
      const nearA = Math.floor(between.length / 2);
      const [ra, ga, ba] = dim65(uvBandColor(Number(hourlyUvi[i])));
      const [rb, gb, bb] = dim65(uvBandColor(Number(hourlyUvi[i + 1])));
      between.forEach((y, k) => {
        if (k < nearA) d._setPixel(curveX0 + i, y, ra, ga, ba);
        else d._setPixel(curveX0 + i + 1, y, rb, gb, bb);
      });
    }
  }

  // Now marker — small up-arrow at the very bottom of the cell (rows y43-44),
  // pointing at the now column: 3px base + 1 centered tip, bright mid-gray.
  if (nowInWindow) {
    const arrowGray = [200, 200, 205];
    d._setPixel(nowX, cellY0 + 16, ...arrowGray); // tip (overwrites tick row)
    hLine(d, nowX - 1, nowX + 1, cellY0 + 17, ...arrowGray); // base
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

// Syncbox line — 3px hLine below power dot. Active+syncing=blue, otherwise white.
// Only drawn when syncbox is known-online; TV col has no line.
function drawSyncboxLine(d, cx, dotY, isSyncing) {
  const [r, g, b] = isSyncing ? [60, 140, 255] : [235, 235, 235];
  hLine(d, cx - 1, cx + 1, dotY + 2, r, g, b);
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

// TV monitor: 15×9 wall-mounted (cx±7, cy-4..cy+4) — no stand
function drawTV(d, cx, cy, isOn, stale) {
  const {
    icon: [r, g, b],
    dot: [dr, dg, db],
  } = _mediaColors(isOn, stale);
  hLine(d, cx - 7, cx + 7, cy - 4, r, g, b);
  hLine(d, cx - 7, cx + 7, cy + 4, r, g, b);
  vLine(d, cx - 7, cy - 4, cy + 4, r, g, b);
  vLine(d, cx + 7, cy - 4, cy + 4, r, g, b);
  d._setPixel(cx, cy + 6, dr, dg, db); // power dot (full brightness)
}

// PS5 controller: 7×5 body (cx±3, cy±2) + grips (cx±4, cy+1..2) + touchpad dot
function drawPS5(d, cx, cy, isOn, stale) {
  const {
    icon: [r, g, b],
    dot: [dr, dg, db],
  } = _mediaColors(isOn, stale);
  hLine(d, cx - 3, cx + 3, cy - 2, r, g, b);
  hLine(d, cx - 3, cx + 3, cy + 2, r, g, b);
  vLine(d, cx - 3, cy - 2, cy + 2, r, g, b);
  vLine(d, cx + 3, cy - 2, cy + 2, r, g, b);
  d._setPixel(cx - 4, cy + 1, r, g, b);
  d._setPixel(cx - 4, cy + 2, r, g, b);
  d._setPixel(cx + 4, cy + 1, r, g, b);
  d._setPixel(cx + 4, cy + 2, r, g, b);
  d._setPixel(cx, cy, r, g, b); // touchpad dot
  d._setPixel(cx, cy + 6, dr, dg, db); // power dot (full brightness)
}

// PC tower: 5×8 outline (cx±2, cy-4..cy+3) + disk slot line
function drawPC(d, cx, cy, isOn, stale) {
  const {
    icon: [r, g, b],
    dot: [dr, dg, db],
  } = _mediaColors(isOn, stale);
  hLine(d, cx - 2, cx + 2, cy - 4, r, g, b);
  hLine(d, cx - 2, cx + 2, cy + 3, r, g, b);
  vLine(d, cx - 2, cy - 4, cy + 3, r, g, b);
  vLine(d, cx + 2, cy - 4, cy + 3, r, g, b);
  hLine(d, cx - 1, cx + 1, cy - 1, r, g, b); // disk slot detail
  d._setPixel(cx, cy + 6, dr, dg, db); // power dot (full brightness)
}

// ── Staleness / Nuki ping ──────────────────────────────────────────────────────

const STALE_MS = 5 * 60 * 1000;
const isStale = (ts, staleMs = STALE_MS) =>
  ts === null || Date.now() - ts > staleMs;

function pingHost(ip) {
  return new Promise((resolve) => {
    const cmd =
      process.platform === "darwin"
        ? `ping -c 1 -W 2000 ${ip}`
        : `ping -c 1 -W 2 ${ip}`;
    exec(cmd, { timeout: 4000 }, (err) => resolve(!err));
  });
}

// ── Scene export ──────────────────────────────────────────────────────────────

export default {
  name: "home_v2",
  pretty_name: "Home Dashboard v2 (merged row 0)",
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
    nuki_vr_ip: {
      type: "string",
      label: "Nuki VR IP",
      group: "Sources",
      default: "192.168.1.186",
    },
    nuki_ke_ip: {
      type: "string",
      label: "Nuki Keller IP",
      group: "Sources",
      default: "192.168.1.244",
    },
    nuki_ping_ms: {
      type: "int",
      label: "Nuki Ping Poll (ms)",
      group: "Polling",
      default: 60000,
      min: 1000,
      max: 600000,
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
    uv_lat: {
      type: "float",
      label: "UV Latitude",
      group: "Sources",
      default: 47.1,
      min: -90,
      max: 90,
      step: 0.01,
    },
    uv_lon: {
      type: "float",
      label: "UV Longitude",
      group: "Sources",
      default: 15.47,
      min: -180,
      max: 180,
      step: 0.01,
    },
    uv_poll_ms: {
      type: "int",
      label: "UV Poll (ms)",
      group: "Polling",
      default: 900000,
      min: 60000,
      max: 21600000,
      step: 60000,
    },
    uv_timeout_ms: {
      type: "int",
      label: "UV Timeout (ms)",
      group: "Polling",
      default: 5000,
      min: 1000,
      max: 30000,
      step: 500,
    },
    uv_stale_ms: {
      type: "int",
      label: "UV Stale Timeout (ms)",
      group: "Timing",
      default: 3600000,
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
        prev.nukiPingMs !== this._cfg.nukiPingMs ||
        prev.nukiVrIp !== this._cfg.nukiVrIp ||
        prev.nukiKeIp !== this._cfg.nukiKeIp
      ) {
        this._restartNukiPolls();
      }
      if (
        prev.syncboxHost !== this._cfg.syncboxHost ||
        prev.syncboxTimeoutMs !== this._cfg.syncboxTimeoutMs ||
        prev.syncboxPollMs !== this._cfg.syncboxPollMs
      ) {
        this._stopSyncboxPoll();
        this._startSyncboxPoll(context.logger);
      }
      if (
        prev.uvLat !== this._cfg.uvLat ||
        prev.uvLon !== this._cfg.uvLon ||
        prev.uvPollMs !== this._cfg.uvPollMs ||
        prev.uvTimeoutMs !== this._cfg.uvTimeoutMs
      ) {
        this._stopUvPoll();
        this._startUvPoll(context.logger);
      }
      if (
        this._healRunner &&
        (prev.healRetryMs !== this._cfg.healRetryMs ||
          prev.healInitialDelayMs !== this._cfg.healInitialDelayMs)
      ) {
        if (this._healTimer) clearInterval(this._healTimer);
        this._healTimer = setInterval(this._healRunner, this._cfg.healRetryMs);
        setTimeout(this._healRunner, this._cfg.healInitialDelayMs);
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
      nukiVrAlive: true, // Nuki VR (front door)
      nukiKeState: null,
      nukiKeAlive: true, // Nuki Keller (basement)
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
      // UV — CAMS via Open-Meteo air-quality API (current + hourly);
      // met.no MQTT kept as last-resort fallback (clear-sky, cloud-blind)
      uvCurrentMqtt: null,
      uvCurrentApi: null,
      uvHourly: null, // length-14 array for hours 06..19 (display bars)
      uvHourly24: null, // full 24h array for now-interpolation
      uvSeen: null,
      uvCurrentOverride: null,
      uvHourlyOverride: null,
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

    const parseContact = (msg) => {
      try {
        return JSON.parse(msg).contact === false;
      } catch {
        return null;
      }
    };
    const parseAvailability = (msg) => {
      try {
        return JSON.parse(msg).state === "online";
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
        return typeof d.power === "number" ? d.power : null;
      } catch {
        return null;
      }
    };

    // Subscribe + store handler refs for self-heal re-subscription
    const _h = {};
    const sub = (topic, fn) => {
      _h[topic] = fn;
      if (topic.includes("#") || topic.includes("+")) {
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
        this._logger.info(`[home] sun elevation = ${v}°`);
      }
    });
    sub("homeassistant/sun/sun/state", (msg) => {
      this._s.sunAbove = msg.trim() === "above_horizon";
      this._logger.info(`[home] sun state = ${msg.trim()}`);
    });

    const NUKI = { 1: "locked", 2: "unlocking", 3: "unlocked", 4: "locking" };
    sub("nuki/463F8F47/#", (msg, topic) => {
      if (topic !== "nuki/463F8F47/state") return;
      this._s.nukiVrState = NUKI[parseInt(msg.trim())] ?? null;
    });
    sub("nuki/4A5D18FF/#", (msg, topic) => {
      if (topic !== "nuki/4A5D18FF/state") return;
      this._s.nukiKeState = NUKI[parseInt(msg.trim())] ?? null;
    });

    // Nuki stale detection via IP ping (devices only publish on state change)
    this._restartNukiPolls();

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
        context.logger.info("[home] self-heal: all topics resolved, stopping");
        return;
      }
      for (const [topic] of pending) {
        if (_h[topic]) {
          if (topic.includes("#") || topic.includes("+")) {
            context.mqtt.subscribeWildcard(topic, _h[topic]);
          } else {
            context.mqtt.subscribe(topic, _h[topic]);
          }
          context.logger.info(`[home] self-heal: re-subscribed ${topic}`);
        }
      }
    };
    this._healRunner = heal;
    this._healTimer = setInterval(heal, this._cfg.healRetryMs);
    // Also run once at 5s — catches the common fast-broker case
    setTimeout(heal, this._cfg.healInitialDelayMs);

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
        this._s.battPct = typeof d.USOC === "number" ? d.USOC : null;
        this._s.battState = d.BatteryCharging
          ? "charging"
          : d.BatteryDischarging
            ? "discharging"
            : "standby";
        this._s.productionW =
          typeof d.Production_W === "number" ? d.Production_W : null;
        this._s.consumptionW =
          typeof d.Consumption_W === "number" ? d.Consumption_W : null;
        this._s.battSeen = Date.now();
        this._s.energySeen = Date.now();
      } catch {}
    });

    // UV current — met.no via HA. CLEAR-SKY value (over-reads under clouds) at
    // hour granularity; kept only as last-resort fallback when CAMS is down.
    context.mqtt.subscribe(
      "homeassistant/weather/forecast_home/uv_index",
      (msg) => {
        const v = parseFloat(msg.trim());
        if (!isNaN(v)) {
          this._s.uvCurrentMqtt = v;
          this._s.uvSeen = Date.now();
        }
      },
    );

    // UV debug overrides — for testing without waiting for nature
    sub("pixdcon/debug/uv_now_override", (msg) => {
      const t = msg.trim();
      if (t === "") {
        this._s.uvCurrentOverride = null;
      } else {
        const v = parseFloat(t);
        if (!isNaN(v)) this._s.uvCurrentOverride = v;
      }
    });
    sub("pixdcon/debug/uv_hourly_override", (msg) => {
      const t = msg.trim();
      if (t === "") {
        this._s.uvHourlyOverride = null;
      } else {
        try {
          const arr = JSON.parse(t);
          if (Array.isArray(arr) && arr.length === 14) {
            this._s.uvHourlyOverride = arr.map(Number);
          }
        } catch {}
      }
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
    this._startUvPoll(context.logger);
    context.logger.info("[home] Scene initialized");
  },

  async destroy(context) {
    this._unsubscribeSettings?.();
    this._stopSyncboxPoll();
    this._stopUvPoll();
    if (this._nukiVrPoll) {
      clearInterval(this._nukiVrPoll);
      this._nukiVrPoll = null;
    }
    if (this._nukiKePoll) {
      clearInterval(this._nukiKePoll);
      this._nukiKePoll = null;
    }
    if (this._healTimer) {
      clearInterval(this._healTimer);
      this._healTimer = null;
    }
    context.mqtt.unsubscribeAll();
    context.logger.info("[home] Scene destroyed");
  },

  async render(device) {
    if (!this._s) return 500;
    this._frame++;
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
        targetBri =
          mins >= this._cfg.fallbackDayStartMins &&
          mins < this._cfg.fallbackNightStartMins
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
          `[home] setBrightness(${targetBri}) elev=${s.sunElevation} above=${s.sunAbove}`,
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
      s.nukiVrAlive,
    );
    drawNukiIcon(
      device,
      nukiImage(s.nukiKeState),
      cx0,
      ROWS[0].y1 - 4,
      s.nukiKeAlive,
    );

    // TE (terrace door) and OL (Oberlichten) share a label x; the leftmost badge
    // of each row shares a second x, so the two rows read as aligned statements.
    await device.drawTextRgbaAligned("TE", [20, 9], C.teLabel, "left");
    drawOpeningBadge(
      device,
      29,
      10,
      s.terraceOpen,
      s.terraceOnline,
      C.teLabel,
      C.teOutline,
    );

    await device.drawTextRgbaAligned("OL", [20, 19], C.olLabel, "left");
    drawOpeningBadge(
      device,
      29,
      20,
      s.w13Open,
      s.w13Online,
      C.olLabel,
      C.olOutline,
    );
    drawOpeningBadge(
      device,
      34,
      20,
      s.w14Open,
      s.w14Online,
      C.olLabel,
      C.olOutline,
    );

    // Temperatures (x 44..63): Dachterrasse above, pool water below.
    await drawTempValue(
      device,
      COLS[2].x0,
      9,
      isStale(s.roofTempSeen, this._cfg.tempStaleMs) ? null : s.roofTempC,
      C.tempRoof,
    );
    await drawTempValue(
      device,
      COLS[2].x0,
      18,
      isStale(s.poolTempSeen, this._cfg.tempStaleMs) ? null : s.poolTempC,
      C.tempPool,
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

    // UV cell — anchored at cell top-left (COLS[2].x0=44, ROWS[1].y0=27)
    // Current-value priority: debug override → interpolated CAMS hourly
    // (smooth, updates every render) → CAMS current (hour-step) → met.no
    // MQTT (clear-sky, last resort).
    const uvNow = new Date();
    const uvCurrent =
      s.uvCurrentOverride ??
      uvInterpNow(s.uvHourly24, uvNow) ??
      s.uvCurrentApi ??
      s.uvCurrentMqtt;
    const uvHourly = s.uvHourlyOverride ?? s.uvHourly;
    await drawUv(device, COLS[2].x0, ROWS[1].y0, uvCurrent, uvHourly, uvNow);
    if (isStale(s.uvSeen, this._cfg.uvStaleMs))
      drawErrorMark(device, 2, 1, this._frame);

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
    return 500;
  },

  // ── Syncbox HTTP poll (self-signed cert) ──────────────────────────────────

  _startSyncboxPoll(logger) {
    const token = process.env.SYNCBOX_BEARER_TOKEN;
    if (!token) {
      logger.warn(
        "[home] SYNCBOX_BEARER_TOKEN not set — syncbox input tracking disabled",
      );
      return;
    }
    this._s.syncEnabled = true;

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
              try {
                const d = JSON.parse(body);
                this._s.syncInput = d.hdmiSource ?? null;
                this._s.syncActive = d.syncActive === true;
                this._s.syncHdmiActive = d.hdmiActive === true;
                this._s.syncSeen = Date.now();
              } catch {}
              resolve();
            });
          },
        );
        req.on("error", resolve);
        req.on("timeout", () => {
          req.destroy();
          resolve();
        });
        req.end();
      });

    const run = async () => {
      await poll();
    };
    run();
    this._syncPoll = setInterval(run, this._cfg.syncboxPollMs);
    logger.info(
      `[home] Syncbox polling started (every ${this._cfg.syncboxPollMs}ms)`,
    );
  },

  _stopSyncboxPoll() {
    if (this._syncPoll) {
      clearInterval(this._syncPoll);
      this._syncPoll = null;
    }
  },

  // ── Open-Meteo air-quality UV poll (CAMS, no API key, free) ───────────────
  // CAMS computes biologically-effective UVI including cloud cover — unlike
  // met.no (clear-sky only) and the /v1/forecast endpoint (GFS approximation).
  // Sets uvCurrentApi (current.uv_index), uvHourly24 (full day, for the
  // interpolated "now" value) and uvHourly (slice 06..19 for the bars).

  _startUvPoll(logger) {
    const poll = () =>
      new Promise((resolve) => {
        const lat = this._cfg.uvLat;
        const lon = this._cfg.uvLon;
        const path =
          `/v1/air-quality?latitude=${lat}&longitude=${lon}` +
          `&current=uv_index&hourly=uv_index&timezone=auto&forecast_days=1`;
        const req = https.request(
          {
            hostname: "air-quality-api.open-meteo.com",
            path,
            method: "GET",
            timeout: this._cfg.uvTimeoutMs,
          },
          (res) => {
            let body = "";
            res.on("data", (c) => {
              body += c;
            });
            res.on("end", () => {
              try {
                const d = JSON.parse(body);
                const cur = d?.current?.uv_index;
                const hourly = d?.hourly?.uv_index;
                if (typeof cur === "number") this._s.uvCurrentApi = cur;
                if (Array.isArray(hourly) && hourly.length >= 20) {
                  // 24 hourly entries starting at 00:00 local (timezone=auto).
                  this._s.uvHourly24 = hourly
                    .slice(0, 24)
                    .map((v) => (typeof v === "number" ? v : 0));
                  // Display bars: hours 06..19 inclusive (14 entries).
                  this._s.uvHourly = this._s.uvHourly24.slice(6, 20);
                }
                this._s.uvSeen = Date.now();
              } catch {}
              resolve();
            });
          },
        );
        req.on("error", resolve);
        req.on("timeout", () => {
          req.destroy();
          resolve();
        });
        req.end();
      });

    const run = async () => {
      await poll();
    };
    run();
    this._uvPoll = setInterval(run, this._cfg.uvPollMs);
    logger.info(
      `[home] UV polling started (every ${this._cfg.uvPollMs}ms, lat=${this._cfg.uvLat} lon=${this._cfg.uvLon})`,
    );
  },

  _stopUvPoll() {
    if (this._uvPoll) {
      clearInterval(this._uvPoll);
      this._uvPoll = null;
    }
  },

  _restartNukiPolls() {
    if (this._nukiVrPoll) clearInterval(this._nukiVrPoll);
    if (this._nukiKePoll) clearInterval(this._nukiKePoll);

    const vrPoll = async () => {
      this._s.nukiVrAlive = await pingHost(this._cfg.nukiVrIp);
    };
    const kePoll = async () => {
      this._s.nukiKeAlive = await pingHost(this._cfg.nukiKeIp);
    };
    vrPoll();
    kePoll();
    this._nukiVrPoll = setInterval(vrPoll, this._cfg.nukiPingMs);
    this._nukiKePoll = setInterval(kePoll, this._cfg.nukiPingMs);
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
      nukiVrIp: values.nuki_vr_ip ?? DEFAULT_SETTINGS.nukiVrIp,
      nukiKeIp: values.nuki_ke_ip ?? DEFAULT_SETTINGS.nukiKeIp,
      nukiPingMs: values.nuki_ping_ms ?? DEFAULT_SETTINGS.nukiPingMs,
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
      uvLat: values.uv_lat ?? DEFAULT_SETTINGS.uvLat,
      uvLon: values.uv_lon ?? DEFAULT_SETTINGS.uvLon,
      uvPollMs: values.uv_poll_ms ?? DEFAULT_SETTINGS.uvPollMs,
      uvTimeoutMs: values.uv_timeout_ms ?? DEFAULT_SETTINGS.uvTimeoutMs,
      uvStaleMs: values.uv_stale_ms ?? DEFAULT_SETTINGS.uvStaleMs,
      tempStaleMs: values.temp_stale_ms ?? DEFAULT_SETTINGS.tempStaleMs,
    };
  },
};
