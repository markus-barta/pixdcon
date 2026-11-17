/**
 * Test kind 3 of 3: fake-device smoke.
 *
 * pixdcon 2 runs in this process against a fake Pixoo64, a fake Ulanzi /
 * AWTRIX and the in-memory broker. What exists now proves the pieces: the
 * fakes speak the device protocols and can go offline, the network guard
 * holds (also in what the process starts), a start that fails half way
 * leaves nothing open, the manual clock crosses the health thresholds
 * without waiting, and pixdcon 2 boots and stops. Phase 3 (drivers worker)
 * replaces the todo entries with the real walks: switch scenes, take a
 * display away and bring it back, watch stale after 30 s and offline after
 * 2 min.
 */

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { startFakeAwtrix } from "../../dev/fake-awtrix.js";
import { startFakePixoo } from "../../dev/fake-pixoo.js";
import { startMemoryBroker } from "../../dev/memory-broker.js";
import { blockedAttempts, coverage } from "../../dev/net-guard.js";
import { manualClock } from "../../src/core/clock.js";
import { deferred, flush, loopRig, rig, until } from "./runtime-fixture.js";
import { requireNetGuard, startStack } from "../helpers/harness.js";

/**
 * Listening sockets and broker timers that are open in this process. A
 * handle that was just closed is gone one turn of the event loop later, so
 * wait two turns before counting.
 */
async function openServersAndTimers() {
  for (let turn = 0; turn < 2; turn++)
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  const counts = { servers: 0, timers: 0 };
  for (const kind of process.getActiveResourcesInfo()) {
    if (kind === "TCPServerWrap") counts.servers += 1;
    if (kind === "Timeout") counts.timers += 1;
  }
  return counts;
}

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

test("network guard: DNS and UDP beyond loopback are refused before anything is sent", async () => {
  // First make sure the doors are closed at all. Only then knock: if the
  // guard were missing, the calls below would really ask a name server.
  assert.deepEqual(coverage(), {
    connect: true,
    spawn: true,
    childPreload: true,
    workerPreload: true,
    dns: true,
    udp: true,
  });

  await assert.rejects(() => dns.promises.lookup("pixdcon.invalid"), {
    code: "ENETGUARD",
  });
  await assert.rejects(() => dns.promises.resolve4("pixdcon.invalid"), {
    code: "ENETGUARD",
  });
  await assert.rejects(
    () => new dns.promises.Resolver().resolveTxt("pixdcon.invalid"),
    { code: "ENETGUARD" },
  );
  assert.deepEqual(
    await dns.promises.lookup("localhost", { family: 4 }),
    { address: "127.0.0.1", family: 4 },
    "localhost still resolves; it needs no network",
  );

  const socket = dgram.createSocket("udp4");
  try {
    const sendError = await new Promise((resolveSend) =>
      socket.send("x", 9, "192.0.2.1", (error) => resolveSend(error)),
    );
    assert.equal(
      /** @type {any} */ (sendError)?.code,
      "ENETGUARD",
      "a datagram to another host is not sent",
    );

    const receiver = dgram.createSocket("udp4");
    try {
      await new Promise((resolveBind) =>
        receiver.bind(0, "127.0.0.1", () => resolveBind(undefined)),
      );
      const arriving = new Promise((resolveMessage) =>
        receiver.once("message", (message) =>
          resolveMessage(message.toString()),
        ),
      );
      socket.send("hello", receiver.address().port, "127.0.0.1");
      assert.equal(await arriving, "hello", "loopback datagrams still work");
    } finally {
      receiver.close();
    }
  } finally {
    socket.close();
  }
});

test("network guard: a Node child process and a worker thread start guarded, whatever environment they get", async () => {
  // The question asked is "is the guard installed in there". Nothing here
  // tries to get out, so nothing is sent even if the answer were no.
  const report =
    "process.stdout.write(String(Boolean(globalThis[Symbol.for('pixdcon2.net-guard')])))";

  /** @param {NodeJS.ProcessEnv} [env] */
  const child = (env) =>
    new Promise((resolveChild, rejectChild) => {
      execFile(
        process.execPath,
        ["-e", report],
        env ? { env } : {},
        (error, stdout) => (error ? rejectChild(error) : resolveChild(stdout)),
      );
    });
  assert.equal(await child(), "true", "child with the inherited environment");
  assert.equal(
    await child({ PATH: process.env.PATH ?? "" }),
    "true",
    "child with a clean environment: the guard adds itself to NODE_OPTIONS",
  );
  assert.equal(
    spawnSync(process.execPath, ["-e", report], { env: {} }).stdout.toString(),
    "true",
    "child started synchronously",
  );

  // A worker has its own net, dns and dgram: the parent's patches do not
  // reach it, so it has to load the guard itself. Both kinds of worker.
  /** @param {Worker} worker */
  const answerOf = async (worker) => {
    try {
      return await new Promise((resolveMessage, rejectMessage) => {
        worker.once("message", resolveMessage);
        worker.once("error", rejectMessage);
      });
    } finally {
      await worker.terminate();
    }
  };
  assert.equal(
    await answerOf(
      new Worker(
        "require('node:worker_threads').parentPort.postMessage(Boolean(globalThis[Symbol.for('pixdcon2.net-guard')]))",
        { eval: true },
      ),
    ),
    true,
    "worker made from source text",
  );
  assert.equal(
    await answerOf(
      new Worker(
        new URL(
          "data:text/javascript,import{parentPort}from'node:worker_threads';parentPort.postMessage(Boolean(globalThis[Symbol.for('pixdcon2.net-guard')]))",
        ),
      ),
    ),
    true,
    "worker made from a module",
  );
});

