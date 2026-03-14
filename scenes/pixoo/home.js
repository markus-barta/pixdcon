/**
 * home — Pixoo64 smart home dashboard
 *
 * 3×3 grid layout (64×64):
 *   y 0-6:   header — HOME label + HH:MM clock
 *   y 7:     horizontal separator
 *   y 8-25:  row 0 — [Nuki lock] [Terrace sliding door] [W13+W14 skylights]
 *   y 26:    horizontal separator
 *   y 27-44: row 1 — [Battery SOC] [PV↑ Cons↓] [Boiler °C]
 *   y 45:    horizontal separator
 *   y 46-63: row 2 — [PS5] [TV] [PC]  ← device icons, syncbox ring on active PS5/PC
 *
 *   x 21, x 43: vertical separators
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
 *   home/ke/sonnenbattery/status                  {USOC, BatteryCharging, BatteryDischarging, Production_W, Consumption_W}
 *   jhw2211/health/boiler                         {state, temp_c}
 *   z2m/wz/plug/zisp08                            {power} — sony-tv
 *   z2m/wz/plug/zisp28                            {power} — PS5
 *   z2m/wz/plug/zisp05                            {power} — windows-pc
 *   HTTP https://192.168.1.111/api/v1/execution/  Hue Syncbox (SYNCBOX_BEARER_TOKEN env)
 *     hdmi.input: "input2"=PC  "input4"=PS5
 *
 * Brightness (elevation-based, smooth curve):
 *   homeassistant/sun/sun/elevation  float degrees → lerp(−6°..10°) → bri_night..bri_day
 *   homeassistant/sun/sun/state      above_horizon | below_horizon  (fallback if no elevation yet)
 *   pidicon-light/<device>/home/settings/bri_day    (default 100)
 *   pidicon-light/<device>/home/settings/bri_night  (default 7)
 *   pidicon-light/debug/bri_override                number | "" (clears)
 *
 *   Twilight zone: elevation −6° (astro dusk) → 10° (full day), ~30–45 min natural fade.
 *   setBrightness fires on integer-level change + 5 min heartbeat.
 */

import https from "https";
import { exec } from "child_process";

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
  skyFill: [120, 15, 15], // medium-dark red glass (closed skylight)
  skyFillOpen: [30, 160, 50], // bright green glass (open skylight)
  skyShadow: [40, 40, 38], // gray shadow row (tilt 3D effect)
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
const V_SEP = [21, 43];
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
  for (const x of V_SEP) vLine(d, x, 8, 63, sr, sg, sb);
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

// ── Icon: Nuki circle ─────────────────────────────────────────────────────────
//
// Layers (back→front):
//   Filled gray disk r=4       — lock body, always full circle
//     Cardinal edge pixels (±4,0)(0,±4) overdrawn at 50% → soft AA edge
//   5×5 colored ring + center  — LED indicator on lock face
//     Locked/trans/unknown → full ring. Unlocked → bottom arc only (dy >= 0).
//   Offline dot             — separate 2px amber marker to the right when ping fails

