/**
 * Test harness shared by the contract and smoke tests: fake displays, the
 * in-memory broker, a data directory, and pixdcon 2 itself in this process.
 *
 * Everything listens on loopback and on free ports, so test files can run in
 * parallel.
 *
 * Cleanup is registered before the first resource exists, and every resource
 * adds its own stop step the moment it is acquired. So whatever happens on
 * the way up (a port that cannot be bound, a config that does not parse, a
 * start step that throws) nothing stays open: startStack() stops what it had
 * started and then rejects. Stop steps run in reverse order, each with its
 * own time limit, and one that fails does not keep the others from running.
 * The whole run has a hard deadline on top (test/helpers/deadline.js).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAwtrix } from "../../dev/fake-awtrix.js";
import { startFakePixoo } from "../../dev/fake-pixoo.js";
import { startMemoryBroker } from "../../dev/memory-broker.js";
import { rasterizeAwtrixApp } from "../../src/drivers/awtrix-raster.js";
import { sharedPaths } from "../../src/scenes/v1-shared.js";
import { guardInstalled } from "../../dev/net-guard.js";
import { createLogger } from "../../src/core/logger.js";
import { createApp } from "../../src/main.js";

export const REPO_ROOT = sharedPaths().root;

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

const CLEANUP_STEP_LIMIT_MS = 5000;

/**
 * A list of stop steps that is run once, in reverse order.
 *
 * @returns {{add: (name: string, step: () => unknown) => void, run: () => Promise<void>}}
 */
export function cleanupStack() {
  /** @type {Array<{name: string, step: () => unknown}>} */
  const steps = [];
  let done = false;
  return {
    add(name, step) {
      steps.push({ name, step });
    },
    async run() {
      if (done) return;
      done = true;
      /** @type {Error[]} */
      const failures = [];
      for (const { name, step } of steps.reverse()) {
        /** @type {NodeJS.Timeout|undefined} */
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(step),
            new Promise((_resolve, rejectLate) => {
              timer = setTimeout(
                () =>
                  rejectLate(
                    new Error(
                      `cleanup step "${name}" did not finish within ${CLEANUP_STEP_LIMIT_MS} ms`,
                    ),
                  ),
                CLEANUP_STEP_LIMIT_MS,
              );
              timer.unref();
            }),
          ]);
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        } finally {
          clearTimeout(timer);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          `test cleanup: ${failures.map((failure) => failure.message).join("; ")}`,
        );
    },
  };
}

/**
 * Start fakes, broker and pixdcon 2. Stops everything when the test ends,
 * and at once when the start itself fails.
 *
 * @param {import("node:test").TestContext} t
 * @param {{clock?: import("../../src/types.js").Clock, config?: (config: Record<string, any>) => void, configText?: string, env?: Record<string, string>, mqtt?: boolean, brokerPort?: number}} [options] configText: write this instead of a generated config.json; brokerPort: bind the broker there instead of a free port
 */
export async function startStack(t, options = {}) {
  requireNetGuard();
  const cleanup = cleanupStack();
  t.after(() => cleanup.run());

  try {
    const broker = await startMemoryBroker({ port: options.brokerPort });
    cleanup.add("broker", () => broker.stop());
    const pixoo = await startFakePixoo();
    cleanup.add("fake pixoo", () => pixoo.stop());
    const awtrix = await startFakeAwtrix();
    cleanup.add("fake awtrix", () => awtrix.stop());
    awtrix.setRaster(
      (app) =>
        rasterizeAwtrixApp(/** @type {Record<string, unknown>} */ (app)).frame
          .rgb,
    );
    const dataDir = await mkdtemp(join(tmpdir(), "pixdcon2-test-"));
    cleanup.add("data dir", () =>
      rm(dataDir, { recursive: true, force: true }),
    );
    const configPath = join(dataDir, "config.json");
    await writeFile(
      configPath,
      options.configText ??
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
    const app = await createApp(
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
    // Registered before start(): a start that fails half way is stopped too.
    cleanup.add("pixdcon2", () => app.stop());
    const { port } = await app.start();
    const base = `http://127.0.0.1:${port}`;

    return stackOf({
      app,
      base,
      broker,
      pixoo,
      awtrix,
      dataDir,
      configPath,
      logLines,
    });
  } catch (error) {
    await cleanup.run().catch(() => {});
    throw error;
  }
}

/**
 * @template {{base: string}} T
 * @param {T} parts
 */
function stackOf(parts) {
  const { base } = parts;
  return {
    ...parts,
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
