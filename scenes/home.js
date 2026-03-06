/**
 * home — Pixoo64 home status display
 *
 * 4-card grid: Nuki lock · terrace sliding door · skylight W13 · skylight W14
 * Live state via MQTT. Same sensor sources as clock_with_homestats.
 *
 * Layout (64×64):
 *   y  0-6:  header — "HOME" label + HH:MM time
 *   y  7:    separator
 *   y  8-34: top row     LEFT=lock  (x 1-30)  │  RIGHT=terrace (x 33-62)
 *   y 35:    separator
 *   y 36-62: bottom row  LEFT=W13   (x 1-30)  │  RIGHT=W14     (x 33-62)
 *   x 31-32: vertical separator
 *
 * Color semantics: OPEN/UNLOCKED=green  CLOSED/LOCKED=red
 *   TRANSITIONING=yellow  UNKNOWN=amber
 */

// ── palette ───────────────────────────────────────────────────────────────────

const OPEN         = [40, 210, 80];
const CLOSED       = [220, 40, 40];
const TRANSITIONING = [220, 180, 0];
const UNKNOWN      = [100, 70, 0];
const TIME_COLOR   = [255, 220, 180];
const LABEL_COLOR  = [60, 60, 60];
const SEP_COLOR    = [28, 28, 28];

function stateColor(isOpen) {
  if (isOpen === null || isOpen === undefined) return UNKNOWN;
  return isOpen ? OPEN : CLOSED;
}

function nukiStateColor(state) {
  switch (state) {
    case "locked":    return CLOSED;
    case "unlocked":  return OPEN;
    case "locking":
    case "unlocking": return TRANSITIONING;
    default:          return UNKNOWN;
  }
}

// ── draw primitives ───────────────────────────────────────────────────────────

function px(d, x, y, r, g, b)             { d._setPixel(x, y, r, g, b); }
function hLine(d, x0, x1, y, r, g, b)     { for (let x = x0; x <= x1; x++) d._setPixel(x, y, r, g, b); }
function vLine(d, x, y0, y1, r, g, b)     { for (let y = y0; y <= y1; y++) d._setPixel(x, y, r, g, b); }
function fillRect(d, x, y, w, h, r, g, b) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      d._setPixel(x + dx, y + dy, r, g, b);
}

/**
 * Card with 1px state-colored border + dark tinted fill.
 * Border at ~35% of state color; interior at ~6% (color >> 4).
 */
function drawCard(d, x, y, w, h, [r, g, b]) {
  const br = (r * 0.35) | 0, bg = (g * 0.35) | 0, bb = (b * 0.35) | 0;
  fillRect(d, x + 1, y + 1, w - 2, h - 2, r >> 4, g >> 4, b >> 4);
  hLine(d, x,         x + w - 1, y,         br, bg, bb);
  hLine(d, x,         x + w - 1, y + h - 1, br, bg, bb);
  vLine(d, x,         y,         y + h - 1, br, bg, bb);
  vLine(d, x + w - 1, y,         y + h - 1, br, bg, bb);
}

// ── icons ─────────────────────────────────────────────────────────────────────

/**
 * Padlock icon centered at (cx, cy).
 * Locked:   closed U-shackle above 7×5 body.  Total span: 9px tall, 7px wide.
 * Unlocked: right arm only, raised.            Total span: 11px tall, 7px wide.
 */
function drawLock(d, cx, cy, locked, r, g, b) {
  // Body: 7w × 5h below center
  fillRect(d, cx - 3, cy + 1, 7, 5, r, g, b);
  // Keyhole: two black pixels carved from body
  d._setPixel(cx, cy + 2, 0, 0, 0);
  d._setPixel(cx, cy + 3, 0, 0, 0);

  if (locked) {
    hLine(d, cx - 2, cx + 2, cy - 3, r, g, b);  // shackle arc top
    vLine(d, cx - 2, cy - 3, cy,     r, g, b);  // left arm
    vLine(d, cx + 2, cy - 3, cy,     r, g, b);  // right arm
  } else {
    vLine(d, cx + 2, cy - 5, cy,     r, g, b);  // right arm raised
    hLine(d, cx,     cx + 2, cy - 5, r, g, b);  // small stub at top
  }
}

/**
 * Terrace sliding door centered at (cx, cy). 8w × 11h.
 * Closed: full frame + right panel edge + door knob.
 * Open:   3-sided frame + door panel shown slid/swung open.
 */
function drawDoor(d, cx, cy, isOpen, r, g, b) {
  const x0 = cx - 4, y0 = cy - 5;
  hLine(d, x0, x0 + 7, y0,      r, g, b);  // top
  hLine(d, x0, x0 + 7, y0 + 10, r, g, b);  // bottom sill
  vLine(d, x0, y0, y0 + 10,     r, g, b);  // left hinge side

  if (!isOpen) {
    vLine(d, x0 + 7, y0, y0 + 10, r, g, b);    // right panel edge (closed)
    d._setPixel(x0 + 5, cy, r, g, b);           // door knob
  } else {
    // Door slid open: panel shown face-on as brace at top of frame opening
    hLine(d, x0 + 1, x0 + 7, y0 + 2, r, g, b);
    d._setPixel(x0 + 7, y0 + 1, r, g, b);
  }
}

