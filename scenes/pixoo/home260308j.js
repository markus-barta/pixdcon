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
 *   nuki/463F8F47/state                           numeric 1=locked 2=unlocking 3=unlocked 4=locking
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
 */

import https from "https";
import { exec }  from "child_process";

// ── Palette ───────────────────────────────────────────────────────────────────

const C = {
  open:       [ 40, 210,  80],
  closed:     [210,  30,  30],
  trans:      [220, 180,   0],
  unknown:    [ 70,  50,   0],
  ok:         [  0, 200,  80],
  warn:       [220, 160,   0],
  bad:        [200,  30,  30],
  amber:      [255, 155,   0],
  cyan:       [  0, 190, 220],
  dimWhite:   [ 80,  80,  80],
  timeColor:  [200, 200, 160],
  sep:        [ 25,  25,  25],
  // Battery
  chrgGreen:  [  0, 200,  80],
  dischRed:   [200,  50,  50],
  stbyGrey:   [ 60,  60,  60],
  // Media
  tvColor:    [ 60, 190, 255],
  ps5Color:   [ 80, 120, 255],
  pcColor:    [160, 160, 160],
  syncRing:   [240, 220,   0],
  // Error
  errorRed:   [200,   0,   0],
};

// ── Grid ──────────────────────────────────────────────────────────────────────

const COLS = [
  { x0:  0, x1: 20, cx: 10 },
  { x0: 22, x1: 42, cx: 32 },
  { x0: 44, x1: 63, cx: 53 },
];
const ROWS = [
  { y0:  8, y1: 25, cy: 16 },
  { y0: 27, y1: 44, cy: 35 },
  { y0: 46, y1: 63, cy: 54 },
];
const V_SEP = [21, 43];
const H_SEP = [7, 26, 45];

// ── Draw primitives ───────────────────────────────────────────────────────────

function hLine(d, x0, x1, y, r, g, b)     { for (let x = x0; x <= x1; x++) d._setPixel(x, y, r, g, b); }
function vLine(d, x, y0, y1, r, g, b)     { for (let y = y0; y <= y1; y++) d._setPixel(x, y, r, g, b); }
function fillRect(d, x, y, w, h, r, g, b) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      d._setPixel(x + dx, y + dy, r, g, b);
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
  d._setPixel(x,     y,     r, g, b);
  d._setPixel(x + 2, y,     r, g, b);
  d._setPixel(x + 1, y + 1, r, g, b);
  d._setPixel(x,     y + 2, r, g, b);
  d._setPixel(x + 2, y + 2, r, g, b);
}

// ── Icon: Nuki padlock ────────────────────────────────────────────────────────

function drawLock(d, cx, cy, locked, r, g, b) {
  fillRect(d, cx - 3, cy + 1, 7, 5, r, g, b);
  d._setPixel(cx, cy + 2, 0, 0, 0);
  d._setPixel(cx, cy + 3, 0, 0, 0);
  if (locked) {
    hLine(d, cx - 2, cx + 2, cy - 3, r, g, b);
    vLine(d, cx - 2, cy - 3, cy,     r, g, b);
    vLine(d, cx + 2, cy - 3, cy,     r, g, b);
  } else {
    vLine(d, cx + 2, cy - 5, cy,     r, g, b);
    hLine(d, cx,     cx + 2, cy - 5, r, g, b);
  }
}

// ── Icon: Dual sliding glass terrace door ─────────────────────────────────────
//
// 14×11px centered at (cx, cy).
// Closed: two panels meeting at center seam with knobs.
// Open:   panels slid to outer edges — ~6px gap visible in center.

