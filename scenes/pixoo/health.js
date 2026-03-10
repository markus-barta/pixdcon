/**
 * health — Pixoo64 smart home health dashboard
 *
 * 4-tab display: HOME overview, WLAN, ZIGBEE, HEIZUNG
 * Port of health-pixoo (renderer.js + state.js + mqtt-collector logic).
 *
 * Device: Pixoo64 (64×64) via PixooDriver
 * Render interval: 500ms (~2fps)
 * Tab cycling: auto-cycle when hasAlerts(), stay on HOME when green
 */

import { start as startPing } from "../lib/collectors/ping-collector.js";
import { start as startRpc  } from "../lib/collectors/rpc-collector.js";

// ── Embedded config ───────────────────────────────────────────────────────────
// Mirrors health-pixoo/src/config.js — override per-device IPs as needed.

const CONFIG = {
  tabCycleMs:    10_000,
  pingIntervalMs: 60_000,
  rpcIntervalMs:  60_000,

  rssi: { good: -70, warn: -80 },
  lqi:  { good: 100, warn:  60 },

  wifi: [
    {
      label: "bz-sh", name: "Boiler Shelly", ip: "192.168.1.161",
      type: "shelly-gen1",
      mqttTopic: "shellies/bz/boiler/info",
      rssiField: "wifi_sta.rssi",
    },
    {
      label: "wc-sh", name: "Tado Bridge", ip: "192.168.1.168",
      type: "shelly-gen1",
      mqttTopic: "shellies/wc/shelly1-tado-bridge/info",
      rssiField: "wifi_sta.rssi",
    },
    {
      label: "vr-4pm", name: "4PM Heizung", ip: "192.168.1.169",
      type: "shelly-gen2-rpc",
      rpcUrl: "http://192.168.1.169/rpc/Shelly.GetStatus",
      rssiField: "wifi.rssi",
    },
    { label: "vr-fb",  name: "Fritz.box",       ip: "192.168.1.5", type: "ping" },
    { label: "dt-rep", name: "Rep. Dachterr.",   ip: "192.168.1.8", type: "ping" },
    { label: "tg-rep", name: "Rep. Tiefgar.",    ip: "192.168.1.9", type: "ping" },
  ],

  zigbee: [
    { label: "bz-boi", name: "Boiler",      z2mTopic: "z2m/bz/powercontrol/boiler" },
    { label: "bz-hzw", name: "Heizwand bz", z2mTopic: "z2m/bz/plug/zisp09" },
    { label: "wz-nw",  name: "Netzwerk",    z2mTopic: "z2m/wz/plug/zisp10" },
    { label: "vk-wlk", name: "Wasserleck",  z2mTopic: "z2m/vk/waterleak/washingmachine" },
    { label: "sz-hzg", name: "Heizung sz",  z2mTopic: "z2m/sz/plug/zisp26" },
    { label: "ki-hzg", name: "Heizung ki",  z2mTopic: "z2m/ki/plug/zisp37" },
  ],

  services: [
    { label: "MQTT", type: "implicit" },
    { label: "NR",   type: "http", url: "http://localhost:1880" },
    { label: "HA",   type: "http", url: "http://localhost:8123" },
  ],

  healthTopics: {
    boiler:    "jhw2211/health/boiler",
    heatChain: "jhw2211/health/heat-chain",
  },
};

// ── Palette ───────────────────────────────────────────────────────────────────
const PAL = {
  white:    [255, 255, 255, 255],
  dimWhite: [160, 160, 160, 255],
  dimGrey:  [ 60,  60,  60, 255],
  ok:       [  0, 220, 100, 255],
  warn:     [255, 180,   0, 255],
  bad:      [220,  40,  40, 255],
  offline:  [ 80,  20,  20, 255],
  cyan:     [  0, 200, 220, 255],
  amber:    [255, 160,   0, 255],
  dimGrey2: [ 18,  18,  18, 255], // signal bar background

  barOk:    [[  0,  60,  20, 255], [  0, 220, 100, 255]],
  barWarn:  [[ 80,  50,   0, 255], [255, 180,   0, 255]],
  barBad:   [[ 80,  10,  10, 255], [220,  40,  40, 255]],
  barOff:   [[ 30,  10,  10, 255], [ 80,  20,  20, 255]],
};

