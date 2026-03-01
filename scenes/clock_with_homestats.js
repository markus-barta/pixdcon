/**
 * clock_with_homestats — Kids bedroom display (Ulanzi 32x8)
 *
 * Shows current time + live home sensor status:
 *   - Nuki smartlock (VR entrance)
 *   - Terrace sliding door (WZ)
 *   - Two ceiling skylights (VK: W13, VR: W14)
 *   - Sonnenbatterie SOC + charge state
 *
 * Color semantics (unified):
 *   OPEN/UNLOCKED = Green
 *   CLOSED/LOCKED = Red
 *   TRANSITIONING = Yellow (Nuki only)
 *   ERROR/UNKNOWN = Yellow (caution; blue only for Nuki jammed/error)
 *
 * Day mode  (07:00–19:00): HH:MM:SS at x1, bright colors, BRI 20
 * Night mode (19:00–07:00): HH:MM only at x7 (+6px), ALL colors extremely dim,
 *                            BRI 5. Child must be able to sleep — no bright anything.
 *
 * Brightness heartbeat: re-asserted every 5 min (guards against missed transitions).
 *
 * Debug overrides via MQTT (retained, cleared by publishing empty/null):
 *   pidicon-light/debug/night_override    → "true" | "false"
 *   pidicon-light/debug/battery_pct       → "0"–"100"
 *   pidicon-light/debug/battery_state     → "charging" | "discharging" | "standby"
 *
 * MQTT source topics:
 *   homeassistant/lock/nuki_vr/state                                              → string
 *   z2m/wz/contact/te-door                                                        → {contact: bool}
 *   z2m/vk/contact/w13                                                            → {contact: bool}
 *   z2m/vr/contact/w14                                                            → {contact: bool}
 *   homeassistant/sensor/sonnenbatterie_260365_state_battery_percentage_user/state → "0"–"100"
 *   homeassistant/sensor/sonnenbatterie_260365_state_sonnenbatterie/state          → string
 *
 * Draw layout (day):
 *   x1        time HH:MM:SS (row 0)
 *   x0–6      terrace door segments (row 7)
 *   x13–14    skylight W13 2×2 (rows 6–7)
 *   x16–17    skylight W14 2×2 (rows 6–7)
 *   x25–27    Nuki bar (row 7)
 *   x28       separator (empty)
 *   x29–31    battery icon (rows 1–6, nub at 0 or 7)
 *
 * Draw layout (night):
 *   x7        time HH:MM only (+6px right, shorter text)
 *   sensors + battery: same positions, all extremely dim
 */

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

const DAY = {
  NUKI_UNLOCKED: [0, 255, 0], // Green
  NUKI_LOCKED: [255, 0, 0], // Red
  NUKI_TRANSITIONING: [255, 255, 0], // Yellow
  NUKI_ERROR: [0, 0, 255], // Blue — jammed/error
  OPEN: [0, 255, 0], // Green
  CLOSED: [255, 0, 0], // Red
  UNKNOWN: [255, 255, 0], // Yellow — caution/offline
  TIME: [255, 255, 213], // Warm white
  BRI: 20,
};

// Night: ALL values must be very subtle — child sleeping.
// Max channel value: 40. Error/unknown still visible but not disruptive.
const NIGHT = {
  NUKI_UNLOCKED: [0, 30, 0], // Very dim green
  NUKI_LOCKED: [30, 0, 0], // Very dim red
  NUKI_TRANSITIONING: [25, 25, 0], // Very dim yellow
  NUKI_ERROR: [0, 0, 30], // Very dim blue
  OPEN: [0, 30, 0], // Very dim green
  CLOSED: [30, 0, 0], // Very dim red
  UNKNOWN: [25, 25, 0], // Very dim yellow
  TIME: [20, 12, 12], // Barely visible warm
  BRI: 2, // Absolute minimum brightness
};

// Brightness heartbeat — re-assert every 5 min (missed transition guard)
const BRI_HEARTBEAT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------