function drawSlidingDoor(d, cx, cy, isOpen, r, g, b) {
  const x0 = cx - 7;
  const y0 = cy - 5;
  // Fixed frame: top rail + bottom sill + outer sides
  hLine(d, x0, x0 + 13, y0,      r, g, b);
  hLine(d, x0, x0 + 13, y0 + 10, r, g, b);
  vLine(d, x0,           y0, y0 + 10, r, g, b);
  vLine(d, x0 + 13,      y0, y0 + 10, r, g, b);

  if (!isOpen) {
    vLine(d, x0 + 6, y0, y0 + 10, r, g, b);  // left panel right edge
    vLine(d, x0 + 7, y0, y0 + 10, r, g, b);  // right panel left edge
    d._setPixel(x0 + 3, cy, r, g, b);         // left knob
    d._setPixel(x0 + 10, cy, r, g, b);        // right knob
  } else {
    vLine(d, x0 + 3,  y0, y0 + 10, r, g, b); // left panel inner edge (slid out)
    vLine(d, x0 + 10, y0, y0 + 10, r, g, b); // right panel inner edge
  }
}

// ── Icon: Stacked skylights (W13 top, W14 bottom) ────────────────────────────
//
// Each window: 10×7px. Stacked with 1px gap. Center at (cx, cy).

function drawStackedWindows(d, cx, cy, topOpen, botOpen) {
  const topColor = topOpen === null ? C.unknown : topOpen ? C.open : C.closed;
  const botColor = botOpen === null ? C.unknown : botOpen ? C.open : C.closed;

  function drawWin(x0, y0, isOpen, [r, g, b]) {
    hLine(d, x0, x0 + 9, y0,     r, g, b);
    hLine(d, x0, x0 + 9, y0 + 6, r, g, b);
    vLine(d, x0,     y0, y0 + 6, r, g, b);
    vLine(d, x0 + 9, y0, y0 + 6, r, g, b);
    hLine(d, x0, x0 + 9, y0 + 3, r, g, b); // mid divider
    if (!isOpen) {
      const dr = r >> 3, dg = g >> 3, db = b >> 3;
      for (let qy = y0 + 1; qy <= y0 + 5; qy++) {
        if (qy === y0 + 3) continue;
        for (let qx = x0 + 1; qx <= x0 + 8; qx++) d._setPixel(qx, qy, dr, dg, db);
      }
    }
  }

  const x0 = cx - 4;
  drawWin(x0, cy - 7, topOpen === true, topColor);  // W13 top window
  drawWin(x0, cy + 1, botOpen === true, botColor);  // W14 bottom window
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
    return [200, Math.round(200 * u), 0];           // red → yellow
  } else {
    const u = (t - 0.5) * 2;
    return [Math.round(200 * (1 - u)), 200, 0];     // yellow → green
  }
}

async function drawBattery(d, cx, cy, pct, state, frame) {
  const isDischarging = state === "discharging";
  const dim = state === "discharging" || state === "charging" ? 1.0 : state === "standby" ? 0.60 : 0.25;

  const BAR_W  = 16;   // outer width (1px border each side → 14px inner fill)
  const BAR_H  = 6;    // outer height (1px border each side → 4px inner fill)
  const INNER  = BAR_W - 2;  // 14 — visible fill columns
  const x0     = cx - Math.floor(BAR_W / 2);
  const barY   = cy + 2;  // moved down 2px

  const BORDER   = [35, 35, 35];
  const fillX0   = x0 + 1;
  const filledPx = pct === null ? 0 : Math.max(0, Math.round((pct / 100) * INNER));

  // Full outline (all 4 sides)
  hLine(d, x0, x0 + BAR_W - 1, barY,             ...BORDER);
  hLine(d, x0, x0 + BAR_W - 1, barY + BAR_H - 1, ...BORDER);
  vLine(d, x0,             barY, barY + BAR_H - 1, ...BORDER);
  vLine(d, x0 + BAR_W - 1, barY, barY + BAR_H - 1, ...BORDER);

  // Inner fill (14 columns × 6 rows)
  for (let i = 0; i < INNER; i++) {
    const base = _gradientColor(i, INNER);
    const dimmed = base.map((v) => Math.round(v * dim));
    const empty  = base.map((v) => Math.round(v * dim * 0.25));
    const [r, g, b] = i < filledPx ? dimmed : empty;
    vLine(d, fillX0 + i, barY + 1, barY + BAR_H - 2, r, g, b);
  }

  // Discharge animation: bright pixel right→left through filled inner area
  if (isDischarging && filledPx > 1) {
    const phase  = Math.floor(frame / 2) % filledPx;
    const drainX = fillX0 + filledPx - 1 - phase;
    const base   = _gradientColor(drainX - fillX0, INNER);
    const [hr, hg, hb] = base.map((v) => Math.min(255, (v * 1.7) | 0));
    vLine(d, drainX, barY + 1, barY + BAR_H - 2, hr, hg, hb);
  }

  // Nub on right: 2px tall, centered (rows 2+3 of 0-indexed 0..5)
  const nubColor = filledPx >= INNER
    ? _gradientColor(INNER - 1, INNER).map((v) => Math.round(v * dim))
    : BORDER;
  d._setPixel(x0 + BAR_W, barY + 2, ...nubColor);
  d._setPixel(x0 + BAR_W, barY + 3, ...nubColor);

  // % text: color matches current SOC gradient position; 1px higher than bar
  if (pct !== null) {
    const labelColor = _gradientColor(Math.max(0, filledPx - 1), INNER).map((v) => Math.round(v * dim));
    await d.drawTextRgbaAligned(`${Math.round(pct)}%`, [cx, barY - 8], labelColor, "center");
  }
}

