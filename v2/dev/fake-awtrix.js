/**
 * Fake Ulanzi TC001 / AWTRIX: an HTTP server that answers like the firmware.
 *
 * Speaks the routes pixdcon uses (matrix D-052 to D-077, C-113, B-050):
 *   GET  /api/stats                    device statistics incl. uid
 *   POST /api/custom?name=<app>        store a custom app; an empty body deletes it
 *   POST /api/switch {name}            select the app that is shown
 *   POST /api/power {power}            matrix on or off
 *   POST /api/settings {BRI, …}        brightness and other settings
 *   POST /api/draw {matrix}            raw 32×8 frame as base64 RGB (used by stop blanking)
 *   POST /api/notify {…}               notification, recorded only
 *   GET  /api/screen                   256 packed colours of what is shown
 *   GET  /list?dir=/CUSTOMAPPS         custom apps on flash
 *
 * /api/screen answers the last raw frame, or black. Phase 3 wires
 * src/drivers/awtrix-raster.js in, so the fake shows custom apps as well.
 *
 * Fault switches as in fake-pixoo.js: setOffline, setHang, failNext.
 * Binds 127.0.0.1 only. Used by dev/dev-runner.js and test/smoke.
 */

import { createServer } from "node:http";

const WIDTH = 32;
const HEIGHT = 8;

/**
 * @typedef {object} FakeAwtrix
 * @property {string} address host:port, usable as `ip` in config.json
 * @property {number} port
 * @property {() => {apps: Record<string, unknown>, currentApp: string|null, updates: number, power: boolean, brightness: number, rawFrame: Uint8Array|null, notifications: unknown[], requests: string[]}} state
 * @property {(timeoutMs?: number) => Promise<{name: string, app: unknown}>} nextApp resolves with the next custom-app update
 * @property {(apps: Record<string, unknown>) => void} seedApps put leftover custom apps on the "flash" (legacy cleanup tests)
 * @property {(raster: ((app: unknown) => Uint8Array)|null) => void} setRaster how /api/screen draws the current custom app
 * @property {(offline: boolean) => Promise<void>} setOffline
 * @property {(hang: boolean) => void} setHang
 * @property {(count: number) => void} failNext
 * @property {() => Promise<void>} stop
 */

/**
 * @param {{port?: number, uid?: string}} [options] port 0 (default) picks a free one
 * @returns {Promise<FakeAwtrix>}
 */