// ── State helpers ─────────────────────────────────────────────────────────────

function isWifiHealthy(state, label) {
  const s = state.wifi[label];
  if (!s || !s.online) return "offline";
  if (s.rssi === null) return "ok"; // ping-only, alive = ok
  if (s.rssi >= CONFIG.rssi.good) return "ok";
  if (s.rssi >= CONFIG.rssi.warn) return "warn";
  return "bad";
}

function isZigbeeHealthy(state, label) {
  const s = state.zigbee[label];
  if (!s || !s.available) return "offline";
  if (s.lqi === null) return "ok";
  if (s.lqi >= CONFIG.lqi.good) return "ok";
  if (s.lqi >= CONFIG.lqi.warn) return "warn";
  return "bad";
}

function overallHealth(state) {
  const wifiStates = CONFIG.wifi.map((d) => isWifiHealthy(state, d.label));
  const zbStates   = CONFIG.zigbee.map((d) => isZigbeeHealthy(state, d.label));
  const svcStates  = Object.values(state.services).map((s) => (s.alive ? "ok" : "offline"));
  const heatState  =
    state.boiler.state === "ok" && state.heatChain.state !== "mismatch" ? "ok" : "warn";

  const all = [...wifiStates, ...zbStates, ...svcStates, heatState];
  if (all.some((s) => s === "offline" || s === "bad")) return "red";
  if (all.some((s) => s === "warn"))                   return "yellow";
  return "green";
}

function hasAlerts(state) {
  return overallHealth(state) !== "green";
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function healthColor(h) {
  if (h === "ok")      return PAL.ok;
  if (h === "warn")    return PAL.warn;
  if (h === "offline") return PAL.offline;
  return PAL.bad;
}

function healthBarGrad(h) {
  if (h === "ok")      return PAL.barOk;
  if (h === "warn")    return PAL.barWarn;
  if (h === "offline") return PAL.barOff;
  return PAL.barBad;
}

function interpolateColor(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}

// ── Low-level drawing helpers ─────────────────────────────────────────────────

function separator(d, y) {
  for (let x = 0; x < 64; x++) d._setPixel(x, y, 40, 40, 40);
}

function dot(d, x, y, color) {
  const [r, g, b] = color;
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const f = (dx === 0 && dy === 0) ? 1.4 : (dx === 2 && dy === 2) ? 0.5 : 1.0;
      d._setPixel(
        x + dx, y + dy,
        Math.min(255, Math.round(r * f)),
        Math.min(255, Math.round(g * f)),
        Math.min(255, Math.round(b * f)),
      );
    }
  }
}

function drawCheckmark(d, x, y, color) {
  const [r, g, b] = color;
  d._setPixel(x + 0, y + 0, r, g, b);
  d._setPixel(x + 1, y + 1, r, g, b);
  d._setPixel(x + 2, y + 0, r, g, b);
  d._setPixel(x + 3, y - 1, r, g, b);
}

async function gradientBar(d, x, y, w, h, darkColor, brightColor) {
  for (let i = 0; i < w; i++) {
    const factor = w > 1 ? i / (w - 1) : 0;
    const [r, g, b] = interpolateColor(darkColor, brightColor, factor);
    for (let row = 0; row < h; row++) d._setPixel(x + i, y + row, r, g, b);
  }
}

async function signalBar(d, x, y, totalW, h, level, health) {
  const filled = Math.round(level * totalW);
  const [dark, bright] = healthBarGrad(health);

  // Empty background
  for (let i = 0; i < totalW; i++)
    for (let row = 0; row < h; row++) d._setPixel(x + i, y + row, 18, 18, 18);

  if (filled > 0) {
    await gradientBar(d, x, y, filled, h, dark, bright);
    // Drop shadow: darken top row of filled portion
    for (let i = 0; i < filled; i++) {
      const idx = (y * 64 + (x + i)) * 3;
      d.buf[idx]     = Math.round(d.buf[idx]     * 0.4);
      d.buf[idx + 1] = Math.round(d.buf[idx + 1] * 0.4);
      d.buf[idx + 2] = Math.round(d.buf[idx + 2] * 0.4);
    }
  }
}

