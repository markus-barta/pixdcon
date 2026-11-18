#!/usr/bin/env node
/**
 * Dev runner: pixdcon 2 against fake displays, restarted on every change.
 *
 *   npm run dev            start, watch src/, restart on change
 *   npm run dev:once       start, wait until v2 answers, stop, exit 0 or 1
 *
 * It starts, inside this process and on loopback only:
 *   - an in-memory MQTT broker (dev/memory-broker.js)
 *   - a fake Pixoo64 and a fake Ulanzi / AWTRIX (dev/fake-*.js)
 *   - a small control port to play with them (below)
 * and, as a child process that is restarted on every change under src/:
 *   - pixdcon 2 (src/main.js) with a config.json generated from
 *     dev/dev-config.json into a temporary data directory
 *
 * The fakes and the broker keep running across restarts, like real displays
 * and a real broker would: retained messages and the last frame survive.
 *
 * No real display, broker or host is contacted. The child gets a clean
 * environment (no broker credentials or scene tokens from your shell) and is
 * started with dev/net-guard.js, so the shared scenes cannot reach beyond
 * loopback either. Dashboard scenes then show "no data" for their own polls;
 * feed them over MQTT through the control port.
 *
 * Control port (default 8091), for curl:
 *   GET  /                                   ports, device state, retained topics
 *   POST /fake/<pixoo|awtrix>/<offline|online|hang|unhang>
 *   POST /mqtt/publish   {"topic": "...", "payload": "...", "retain": true}
 *
 * Environment: PIXDCON2_DEV_PORT (UI, default 8090), PIXDCON2_DEV_CONTROL_PORT
 * (default 8091), LOG_LEVEL, TZ.
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeAwtrix } from "./fake-awtrix.js";
import { startFakePixoo } from "./fake-pixoo.js";
import { startMemoryBroker } from "./memory-broker.js";
import { rasterizeAwtrixApp } from "../src/drivers/awtrix-raster.js";
import { sharedPaths } from "../src/scenes/v1-shared.js";
import "./net-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const v2Root = resolve(here, "..");
const repoRoot = sharedPaths().root;
const once = process.argv.includes("--once");
const uiPort = Number(process.env.PIXDCON2_DEV_PORT ?? (once ? 0 : 8090));
const controlPort = Number(
  process.env.PIXDCON2_DEV_CONTROL_PORT ?? (once ? 0 : 8091),
);

/** @param {string} message */
const say = (message) => process.stdout.write(`[dev] ${message}\n`);

/**
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>|null>} the health answer, or null when v2 did not come up in time
 */
async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok)
        return /** @type {Record<string, unknown>} */ (await response.json());
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return null;
}

/** @returns {Promise<number>} a free loopback port */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