export async function startFakeAwtrix(options = {}) {
  const host = "127.0.0.1";
  const uid = options.uid ?? "awtrix_fake01";
  const startedAt = Date.now();
  const state = {
    /** @type {Record<string, unknown>} */
    apps: {},
    /** @type {string|null} */
    currentApp: null,
    updates: 0,
    power: true,
    brightness: 120,
    /** @type {Uint8Array|null} */
    rawFrame: null,
    /** @type {unknown[]} */
    notifications: [],
    /** @type {string[]} */
    requests: [],
  };
  let hang = false;
  let failures = 0;
  /** @type {((app: unknown) => Uint8Array)|null} */
  let raster = null;
  /** @type {Array<(update: {name: string, app: unknown}) => void>} */
  let waiters = [];
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();

  function screen() {
    let rgb = state.rawFrame;
    if (
      raster &&
      state.currentApp &&
      state.apps[state.currentApp] !== undefined
    ) {
      rgb = raster(state.apps[state.currentApp]);
    }
    const packed = new Array(WIDTH * HEIGHT).fill(0);
    if (rgb && state.power) {
      for (let i = 0; i < packed.length; i++) {
        packed[i] = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
      }
    }
    return packed;
  }

  /**
   * @param {string} method
   * @param {URL} url
   * @param {string} text
   * @returns {{status: number, body?: unknown}}
   */
  function execute(method, url, text) {
    const route = `${method} ${url.pathname}`;
    state.requests.push(route);
    if (failures > 0) {
      failures -= 1;
      return { status: 500 };
    }
    /** @returns {Record<string, any>} */
    const json = () => (text ? JSON.parse(text) : {});
    switch (route) {
      case "GET /api/stats":
        return {
          status: 200,
          body: {
            bat: 100,
            bat_raw: 669,
            type: 0,
            lux: 12,
            ldr_raw: 380,
            ram: 151204,
            bri: state.brightness,
            temp: 23,
            hum: 41,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            wifi_signal: -58,
            messages: state.updates,
            version: "0.98",
            indicator1: false,
            indicator2: false,
            indicator3: false,
            app: state.currentApp ?? "Time",
            uid,
            matrix: state.power,
            ip_address: host,
          },
        };
      case "POST /api/custom": {
        const name = url.searchParams.get("name") ?? "";
        if (!name) return { status: 400 };
        if (text.trim() === "") {
          delete state.apps[name];
          if (state.currentApp === name) state.currentApp = null;
          return { status: 200 };
        }
        const app = json();
        state.apps[name] = app;
        state.updates += 1;
        const waiting = waiters;
        waiters = [];
        for (const resolveApp of waiting) resolveApp({ name, app });
        return { status: 200 };
      }
      case "POST /api/switch":
        state.currentApp = String(json().name ?? "");
        return { status: 200 };
      case "POST /api/power":
        state.power = Boolean(json().power);
        return { status: 200 };
      case "POST /api/settings": {
        const settings = json();
        if (typeof settings.BRI === "number") state.brightness = settings.BRI;
        return { status: 200 };
      }
      case "POST /api/draw": {
        const frame = Uint8Array.from(
          Buffer.from(String(json().matrix ?? ""), "base64"),
        );
        if (frame.length !== WIDTH * HEIGHT * 3) return { status: 400 };
        state.rawFrame = frame;
        return { status: 200 };
      }
      case "POST /api/notify":
        state.notifications.push(json());
        return { status: 200 };
      case "GET /api/screen":
        return { status: 200, body: screen() };
      case "GET /list":
        return {
          status: 200,
          body: Object.keys(state.apps).map((name) => ({
            type: "file",
            name: `${name}.json`,
          })),
        };
      default:
        return { status: 404 };
    }
  }

  const server = createServer((req, res) => {
    if (hang) return;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let answer;
      try {
        const url = new URL(req.url ?? "/", `http://${host}`);
        answer = execute(
          req.method ?? "GET",
          url,
          Buffer.concat(chunks).toString("utf8"),
        );
      } catch {
        answer = { status: 400 };
      }
      if (answer.body === undefined) {
        res.writeHead(answer.status).end(answer.status === 200 ? "OK" : "");
      } else {
        res.writeHead(answer.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer.body));
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  /** @param {number} port */
  const listen = (port) =>
    new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, host, () => {
        server.off("error", rejectListen);
        resolveListen(undefined);
      });
    });
  const close = () =>
    new Promise((resolveClose) => {
      if (!server.listening) {
        resolveClose(undefined);
        return;
      }
      server.close(() => resolveClose(undefined));
      for (const socket of sockets) socket.destroy();
    });

  await listen(options.port ?? 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    address: `${host}:${port}`,
    port,
    state: () => ({
      ...state,
      apps: { ...state.apps },
      notifications: state.notifications.slice(),
      requests: state.requests.slice(),
    }),
    nextApp(timeoutMs = 2000) {
      return new Promise((resolveApp, rejectApp) => {
        const timer = setTimeout(
          () =>
            rejectApp(new Error("fake awtrix: no app update arrived in time")),
          timeoutMs,
        );
        waiters.push((update) => {
          clearTimeout(timer);
          resolveApp(update);
        });
      });
    },
    seedApps(apps) {
      Object.assign(state.apps, apps);
    },
    setRaster(value) {
      raster = value;
    },
    async setOffline(offline) {
      if (offline) await close();
      else if (!server.listening) await listen(port);
    },
    setHang(value) {
      hang = value;
    },
    failNext(count) {
      failures = count;
    },
    stop: close,
  };
}