function applyScanlines(d, startY, endY, alpha = 0.18) {
  for (let y = startY; y < endY; y += 2) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 3;
      d.buf[i]     = Math.round(d.buf[i]     * (1 - alpha));
      d.buf[i + 1] = Math.round(d.buf[i + 1] * (1 - alpha));
      d.buf[i + 2] = Math.round(d.buf[i + 2] * (1 - alpha));
    }
  }
}

let glowPhase = 0;
function ambientGlow(d, startY, health) {
  glowPhase = (glowPhase + 0.04) % (Math.PI * 2);
  const intensity = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(glowPhase));
  const base =
    health === "green"  ? [0, 100, 40] :
    health === "yellow" ? [100, 70, 0] :
                          [100, 10, 10];

  for (let y = startY; y < 64; y++) {
    const fade = (y - startY) / (64 - startY);
    for (let x = 0; x < 64; x++) {
      d._setPixel(
        x, y,
        Math.round(base[0] * intensity * fade),
        Math.round(base[1] * intensity * fade),
        Math.round(base[2] * intensity * fade),
      );
    }
  }
  applyScanlines(d, startY, 64, 0.25);
}

// ── Tab header ────────────────────────────────────────────────────────────────

async function drawHeader(d, title, tabNum, totalTabs) {
  // Diamond accent (cyan)
  const [cr, cg, cb] = PAL.cyan;
  d._setPixel(1, 1, cr, cg, cb);
  d._setPixel(2, 0, cr, cg, cb);
  d._setPixel(2, 2, cr, cg, cb);
  d._setPixel(3, 1, cr, cg, cb);

  await d.drawTextRgbaAligned(title, [5, 0], PAL.white, "left");
  if (totalTabs > 1) {
    await d.drawTextRgbaAligned(`${tabNum}/${totalTabs}`, [63, 0], PAL.dimGrey, "right");
  }
  separator(d, 6);
}

async function drawClock(d, x, y) {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, "0");
  const mm  = String(now.getMinutes()).padStart(2, "0");
  await d.drawTextRgbaAligned(`${hh}:${mm}`, [x, y], PAL.dimWhite, "right");
}

// ── Tab 0: HOME ───────────────────────────────────────────────────────────────

async function renderOverview(d, state) {
  const health = overallHealth(state);

  await drawHeader(d, "HOME", 0, 0);
  await drawClock(d, 63, 0);

  // WLAN row
  await d.drawTextRgbaAligned("WLAN", [0, 8], PAL.dimWhite, "left");
  for (let i = 0; i < CONFIG.wifi.length; i++) {
    dot(d, 22 + i * 7, 8, healthColor(isWifiHealthy(state, CONFIG.wifi[i].label)));
  }

  // Zigbee row
  await d.drawTextRgbaAligned("ZB  ", [0, 15], PAL.dimWhite, "left");
  for (let i = 0; i < CONFIG.zigbee.length; i++) {
    dot(d, 22 + i * 7, 15, healthColor(isZigbeeHealthy(state, CONFIG.zigbee[i].label)));
  }

  // Services row
  await d.drawTextRgbaAligned("SVC", [0, 23], PAL.dimWhite, "left");
  const svcKeys  = Object.keys(state.services);
  const svcShort = ["MQ", "NR", "HA"];
  for (let i = 0; i < svcKeys.length; i++) {
    const svc   = state.services[svcKeys[i]];
    const color = svc.alive ? PAL.ok : PAL.bad;
    dot(d, 22 + i * 14, 23, color);
    await d.drawTextRgbaAligned(
      svcShort[i] || svcKeys[i].slice(0, 2),
      [27 + i * 14, 23],
      PAL.dimGrey,
      "left",
    );
  }

  separator(d, 28);

  // Boiler row
  const boilerOk = state.boiler.state === "ok";
  await d.drawTextRgbaAligned("Boiler", [0, 30], PAL.dimWhite, "left");
  if (state.boiler.tempC !== null) {
    const tempVal = `${Math.round(state.boiler.tempC)}`;
    const tempW   = tempVal.length * 4 - 1;
    await d.drawTextRgbaAligned(tempVal, [25, 30], PAL.amber, "left");
    const degX = 25 + tempW + 1;
    d._blendPixel(degX, 30, 255, 160, 0, 128);
    await d.drawTextRgbaAligned("C", [degX + 2, 30], PAL.amber, "left");
    const markX = degX + 2 + 4;
    if (boilerOk) drawCheckmark(d, markX, 31, PAL.ok);
    else          await d.drawTextRgbaAligned("!", [markX, 30], PAL.bad, "left");
  } else {
    await d.drawTextRgbaAligned("---", [25, 30], PAL.dimGrey, "left");
  }

  // Heat chain row
  const chainOk   = state.heatChain.state !== "mismatch";
  const chainDisp =
    state.heatChain.state === "unknown" ? "?" : (chainOk ? "OK" : "FEHLER");
  await d.drawTextRgbaAligned("FBH-WC", [0, 37], PAL.dimWhite, "left");
  await d.drawTextRgbaAligned(chainDisp, [24, 37], chainOk ? PAL.ok : PAL.bad, "left");
  if (chainOk && state.heatChain.state !== "unknown") drawCheckmark(d, 36, 36, PAL.ok);

  separator(d, 43);
  ambientGlow(d, 44, health);
}