function drawNukiCircle(d, cx, cy, nukiState, alive) {
  const isOpen = nukiState === "unlocked";
  const isTrans = nukiState === "locking" || nukiState === "unlocking";
  const unknown = nukiState === null;
  const [r, g, b] = unknown
    ? C.unknown
    : isTrans
      ? C.trans
      : isOpen
        ? C.open
        : C.closed;

  // Gray disk r=4 — always full (lock body never clips)
  for (let dx = -4; dx <= 4; dx++)
    for (let dy = -4; dy <= 4; dy++)
      if (dx * dx + dy * dy <= 16) d._setPixel(cx + dx, cy + dy, 40, 40, 40);

  // Antialias: soften the 4 cardinal spike pixels at exact r=4
  for (const [dx, dy] of [
    [4, 0],
    [-4, 0],
    [0, 4],
    [0, -4],
  ])
    d._setPixel(cx + dx, cy + dy, 20, 20, 20);

  // 5×5 colored ring; open = bottom arc only (dy >= 0), else full ring
  const minDy = isOpen && !unknown ? 0 : -2;
  for (const [dx, dy, op] of [
    // corners (±2,±2) at 40%
    [-2, -2, 0.4],
    [2, -2, 0.4],
    [-2, 2, 0.4],
    [2, 2, 0.4],
    // edge mids (±2,0)(0,±2) at 100%
    [-2, 0, 1.0],
    [2, 0, 1.0],
    [0, -2, 1.0],
    [0, 2, 1.0],
    // inner diagonals (±1,±2)(±2,±1) at 70%
    [-1, -2, 0.7],
    [1, -2, 0.7],
    [-1, 2, 0.7],
    [1, 2, 0.7],
    [-2, -1, 0.7],
    [2, -1, 0.7],
    [-2, 1, 0.7],
    [2, 1, 0.7],
  ]) {
    if (dy >= minDy)
      d._setPixel(cx + dx, cy + dy, (r * op) | 0, (g * op) | 0, (b * op) | 0);
  }

  // Center fill at 33%
  d._setPixel(cx, cy, (r * 0.33) | 0, (g * 0.33) | 0, (b * 0.33) | 0);

  if (!alive) {
    const [dr, dg, db] = [255, 190, 40];
    d._setPixel(cx + 5, cy - 1, dr, dg, db);
    d._setPixel(cx + 5, cy, dr, dg, db);
  }
}

// ── Icon: Dual sliding glass terrace door ─────────────────────────────────────
//
// 12×9px total (cx±5, cy-4..cy+4). Two sliding panels inside outer frame.
// Frame: mid-gray. Fill: very dark red (closed) / very dark green (open).
// Handles: brighter warm pixel at vertical midpoint, inner edge of each panel.
// Closed: panels meet at center seam; handles face inward.
// Open:   panels slid to outer edges; center area shows fill gap.

function drawSlidingDoor(d, cx, cy, isOpen) {
  const x0 = cx - 5;
  const y0 = cy - 4;
  const W = 10; // inner width (x0..x0+W = 11px total incl. both side frames)
  const H = 8; // inner height
  const [fr, fg, fb] = C.frameGray;
  const [dr, dg, db] = isOpen ? C.doorFillOpen : C.doorFill;
  const [hr, hg, hb] = isOpen ? C.skyFillOpen : C.skyFill; // green=open, red=closed

  // Outer frame
  hLine(d, x0, x0 + W, y0, fr, fg, fb);
  hLine(d, x0, x0 + W, y0 + H, fr, fg, fb);
  vLine(d, x0, y0, y0 + H, fr, fg, fb);
  vLine(d, x0 + W, y0, y0 + H, fr, fg, fb);

  if (!isOpen) {
    // Center seam (two adjacent lines)
    vLine(d, cx - 1, y0, y0 + H, fr, fg, fb);
    vLine(d, cx, y0, y0 + H, fr, fg, fb);
    // Dark fill in each panel
    fillRect(d, x0 + 1, y0 + 1, 4, H - 1, dr, dg, db); // left panel
    fillRect(d, cx + 1, y0 + 1, 4, H - 1, dr, dg, db); // right panel
    // Handles: inner edge of each panel, vertical center
    d._setPixel(cx - 1, cy, hr, hg, hb); // left handle (+1px right per design)
    d._setPixel(cx + 1, cy, hr, hg, hb); // right handle
  } else {
    // Panels slid out; inner edges close to outer frame
    vLine(d, x0 + 3, y0, y0 + H, fr, fg, fb); // left panel inner edge
    vLine(d, x0 + W - 3, y0, y0 + H, fr, fg, fb); // right panel inner edge
    // Thin fill strips at outer edges
    fillRect(d, x0 + 1, y0 + 1, 2, H - 1, dr, dg, db); // left strip
    fillRect(d, x0 + W - 2, y0 + 1, 2, H - 1, dr, dg, db); // right strip
    // Open center area slightly lighter
    fillRect(d, x0 + 4, y0 + 1, W - 7, H - 1, dr, dg, db);
    // Handles: now face outward (inner edge of each slid panel)
    d._setPixel(x0 + 3, cy, hr, hg, hb);
    d._setPixel(x0 + W - 3, cy, hr, hg, hb);
  }
}

