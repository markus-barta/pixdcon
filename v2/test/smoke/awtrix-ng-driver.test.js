/**
 * AWTRIX NG driver (OPS-653): the AWTRIX 3 → NG payload translation, the telemetry mapping, the
 * driver choice by `firmware`, and the wire calls (method + path + body) against a loopback
 * recorder. Checked live against a real Ulanzi TC001 on AWTRIX NG 1.2.3 on 2026-11-22 (OPS-653):
 * same rows and glyphs as an AWTRIX 3 clock showing clock_with_homestats.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { systemClock } from "../../src/core/clock.js";
import { createDriver } from "../../src/drivers/driver.js";
import { statsFromDevice, translateApp } from "../../src/drivers/awtrix-ng-driver.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test("translateApp: draw objects become NG command arrays, colours pass unchanged", () => {
  const out = translateApp({ draw: [{ dt: [0, 0, "12:34", [255, 255, 213]] }, { dl: [24, 7, 26, 7, "#00FF00"] },
    { dr: [11, 6, 2, 2, [255, 0, 0]] }, { dp: [30, 0, 65280] }, { df: [0, 0, 2, 2, "#111"] }, { dc: [4, 4, 1, "#FFF"] },
    { dfc: [4, 4, 1, "#FFF"] }, { db: [0, 0, 1, 1, [16711680]] }] });
  assert.deepEqual(out.draw, [["text", 0, 0, "12:34", [255, 255, 213]], ["line", 24, 7, 26, 7, "#00FF00"],
    ["rect", 11, 6, 2, 2, [255, 0, 0]], ["pixel", 30, 0, 65280], ["rectFill", 0, 0, 2, 2, "#111"],
    ["circle", 4, 4, 1, "#FFF"], ["circleFill", 4, 4, 1, "#FFF"], ["bitmap", 0, 0, 1, 1, [16711680]]]);
});

test("translateApp: renamed, converted and dropped keys", () => {
  /** @type {string[]} */
  const dropped = [];
  const out = translateApp({ text: [{ t: "A", c: "#F00" }], color: "#0F0", background: "#000", center: true, textCase: 2,
    noScroll: true, scrollSpeed: 50, duration: 3, lifetime: 60, lifetimeMode: 1, repeat: -1, pushIcon: 2, icon: "2422",
    progress: 40, progressC: "#FFF", progressBC: "#222", bar: [1, 2], overlay: "clear", rainbow: true, rtttl: "x:d=4:c",
    pos: 1, save: true, topText: true, hold: true }, (key) => dropped.push(key));
  assert.deepEqual(out, { text: [{ text: "A", color: "#F00" }], textColor: "palette", backgroundColor: "#000",
    textAlign: "center", textCase: "asTyped", durationMs: 3000, lifetimeMs: 60000, lifetimeExpiry: "mark", repeat: 0,
    iconMode: "push", icon: "2422", progress: 40, progressColor: "#FFF", progressTrackColor: "#222", barChart: [1, 2],
    overlay: "", palette: "Rainbow", sound: { rtttl: "x:d=4:c" }, hold: true, scroll: { mode: "static", speed: 50 } });
  assert.deepEqual(dropped, ["pos", "save", "topText"]);
});

test("statsFromDevice keeps NG fields and adds the AWTRIX 3 names HA discovery reads", () => {
  const s = statsFromDevice({ uid: "3076f56cbba4", version: "1.2.3", uptimeSeconds: 9, batteryPercent: 52, wifiRssi: -54,
    freeHeapBytes: 1000, temperature: 21.5, humidity: 40, lightLevel: 7, messageCount: 0, currentApp: "Time", brightness: 120,
    matrixPower: true, ipAddress: "192.168.1.62" });
  assert.equal(s.uid, "3076f56cbba4");
  assert.equal(s.uptime, 9);
  assert.equal(s.bat, 52);
  assert.equal(s.wifi_signal, -54);
  assert.equal(s.temp, 21.5);
  assert.equal(s.app, "Time");
  assert.equal(s.firmware, "awtrix-ng");
  assert.equal(s.batteryPercent, 52);
});

test("createDriver picks the NG driver only for firmware awtrix-ng; wire calls use NG methods and paths", async () => {
  /** @type {Array<[string, string, unknown]>} */
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push([req.method ?? "", req.url ?? "", body ? JSON.parse(body) : undefined]);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/v1/device") res.end(JSON.stringify({ uid: "u1", version: "1.2.3" }));
      else if (req.url === "/api/v1/display/screen") res.end(JSON.stringify({ width: 32, height: 8, pixels: new Array(256).fill(16711680) }));
      else res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const deps = { logger: quiet, clock: systemClock(),
    rasterizeAwtrixApp: () => ({ frame: { width: 32, height: 8, rgb: new Uint8Array(768) }, unsupported: [] }) };
  const ng = createDriver({ name: "ulanzi-62", type: "ulanzi", address: `127.0.0.1:${port}`, output: "drive", firmware: "awtrix-ng" }, deps);
  try {
    await ng.init();
    await ng.show({ kind: "app", app: { draw: [{ dp: [1, 2, "#FFF"] }] } });
    await ng.setBrightness(300);
    await ng.setPower(false);
    const frame = await ng.readScreen?.();
    assert.equal(frame?.rgb[0], 255);
    assert.deepEqual(calls.map(([m, u]) => `${m} ${u}`), [
      "GET /api/v1/device", "PATCH /api/v1/settings", "PUT /api/v1/apps/pushed/pixdcon_ulanzi-62",
      "PUT /api/v1/apps/active", "PATCH /api/v1/settings", "PATCH /api/v1/display", "GET /api/v1/display/screen"]);
    assert.deepEqual(calls[2][2], { draw: [["pixel", 1, 2, "#FFF"]] });
    assert.deepEqual(calls[3][2], { name: "pixdcon_ulanzi-62", fast: true });
    assert.deepEqual(calls[4][2], { brightness: 255 });
    const legacy = createDriver({ name: "ulanzi-56", type: "ulanzi", address: `127.0.0.1:${port}`, output: "drive" }, deps);
    assert.equal(typeof legacy.switchApp, "function");
    await legacy.close();
  } finally {
    await ng.close();
    await new Promise((r) => server.close(() => r(undefined)));
  }
});