/**
 * Skylight / window icon centered at (cx, cy). 10w × 9h.
 * Two panes divided by a horizontal bar.
 * Closed: dim-tinted panes (glass sealed).  Open: frame only (air through).
 */
function drawWindow(d, cx, cy, isOpen, r, g, b) {
  const x0 = cx - 5, y0 = cy - 4;
  const W = 10, H = 9, mid = y0 + 4;
  hLine(d, x0, x0 + W - 1, y0,     r, g, b);  // top
  hLine(d, x0, x0 + W - 1, y0+H-1, r, g, b);  // bottom
  vLine(d, x0,         y0, y0+H-1, r, g, b);  // left
  vLine(d, x0 + W - 1, y0, y0+H-1, r, g, b);  // right
  hLine(d, x0, x0 + W - 1, mid,    r, g, b);  // horizontal pane divider

  if (!isOpen) {
    // Very dim tinted fill = glass closed
    const dr = r >> 3, dg = g >> 3, db = b >> 3;
    for (let qy = y0 + 1; qy < y0 + H - 1; qy++) {
      if (qy === mid) continue;
      for (let qx = x0 + 1; qx < x0 + W - 1; qx++)
        d._setPixel(qx, qy, dr, dg, db);
    }
  }
}

// ── scene ─────────────────────────────────────────────────────────────────────

export default {
  name: "home",

  async init(context) {
    this._s = { nukiState: null, terraceOpen: null, w13Open: null, w14Open: null };

    const parseContact = (msg) => {
      try { return JSON.parse(msg).contact === false; }
      catch { return null; }
    };

    // Nuki MQTT bridge publishes numeric state: 1=locked 2=unlocking 3=unlocked 4=locking
    const NUKI = { 1: "locked", 2: "unlocking", 3: "unlocked", 4: "locking" };
    context.mqtt.subscribe("nuki/463F8F47/state", (msg) => {
      this._s.nukiState = NUKI[parseInt(msg.trim())] ?? null;
    });
    context.mqtt.subscribe("z2m/wz/contact/te-door", (msg) => {
      this._s.terraceOpen = parseContact(msg);
    });
    context.mqtt.subscribe("z2m/vk/contact/w13", (msg) => {
      this._s.w13Open = parseContact(msg);
    });
    context.mqtt.subscribe("z2m/vr/contact/w14", (msg) => {
      this._s.w14Open = parseContact(msg);
    });
  },

  async destroy(context) {
    context.mqtt.unsubscribeAll();
  },

  async render(device) {
    if (!this._s) return 5000;

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");

    const { nukiState, terraceOpen, w13Open, w14Open } = this._s;

    const cNuki    = nukiStateColor(nukiState);
    const cTerrace = stateColor(terraceOpen);
    const cW13     = stateColor(w13Open);
    const cW14     = stateColor(w14Open);

    device.clear();

    // ── cards: state-colored border + dark tinted fill ────────────────────────
    // Layout: 2px outer margin, 4px center gutter (x=30..33), 3px row gap (y=34..36)
    drawCard(device,  2,  9, 28, 25, cNuki);
    drawCard(device, 34,  9, 28, 25, cTerrace);
    drawCard(device,  2, 37, 28, 25, cW13);
    drawCard(device, 34, 37, 28, 25, cW14);

    // ── header separator ─────────────────────────────────────────────────────
    const [sr, sg, sb] = SEP_COLOR;
    hLine(device, 0, 63, 7, sr, sg, sb);

    // ── header ────────────────────────────────────────────────────────────────
    await device.drawTextRgbaAligned("HOME",       [1,  1], LABEL_COLOR);
    await device.drawTextRgbaAligned(`${hh}:${mm}`,[63, 1], TIME_COLOR, "right");

    // ── icons (cx, cy relative to card centers) ───────────────────────────────
    drawLock  (device, 16, 19, nukiState !== "unlocked", ...cNuki);
    drawDoor  (device, 48, 19, terraceOpen === true,     ...cTerrace);
    drawWindow(device, 16, 47, w13Open === true,         ...cW13);
    drawWindow(device, 48, 47, w14Open === true,         ...cW14);

    // ── labels ────────────────────────────────────────────────────────────────
    await device.drawTextRgbaAligned("NUKI", [16, 27], LABEL_COLOR, "center");
    await device.drawTextRgbaAligned("DOOR", [48, 27], LABEL_COLOR, "center");
    await device.drawTextRgbaAligned("W 13", [16, 55], LABEL_COLOR, "center");
    await device.drawTextRgbaAligned("W 14", [48, 55], LABEL_COLOR, "center");

    await device.push();

    // Poll fast until all retained states have arrived; self-heals after reconnect too.
    const allKnown = nukiState !== null && terraceOpen !== null && w13Open !== null && w14Open !== null;
    return allKnown ? 5000 : 500;
  },
};