// ── Tab 1: WLAN ───────────────────────────────────────────────────────────────

async function renderWlan(d, state) {
  await drawHeader(d, "WLAN", 1, 4);

  for (let i = 0; i < CONFIG.wifi.length; i++) {
    const dev  = CONFIG.wifi[i];
    const s    = state.wifi[dev.label];
    const h    = isWifiHealthy(state, dev.label);
    const y    = 8 + i * 9;

    await d.drawTextRgbaAligned(dev.label, [0, y], PAL.dimWhite, "left");

    let level = 0;
    if (s.online) {
      level = s.rssi !== null
        ? Math.min(1, Math.max(0, (s.rssi + 100) / 50))
        : 1.0;
    }
    await signalBar(d, 25, y + 1, 24, 3, level, h);

    const valStr = !s.online ? "OFF" : s.rssi !== null ? `${s.rssi}` : "OK";
    await d.drawTextRgbaAligned(valStr, [63, y], healthColor(h), "right");
  }
}

// ── Tab 2: ZIGBEE ─────────────────────────────────────────────────────────────

async function renderZigbee(d, state) {
  await drawHeader(d, "ZIGBEE", 2, 4);

  for (let i = 0; i < CONFIG.zigbee.length; i++) {
    const dev   = CONFIG.zigbee[i];
    const s     = state.zigbee[dev.label];
    const h     = isZigbeeHealthy(state, dev.label);
    const y     = 8 + i * 9;

    await d.drawTextRgbaAligned(dev.label, [0, y], PAL.dimWhite, "left");

    const level = s.available && s.lqi !== null ? Math.min(1, s.lqi / 255) : 0;
    await signalBar(d, 25, y + 1, 24, 3, level, h);

    const valStr = !s.available ? "OFF" : s.lqi !== null ? `${s.lqi}` : "OK";
    await d.drawTextRgbaAligned(valStr, [63, y], healthColor(h), "right");
  }
}

// ── Tab 3: HEIZUNG ────────────────────────────────────────────────────────────