export default {
  name: "clock_with_homestats",
  description: "Time + Nuki / terrace / skylights / sonnenbatterie. Day/night.",

  // ---------------------------------------------------------------------------
  // init — subscribe to all topics; retained messages arrive synchronously
  // on next event-loop tick after subscribe ACK (handler registered first)
  // ---------------------------------------------------------------------------
  async init(context) {
    this._state = {
      nukiState: null,
      terraceOpen: null,
      w13Open: null,
      w14Open: null,
      batteryPct: null,
      batteryState: null,
    };

    // Debug overrides — null means "not set" (use real values)
    this._debug = {
      nightOverride: null, // true → force night mode
      batteryPct: null, // override SOC
      batteryState: null, // override charge state
    };

    this._lastMode = null;
    this._lastBriSet = 0;

    // --- Sensor topics -------------------------------------------------------

    context.mqtt.subscribe("homeassistant/lock/nuki_vr/state", (msg) => {
      this._state.nukiState = msg.trim();
    });

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

    context.mqtt.subscribe(
      "homeassistant/sensor/sonnenbatterie_260365_state_battery_percentage_user/state",
      (msg) => {
        const pct = parseFloat(msg);
        this._state.batteryPct = isNaN(pct)
          ? null
          : Math.max(0, Math.min(100, pct));
      },
    );
    context.mqtt.subscribe(
      "homeassistant/sensor/sonnenbatterie_260365_state_sonnenbatterie/state",
      (msg) => {
        this._state.batteryState = msg.trim();
      },
    );

    // --- Debug override topics -----------------------------------------------
    // Retained so they survive restarts. Clear with empty payload or "false"/"null".

    context.mqtt.subscribe("pidicon-light/debug/night_override", (msg) => {
      const v = msg.trim().toLowerCase();
      this._debug.nightOverride =
        v === "true" || v === "1"
          ? true
          : v === "false" || v === "0" || v === "" || v === "null"
            ? null
            : null;
      context.logger.info(
        `[clock_with_homestats] debug night_override = ${this._debug.nightOverride}`,
      );
    });

    context.mqtt.subscribe("pidicon-light/debug/battery_pct", (msg) => {
      const v = msg.trim();
      const pct = parseFloat(v);
      this._debug.batteryPct =
        v === "" || v === "null"
          ? null
          : isNaN(pct)
            ? null
            : Math.max(0, Math.min(100, pct));
      context.logger.info(
        `[clock_with_homestats] debug battery_pct = ${this._debug.batteryPct}`,
      );
    });

    context.mqtt.subscribe("pidicon-light/debug/battery_state", (msg) => {
      const v = msg.trim().toLowerCase();
      this._debug.batteryState = v === "" || v === "null" ? null : v;
      context.logger.info(
        `[clock_with_homestats] debug battery_state = ${this._debug.batteryState}`,
      );
    });
  },

  // ---------------------------------------------------------------------------
  // destroy — clean up all subscriptions on scene eviction / config reload
  // ---------------------------------------------------------------------------
  async destroy(context) {
    context.mqtt.unsubscribeAll();
  },

  // ---------------------------------------------------------------------------
  // render — called every 1000 ms
  // ---------------------------------------------------------------------------
  async render(device) {
    if (!this._state) return 500; // guard: init() not yet complete

    // Determine mode — debug override takes priority
    const hour = new Date().getHours();
    const isDay =
      this._debug.nightOverride === true ? false : hour >= 7 && hour < 19;
    const mode = isDay ? "day" : "night";
    const C = isDay ? DAY : NIGHT;

    // Brightness: assert on mode change or heartbeat
    const modeChanged = mode !== this._lastMode;
    const briHeartbeat = Date.now() - this._lastBriSet >= BRI_HEARTBEAT_MS;
    if (modeChanged || briHeartbeat) {
      await device.setBrightness(C.BRI);
      this._lastBriSet = Date.now();
      this._lastMode = mode;
    }

    // Time string — HH:MM:SS in day, HH:MM only at night (shorter + shifted right)
    const now = new Date();
    const timeStr = isDay
      ? now.toLocaleTimeString("de-AT", {
          timeZone: "Europe/Vienna",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      : now.toLocaleTimeString("de-AT", {
          timeZone: "Europe/Vienna",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });

    // Time x-position: day=1, night=7 (+6px right, centered for shorter text)
    const timeX = isDay ? 1 : 7;

    // Sensor colors
    const nukiColor = this._nukiColor(C);
    const terraceColor = this._openClosedColor(this._state.terraceOpen, C);
    const w13Color = this._openClosedColor(this._state.w13Open, C);
    const w14Color = this._openClosedColor(this._state.w14Open, C);

    // Terrace door gap: closed=gap (tx=1), open=no gap (tx=0)
    const tx = this._state.terraceOpen ? 0 : 1;

    await device.drawCustom({
      draw: [
        { dt: [timeX, 0, timeStr, C.TIME] }, // time
        { dl: [25, 7, 27, 7, nukiColor] }, // nuki bar
        { dr: [13, 6, 2, 2, w13Color] }, // skylight W13
        { dr: [16, 6, 2, 2, w14Color] }, // skylight W14
        { dl: [tx, 7, tx + 2, 7, terraceColor] }, // terrace seg 1
        { dl: [4, 7, 6, 7, terraceColor] }, // terrace seg 2
        ...this._batteryDraw(isDay), // x29–31 battery
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
        return C.NUKI_ERROR;
    }
  },

  _openClosedColor(isOpen, C) {
    if (isOpen === null) return C.UNKNOWN;
    return isOpen ? C.OPEN : C.CLOSED;
  },

  /**
   * Battery icon x29–31, rows 0–7.
   *
   * Body: rows 1–6 (6 rows × 3 cols = 18px = 100%)
   * Nub:  charging → top center (x30, y0)
   *       discharging → bottom center (x30, y7)
   * Fill: always bottom→top, left→right
   * Colors: charging=green, discharging=red; night versions extremely dim.
   */
  _batteryDraw(isDay) {
    const TOTAL_ROWS = 6;
    const TOTAL_PX = TOTAL_ROWS * 3; // 18
    const X_START = 29;
    const X_END = 31;
    const X_NUB = 30;

    // Use debug overrides if set
    const pct = this._debug.batteryPct ?? this._state.batteryPct;
    const state = this._debug.batteryState ?? this._state.batteryState;

    const isCharging = state === "charging";
    const isDischarging = state === "discharging";

    // Colors — night versions must be very subtle
    let fillColor, dimColor;
    if (isDay) {
      fillColor = isCharging ? [0, 255, 0] : [255, 0, 0]; // green or red
      dimColor = isCharging ? [0, 30, 0] : [30, 0, 0];
    } else {
      fillColor = isCharging ? [0, 25, 0] : [25, 0, 0]; // extremely dim
      dimColor = [8, 0, 0]; // barely visible
    }

    const filledPx =
      pct === null
        ? 0
        : pct === 0
          ? 0
          : Math.max(1, Math.round((pct / 100) * TOTAL_PX));

    const cmds = [];
    let filled = 0;

    for (let row = TOTAL_ROWS; row >= 1; row--) {
      const rowFilled = Math.min(3, Math.max(0, filledPx - filled));

      if (rowFilled === 3) {
        cmds.push({ dl: [X_START, row, X_END, row, fillColor] });
      } else if (rowFilled === 0) {
        cmds.push({ dl: [X_START, row, X_END, row, dimColor] });
      } else {
        cmds.push({
          dl: [X_START, row, X_START + rowFilled - 1, row, fillColor],
        });
        cmds.push({ dl: [X_START + rowFilled, row, X_END, row, dimColor] });
      }

      filled += 3;
    }

    if (isCharging) cmds.push({ dp: [X_NUB, 0, fillColor] }); // nub top
    if (isDischarging) cmds.push({ dp: [X_NUB, 7, fillColor] }); // nub bottom

    return cmds;
  },
};
