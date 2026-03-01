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
 *   ERROR/UNKNOWN = Yellow (caution); Blue only for Nuki jammed/error
 *
 * Day mode  (configurable, default 07:00–19:00): HH:MM:SS at x1, bright colors
 * Night mode (configurable, default 19:00–07:00): HH:MM at x7, all colors dim,
 *   child-safe brightness. No bright anything — boy must sleep well.
 *
 * Brightness heartbeat: re-asserted every 5 min (guards missed transitions).
 *
 * ── Settings topics (device+scene scoped, retained) ─────────────────────────
 * pidicon-light/<device>/<scene>/settings/day_start_hour   default: 7
 * pidicon-light/<device>/<scene>/settings/night_start_hour default: 19
 * pidicon-light/<device>/<scene>/settings/bri_day          default: 20
 * pidicon-light/<device>/<scene>/settings/bri_night        default: 8
 *
 * ── Debug override topics (global, retained, cleared with empty payload) ────
 * pidicon-light/debug/mode_override    "day" | "night" | ""
 * pidicon-light/debug/bri_override     1–255 | ""
 * pidicon-light/debug/battery_pct      0–100 | ""
 * pidicon-light/debug/battery_state    "charging" | "discharging" | "standby" | ""
 *
 * ── Sensor source topics ────────────────────────────────────────────────────
 * homeassistant/lock/nuki_vr/state                                              → string
 * z2m/wz/contact/te-door                                                        → {contact: bool}
 * z2m/vk/contact/w13                                                            → {contact: bool}
 * z2m/vr/contact/w14                                                            → {contact: bool}
 * Sonnenbatterie: polled directly via API every 3s (not MQTT — HA publishes too slowly)
 *   http://$SONNEN_BATTERY_HOST/api/v2/status  Auth-Token: $SONNEN_BATTERY_API_TOKEN
 *   Fields used: BatteryCharging (bool), BatteryDischarging (bool), USOC (0–100)
 *
 * ── Draw layout ─────────────────────────────────────────────────────────────
 * Day:   x1  time HH:MM:SS
 * Night: x7  time HH:MM (+6px right, shorter text)
 * x0–6   terrace door segments (row 7)
 * x13–14 skylight W13 2×2 (rows 6–7)
 * x16–17 skylight W14 2×2 (rows 6–7)
 * x25–27 Nuki bar (row 7)
 * x28    separator (empty)
 * x29–31 battery icon (rows 1–6, nub at row 0 or 7)
 */

// ---------------------------------------------------------------------------
// Default color palettes
// ---------------------------------------------------------------------------

const DAY = {
  NUKI_UNLOCKED: [0, 255, 0],
  NUKI_LOCKED: [255, 0, 0],
  NUKI_TRANSITIONING: [255, 255, 0],
  NUKI_ERROR: [0, 0, 255],
  OPEN: [0, 255, 0],
  CLOSED: [255, 0, 0],
  UNKNOWN: [255, 255, 0],
  TIME: [255, 255, 213],
};

// Night: dim but visible — max ~40 per channel, TIME in warm red
const NIGHT = {
  NUKI_UNLOCKED: [0, 40, 0],
  NUKI_LOCKED: [40, 0, 0],
  NUKI_TRANSITIONING: [35, 35, 0],
  NUKI_ERROR: [0, 0, 40],
  OPEN: [0, 40, 0],
  CLOSED: [40, 0, 0],
  UNKNOWN: [35, 35, 0],
  TIME: [80, 30, 20], // dim warm red — readable in dark room
};

// Brightness heartbeat — re-assert every 5 min (missed transition guard)
const BRI_HEARTBEAT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------