async function renderHeizung(d, state) {
  await drawHeader(d, "HEIZUNG", 3, 4);

  const tempStr   = state.boiler.tempC !== null ? `${Math.round(state.boiler.tempC)}` : "---";
  const nrStr     = state.boiler.nrRunning === true ? "OK" : state.boiler.nrRunning === false ? "ERR" : "?";
  const boilerCol =
    state.boiler.state === "ok"      ? PAL.ok :
    state.boiler.state === "unknown" ? PAL.warn : PAL.bad;

  await d.drawTextRgbaAligned("BOILER", [0, 8], PAL.dimWhite, "left");
  if (state.boiler.tempC !== null) {
    const tempW = tempStr.length * 4 - 1;
    await d.drawTextRgbaAligned(tempStr, [28, 8], PAL.amber, "left");
    const degX = 28 + tempW + 1;
    d._blendPixel(degX, 8, 255, 160, 0, 128);
    await d.drawTextRgbaAligned("C", [degX + 2, 8], PAL.amber, "left");
    await d.drawTextRgbaAligned(`NR:${nrStr}`, [degX + 7, 8], boilerCol, "left");
  } else {
    await d.drawTextRgbaAligned("---", [28, 8], PAL.dimGrey, "left");
    await d.drawTextRgbaAligned(`NR:${nrStr}`, [44, 8], boilerCol, "left");
  }

  if (state.boiler.tempC !== null) {
    const level = Math.min(1, Math.max(0, state.boiler.tempC / 80));
    await signalBar(d, 0, 15, 64, 2, level, state.boiler.state === "ok" ? "ok" : "warn");
  }

  separator(d, 19);

  const chainState = state.heatChain.state;
  const chainColor =
    chainState === "ok"      ? PAL.ok :
    chainState === "unknown" ? PAL.warn : PAL.bad;
  const chainStr =
    chainState === "ok"       ? "OK" :
    chainState === "mismatch" ? "FEHLER" : "?";

  await d.drawTextRgbaAligned("FBH-WC", [0, 21], PAL.dimWhite, "left");
  await d.drawTextRgbaAligned(chainStr, [28, 21], chainColor, "left");

  const inputStr  = state.heatChain.input0  === null ? "?" : (state.heatChain.input0  ? "AN" : "AUS");
  const outputStr = state.heatChain.output1 === null ? "?" : (state.heatChain.output1 ? "AN" : "AUS");
  await d.drawTextRgbaAligned("SH:",   [ 0, 28], PAL.dimGrey, "left");
  await d.drawTextRgbaAligned(inputStr, [12, 28], state.heatChain.input0  ? PAL.warn : PAL.ok, "left");
  await d.drawTextRgbaAligned("4PM:", [32, 28], PAL.dimGrey, "left");
  await d.drawTextRgbaAligned(outputStr, [52, 28], state.heatChain.output1 ? PAL.warn : PAL.ok, "left");

  if (chainState === "mismatch") {
    await d.drawTextRgbaAligned("HEIZUNG LAEUFT!", [0, 36], PAL.bad, "left");
  } else if (state.heatChain.checkedAt) {
    const t = state.heatChain.checkedAt;
    const ts = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    await d.drawTextRgbaAligned(`Check: ${ts}`, [0, 36], PAL.dimGrey, "left");
  }

  separator(d, 43);
  ambientGlow(d, 44, chainState === "ok" ? "green" : "red");
}

// ── MQTT message handler ──────────────────────────────────────────────────────

function handleMqtt(topic, raw, state, logger) {
  try {
    // Shelly Gen1 /online
    const wifiOnline = CONFIG.wifi.find(
      (d) => d.type === "shelly-gen1" && topic === d.mqttTopic.replace("/info", "/online"),
    );
    if (wifiOnline) {
      state.wifi[wifiOnline.label].online  = raw === "true";
      state.wifi[wifiOnline.label].lastSeen = new Date();
      return;
    }

    // Shelly Gen1 /info (RSSI)
    const wifiInfo = CONFIG.wifi.find(
      (d) => d.type === "shelly-gen1" && topic === d.mqttTopic,
    );
    if (wifiInfo) {
      const data = JSON.parse(raw);
      const rssi = wifiInfo.rssiField
        .split(".")
        .reduce((cur, k) => (cur != null && cur[k] !== undefined ? cur[k] : null), data);
      if (rssi !== null) {
        state.wifi[wifiInfo.label].rssi    = rssi;
        state.wifi[wifiInfo.label].online  = true;
        state.wifi[wifiInfo.label].lastSeen = new Date();
      }
      return;
    }

    // Tado bridge input/0 (heat chain)
    if (topic === "shellies/wc/shelly1-tado-bridge/input/0") {
      state.heatChain.input0 = raw === "1";
      return;
    }

    // Z2M availability
    const zbAvail = CONFIG.zigbee.find((d) => topic === `${d.z2mTopic}/availability`);
    if (zbAvail) {
      const data = JSON.parse(raw);
      state.zigbee[zbAvail.label].available = data.state === "online";
      state.zigbee[zbAvail.label].lastSeen  = new Date();
      return;
    }

    // Z2M state (LQI)
    const zbState = CONFIG.zigbee.find((d) => topic === d.z2mTopic);
    if (zbState) {
      const data = JSON.parse(raw);
      if (data.linkquality !== undefined) {
        state.zigbee[zbState.label].lqi     = data.linkquality;
        state.zigbee[zbState.label].lastSeen = new Date();
      }
      return;
    }

    // Node-RED health: boiler
    if (topic === CONFIG.healthTopics.boiler) {
      const data = JSON.parse(raw);
      state.boiler.state       = data.state || "unknown";
      state.boiler.tempC       = data.temp_c ?? null;
      state.boiler.nrRunning   = data.nr_running ?? null;
      state.boiler.lastChecked = new Date();
      return;
    }

    // Node-RED health: heat-chain
    if (topic === CONFIG.healthTopics.heatChain) {
      const data = JSON.parse(raw);
      state.heatChain.state     = data.state || "unknown";
      state.heatChain.checkedAt = data.checked_at ? new Date(data.checked_at) : new Date();
      return;
    }
  } catch (err) {
    logger.debug(`[health] MQTT parse error on ${topic}: ${err.message}`);
  }
}