test("in-memory broker: a start that fails closes what it had opened", async (t) => {
  const first = await startMemoryBroker();
  t.after(() => first.stop());
  const before = await openServersAndTimers();

  // The port is taken: listening fails after aedes itself is already up.
  await assert.rejects(() => startMemoryBroker({ port: first.port }), {
    code: "EADDRINUSE",
  });
  assert.deepEqual(
    await openServersAndTimers(),
    before,
    "no listening socket and no broker timer is left behind",
  );

  await first.stop();
  await first.stop(); // safe to call twice
});

test("harness: a stack that fails on the way up stops what it had started, at once", async (t) => {
  const taken = await startMemoryBroker();
  t.after(() => taken.stop());
  const before = await openServersAndTimers();

  // Fails at the first resource: the broker cannot bind.
  await assert.rejects(() => startStack(t, { brokerPort: taken.port }), {
    code: "EADDRINUSE",
  });
  assert.deepEqual(await openServersAndTimers(), before);

  // Fails at the last step: broker, both fakes and the data directory exist,
  // then pixdcon 2 refuses its port.
  await assert.rejects(
    () => startStack(t, { env: { WEB_PORT: "not-a-port" } }),
    /Invalid WEB_PORT/,
  );
  assert.deepEqual(
    await openServersAndTimers(),
    before,
    "the broker and both fake displays were stopped before the error was passed on",
  );
});

test("test deadline: a test file that hangs ends itself with exit code 1 at the run's deadline", () => {
  // A test file's process that never finishes, in a run whose deadline is
  // 300 ms away.
  const deadline = fileURLToPath(
    new URL("../helpers/deadline.js", import.meta.url),
  );
  const started = Date.now();
  const hung = spawnSync(
    process.execPath,
    ["--import", deadline, "-e", "setInterval(() => {}, 1000)"],
    {
      env: {
        PATH: process.env.PATH ?? "",
        PIXDCON2_TEST_DEADLINE_AT: String(started + 300),
      },
      timeout: 10000,
    },
  );
  assert.equal(hung.status, 1, "exit code 1");
  assert.match(hung.stderr.toString(), /hard deadline: this test file/);
  assert.ok(
    Date.now() - started < 5000,
    "ended by the deadline, not by this test",
  );
});

test("test deadline: a run that cannot even run a timer is killed, with everything it started, and answers exit code 1", async (t) => {
  // The worst case for a gate: a test that never yields. Its own deadline
  // timer cannot fire. test/helpers/run.js has to end the whole run.
  const dir = await mkdtemp(join(tmpdir(), "pixdcon2-deadline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "pid");
  await writeFile(
    join(dir, "spin.test.mjs"),
    [
      'import test from "node:test";',
      'import { writeFileSync } from "node:fs";',
      'test("never yields", () => {',
      `  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "  for (;;) {}",
      "});",
      "",
    ].join("\n"),
  );

  const runScript = fileURLToPath(
    new URL("../helpers/run.js", import.meta.url),
  );
  const started = Date.now();
  const run = await new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [runScript, join(dir, "spin.test.mjs")],
      {
        env: {
          PATH: process.env.PATH ?? "",
          PIXDCON2_TEST_DEADLINE_MS: "400",
          PIXDCON2_TEST_DEADLINE_GRACE_MS: "300",
        },
        timeout: 15000,
      },
      (error, stdout, stderr) =>
        resolveRun({
          code: error ? /** @type {any} */ (error).code : 0,
          output: `${stdout}${stderr}`,
        }),
    );
  });
  assert.equal(run.code, 1, "exit code 1");
  assert.match(run.output, /hard deadline: the test run is still alive/);
  assert.ok(
    Date.now() - started < 8000,
    "ended by the deadline, not by this test",
  );

  const spinner = Number(await readFile(pidFile, "utf8"));
  assert.ok(spinner > 0, "the spinning test file had started");
  await new Promise((resolveTurn) => setTimeout(resolveTurn, 100));
  assert.throws(
    () => process.kill(spinner, 0),
    { code: "ESRCH" },
    "the spinning process is gone; nothing of the run is left behind",
  );
});

test("test runner: a test that passes and leaves a child process behind does not leave it behind; the run still reports the test's result", async (t) => {
  // --test-force-exit ends a test file's process although a child it
  // started still runs. The runner exits with the tests' status; before
  // test/helpers/run.js passes that on, it has to end what is left of the run.
  const dir = await mkdtemp(join(tmpdir(), "pixdcon2-leak-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "pid");
  await writeFile(
    join(dir, "leak.test.mjs"),
    [
      'import test from "node:test";',
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'test("passes, and forgets a child that only holds a timer", () => {',
      '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "  child.unref();",
      `  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "});",
      "",
    ].join("\n"),
  );

  const runScript = fileURLToPath(
    new URL("../helpers/run.js", import.meta.url),
  );
  const run = await new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [runScript, join(dir, "leak.test.mjs")],
      { env: { PATH: process.env.PATH ?? "" }, timeout: 15000 },
      (error, stdout, stderr) =>
        resolveRun({
          code: error ? /** @type {any} */ (error).code : 0,
          output: `${stdout}${stderr}`,
        }),
    );
  });
  assert.equal(
    run.code,
    0,
    `the test passed, so the run passes:\n${run.output}`,
  );
  assert.match(run.output, /the run left a process behind/);

  const leaked = Number(await readFile(pidFile, "utf8"));
  assert.ok(leaked > 0, "the test had started its child");
  await new Promise((resolveTurn) => setTimeout(resolveTurn, 100));
  assert.throws(
    () => process.kill(leaked, 0),
    { code: "ESRCH" },
    "the leaked child is gone",
  );
});

