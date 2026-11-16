/**
 * Test kind 3 of 3: fake-device smoke.
 *
 * pixdcon 2 runs in this process against a fake Pixoo64, a fake Ulanzi /
 * AWTRIX and the in-memory broker. What exists now proves the pieces: the
 * fakes speak the device protocols and can go offline, the network guard
 * holds, the manual clock crosses the health thresholds without waiting, and
 * pixdcon 2 boots and stops. Phase 3 (drivers worker) replaces the todo
 * entries with the real walks: switch scenes, take a display away and bring
 * it back, watch stale after 30 s and offline after 2 min.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { startFakeAwtrix } from "../../dev/fake-awtrix.js";
import { startFakePixoo } from "../../dev/fake-pixoo.js";
import { blockedAttempts } from "../../dev/net-guard.js";
import { manualClock } from "../../src/core/clock.js";
import { requireNetGuard, startStack } from "../helpers/harness.js";

/**
 * @param {string} address
 * @param {Record<string, unknown>} command
 */
async function pixooPost(address, command) {
  const response = await fetch(`http://${address}/post`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(1000),
  });
  return /** @type {Promise<any>} */ (response.json());
}

test("fake Pixoo64: takes a frame the way v1 sends it, goes offline, hangs, comes back", async (t) => {
  requireNetGuard();
  const pixoo = await startFakePixoo();
  t.after(() => pixoo.stop());

  assert.deepEqual(
    await pixooPost(pixoo.address, { Command: "Draw/ResetHttpGifId" }),
    { error_code: 0 },
  );
  assert.deepEqual(
    await pixooPost(pixoo.address, {
      Command: "Channel/SetIndex",
      SelectIndex: 3,
    }),
    { error_code: 0 },
  );

  const frame = new Uint8Array(64 * 64 * 3).fill(7);
  const arriving = pixoo.nextFrame();
  await pixooPost(pixoo.address, {
    Command: "Draw/SendHttpGif",
    PicNum: 1,
    PicWidth: 64,
    PicHeight: 64,
    PicOffset: 0,
    PicID: 1,
    PicSpeed: 1000,
    PicData: Buffer.from(frame).toString("base64"),
  });
  assert.deepEqual(await arriving, frame);
  assert.equal(pixoo.state().channel, 3);
  assert.equal(pixoo.state().frames, 1);

  await pixooPost(pixoo.address, {
    Command: "Channel/SetBrightness",
    Brightness: 5,
  });
  const conf = await pixooPost(pixoo.address, {
    Command: "Channel/GetAllConf",
  });
  assert.equal(conf.Brightness, 5);

  await pixoo.setOffline(true);
  await assert.rejects(
    () => pixooPost(pixoo.address, { Command: "Channel/GetAllConf" }),
    "unplugged: refused",
  );
  await pixoo.setOffline(false);
  assert.equal(
    (await pixooPost(pixoo.address, { Command: "Channel/GetAllConf" }))
      .error_code,
    0,
  );

  pixoo.setHang(true);
  await assert.rejects(
    () => pixooPost(pixoo.address, { Command: "Channel/GetAllConf" }),
    { name: "TimeoutError" },
    "firmware hang: accepted, never answered",
  );
  pixoo.setHang(false);

  pixoo.failNext(1);
  assert.equal(
    (await pixooPost(pixoo.address, { Command: "Draw/ResetHttpGifId" }))
      .error_code,
    1,
  );
});

test("fake AWTRIX: custom app, switch, settings, screen, cleanup list, offline", async (t) => {
  const awtrix = await startFakeAwtrix({ uid: "awtrix_test01" });
  t.after(() => awtrix.stop());
  const base = `http://${awtrix.address}`;
  /**
   * @param {string} path
   * @param {unknown} [body]
   */
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? "" : JSON.stringify(body),
    });

  const stats = /** @type {any} */ (
    await (await fetch(`${base}/api/stats`)).json()
  );
  assert.equal(stats.uid, "awtrix_test01");

  awtrix.seedApps({ pidicon_old: { text: "left over" } });
  const arriving = awtrix.nextApp();
  assert.equal(
    (
      await post("/api/custom?name=pixdcon_ulanzi-t", {
        text: "18:42",
        color: "#00FF00",
      })
    ).status,
    200,
  );
  assert.deepEqual(await arriving, {
    name: "pixdcon_ulanzi-t",
    app: { text: "18:42", color: "#00FF00" },
  });
  await post("/api/switch", { name: "pixdcon_ulanzi-t" });
  assert.equal(awtrix.state().currentApp, "pixdcon_ulanzi-t");

  const list = /** @type {any[]} */ (
    await (await fetch(`${base}/list?dir=/CUSTOMAPPS`)).json()
  );
  assert.deepEqual(
    list.map((/** @type {{name: string}} */ entry) => entry.name).sort(),
    ["pidicon_old.json", "pixdcon_ulanzi-t.json"],
  );
  await post("/api/custom?name=pidicon_old");
  assert.deepEqual(Object.keys(awtrix.state().apps), ["pixdcon_ulanzi-t"]);

  await post("/api/settings", { BRI: 77 });
  await post("/api/power", { power: false });
  assert.equal(awtrix.state().brightness, 77);
  assert.equal(awtrix.state().power, false);

  const black = Buffer.from(new Uint8Array(32 * 8 * 3)).toString("base64");
  assert.equal((await post("/api/draw", { matrix: black })).status, 200);
  const screen = /** @type {any[]} */ (
    await (await fetch(`${base}/api/screen`)).json()
  );
  assert.equal(screen.length, 256);

  await awtrix.setOffline(true);
  await assert.rejects(() =>
    fetch(`${base}/api/stats`, { signal: AbortSignal.timeout(1000) }),
  );
  await awtrix.setOffline(false);
  assert.equal((await fetch(`${base}/api/stats`)).status, 200);
});