// ── Cell: PV production + home consumption ────────────────────────────────────

async function drawPvCons(d, cx, cy, productionW, consumptionW) {
  const fmt = (w) => w === null ? "---" : (w / 1000).toFixed(1);

  // Production: grey if 0/null (no sun), bright yellow if generating
  const pvColor = (!productionW) ? C.dimWhite : [255, 220, 0];
  await d.drawTextRgbaAligned(`↑${fmt(productionW)}`, [cx, cy - 6], pvColor, "center");

  // Consumption: dark-red → red → bright-red by kW tier
  const cons = consumptionW ?? 0;
  const consColor = cons < 500 ? [120, 20, 20] : cons <= 1000 ? [200, 40, 40] : [255, 60, 60];
  await d.drawTextRgbaAligned(`↓${fmt(consumptionW)}`, [cx, cy + 2], consColor, "center");
}

// Temperature → perceptual color: blue (cold) → yellow (mid) → red (hot)
function _boilerTempColor(tempC) {
  if (tempC === null) return C.dimWhite;
  const t = Math.max(0, Math.min(1, (tempC - 20) / 60)); // 0=20°C .. 1=80°C
  if (t < 0.5) {
    const u = t * 2;
    return [Math.round(40 + 210 * u), Math.round(100 + 100 * u), Math.round(220 - 200 * u)]; // blue→yellow
  } else {
    const u = (t - 0.5) * 2;
    return [Math.round(250), Math.round(200 - 180 * u), Math.round(20 - 20 * u)]; // yellow→red
  }
}

// ── Cell: Boiler temperature + state indicator ────────────────────────────────
//
// 6×9 off-white casing, subtle outline. Temp in perceptual color (blue=cold/red=hot).
// ° rendered as a single dim dot (not a char). 2×2 status LED.
// State: ok=idle (amber), else=heating (animated red↔amber pulse).

async function drawBoiler(d, cx, cy, boiler, frame) {
  const textY    = cy - 6;   // 1px lower than before
  const tempColor = _boilerTempColor(boiler.tempC);

  // Temperature number + manual ° dot
  if (boiler.tempC !== null) {
    const numStr = `${Math.round(boiler.tempC)}`;
    const textW  = numStr.length * 4 - 1;  // 3×5 font, 4px/char except last
    const dotX   = cx + 1 + Math.floor(textW / 2) + 1;
    await d.drawTextRgbaAligned(numStr, [cx + 1, textY], tempColor, "center");
    const [tr, tg, tb] = tempColor;
    d._setPixel(dotX, textY, (tr * 0.7) | 0, (tg * 0.7) | 0, (tb * 0.7) | 0);
  } else {
    await d.drawTextRgbaAligned("---", [cx, textY], C.dimWhite, "center");
  }

  // Casing: 7×8, off-white, subtle outline (1px lower, 1px less tall)
  const casingX = cx - 3;
  const casingY = cy + 1;
  fillRect(d, casingX, casingY, 7, 8, 160, 160, 155);
  hLine(d, casingX, casingX + 6, casingY,     200, 200, 196);
  hLine(d, casingX, casingX + 6, casingY + 7, 200, 200, 196);
  vLine(d, casingX,     casingY, casingY + 7, 200, 200, 196);
  vLine(d, casingX + 6, casingY, casingY + 7, 200, 200, 196);

  // 2×2 status LED, 2px lower (casingY+5)
  let lr, lg, lb;
  if (boiler.state === "ok") {
    [lr, lg, lb] = C.amber;  // idle — solid amber
  } else {
    // heating / error — pulse between red and amber
    const t = (Math.sin(frame * 0.35) + 1) / 2;
    lr = Math.round(200 + 55 * t);
    lg = Math.round(30 + 125 * t);
    lb = 0;
  }
  d._setPixel(casingX + 3, casingY + 5, lr, lg, lb); // 1×1, 1px right of center, 2px from bottom
}