// ── Scene export ──────────────────────────────────────────────────────────────

export default {
  name: "health",
  pretty_name: "Health Dashboard",
  deviceType: "pixoo",
  description: "Smart home health dashboard — 4-tab Pixoo64 display.",

  async init(context) {
    this._logger = context.logger;

    // Build state
    this._state = {
      wifi:   {},
      zigbee: {},
      services: {
        MQTT: { alive: true,  lastChecked: null },
        NR:   { alive: false, lastChecked: null },
        HA:   { alive: false, lastChecked: null },
      },
      boiler: { state: "unknown", tempC: null, nrRunning: null, lastChecked: null },
      heatChain: { state: "unknown", checkedAt: null, output1: null, input0: null },
    };
    for (const d of CONFIG.wifi)   this._state.wifi[d.label]   = { rssi: null, online: false, lastSeen: null };
    for (const d of CONFIG.zigbee) this._state.zigbee[d.label] = { lqi: null, available: false, lastSeen: null };

    this._currentTab = 0;
    this._tabTimer   = null;
    this._collectors = [];

    // Start background collectors
    this._collectors.push(startPing(CONFIG, this._state, context.logger));
    this._collectors.push(startRpc(CONFIG, this._state, context.logger));

    // Subscribe to MQTT topics
    const sub = (topic) =>
      context.mqtt.subscribe(topic, (msg) => handleMqtt(topic, msg, this._state, context.logger));

    for (const d of CONFIG.wifi.filter((d) => d.type === "shelly-gen1")) {
      sub(d.mqttTopic);
      sub(d.mqttTopic.replace("/info", "/online"));
    }
    sub("shellies/wc/shelly1-tado-bridge/input/0");

    for (const d of CONFIG.zigbee) {
      sub(`${d.z2mTopic}/availability`);
      sub(d.z2mTopic);
    }

    sub(CONFIG.healthTopics.boiler);
    sub(CONFIG.healthTopics.heatChain);

    context.logger.info("[health] Scene initialized");
  },

  async destroy(context) {
    if (this._tabTimer) {
      clearInterval(this._tabTimer);
      this._tabTimer = null;
    }
    for (const c of this._collectors) c.stop?.();
    this._collectors = [];
    context.mqtt.unsubscribeAll();
    context.logger.info("[health] Scene destroyed");
  },

  async render(device) {
    if (!this._state) return 500;

    // Update tab auto-cycling based on alerts
    const alerts = hasAlerts(this._state);
    if (alerts && !this._tabTimer) {
      this._tabTimer = setInterval(() => {
        this._currentTab = (this._currentTab + 1) % 4;
      }, CONFIG.tabCycleMs);
    } else if (!alerts && this._tabTimer) {
      clearInterval(this._tabTimer);
      this._tabTimer   = null;
      this._currentTab = 0;
    }

    device.buf.fill(0);

    try {
      switch (this._currentTab) {
        case 0: await renderOverview(device, this._state); break;
        case 1: await renderWlan(device, this._state);     break;
        case 2: await renderZigbee(device, this._state);   break;
        case 3: await renderHeizung(device, this._state);  break;
      }
      if (this._currentTab === 0) applyScanlines(device, 7, 44, 0.12);
      await device.push();
    } catch (err) {
      this._logger?.warn(`[health] Render error (tab ${this._currentTab}): ${err.message}`);
    }

    return 500;
  },
};