// ── Icon: Side-by-side skylights (W13 left, W14 right) ───────────────────────
//
// Each tile: 4×6px outer (3×4 inner fill). 1px gap between tiles.
// Frame: mid-gray outline. Fill: dark red (closed) / bright green (open).
// Open state: panel height reduced by 1px (tilts up), gray shadow row at bottom.
// Unknown: fill uses C.unknown color.
//
// Layout centered at (cx, cy):
//   W13: x = cx-5..cx-1   W14: x = cx+1..cx+5
//   y   = cy-3..cy+2  (6px tall closed, 5px panel + 1px shadow when open)

function drawSideBySideSkylights(d, cx, cy, leftOpen, rightOpen) {
  // Tile x offsets: left tile starts at cx-5, right tile at cx+1
  const tiles = [
    { x0: cx - 5, state: leftOpen },
    { x0: cx + 1, state: rightOpen },
  ];
  const y0 = cy - 3; // top of tile
  const TW = 4; // tile outer width  (0..3 → 4px)
  const TH = 6; // tile outer height (0..5 → 6px)
  const [fr, fg, fb] = C.frameGray;
  const [sr, sg, sb] = C.skyShadow;

  for (const { x0, state } of tiles) {
    const isOpen = state === true;
    const isUnknown = state === null;
    const [ir, ig, ib] = isUnknown
      ? C.unknown
      : isOpen
        ? C.skyFillOpen
        : C.skyFill;

    if (!isOpen) {
      // Full 4×6 tile
      hLine(d, x0, x0 + TW - 1, y0, fr, fg, fb); // top
      hLine(d, x0, x0 + TW - 1, y0 + TH - 1, fr, fg, fb); // bottom
      vLine(d, x0, y0, y0 + TH - 1, fr, fg, fb); // left
      vLine(d, x0 + TW - 1, y0, y0 + TH - 1, fr, fg, fb); // right
      // Fill inner 2×4
      fillRect(d, x0 + 1, y0 + 1, TW - 2, TH - 2, ir, ig, ib);
    } else {
      // Panel is 1px shorter (tilted open) — 4×5, shadow row at bottom
      const ph = TH - 1; // panel height = 5
      hLine(d, x0, x0 + TW - 1, y0, fr, fg, fb); // top
      hLine(d, x0, x0 + TW - 1, y0 + ph - 1, fr, fg, fb); // bottom of panel
      vLine(d, x0, y0, y0 + ph - 1, fr, fg, fb); // left
      vLine(d, x0 + TW - 1, y0, y0 + ph - 1, fr, fg, fb); // right
      // Fill inner 2×3
      fillRect(d, x0 + 1, y0 + 1, TW - 2, ph - 2, ir, ig, ib);
      // Shadow row (3D tilt effect) — where bottom frame was
      hLine(d, x0 + 1, x0 + TW - 2, y0 + TH - 1, sr, sg, sb);
    }
  }
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

  const BORDER = [35, 35, 35];
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

  // Discharge animation: bright pixel right→left through filled inner area
  if (isDischarging && filledPx > 1) {
    const phase = Math.floor(frame / 2) % filledPx;
    const drainX = fillX0 + filledPx - 1 - phase;
    const base = _gradientColor(drainX - fillX0, INNER);
    const [hr, hg, hb] = base.map((v) => Math.min(255, (v * 1.7) | 0));
    vLine(d, drainX, barY + 1, barY + BAR_H - 2, hr, hg, hb);
  }

  // Nub on right: 2px tall, centered (rows 2+3 of 0-indexed 0..5)
  const nubColor =
    filledPx >= INNER
      ? _gradientColor(INNER - 1, INNER).map((v) => Math.round(v * dim))
      : BORDER;
  d._setPixel(x0 + BAR_W, barY + 2, ...nubColor);
  d._setPixel(x0 + BAR_W, barY + 3, ...nubColor);

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

// ── Arrow glyphs (4px each, 3px wide) ────────────────────────────────────────
//
// Up  (top-aligned):   . X .    row y
//                      X X X    row y+1
// Down (bot-aligned):  X X X    row y+3
//                      . X .    row y+4

function drawUpArrow(d, x0, y, r, g, b) {
  d._setPixel(x0 + 1, y, r, g, b);
  d._setPixel(x0, y + 1, r, g, b);
  d._setPixel(x0 + 1, y + 1, r, g, b);
  d._setPixel(x0 + 2, y + 1, r, g, b);
}

function drawDownArrow(d, x0, y, r, g, b) {
  d._setPixel(x0, y + 3, r, g, b);
  d._setPixel(x0 + 1, y + 3, r, g, b);
  d._setPixel(x0 + 2, y + 3, r, g, b);
  d._setPixel(x0 + 1, y + 4, r, g, b);
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
  drawUpArrow(d, ax, cy - 6, ...pvColor);
  await drawKwTight(d, cx + 1, cy - 6, productionW, pvColor);

  // Consumption: dark-red → red → bright-red by kW tier
  const cons = consumptionW ?? 0;
  const consColor =
    cons < 500 ? [120, 20, 20] : cons <= 1000 ? [200, 40, 40] : [255, 60, 60];
  drawDownArrow(d, ax, cy + 2, ...consColor);
  await drawKwTight(d, cx + 1, cy + 2, consumptionW, consColor);
}

// Temperature → human-perception color (white-blue=icy → fire-red=scalding)
// Breakpoints follow physiological sensation thresholds.
function _boilerTempColor(tempC) {
  if (tempC === null) return C.dimWhite;
  const stops = [
    [0, [200, 230, 255]], // icy — white-blue
    [12, [80, 150, 255]], // cold — clear blue
    [24, [40, 200, 240]], // cool — cyan
    [32, [200, 200, 220]], // tepid — pale neutral
    [38, [255, 200, 40]], // warm — amber
    [43, [255, 80, 0]], // hot — orange
    [60, [255, 20, 0]], // very hot — red
    [80, [220, 0, 30]], // scalding — fire red
  ];
  if (tempC <= stops[0][0]) return stops[0][1];
  if (tempC >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i],
      [t1, c1] = stops[i + 1];
    if (tempC <= t1) {
      const u = (tempC - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + u * (c1[j] - v)));
    }
  }
  return stops[stops.length - 1][1];
}

