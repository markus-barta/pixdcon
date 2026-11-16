/**
 * Test harness shared by the contract and smoke tests: fake displays, the
 * in-memory broker, a data directory, and pixdcon 2 itself in this process.
 *
 * Everything listens on loopback and on free ports, so test files can run in
 * parallel. `startStack()` registers its own cleanup with the test context.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeAwtrix } from "../../dev/fake-awtrix.js";
import { startFakePixoo } from "../../dev/fake-pixoo.js";
import { startMemoryBroker } from "../../dev/memory-broker.js";
import { guardInstalled } from "../../dev/net-guard.js";
import { createLogger } from "../../src/core/logger.js";
import { createApp } from "../../src/main.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

/** Every test file must run under the network guard; `npm test` preloads it. */
export function requireNetGuard() {
  assert.ok(
    guardInstalled(),
    "run tests through npm test: dev/net-guard.js must be preloaded",
  );
}

/**
 * A config.json for tests: one fake Pixoo and one fake Ulanzi, scenes from the repository.
 *
 * @param {{pixoo: string, awtrix: string}} addresses
 * @param {(config: Record<string, any>) => void} [adjust]
 * @returns {Record<string, any>}
 */
export function testConfig(addresses, adjust) {
  const config = {
    devices: [
      {
        name: "pixoo-t",
        type: "pixoo",
        ip: addresses.pixoo,
        scene: "funkeykid",
        minFrameMs: 50,
      },
      {
        name: "ulanzi-t",
        type: "ulanzi",
        ip: addresses.awtrix,
        scene: "clock",
        minFrameMs: 50,
      },
    ],
    scenes: {
      clock: { path: join(REPO_ROOT, "scenes/ulanzi/clock.js") },
      "test-pattern": {
        path: join(REPO_ROOT, "scenes/ulanzi/test-pattern.js"),
      },
      funkeykid: { path: join(REPO_ROOT, "scenes/pixoo/funkeykid.js") },
    },
  };
  adjust?.(config);
  return config;
}

/**
 * Start fakes, broker and pixdcon 2. Stops everything when the test ends.
 *
 * @param {import("node:test").TestContext} t
 * @param {{clock?: import("../../src/types.js").Clock, config?: (config: Record<string, any>) => void, env?: Record<string, string>, mqtt?: boolean}} [options]
 */
export async function startStack(t, options = {}) {
  requireNetGuard();
  const broker = await startMemoryBroker();
  const pixoo = await startFakePixoo();
  const awtrix = await startFakeAwtrix();
  const dataDir = await mkdtemp(join(tmpdir(), "pixdcon2-test-"));
  const configPath = join(dataDir, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify(testConfig({ pixoo: pixoo.address, awtrix: awtrix.address }, options.config), null, 2)}\n`,
  );

  /** @type {string[]} */
  const logLines = [];
  const logger = createLogger({
    level: "debug",
    sink: {
      out: (line) => logLines.push(line),
      err: (line) => logLines.push(line),
    },
  });
  const app = createApp(
    {
      PIXDCON_CONFIG_PATH: configPath,
      WEB_PORT: "0",
      TZ: "Europe/Vienna",
      ...(options.mqtt === false
        ? {}
        : {
            MOSQUITTO_HOST: broker.host,
            MQTT_PORT: String(broker.port),
            PIXDCON2_MQTT_ANONYMOUS: "1",
          }),
      PIXDCON2_INSTANCE: "pixdcon2-test",
      ...options.env,
    },
    { clock: options.clock, logger },
  );
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await app.stop();
    await Promise.all([pixoo.stop(), awtrix.stop(), broker.stop()]);
    await rm(dataDir, { recursive: true, force: true });
  });

  return {
    app,
    base,
    broker,
    pixoo,
    awtrix,
    dataDir,
    configPath,
    logLines,
    /**
     * @param {string} path
     * @param {{method?: string, body?: unknown}} [request]
     * @returns {Promise<{status: number, body: any}>}
     */
    async api(path, request = {}) {
      const response = await fetch(`${base}${path}`, {
        method: request.method ?? (request.body === undefined ? "GET" : "POST"),
        headers:
          request.body === undefined
            ? {}
            : { "Content-Type": "application/json" },
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body };
    },
  };
}
