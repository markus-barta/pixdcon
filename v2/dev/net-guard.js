/**
 * Network guard for dev and tests: only loopback is reachable.
 *
 * Preloaded with `node --import ./dev/net-guard.js` by `npm run dev` (for the
 * v2 process) and by every `npm test` script. Why it exists: scenes are shared
 * with v1 and do their own I/O. The dashboards poll the Hue Sync Box, the
 * Sonnen battery, a Shelly, Open-Meteo, and ping the locks and repeaters.
 * Without this guard, running a dashboard scene on the laptop in the home
 * network would contact real hosts, and a test with a typo in an address
 * would contact a real display or broker. The rule for v2 work is: never.
 *
 * What it does:
 *  - TCP and TLS (so also http, https, fetch and mqtt): a connection to
 *    anything but localhost, 127.0.0.0/8 or ::1 fails at once with code
 *    ENETGUARD; no packet and no DNS query leaves the machine
 *  - child processes: only Node itself may be started (the test runner and the
 *    dev runner do that); `ping` and everything else fails like a missing
 *    program (ENOENT), which the scenes already handle as "not alive"
 *  - UDP is not covered; no shipped code uses it
 *
 * There is no switch to turn it off. The production image and the edge lane
 * do not load this file.
 */

import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const KEY = Symbol.for("pixdcon2.net-guard");

/** @typedef {{kind: "connect"|"spawn", target: string, at: number}} BlockedAttempt */

/** @type {{blocked: BlockedAttempt[]}} */
const state = /** @type {any} */ (globalThis)[KEY] ?? { blocked: [] };

/**
 * @param {unknown} host
 * @returns {boolean}
 */
export function isLoopback(host) {
  if (host === undefined || host === null || host === "") return true; // Node's default is localhost
  const text = String(host)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    text === "localhost" ||
    text === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(text) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(text)
  );
}

/**
 * Work out where a Socket.connect() call is going. Handles the three public
 * forms and the normalised array that net.connect() passes on.
 *
 * @param {unknown[]} args
 * @returns {{ipc: true} | {ipc: false, host: unknown, port: unknown}}
 */
function targetOf(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    const options =
      /** @type {{path?: unknown, host?: unknown, port?: unknown}} */ (first);
    if (options.path) return { ipc: true };
    return { ipc: false, host: options.host, port: options.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { ipc: true };
  return {
    ipc: false,
    host: typeof args[1] === "string" ? args[1] : undefined,
    port: first,
  };
}

function install() {
  const socketProto = /** @type {any} */ (net.Socket.prototype);
  const originalConnect = socketProto.connect;
  /**
   * @this {import("node:net").Socket}
   * @param {...unknown} args
   */
  function guardedConnect(...args) {
    const target = targetOf(args);
    if (target.ipc || isLoopback(target.host))
      return originalConnect.apply(this, args);
    const where = `${String(target.host)}:${String(target.port)}`;
    state.blocked.push({ kind: "connect", target: where, at: Date.now() });
    const error = Object.assign(
      new Error(
        `net-guard: connection to ${where} blocked; dev and tests may only reach loopback`,
      ),
      { code: "ENETGUARD", address: String(target.host), port: target.port },
    );
    process.nextTick(() => this.destroy(error));
    return this;
  }
  socketProto.connect = guardedConnect;

  const childProto = /** @type {any} */ (childProcess.ChildProcess.prototype);
  const originalSpawn = childProto.spawn;
  /**
   * @this {import("node:child_process").ChildProcess}
   * @param {{file?: string}} options
   */
  function guardedSpawn(options) {
    if (options?.file !== process.execPath) {
      state.blocked.push({
        kind: "spawn",
        target: String(options?.file),
        at: Date.now(),
      });
      // Fail the way a missing program fails; callers already handle that.
      options.file = "/nonexistent/blocked-by-pixdcon2-net-guard";
    }
    return originalSpawn.call(this, options);
  }
  childProto.spawn = guardedSpawn;

  const syncNames = /** @type {const} */ ([
    "spawnSync",
    "execSync",
    "execFileSync",
  ]);
  for (const name of syncNames) {
    const original = /** @type {(...args: any[]) => any} */ (
      childProcess[name]
    );
    /** @type {any} */ (childProcess)[name] = (
      /** @type {any[]} */ ...args
    ) => {
      if (name !== "execSync" && args[0] === process.execPath)
        return original(...args);
      state.blocked.push({
        kind: "spawn",
        target: String(args[0]),
        at: Date.now(),
      });
      throw Object.assign(
        new Error(`net-guard: ${name}("${String(args[0])}") blocked`),
        {
          code: "ENETGUARD",
        },
      );
    };
  }
  syncBuiltinESMExports();
}

if (!(/** @type {any} */ (globalThis)[KEY])) {
  /** @type {any} */ (globalThis)[KEY] = state;
  install();
}

/** @returns {boolean} true when the guard is active in this process */
export function guardInstalled() {
  return Boolean(/** @type {any} */ (globalThis)[KEY]);
}

/** @returns {BlockedAttempt[]} what was blocked so far, oldest first */
export function blockedAttempts() {
  return state.blocked.slice();
}
