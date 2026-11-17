/**
 * Fake Pixoo64: an HTTP server that answers like the display's /post API.
 *
 * Speaks the part of the Divoom protocol that pixdcon uses (matrix D-002 to
 * D-034, C-132, C-133): Draw/ResetHttpGifId, Channel/SetIndex,
 * Draw/SendHttpGif, Channel/SetBrightness, Channel/OnOffScreen,
 * Channel/GetAllConf. It records what it was told, so a test can ask "which
 * frame is on the display" and "which channel is selected".
 *
 * Fault switches for the smoke tests:
 *   setOffline(true)   connections are refused (display unplugged)
 *   setHang(true)      requests are accepted and never answered (the firmware
 *                      hang of D-199: ping works, HTTP does not)
 *   failNext(n)        the next n requests answer error_code 1
 *
 * Binds 127.0.0.1 only. Used by dev/dev-runner.js and test/smoke.
 */

import { createServer } from "node:http";

const WIDTH = 64;
const HEIGHT = 64;

/**
 * @typedef {object} FakePixoo
 * @property {string} address host:port, usable as `ip` in config.json
 * @property {number} port
 * @property {() => {frames: number, lastFrame: Uint8Array|null, lastPicId: number|null, channel: number|null, brightness: number, screenOn: boolean, gifIdResets: number, requests: string[]}} state
 * @property {(timeoutMs?: number) => Promise<Uint8Array>} nextFrame resolves with the next frame the display receives
 * @property {(offline: boolean) => Promise<void>} setOffline
 * @property {(hang: boolean) => void} setHang
 * @property {(count: number, command?: string) => void} failNext optional protocol command filter
 * @property {() => Promise<void>} stop
 */

/**
 * @param {{port?: number, successCode?: 0|null}} [options] port 0 picks a free one; null exercises firmware's nullable success code
 * @returns {Promise<FakePixoo>}
 */
export async function startFakePixoo(options = {}) {
  const host = "127.0.0.1";
  const state = {
    frames: 0,
    /** @type {Uint8Array|null} */
    lastFrame: null,
    /** @type {number|null} */
    lastPicId: null,
    /** @type {number|null} */
    channel: null,
    brightness: 50,
    screenOn: true,
    gifIdResets: 0,
    /** @type {string[]} */
    requests: [],
  };
  let hang = false;
  let failures = 0;
  /** @type {string|null} */
  let failureCommand = null;
  /** @type {Array<(frame: Uint8Array) => void>} */
  let waiters = [];
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();

  /**
   * @param {Record<string, any>} body
   * @returns {Record<string, unknown>}
   */
  function execute(body) {
    const command = String(body.Command ?? "");
    state.requests.push(command);
    if (failures > 0 && (!failureCommand || failureCommand === command)) {
      failures -= 1;
      return { error_code: 1 };
    }
    switch (command) {
      case "Draw/ResetHttpGifId":
        state.gifIdResets += 1;
        return { error_code: 0 };
      case "Channel/SetIndex":
        state.channel = Number(body.SelectIndex);
        return { error_code: 0 };
      case "Channel/SetBrightness":
        state.brightness = Number(body.Brightness);
        return { error_code: 0 };
      case "Channel/OnOffScreen":
        state.screenOn = Number(body.OnOff) === 1;
        return { error_code: 0 };
      case "Channel/GetAllConf":
        return {
          error_code: 0,
          Brightness: state.brightness,
          CurClockId: 182,
          LightSwitch: state.screenOn ? 1 : 0,
        };
      case "Draw/SendHttpGif": {
        const frame = Uint8Array.from(
          Buffer.from(String(body.PicData ?? ""), "base64"),
        );
        if (frame.length !== WIDTH * HEIGHT * 3 || body.PicWidth !== WIDTH) {
          return { error_code: "Request data illegal json" };
        }
        state.frames += 1;
        state.lastFrame = frame;
        state.lastPicId = Number(body.PicID);
        const waiting = waiters;
        waiters = [];
        for (const resolveFrame of waiting) resolveFrame(frame);
        return { error_code: 0 };
      }
      default:
        return { error_code: "Request data illegal json" };
    }
  }

  const server = createServer((req, res) => {
    if (hang) return; // never answer; the caller's deadline has to fire
    if (req.method !== "POST" || req.url !== "/post") {
      res.writeHead(404).end();
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let answer;
      try {
        answer = execute(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (answer.error_code === 0 && options.successCode === null) answer.error_code = null;
      } catch {
        answer = { error_code: "Request data illegal json" };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
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
    state: () => ({ ...state, requests: state.requests.slice() }),
    nextFrame(timeoutMs = 2000) {
      return new Promise((resolveFrame, rejectFrame) => {
        const timer = setTimeout(
          () => rejectFrame(new Error("fake pixoo: no frame arrived in time")),
          timeoutMs,
        );
        waiters.push((frame) => {
          clearTimeout(timer);
          resolveFrame(frame);
        });
      });
    },
    async setOffline(offline) {
      if (offline) await close();
      else if (!server.listening) await listen(port);
    },
    setHang(value) {
      hang = value;
    },
    failNext(count, command) {
      failures = count;
      failureCommand = command ?? null;
    },
    stop: close,
  };
}