// Everything this process opens is stopped again in reverse order, also when
// the start fails half way (a port that is taken): each resource registers
// its stop step the moment it exists.
/** @type {Array<() => unknown>} */
const stopSteps = [];
async function stopEverything() {
  for (const step of stopSteps.splice(0).reverse()) {
    try {
      await step();
    } catch (error) {
      say(
        `stop step failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
/**
 * @template T
 * @param {Promise<T>} starting
 * @param {(resource: T) => unknown} stop
 * @returns {Promise<T>}
 */
async function acquire(starting, stop) {
  try {
    const resource = await starting;
    stopSteps.push(() => stop(resource));
    return resource;
  } catch (error) {
    say(
      `could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    await stopEverything();
    process.exit(1);
  }
}

const broker = await acquire(startMemoryBroker(), (started) => started.stop());
const pixoo = await acquire(startFakePixoo(), (started) => started.stop());
const awtrix = await acquire(startFakeAwtrix(), (started) => started.stop());
awtrix.setRaster(
  (app) =>
    rasterizeAwtrixApp(/** @type {Record<string, unknown>} */ (app)).frame.rgb,
);
const fakes = { pixoo, awtrix };

const dataDir = await acquire(mkdtemp(join(tmpdir(), "pixdcon2-dev-")), (dir) =>
  rm(dir, { recursive: true, force: true }),
);
const template = await readFile(join(here, "dev-config.json"), "utf8");
await writeFile(
  join(dataDir, "config.json"),
  template
    .replaceAll("__PIXOO__", pixoo.address)
    .replaceAll("__AWTRIX__", awtrix.address)
    .replaceAll("__REPO__", repoRoot.replaceAll("\\", "/")),
);

const childPort = uiPort || (await freePort());
/** @type {import("node:child_process").ChildProcess|null} */
let child = null;
let stopping = false;

function startChild() {
  const started = Date.now();
  child = spawn(
    process.execPath,
    ["--import", join(here, "net-guard.js"), join(v2Root, "src/main.js")],
    {
      cwd: v2Root,
      stdio: "inherit",
      // A clean environment: nothing from the developer's shell reaches v2 or the scenes.
      env: {
        PATH: process.env.PATH ?? "",
        TZ: process.env.TZ ?? "Europe/Vienna",
        LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
        PIXDCON_CONFIG_PATH: join(dataDir, "config.json"),
        WEB_PORT: String(childPort),
        MOSQUITTO_HOST: broker.host,
        MQTT_PORT: String(broker.port),
        PIXDCON2_MQTT_ANONYMOUS: "1",
        PIXDCON2_INSTANCE: "pixdcon2-dev",
      },
    },
  );
  const thisChild = child;
  child.on("exit", (code, signal) => {
    // Only an exit nobody asked for is worth a line: a crash while starting or running.
    if (child === thisChild && !stopping) {
      say(
        `pixdcon2 exited by itself (code ${code}, signal ${signal}); waiting for the next change`,
      );
    }
  });
  return waitForHealth(childPort, 10000).then((health) => {
    if (health)
      say(
        `pixdcon2 is up after ${Date.now() - started} ms → http://127.0.0.1:${childPort}/`,
      );
    else say("pixdcon2 did not answer /api/health within 10 s");
    return health;
  });
}

/** @returns {Promise<void>} */
function stopChild() {
  return new Promise((resolveStop) => {
    const running = child;
    child = null;
    if (!running || running.exitCode !== null || running.signalCode !== null) {
      resolveStop();
      return;
    }
    const force = setTimeout(() => running.kill("SIGKILL"), 9000);
    running.once("exit", () => {
      clearTimeout(force);
      resolveStop();
    });
    running.kill("SIGTERM");
  });
}

// --- control port -------------------------------------------------------------
const control = createServer((req, res) => {
  /** @type {Buffer[]} */
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    /**
     * @param {number} status
     * @param {unknown} body
     */
    const answer = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(`${JSON.stringify(body, null, 2)}\n`);
    };
    try {
      const path = (req.url ?? "/").split("?")[0];
      const fake =
        /^\/fake\/(pixoo|awtrix)\/(offline|online|hang|unhang)$/.exec(path);
      if (req.method === "GET" && path === "/") {
        const { lastFrame, ...pixooState } = pixoo.state();
        const { rawFrame, ...awtrixState } = awtrix.state();
        answer(200, {
          ui: `http://127.0.0.1:${childPort}/`,
          broker: broker.url,
          dataDir,
          pixoo: {
            address: pixoo.address,
            hasFrame: Boolean(lastFrame),
            ...pixooState,
            requests: pixooState.requests.length,
          },
          awtrix: {
            address: awtrix.address,
            hasRawFrame: Boolean(rawFrame),
            ...awtrixState,
            requests: awtrixState.requests.length,
          },
          retained: broker.retained(),
        });
      } else if (req.method === "POST" && fake) {
        const target = fakes[/** @type {"pixoo"|"awtrix"} */ (fake[1])];
        if (fake[2] === "offline") await target.setOffline(true);
        if (fake[2] === "online") await target.setOffline(false);
        if (fake[2] === "hang") target.setHang(true);
        if (fake[2] === "unhang") target.setHang(false);
        answer(200, { ok: true, device: fake[1], state: fake[2] });
      } else if (req.method === "POST" && path === "/mqtt/publish") {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        await broker.inject(
          String(message.topic),
          String(message.payload ?? ""),
          { retain: message.retain === true },
        );
        answer(200, { ok: true });
      } else {
        answer(404, { error: "unknown control route" });
      }
    } catch (error) {
      answer(400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
await acquire(
  new Promise((resolveListen, rejectListen) => {
    control.once("error", rejectListen);
    control.listen(controlPort, "127.0.0.1", () => {
      control.off("error", rejectListen);
      resolveListen(control);
    });
  }),
  (server) =>
    new Promise((resolveClose) => server.close(() => resolveClose(undefined))),
);
const controlAddress = control.address();
const controlPortInUse =
  typeof controlAddress === "object" && controlAddress
    ? controlAddress.port
    : controlPort;

/** @param {number} code */
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  await stopChild();
  await stopEverything();
  process.exit(code);
}

say(
  `fake Pixoo64 on ${pixoo.address}, fake AWTRIX on ${awtrix.address}, MQTT broker on ${broker.url}`,
);
say(
  `control port: http://127.0.0.1:${controlPortInUse}/   data dir: ${dataDir}`,
);

const health = await startChild();
if (once) {
  await shutdown(health ? 0 : 1);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

// --- restart on change ---------------------------------------------------------
/** @type {NodeJS.Timeout|null} */
let debounce = null;
let restarting = false;
watch(join(v2Root, "src"), { recursive: true }, (_event, file) => {
  if (stopping || (file && !String(file).endsWith(".js"))) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(async () => {
    if (restarting || stopping) return;
    restarting = true;
    const started = Date.now();
    say(`change in src/${file ?? ""}: restarting`);
    await stopChild();
    await startChild();
    say(`restart took ${Date.now() - started} ms`);
    restarting = false;
  }, 150);
});