// ── Media icons ───────────────────────────────────────────────────────────────
//
// Unified state: on=green, standby/off=amber, stale=gray.
// Icon body drawn at 60% opacity; power dot at full brightness.

const POWER_ON      = [  0, 200,  80];
const POWER_STANDBY = [255, 155,   0];
const MEDIA_STALE   = [ 60,  60,  60];

function _mediaColors(isOn, stale) {
  const base = stale ? MEDIA_STALE : isOn ? POWER_ON : POWER_STANDBY;
  const dim  = base.map((v) => Math.round(v * 0.6));
  return { dot: base, icon: dim };
}

// Syncbox line — 3px hLine below power dot. isActive=blue, inactive=gray.
// Only drawn when syncbox is known-online; TV col has no line.
function drawSyncboxLine(d, cx, dotY, isActive) {
  const [r, g, b] = isActive ? [60, 140, 255] : [50, 50, 50];
  hLine(d, cx - 1, cx + 1, dotY + 2, r, g, b);
}

// Syncbox offline — red X at bottom-right of TV cell (permanent, no blink)
function drawSyncboxOffline(d) {
  const ex = COLS[1].x1 - 4;   // x 38
  const ey = ROWS[2].y1 - 3;   // y 60
  const [r, g, b] = C.errorRed;
  d._setPixel(ex,     ey,     r, g, b);
  d._setPixel(ex + 2, ey,     r, g, b);
  d._setPixel(ex + 1, ey + 1, r, g, b);
  d._setPixel(ex,     ey + 2, r, g, b);
  d._setPixel(ex + 2, ey + 2, r, g, b);
}

// TV monitor: 15×9 wall-mounted (cx±7, cy-4..cy+4) — no stand
function drawTV(d, cx, cy, isOn, stale) {
  const { icon: [r, g, b], dot: [dr, dg, db] } = _mediaColors(isOn, stale);
  hLine(d, cx - 7, cx + 7, cy - 4, r, g, b);
  hLine(d, cx - 7, cx + 7, cy + 4, r, g, b);
  vLine(d, cx - 7, cy - 4, cy + 4, r, g, b);
  vLine(d, cx + 7, cy - 4, cy + 4, r, g, b);
  d._setPixel(cx, cy + 6, dr, dg, db); // power dot (full brightness)
}

// PS5 controller: 7×5 body (cx±3, cy±2) + grips (cx±4, cy+1..2) + touchpad dot
function drawPS5(d, cx, cy, isOn, stale) {
  const { icon: [r, g, b], dot: [dr, dg, db] } = _mediaColors(isOn, stale);
  hLine(d, cx - 3, cx + 3, cy - 2, r, g, b);
  hLine(d, cx - 3, cx + 3, cy + 2, r, g, b);
  vLine(d, cx - 3, cy - 2, cy + 2, r, g, b);
  vLine(d, cx + 3, cy - 2, cy + 2, r, g, b);
  d._setPixel(cx - 4, cy + 1, r, g, b);
  d._setPixel(cx - 4, cy + 2, r, g, b);
  d._setPixel(cx + 4, cy + 1, r, g, b);
  d._setPixel(cx + 4, cy + 2, r, g, b);
  d._setPixel(cx, cy, r, g, b);               // touchpad dot
  d._setPixel(cx, cy + 6, dr, dg, db);        // power dot (full brightness)
}

