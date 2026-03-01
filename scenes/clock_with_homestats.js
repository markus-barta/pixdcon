/**
 * clock_with_homestats — Kids bedroom display (Ulanzi 32x8)
 *
 * Shows current time + live home sensor status:
 *   - Nuki smartlock (VR entrance)
 *   - Terrace sliding door (WZ)
 *   - Two ceiling skylights (VK: W13, VR: W14)
 *
 * Color semantics (unified):
 *   OPEN/UNLOCKED = Green → accessible/open
 *   CLOSED/LOCKED = Red   → sealed/secured
 *   TRANSITIONING = Yellow → locking or unlocking in progress (Nuki only)
 *   UNKNOWN/ERROR = Blue  → no data, jammed, or error state
 *
 * Day/Night mode (time-based, checked every render):
 *   Day   07:00–19:00 : bright colors, BRI 20
 *   Night 19:00–07:00 : dim colors, BRI 5
 *
 * Brightness is re-asserted every 5 min as safety net against missed transitions.
 *
 * MQTT source topics:
 *   homeassistant/lock/nuki_vr/state  → "locked" | "unlocked" | other string
 *   z2m/wz/contact/te-door            → {contact: bool}  true=closed
 *   z2m/vk/contact/w13               → {contact: bool}  true=closed
 *   z2m/vr/contact/w14               → {contact: bool}  true=closed
 *
 * Draw layout (pixel positions match Node-RED BZ flow):
 *   [3,0]          time text (HH:MM:SS)
 *   [29,7]–[31,7]  Nuki lock bar, bottom-right
 *   [14,6] 2×2     skylight W13
 *   [17,6] 2×2     skylight W14
 *   [0/1,7]–[2/3,7] terrace door seg 1 (shifts 1px right when open)
 *   [4,7]–[6,7]    terrace door seg 2
 */

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

const DAY = {
  NUKI_UNLOCKED: [0, 255, 0], // Green  — unlocked = open
  NUKI_LOCKED: [255, 0, 0], // Red    — locked = closed
  NUKI_TRANSITIONING: [255, 255, 0], // Yellow — locking/unlocking
  NUKI_ERROR: [0, 0, 255], // Blue   — jammed/unknown/error
  OPEN: [0, 255, 0], // Green  — open
  CLOSED: [255, 0, 0], // Red    — closed
  UNKNOWN: [0, 0, 255], // Blue   — no data
  TIME: [255, 255, 213], // Warm white
  BRI: 20,
};

const NIGHT = {
  NUKI_UNLOCKED: [0, 70, 0], // Dim green
  NUKI_LOCKED: [70, 0, 0], // Dim red
  NUKI_TRANSITIONING: [70, 70, 0], // Dim yellow
  NUKI_ERROR: [0, 0, 70], // Dim blue
  OPEN: [0, 70, 0], // Dim green
  CLOSED: [70, 0, 0], // Dim red
  UNKNOWN: [0, 0, 70], // Dim blue
  TIME: [50, 30, 30], // Very dim
  BRI: 5,
};

// Brightness heartbeat — re-assert every 5 min in case device missed transition
const BRI_HEARTBEAT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------

export default {
  name: "clock_with_homestats",
  description: "Time + Nuki / terrace door / skylights. Day/night mode.",

  // ---------------------------------------------------------------------------
  // init — called once on scene load; subscribe to sensor topics
  // ---------------------------------------------------------------------------
  async init(context) {
    // Initialise state on the module object — shared across render() calls.
    // Must be done here (not at module level) so config-reload resets cleanly.
    this._state = {
      nukiState: null, // string from HA
      terraceOpen: null, // bool: true = open
      w13Open: null, // bool: true = open
      w14Open: null, // bool: true = open
    };
    this._lastMode = null;
    this._lastBriSet = 0;

    // Nuki: HA sends plain string payloads
    context.mqtt.subscribe("homeassistant/lock/nuki_vr/state", (msg) => {
      this._state.nukiState = msg.trim();
    });

    // z2m contact sensors: {contact: true} = closed, {contact: false} = open
    const parseOpen = (msg) => {
      try {
        return JSON.parse(msg).contact === false;
      } catch {
        return null;
      }
    };

    context.mqtt.subscribe("z2m/wz/contact/te-door", (msg) => {
      this._state.terraceOpen = parseOpen(msg);
    });
    context.mqtt.subscribe("z2m/vk/contact/w13", (msg) => {
      this._state.w13Open = parseOpen(msg);
    });
    context.mqtt.subscribe("z2m/vr/contact/w14", (msg) => {
      this._state.w14Open = parseOpen(msg);
    });
  },

  // ---------------------------------------------------------------------------
  // destroy — called on scene eviction / config reload; clean up subscriptions
  // ---------------------------------------------------------------------------
  async destroy(context) {
    context.mqtt.unsubscribeAll();
  },

  // ---------------------------------------------------------------------------
  // render — called every 1000 ms
  // ---------------------------------------------------------------------------
  async render(device) {
    // Guard: init() may not have completed yet on very first render
    if (!this._state) {
      return 500;
    }

    const hour = new Date().getHours();
    const isDay = hour >= 7 && hour < 19;
    const mode = isDay ? "day" : "night";
    const C = isDay ? DAY : NIGHT;

    // Set brightness on mode change or heartbeat — not every frame
    const modeChanged = mode !== this._lastMode;
    const briHeartbeat = Date.now() - this._lastBriSet >= BRI_HEARTBEAT_MS;
    if (modeChanged || briHeartbeat) {
      await device.setBrightness(C.BRI);
      this._lastBriSet = Date.now();
      this._lastMode = mode;
    }

    // Time string with correct TZ/DST
    const timeStr = new Date().toLocaleTimeString("de-AT", {
      timeZone: "Europe/Vienna",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    // Colors from sensor state
    const nukiColor = this._nukiColor(C);
    const terraceColor = this._openClosedColor(this._state.terraceOpen, C);
    const w13Color = this._openClosedColor(this._state.w13Open, C);
    const w14Color = this._openClosedColor(this._state.w14Open, C);

    // Terrace: left segment shifts 1px right when open to show gap
    const tx = this._state.terraceOpen ? 1 : 0;

    await device.drawCustom({
      draw: [
        { dt: [3, 0, timeStr, C.TIME] }, // time
        { dl: [29, 7, 31, 7, nukiColor] }, // nuki bar
        { dr: [14, 6, 2, 2, w13Color] }, // skylight W13
        { dr: [17, 6, 2, 2, w14Color] }, // skylight W14
        { dl: [tx, 7, tx + 2, 7, terraceColor] }, // terrace seg 1
        { dl: [4, 7, 6, 7, terraceColor] }, // terrace seg 2
      ],
    });

    return 1000;
  },

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _nukiColor(C) {
    switch (this._state.nukiState) {
      case "locked":
        return C.NUKI_LOCKED;
      case "unlocked":
        return C.NUKI_UNLOCKED;
      case "locking":
      case "unlocking":
        return C.NUKI_TRANSITIONING;
      default:
        return C.NUKI_ERROR; // null, "jammed", unknown string
    }
  },

  _openClosedColor(isOpen, C) {
    if (isOpen === null) return C.UNKNOWN;
    return isOpen ? C.OPEN : C.CLOSED;
  },
};