export default {
  name: "clock_with_homestats",
  description: "Time + Nuki / terrace / skylights / sonnenbatterie. Day/night.",

  // ---------------------------------------------------------------------------
  // init
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

    // Settings — overridable via MQTT, fallback to defaults
    this._settings = {
      dayStartHour: 7,
      nightStartHour: 19,
      briDay: 20,
      briNight: 8,
    };

    // Debug overrides — null = not active
    this._debug = {
      modeOverride: null, // "day" | "night" | null
      briOverride: null, // number | null
      batteryPct: null,
      batteryState: null,
    };

    this._lastMode = null;
    this._lastBriSet = 0;

    const S = context.settingsTopic; // pidicon-light/<device>/<scene>/settings

    // --- Settings -----------------------------------------------------------

    const parseHour = (msg) => {
      const h = parseInt(msg.trim(), 10);
      return !isNaN(h) && h >= 0 && h <= 23 ? h : null;
    };
    const parseBri = (msg) => {
      const b = parseInt(msg.trim(), 10);
      return !isNaN(b) && b >= 1 && b <= 255 ? b : null;
    };

    context.mqtt.subscribe(`${S}/day_start_hour`, (msg) => {
      const v = parseHour(msg);
      if (v !== null) {
        this._settings.dayStartHour = v;
        context.logger.info(`[${this.name}] day_start_hour = ${v}`);
      }
    });
    context.mqtt.subscribe(`${S}/night_start_hour`, (msg) => {
      const v = parseHour(msg);
      if (v !== null) {
        this._settings.nightStartHour = v;
        context.logger.info(`[${this.name}] night_start_hour = ${v}`);
      }
    });
    context.mqtt.subscribe(`${S}/bri_day`, (msg) => {
      const v = parseBri(msg);
      if (v !== null) {
        this._settings.briDay = v;
        this._lastBriSet = 0;
        context.logger.info(`[${this.name}] bri_day = ${v}`);
      }
    });
    context.mqtt.subscribe(`${S}/bri_night`, (msg) => {
      const v = parseBri(msg);
      if (v !== null) {
        this._settings.briNight = v;
        this._lastBriSet = 0;
        context.logger.info(`[${this.name}] bri_night = ${v}`);
      }
    });

    // --- Sensor topics ------------------------------------------------------

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

    // --- Sonnenbatterie API poll (every 3s, direct — faster than HA MQTT) ------
    // Env vars injected via agenix: SONNEN_BATTERY_HOST, SONNEN_BATTERY_API_TOKEN
    this._startSonnenPoll(context.logger);

    // --- Debug overrides ----------------------------------------------------

    const clearable = (msg, parser) => {
      const v = msg.trim();
      return v === "" || v === "null" ? null : parser(v);
    };

    context.mqtt.subscribe("pidicon-light/debug/mode_override", (msg) => {
      const v = msg.trim().toLowerCase();
      this._debug.modeOverride = v === "day" || v === "night" ? v : null;
      this._lastBriSet = 0; // force brightness re-assert on mode change
      context.logger.info(
        `[${this.name}] debug mode_override = ${this._debug.modeOverride}`,
      );
    });

    context.mqtt.subscribe("pidicon-light/debug/bri_override", (msg) => {
      this._debug.briOverride = clearable(msg, (v) => {
        const b = parseInt(v, 10);
        return !isNaN(b) && b >= 1 && b <= 255 ? b : null;
      });
      this._lastBriSet = 0;
      context.logger.info(
        `[${this.name}] debug bri_override = ${this._debug.briOverride}`,
      );
    });

    context.mqtt.subscribe("pidicon-light/debug/battery_pct", (msg) => {
      this._debug.batteryPct = clearable(msg, (v) => {
        const pct = parseFloat(v);
        return isNaN(pct) ? null : Math.max(0, Math.min(100, pct));
      });
      context.logger.info(
        `[${this.name}] debug battery_pct = ${this._debug.batteryPct}`,
      );
    });

    context.mqtt.subscribe("pidicon-light/debug/battery_state", (msg) => {
      this._debug.batteryState = clearable(msg, (v) => v || null);
      context.logger.info(
        `[${this.name}] debug battery_state = ${this._debug.batteryState}`,
      );
    });
  },

  // ---------------------------------------------------------------------------
  // destroy
  // ---------------------------------------------------------------------------
  async destroy(context) {
    context.mqtt.unsubscribeAll();
    this._stopSonnenPoll();
  },

  // ---------------------------------------------------------------------------
  // render — called every 1000 ms
  // ---------------------------------------------------------------------------
  async render(device) {
    if (!this._state) return 500;

    const hour = new Date().getHours();
    const { dayStartHour, nightStartHour, briDay, briNight } = this._settings;

    // Mode: debug override > time-based
    const isDay =
      this._debug.modeOverride === "day"
        ? true
        : this._debug.modeOverride === "night"
          ? false
          : hour >= dayStartHour && hour < nightStartHour;

    const mode = isDay ? "day" : "night";
    const C = isDay ? DAY : NIGHT;

    // Brightness: debug override > settings
    const targetBri = this._debug.briOverride ?? (isDay ? briDay : briNight);

    const modeChanged = mode !== this._lastMode;
    const briHeartbeat = Date.now() - this._lastBriSet >= BRI_HEARTBEAT_MS;
    if (modeChanged || briHeartbeat) {
      await device.setBrightness(targetBri);
      this._lastBriSet = Date.now();
      this._lastMode = mode;
    }

    // Time
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
    const timeX = isDay ? 1 : 7;

    // Sensor colors
    const nukiColor = this._nukiColor(C);
    const terraceColor = this._openClosedColor(this._state.terraceOpen, C);
    const w13Color = this._openClosedColor(this._state.w13Open, C);
    const w14Color = this._openClosedColor(this._state.w14Open, C);
    const tx = this._state.terraceOpen ? 0 : 1; // closed=gap

    await device.drawCustom({
      draw: [
        { dt: [timeX, 0, timeStr, C.TIME] },
        { dl: [25, 7, 27, 7, nukiColor] },
        { dr: [13, 6, 2, 2, w13Color] },
        { dr: [16, 6, 2, 2, w14Color] },
        { dl: [tx, 7, tx + 2, 7, terraceColor] },
        { dl: [4, 7, 6, 7, terraceColor] },
        ...this._batteryDraw(isDay),
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
   * Start polling sonnenbatterie API every 3s.
   * Uses SONNEN_BATTERY_HOST + SONNEN_BATTERY_API_TOKEN from env (injected via agenix).
   * Falls back gracefully if env vars not set (no crash, just null state).
   */
  _startSonnenPoll(logger) {
    const host = process.env.SONNEN_BATTERY_HOST;
    const token = process.env.SONNEN_BATTERY_API_TOKEN;

    if (!host || !token) {
      logger.warn(
        "[clock_with_homestats] SONNEN_BATTERY_HOST / SONNEN_BATTERY_API_TOKEN not set — battery polling disabled",
      );
      return;
    }

    const url = `http://${host}/api/v2/status`;

    const poll = async () => {
      try {
        const res = await fetch(url, {
          headers: { "Auth-Token": token },
          signal: AbortSignal.timeout(2500), // 2.5s timeout — must finish before next poll
        });

        if (!res.ok) {
          logger.warn(`[clock_with_homestats] Sonnen API HTTP ${res.status}`);
          return;
        }

        const data = await res.json();

        // USOC = user state of charge (0–100)
        const pct = parseFloat(data.USOC);
        this._state.batteryPct = isNaN(pct)
          ? null
          : Math.max(0, Math.min(100, pct));

        // Derive state from boolean flags (more reliable than string status)
        if (data.BatteryCharging === true)
          this._state.batteryState = "charging";
        else if (data.BatteryDischarging === true)
          this._state.batteryState = "discharging";
        else this._state.batteryState = "standby";
      } catch (err) {
        // Network error / timeout — keep last known values, don't crash
        logger.warn(
          `[clock_with_homestats] Sonnen API poll failed: ${err.message}`,
        );
      }
    };

    // Poll immediately on start, then every 3s
    poll();
    this._sonnenPollInterval = setInterval(poll, 3000);
    logger.info(
      `[clock_with_homestats] Sonnenbatterie polling started (${url}, every 3s)`,
    );
  },

  _stopSonnenPoll() {
    if (this._sonnenPollInterval) {
      clearInterval(this._sonnenPollInterval);
      this._sonnenPollInterval = null;
    }
  },

  /**
   * Battery icon x29–31, rows 0–7.
   *
   * Total fillable pixels: 19 (3×6 body + 1 nub).
   *
   * Charging (nub top, y0):
   *   Fill order: row6 → row5 → ... → row1 → nub(y0)
   *   Nub is last to fill — only lights up near 100%.
   *
   * Discharging (nub bottom, y7):
   *   Fill order: nub(y7) → row6 → row5 → ... → row1
   *   Nub is first filled, last to empty — stays lit until nearly dead.
   */
  _batteryDraw(isDay) {
    const TOTAL_ROWS = 6;
    const TOTAL_PX = 19; // 18 body + 1 nub
    const X_START = 29;
    const X_END = 31;
    const X_NUB = 30;

    const pct = this._debug.batteryPct ?? this._state.batteryPct;
    const state = this._debug.batteryState ?? this._state.batteryState;

    const isCharging = state === "charging";
    const isDischarging = state === "discharging";

    let fillColor, dimColor, nubDimColor;
    if (isDay) {
      fillColor = isCharging ? [0, 255, 0] : [255, 0, 0];
      dimColor = isCharging ? [0, 30, 0] : [30, 0, 0];
      nubDimColor = dimColor;
    } else {
      fillColor = isCharging ? [0, 60, 0] : [60, 0, 0];
      dimColor = [20, 0, 0];
      nubDimColor = [40, 0, 0]; // more visible than body dim — nub outline always findable
    }

    const filledPx =
      pct === null
        ? 0
        : pct === 0
          ? 0
          : Math.max(1, Math.round((pct / 100) * TOTAL_PX));

    const cmds = [];

    if (isDischarging) {
      // Nub at bottom — counts as pixel 1, last to empty
      // filledPx includes nub: if filledPx >= 1 → nub lit
      const nubLit = filledPx >= 1;
      cmds.push({ dp: [X_NUB, 7, nubLit ? fillColor : nubDimColor] });

      // Body: rows 6→1, remaining filled pixels after nub
      const bodyFilled = Math.max(0, filledPx - 1);
      let filled = 0;
      for (let row = TOTAL_ROWS; row >= 1; row--) {
        const rowFilled = Math.min(3, Math.max(0, bodyFilled - filled));
        cmds.push(
          ...this._rowCmds(row, rowFilled, X_START, X_END, fillColor, dimColor),
        );
        filled += 3;
      }
    } else {
      // Charging or standby — nub at top, fills last
      // Body: rows 6→1 first
      let filled = 0;
      for (let row = TOTAL_ROWS; row >= 1; row--) {
        const rowFilled = Math.min(3, Math.max(0, filledPx - filled));
        cmds.push(
          ...this._rowCmds(row, rowFilled, X_START, X_END, fillColor, dimColor),
        );
        filled += 3;
      }
      // Nub: only lights up when all 18 body pixels are filled
      const nubLit = filledPx >= 19;
      if (isCharging) {
        cmds.push({ dp: [X_NUB, 0, nubLit ? fillColor : nubDimColor] });
      }
      // standby: no nub drawn
    }

    return cmds;
  },

  /** Build line draw commands for one battery row. */
  _rowCmds(row, rowFilled, xStart, xEnd, fillColor, dimColor) {
    if (rowFilled === 3) {
      return [{ dl: [xStart, row, xEnd, row, fillColor] }];
    } else if (rowFilled === 0) {
      return [{ dl: [xStart, row, xEnd, row, dimColor] }];
    } else {
      return [
        { dl: [xStart, row, xStart + rowFilled - 1, row, fillColor] },
        { dl: [xStart + rowFilled, row, xEnd, row, dimColor] },
      ];
    }
  },
};