test("test runner: a Node child of a test file gets the run's deadline, so one that leaves the run's process group still ends itself", () => {
  // The guard of this process hands the deadline on (dev/net-guard.js).
  // The child reports what it was given; nothing is left running.
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({ at: process.env.PIXDCON2_TEST_DEADLINE_AT, preload: process.env.PIXDCON2_TEST_DEADLINE_PRELOAD, options: process.env.NODE_OPTIONS }))",
    ],
    { env: { PATH: process.env.PATH ?? "" }, timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr.toString());
  const given = JSON.parse(child.stdout.toString());
  assert.equal(
    given.at,
    process.env.PIXDCON2_TEST_DEADLINE_AT,
    "the run's deadline, although the child was given a clean environment",
  );
  assert.match(String(given.preload), /test\/helpers\/deadline\.js$/);
  assert.ok(
    String(given.options).includes(`--import=${given.preload}`),
    "and the module that enforces it is preloaded",
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
test.todo(
  "shadow state files: a scene with a state field writes below the data directory, never beside the scene; also under an alias key and as a copy",
);
test.todo(
  "PIXDCON2_FORCE_SHADOW=1: no fake receives a request although config.json says drive",
);
test.todo(
  "a scene file that changes is reloaded for the displays running it; a broken edit keeps the last good version",
);
test.todo(
  "hot reload with a replacement whose init fails: the running instance keeps its MQTT and settings subscriptions; only the replacement's are released",
);
test.todo(
  "two displays run the same scene: module-level state of the scene file is not shared between them",
);
test.todo(
  "MQTT gone and back: displays keep rendering, retained state is read again, pending clears are sent",
);

// --- Ordering (knowledge entry, section 3.0) ---

test("stop: the process ends within 8 s also while a render hangs", async (t) => {
  const held = deferred();
  const r = loopRig(t, { render: () => held.promise }); await flush();
  const stopping = r.loop.stop({ deadlineMs: 6000 });
  await r.clock.advance(6000); assert.deepEqual(await stopping, { clean: false });
  assert.equal(r.loop.status().alive, false);
  held.resolve(null); await flush(); assert.equal(r.loop.status().frameCount, 0);
});

test("render reports in order: a render that hung and comes back after its device runtime was rebuilt reports no good frame, no phase and no preview for the new runtime", async (t) => {
  const held = deferred();
  let first = true;
  const r = await rig(t, { render: async (/** @type {string} */ _, /** @type {string} */ name, /** @type {any} */ surface) => { if (name === "p" && first) { first = false; await held.promise; } await surface.paint(3); return null; } });
  await until(() => r.renderCalls.has("p"));
  r.change(r.devices.map((/** @type {any} */ d) => d.name === "p" ? { ...d, minFrameMs: 900 } : d), { devicesChanged: { p: ["minFrameMs"] } });
  await flush(); await r.clock.advance(6000); await until(() => r.tokens.get("p") === 2);
  await until(() => r.previews.get("p"));
  const before = { reports: r.reports.length, preview: r.previews.get("p"), health: r.health.get("p") };
  held.resolve(null); await flush();
  assert.equal(r.reports.length, before.reports); assert.deepEqual(r.previews.get("p"), before.preview); assert.deepEqual(r.health.get("p"), before.health);
});