// ── Cell: Boiler temperature + state indicator ────────────────────────────────
//
// 6×9 off-white casing, subtle outline. Temp in perceptual color (blue=cold/red=hot).
// ° rendered as a single dim dot (not a char). 2×2 status LED.
// State: ok=idle (amber), else=heating (animated red↔amber pulse).

async function drawBoiler(d, cx, cy, boiler, frame) {
  const textY = cy - 6; // 1px lower than before
  const tempColor = _boilerTempColor(boiler.tempC);

  // Temperature number + manual ° dot
  if (boiler.tempC !== null) {
    const numStr = `${Math.round(boiler.tempC)}`;
    const textW = numStr.length * 4 - 1; // 3×5 font, 4px/char except last
    const dotX = cx + 1 + Math.floor(textW / 2) + 1;
    await d.drawTextRgbaAligned(numStr, [cx + 1, textY], tempColor, "center");
    const [tr, tg, tb] = tempColor;
    d._setPixel(dotX, textY, (tr * 0.7) | 0, (tg * 0.7) | 0, (tb * 0.7) | 0);
  } else {
    await d.drawTextRgbaAligned("---", [cx, textY], C.dimWhite, "center");
  }

  // Casing: 7×8. Fill = light (70%), outline = darker (70%), corners = 50%.
  // Colors flipped vs original: fill uses brighter 200/196, outline uses dimmer 160/155.
  const casingX = cx - 3;
  const casingY = cy + 1;
  fillRect(d, casingX, casingY, 7, 8, 140, 140, 137); // 200/196 @ 70%
  // Outline: sides without corners (112/109 @ 70% of 160/155)
  hLine(d, casingX + 1, casingX + 5, casingY, 112, 112, 109);
  hLine(d, casingX + 1, casingX + 5, casingY + 7, 112, 112, 109);
  vLine(d, casingX, casingY + 1, casingY + 6, 112, 112, 109);
  vLine(d, casingX + 6, casingY + 1, casingY + 6, 112, 112, 109);
  // Corner pixels at 50%
  d._setPixel(casingX, casingY, 80, 80, 78);
  d._setPixel(casingX + 6, casingY, 80, 80, 78);
  d._setPixel(casingX, casingY + 7, 80, 80, 78);
  d._setPixel(casingX + 6, casingY + 7, 80, 80, 78);

  // 1×1 status LED — 1px right of center, 2px from bottom
  let lr, lg, lb;
  if (boiler.state === "ok") {
    [lr, lg, lb] = C.amber; // idle — solid amber
  } else {
    // heating / error — pulse between red and amber
    const t = (Math.sin(frame * 0.35) + 1) / 2;
    lr = Math.round(200 + 55 * t);
    lg = Math.round(30 + 125 * t);
    lb = 0;
  }
  d._setPixel(casingX + 4, casingY + 5, lr, lg, lb); // 1px right of center
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

// Syncbox line — 3px hLine below power dot. isActive=blue, inactive=gray.
// Only drawn when syncbox is known-online; TV col has no line.
function drawSyncboxLine(d, cx, dotY, isActive) {
  const [r, g, b] = isActive ? [60, 140, 255] : [50, 50, 50];
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
  name: "home",
  pretty_name: "Home Dashboard",
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
  },

  async init(context) {
    this._frame = 0;
    this._logger = context.logger;

    this._cfg = this._mapSettings(context.settings.all());
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
      // Row 1 — energy
      battPct: null,
      battState: null,
      battSeen: null,
      productionW: null,
      consumptionW: null,
      energySeen: null,
      boiler: { state: "unknown", tempC: null },
      boilerSeen: null,
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

    sub("pidicon-light/debug/bri_override", (msg) => {
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

    sub("z2m/wz/contact/te-door", (msg) => {
      this._s.terraceOpen = parseContact(msg);
    });
    sub("z2m/wz/contact/te-door/availability", (msg) => {
      this._s.terraceOnline = parseAvailability(msg);
    });

    sub("z2m/vk/contact/w13", (msg) => {
      this._s.w13Open = parseContact(msg);
    });
    sub("z2m/vk/contact/w13/availability", (msg) => {
      this._s.w13Online = parseAvailability(msg);
    });

    sub("z2m/vr/contact/w14", (msg) => {
      this._s.w14Open = parseContact(msg);
    });
    sub("z2m/vr/contact/w14/availability", (msg) => {
      this._s.w14Online = parseAvailability(msg);
    });

    // Self-heal: shared MQTT client means the broker won't re-deliver retained
    // messages if another scene already holds the same subscription. Re-subscribe
    // any topic still null every 30s until healed, then stop.
    // Root cause: broker sees topic already subscribed by this client → skips
    // retained delivery. Re-subscribing forces a new retained message delivery.
    const nullChecks = [
      ["nuki/463F8F47/#", () => this._s.nukiVrState !== null],
      ["nuki/4A5D18FF/#", () => this._s.nukiKeState !== null],
      ["z2m/wz/contact/te-door", () => this._s.terraceOpen !== null],
      [
        "z2m/wz/contact/te-door/availability",
        () => this._s.terraceOnline !== null,
      ],
      ["z2m/vk/contact/w13", () => this._s.w13Open !== null],
      ["z2m/vk/contact/w13/availability", () => this._s.w13Online !== null],
      ["z2m/vr/contact/w14", () => this._s.w14Open !== null],
      ["z2m/vr/contact/w14/availability", () => this._s.w14Online !== null],
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
          context.mqtt.subscribe(topic, _h[topic]);
          context.logger.info(`[home] self-heal: re-subscribed ${topic}`);
        }
      }
    };
    this._healRunner = heal;
    this._healTimer = setInterval(heal, this._cfg.healRetryMs);
    // Also run once at 5s — catches the common fast-broker case
    setTimeout(heal, this._cfg.healInitialDelayMs);

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

    context.mqtt.subscribe("jhw2211/health/boiler", (msg) => {
      try {
        const d = JSON.parse(msg);
        this._s.boiler.state = d.state ?? "unknown";
        this._s.boiler.tempC = d.temp_c ?? null;
        this._s.boilerSeen = Date.now();
      } catch {}
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

    this._startSyncboxPoll(context.logger);
    context.logger.info("[home] Scene initialized");
  },

  async destroy(context) {
    this._unsubscribeSettings?.();
    this._stopSyncboxPoll();
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
    drawSeparators(device);

    // ── Row 0: Doors / Windows ───────────────────────────────────────────────

    // NUKI col 0 — two circles stacked: VR (front) top, Keller (basement) bottom.
    // Row 0 = y 8..25 (18px). r=1 colored + r=2+r=3 gray outline. Top cy=13, bottom cy=21.
    const cx0 = COLS[0].cx;
    drawNukiCircle(device, cx0, ROWS[0].y0 + 4, s.nukiVrState, s.nukiVrAlive); // top cy=12
    drawNukiCircle(device, cx0, ROWS[0].y1 - 4, s.nukiKeState, s.nukiKeAlive); // bottom cy=21

    // TERRACE dual sliding door (col 1) — error if z2m reports offline
    drawSlidingDoor(device, COLS[1].cx, ROWS[0].cy, s.terraceOpen);
    if (s.terraceOnline === false) drawErrorMark(device, 1, 0, this._frame);

    // W13 + W14 side-by-side skylights (col 2) — error if either is offline
    drawSideBySideSkylights(
      device,
      COLS[2].cx,
      ROWS[0].cy,
      s.w13Open,
      s.w14Open,
    );
    if (s.w13Online === false || s.w14Online === false)
      drawErrorMark(device, 2, 0, this._frame);

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

    await drawBoiler(device, COLS[2].cx, ROWS[1].cy, s.boiler, this._frame);
    if (isStale(s.boilerSeen, this._cfg.staleMs))
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
    drawPS5(device, COLS[0].cx, cy2, ps5On, ps5Stale);
    drawTV(device, COLS[1].cx, cy2, tvOn, tvStale);
    drawPC(device, COLS[2].cx, cy2, pcOn, pcStale);

    // Syncbox: online=lines, offline=red X in TV cell, not configured=nothing
    const syncOnline =
      s.syncEnabled &&
      s.syncSeen !== null &&
      Date.now() - s.syncSeen < this._cfg.syncboxFreshMs;
    if (s.syncEnabled && !syncOnline) {
      drawSyncboxOffline(device);
    } else if (syncOnline) {
      drawSyncboxLine(
        device,
        COLS[0].cx,
        cy2 + 6,
        s.syncInput === this._cfg.syncboxInputPs5,
      );
      drawSyncboxLine(
        device,
        COLS[2].cx,
        cy2 + 6,
        s.syncInput === this._cfg.syncboxInputPc,
      );
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
    };
  },
};