// PC tower: 5×8 outline (cx±2, cy-4..cy+3) + disk slot line
function drawPC(d, cx, cy, isOn, stale) {
  const { icon: [r, g, b], dot: [dr, dg, db] } = _mediaColors(isOn, stale);
  hLine(d, cx - 2, cx + 2, cy - 4, r, g, b);
  hLine(d, cx - 2, cx + 2, cy + 3, r, g, b);
  vLine(d, cx - 2, cy - 4, cy + 3, r, g, b);
  vLine(d, cx + 2, cy - 4, cy + 3, r, g, b);
  hLine(d, cx - 1, cx + 1, cy - 1, r, g, b); // disk slot detail
  d._setPixel(cx, cy + 6, dr, dg, db);        // power dot (full brightness)
}

// ── Staleness / Nuki ping ──────────────────────────────────────────────────────

const STALE_MS    = 5 * 60 * 1000;
const isStale     = (ts) => ts === null || (Date.now() - ts) > STALE_MS;
const NUKI_IP     = "192.168.1.186";

function pingNuki() {
  return new Promise((resolve) => {
    const cmd = process.platform === "darwin"
      ? `ping -c 1 -W 2000 ${NUKI_IP}`
      : `ping -c 1 -W 2 ${NUKI_IP}`;
    exec(cmd, { timeout: 4000 }, (err) => resolve(!err));
  });
}

// ── Scene export ──────────────────────────────────────────────────────────────