test("network guard: nothing but loopback is reachable, and ping cannot be started", async () => {
  const before = blockedAttempts().length;

  // 192.0.2.0/24 is reserved for documentation; even so, no packet may leave.
  const started = Date.now();
  await assert.rejects(
    () => fetch("http://192.0.2.1:8080/"),
    "fetch to another host is refused",
  );
  assert.ok(
    Date.now() - started < 500,
    "refused at once, without waiting for a timeout",
  );

  const pingError = await new Promise((resolvePing) => {
    execFile("ping", ["-c", "1", "192.0.2.1"], (error) => resolvePing(error));
  });
  assert.ok(pingError, "ping is not started");

  const blocked = blockedAttempts().slice(before);
  assert.deepEqual(
    blocked.map((entry) => `${entry.kind} ${entry.target}`),
    ["connect 192.0.2.1:8080", "spawn ping"],
  );
});

test("manual clock: 30 s and 2 min pass in no time, timers fire in order", async () => {
  const clock = manualClock();
  const start = clock.now();
  /** @type {string[]} */
  const events = [];
  void clock.sleep(30_000).then(() => events.push("stale after 30 s"));
  void clock.sleep(120_000).then(() => events.push("offline after 2 min"));
  const ticker = clock.every(() => events.push("tick"), 50_000);

  await clock.advance(29_999);
  assert.deepEqual(events, []);
  await clock.advance(1);
  assert.deepEqual(events, ["stale after 30 s"]);
  await clock.advance(90_000);
  assert.deepEqual(events, [
    "stale after 30 s",
    "tick",
    "tick",
    "offline after 2 min",
  ]);
  assert.equal(clock.now() - start, 120_000);

  ticker.cancel();
  const aborted = new AbortController();
  const sleeping = clock.sleep(1000, aborted.signal);
  aborted.abort();
  assert.equal(await sleeping, false, "a sleep can be cut short");
  assert.equal(clock.pending(), 0);
});

test("pixdcon 2 boots against the fakes and the in-memory broker, answers, and stops cleanly", async (t) => {
  const stack = await startStack(t);
  const health = await stack.api("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
  assert.ok(
    stack.logLines.some((line) => /INFO \[pixdcon2\] Running/.test(line)),
    "the log says Running",
  );
  assert.ok(
    stack.logLines.every((line) =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z +(ERROR|WARN|INFO|DEBUG) /.test(
        line,
      ),
    ),
    "every log line has the v1 shape",
  );
  await stack.app.stop();
  await assert.rejects(
    () => fetch(`${stack.base}/api/health`),
    "stopped: the port is closed",
  );
});

// --- Phase 3: the walks ------------------------------------------------------------------------
test.todo("both fakes receive frames of their scenes within 2 s of the start");
test.todo(
  "switching the scene of one display changes its frames and leaves the other display untouched",
);
test.todo(
  "a display that is offline at the start does not delay the UI or the other display",
);
test.todo(
  "display unplugged: stale after 30 s without a good frame, offline after 2 min, online again after the first good frame",
);
test.todo(
  "display hangs (accepts, never answers): the same timing, last error 'Pixoo HTTP timeout after 5000ms'",
);
test.todo(
  "a scene that throws is a scene error: the display stays reachable, no power cycle, the last good frame stays",
);
test.todo(
  "backoff 1, 2, 4, 8, 16, 30 s with a probe every 10 s; a display that answers ends the wait",
);
test.todo(
  "10 failed renders with a plug configured: OFF, 10 s, ON, 30 s on the plug topic, then a re-init",
);
test.todo(
  "power cycles used up: slow probing goes on and 'Retry now' starts over",
);
test.todo(
  "pause holds one frame, stop blanks and switches off, play takes the display back",
);
test.todo(
  "built-in mode: the fake shows the firmware channel or app and receives no frames",
);
test.todo(
  "brightness override: applied at once; cleared: the scene's last level is applied again",
);
test.todo(
  "mode and brightness from retained controls are applied before the first frame",
);
test.todo(
  "shadow output: scenes render and previews update, the fake receives no request, the broker no message",
);
test.todo(
  "PIXDCON2_FORCE_SHADOW=1: no fake receives a request although config.json says drive",
);
test.todo(
  "a scene file that changes is reloaded for the displays running it; a broken edit keeps the last good version",
);
test.todo("changing one device in config.json restarts that device only");
test.todo(
  "MQTT gone and back: displays keep rendering, retained state is read again, pending clears are sent",
);
test.todo(
  "legacy app cleanup on the fake AWTRIX: every other custom app is deleted once, ours stays",
);
test.todo("stop: the process ends within 8 s also while a render hangs");