export default {
  name: "home",

  async init(context) {
    this._frame = 0;

    this._s = {
      // Row 0 — contact sensors (availability-tracked)
      nukiState:     null, nukiAlive:     true,
      terraceOpen:   null, terraceOnline: null,
      w13Open:       null, w13Online:     null,
      w14Open:       null, w14Online:     null,
      // Row 1 — energy
      battPct:       null, battState:     null, battSeen:   null,
      productionW:   null, consumptionW:  null, energySeen: null,
      boiler:        { state: "unknown", tempC: null }, boilerSeen: null,
      // Row 2 — media (power in watts)
      tvPower:       null, tvSeen:        null,
      ps5Power:      null, ps5Seen:       null,
      pcPower:       null, pcSeen:        null,
      syncInput:     null, syncSeen:      null, syncEnabled: false,
    };

    const parseContact     = (msg) => { try { return JSON.parse(msg).contact === false; } catch { return null; } };
    const parseAvailability = (msg) => { try { return JSON.parse(msg).state === "online"; } catch { return null; } };
    const parsePower       = (msg) => { try { const d = JSON.parse(msg); return typeof d.power === "number" ? d.power : null; } catch { return null; } };

    // Subscribe + store handler refs for self-heal re-subscription
    const _h = {};
    const sub = (topic, fn) => { _h[topic] = fn; context.mqtt.subscribe(topic, fn); };

    const NUKI = { 1: "locked", 2: "unlocking", 3: "unlocked", 4: "locking" };
    sub("nuki/463F8F47/state", (msg) => {
      this._s.nukiState = NUKI[parseInt(msg.trim())] ?? null;
    });

    // Nuki stale detection via IP ping (device only publishes on state change)
    const nukiPoll = async () => { this._s.nukiAlive = await pingNuki(); };
    nukiPoll();
    this._nukiPoll = setInterval(nukiPoll, 60_000);

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

    // Self-heal: after 20s re-subscribe any contact/availability topics still null.
    // Broker will re-deliver retained messages immediately on new subscription.
    this._healTimer = setTimeout(() => {
      const nullChecks = [
        ["nuki/463F8F47/state",                  () => this._s.nukiState     !== null],
        ["z2m/wz/contact/te-door",               () => this._s.terraceOpen   !== null],
        ["z2m/wz/contact/te-door/availability",  () => this._s.terraceOnline !== null],
        ["z2m/vk/contact/w13",                   () => this._s.w13Open       !== null],
        ["z2m/vk/contact/w13/availability",      () => this._s.w13Online     !== null],
        ["z2m/vr/contact/w14",                   () => this._s.w14Open       !== null],
        ["z2m/vr/contact/w14/availability",      () => this._s.w14Online     !== null],
      ];
      for (const [topic, isHealed] of nullChecks) {
        if (!isHealed() && _h[topic]) {
          context.mqtt.subscribe(topic, _h[topic]);
          context.logger.info(`[home] self-heal: re-subscribed ${topic}`);
        }
      }
    }, 20_000);

    context.mqtt.subscribe("home/ke/sonnenbattery/status", (msg) => {
      try {
        const d = JSON.parse(msg);
        this._s.battPct      = typeof d.USOC          === "number" ? d.USOC          : null;
        this._s.battState    = d.BatteryCharging ? "charging" : d.BatteryDischarging ? "discharging" : "standby";
        this._s.productionW  = typeof d.Production_W  === "number" ? d.Production_W  : null;
        this._s.consumptionW = typeof d.Consumption_W === "number" ? d.Consumption_W : null;
        this._s.battSeen     = Date.now();
        this._s.energySeen   = Date.now();
      } catch {}
    });

    context.mqtt.subscribe("jhw2211/health/boiler", (msg) => {
      try {
        const d = JSON.parse(msg);
        this._s.boiler.state = d.state  ?? "unknown";
        this._s.boiler.tempC = d.temp_c ?? null;
        this._s.boilerSeen   = Date.now();
      } catch {}
    });

    context.mqtt.subscribe("z2m/wz/plug/zisp08", (msg) => { this._s.tvPower  = parsePower(msg); this._s.tvSeen  = Date.now(); });
    context.mqtt.subscribe("z2m/wz/plug/zisp28", (msg) => { this._s.ps5Power = parsePower(msg); this._s.ps5Seen = Date.now(); });
    context.mqtt.subscribe("z2m/wz/plug/zisp05", (msg) => { this._s.pcPower  = parsePower(msg); this._s.pcSeen  = Date.now(); });

    this._startSyncboxPoll(context.logger);
    context.logger.info("[home] Scene initialized");
  },

  async destroy(context) {
    this._stopSyncboxPoll();
    if (this._nukiPoll)  { clearInterval(this._nukiPoll);  this._nukiPoll  = null; }
    if (this._healTimer) { clearTimeout(this._healTimer);  this._healTimer = null; }
    context.mqtt.unsubscribeAll();
    context.logger.info("[home] Scene destroyed");
  },

  async render(device) {
    if (!this._s) return 500;
    this._frame++;
    const s = this._s;

    device.clear();

    // ── Header ───────────────────────────────────────────────────────────────
    const now = new Date();
    const hh  = String(now.getHours()).padStart(2, "0");
    const mm  = String(now.getMinutes()).padStart(2, "0");
    await device.drawTextRgbaAligned("HOME",       [1,  1], C.dimWhite,  "left");
    await device.drawTextRgbaAligned(`${hh}:${mm}`, [63, 1], C.timeColor, "right");
    drawSeparators(device);

    // ── Row 0: Doors / Windows ───────────────────────────────────────────────

    // NUKI (col 0) — stale if >5 min without any MQTT message
    const nukiColor =
      s.nukiState === "locked"   ? C.closed :
      s.nukiState === "unlocked" ? C.open   :
      (s.nukiState === "locking" || s.nukiState === "unlocking") ? C.trans : C.unknown;
    drawLock(device, COLS[0].cx, ROWS[0].cy, s.nukiState !== "unlocked", ...nukiColor);
    if (!s.nukiAlive) drawErrorMark(device, 0, 0, this._frame);

    // TERRACE dual sliding door (col 1) — error if z2m reports offline
    const terraceColor = s.terraceOpen === null ? C.unknown : s.terraceOpen ? C.open : C.closed;
    drawSlidingDoor(device, COLS[1].cx, ROWS[0].cy, s.terraceOpen === true, ...terraceColor);
    if (s.terraceOnline === false) drawErrorMark(device, 1, 0, this._frame);

    // W13 + W14 stacked skylights (col 2) — error if either is offline
    drawStackedWindows(device, COLS[2].cx, ROWS[0].cy, s.w13Open, s.w14Open);
    if (s.w13Online === false || s.w14Online === false) drawErrorMark(device, 2, 0, this._frame);

    // ── Row 1: Energy ────────────────────────────────────────────────────────

    await drawBattery(device, COLS[0].cx, ROWS[1].cy, s.battPct, s.battState ?? "standby", this._frame);
    if (isStale(s.battSeen)) drawErrorMark(device, 0, 1, this._frame);

    await drawPvCons(device, COLS[1].cx, ROWS[1].cy, s.productionW, s.consumptionW);
    if (isStale(s.energySeen)) drawErrorMark(device, 1, 1, this._frame);

    await drawBoiler(device, COLS[2].cx, ROWS[1].cy, s.boiler, this._frame);
    if (isStale(s.boilerSeen)) drawErrorMark(device, 2, 1, this._frame);

    // ── Row 2: Media ─────────────────────────────────────────────────────────

    // on = >threshold watts; everything else = amber (standby/off treated same)
    const ps5On    = (s.ps5Power ?? 0) > 25;
    const tvOn     = (s.tvPower  ?? 0) > 26;
    const pcOn     = (s.pcPower  ?? 0) > 10;
    const ps5Stale = isStale(s.ps5Seen);
    const tvStale  = isStale(s.tvSeen);
    const pcStale  = isStale(s.pcSeen);

    const cy2 = ROWS[2].cy;
    drawPS5(device, COLS[0].cx, cy2, ps5On, ps5Stale);
    drawTV (device, COLS[1].cx, cy2, tvOn,  tvStale);
    drawPC (device, COLS[2].cx, cy2, pcOn,  pcStale);

    // Syncbox: online=lines, offline=red X in TV cell, not configured=nothing
    const syncOnline = s.syncEnabled && s.syncSeen !== null && (Date.now() - s.syncSeen) < 30_000;
    if (s.syncEnabled && !syncOnline) {
      drawSyncboxOffline(device);
    } else if (syncOnline) {
      drawSyncboxLine(device, COLS[0].cx, cy2 + 6, s.syncInput === "input4"); // PS5
      drawSyncboxLine(device, COLS[2].cx, cy2 + 6, s.syncInput === "input2"); // PC
    }

    if (ps5Stale) drawErrorMark(device, 0, 2, this._frame);
    if (tvStale)  drawErrorMark(device, 1, 2, this._frame);
    if (pcStale)  drawErrorMark(device, 2, 2, this._frame);

    await device.push();
    return 500;
  },

  // ── Syncbox HTTP poll (self-signed cert) ──────────────────────────────────

  _startSyncboxPoll(logger) {
    const token = process.env.SYNCBOX_BEARER_TOKEN;
    if (!token) {
      logger.warn("[home] SYNCBOX_BEARER_TOKEN not set — syncbox input tracking disabled");
      return;
    }
    this._s.syncEnabled = true;

    const poll = () => new Promise((resolve) => {
      const req = https.request({
        hostname: "192.168.1.111", path: "/api/v1/execution/", method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        rejectUnauthorized: false, timeout: 2500,
      }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end",  ()  => {
          try {
            const d = JSON.parse(body);
            this._s.syncInput = d.hdmiSource ?? null;
            this._s.syncSeen  = Date.now();
          } catch {}
          resolve();
        });
      });
      req.on("error",   resolve);
      req.on("timeout", () => { req.destroy(); resolve(); });
      req.end();
    });

    const run = async () => { await poll(); };
    run();
    this._syncPoll = setInterval(run, 5000);
    logger.info("[home] Syncbox polling started (every 5s)");
  },

  _stopSyncboxPoll() {
    if (this._syncPoll) { clearInterval(this._syncPoll); this._syncPoll = null; }
  },
};
