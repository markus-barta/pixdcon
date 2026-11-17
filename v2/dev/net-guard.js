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
 * What it does, in the process that loads it:
 *  - TCP and TLS (so also http, https, fetch and mqtt): a connection to
 *    anything but localhost, 127.0.0.0/8 or ::1 fails at once with code
 *    ENETGUARD; no packet and no DNS query leaves the machine
 *  - DNS: dns.lookup answers for localhost and for IP literals (neither needs
 *    the network) and fails for every other name; every resolve and reverse
 *    function, also on Resolver objects and on dns.promises, fails. All with
 *    code ENETGUARD, before a query is sent
 *  - UDP: a datagram to anything but loopback is not sent; send() and
 *    connect() fail with ENETGUARD
 *  - child processes: only Node itself may be started (the test runner and
 *    the dev runner do that); `ping` and everything else fails like a missing
 *    program (ENOENT), which the scenes already handle as "not alive"
 *
 * And in what that process starts:
 *  - a Node child process gets the guard too, whatever environment and
 *    arguments it was started with: the guard adds `--import <this file>` to
 *    the child's NODE_OPTIONS. Without this a child was a way out.
 *  - in a test run a Node child also gets the run's hard deadline
 *    (test/helpers/deadline.js): when this process has
 *    PIXDCON2_TEST_DEADLINE_PRELOAD and PIXDCON2_TEST_DEADLINE_AT, set by
 *    test/helpers/run.js, both are passed on and the preload is added. A
 *    child that outlives its test, also one that left the run's process
 *    group, then ends itself at the deadline.
 *  - a worker thread gets the guard too. A worker has its own copies of the
 *    net, dns and dgram modules, so the patches of the parent do not reach
 *    it, and Node passes a parent's `--import` on only to some kinds of
 *    worker (not to one created from source text, `eval: true`). The guard
 *    therefore wraps the Worker class: it adds the preload to the worker's
 *    arguments and, for a worker made from source text, loads itself in the
 *    first line.
 *
 * coverage() reports which of these are in place; test/smoke checks it, and
 * checks a child and a worker, without sending anything: the checks ask "is
 * the guard installed there", they do not try to get out.
 *
 * Limits, stated plainly: this is a guard inside Node, not a sandbox. Code
 * that loads a native add-on to open sockets, or that starts a Node binary
 * built without NODE_OPTIONS support, is outside it. No shipped scene or
 * helper does either. The image and the edge lane run without this file.
 *
 * There is no switch to turn it off.
 */

import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { pathToFileURL } from "node:url";
import workerThreads from "node:worker_threads";

const KEY = Symbol.for("pixdcon2.net-guard");
const PRELOAD = `--import=${pathToFileURL(import.meta.filename).href}`;

/** @typedef {{kind: "connect"|"spawn"|"dns"|"udp", target: string, at: number}} BlockedAttempt */
/** @typedef {{connect: boolean, spawn: boolean, childPreload: boolean, workerPreload: boolean, dns: boolean, udp: boolean}} GuardCoverage */

/** @type {{blocked: BlockedAttempt[], coverage: GuardCoverage}} */
const state = /** @type {any} */ (globalThis)[KEY] ?? {
  blocked: [],
  coverage: {
    connect: false,
    spawn: false,
    childPreload: false,
    workerPreload: false,
    dns: false,
    udp: false,
  },
};

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
 * @param {BlockedAttempt["kind"]} kind
 * @param {string} target
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {Error & {code: string}}
 */
function blocked(kind, target, message, extra = {}) {
  state.blocked.push({ kind, target, at: Date.now() });
  return Object.assign(new Error(`net-guard: ${message}`), {
    code: "ENETGUARD",
    ...extra,
  });
}

/**
 * NODE_OPTIONS with the guard's preload added, for a Node child.
 *
 * @param {string|undefined} current
 * @returns {string}
 */
function withPreload(current) {
  let options = current ?? "";
  for (const preload of [PRELOAD, deadlinePreload()]) {
    if (preload && !options.includes(preload))
      options = options ? `${options} ${preload}` : preload;
  }
  return options;
}

/** @returns {string|null} `--import` of the test run's deadline module, when this process is part of a test run */
function deadlinePreload() {
  const url = process.env.PIXDCON2_TEST_DEADLINE_PRELOAD;
  return url && process.env.PIXDCON2_TEST_DEADLINE_AT
    ? `--import=${url}`
    : null;
}

/** Environment variables of a test run that a Node child must get, whatever environment it was given. */
const DEADLINE_VARIABLES = /** @type {const} */ ([
  "PIXDCON2_TEST_DEADLINE_AT",
  "PIXDCON2_TEST_DEADLINE_PRELOAD",
]);

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

function installConnect() {
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
    const error = blocked(
      "connect",
      where,
      `connection to ${where} blocked; dev and tests may only reach loopback`,
      { address: String(target.host), port: target.port },
    );
    process.nextTick(() => this.destroy(error));
    return this;
  }
  socketProto.connect = guardedConnect;
  state.coverage.connect = true;
}

function installSpawn() {
  const childProto = /** @type {any} */ (childProcess.ChildProcess.prototype);
  const originalSpawn = childProto.spawn;
  /**
   * Every asynchronous way to start a process ends here (spawn, exec,
   * execFile, fork). `options` is Node's normalised form: `file`, and the
   * environment as "KEY=value" strings in `envPairs`.
   *
   * @this {import("node:child_process").ChildProcess}
   * @param {{file?: string, envPairs?: string[]}} options
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
    } else {
      // A Node child: make sure it loads the guard, also when it was given a
      // clean environment or one without NODE_OPTIONS.
      const pairs = Array.isArray(options.envPairs)
        ? options.envPairs.slice()
        : [];
      const index = pairs.findIndex((pair) => pair.startsWith("NODE_OPTIONS="));
      const value = withPreload(
        index === -1 ? undefined : pairs[index].slice("NODE_OPTIONS=".length),
      );
      if (index === -1) pairs.push(`NODE_OPTIONS=${value}`);
      else pairs[index] = `NODE_OPTIONS=${value}`;
      if (deadlinePreload()) {
        // A deadline the child was given itself stays as it is.
        for (const name of DEADLINE_VARIABLES)
          if (!pairs.some((pair) => pair.startsWith(`${name}=`)))
            pairs.push(`${name}=${process.env[name]}`);
      }
      options.envPairs = pairs;
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
      if (name === "execSync" || args[0] !== process.execPath) {
        throw blocked(
          "spawn",
          String(args[0]),
          `${name}("${String(args[0])}") blocked`,
        );
      }
      // Node itself, synchronously: same rule, the child loads the guard.
      const last = args[args.length - 1];
      const hasOptions =
        last !== null && typeof last === "object" && !Array.isArray(last);
      const options = hasOptions ? { ...last } : {};
      const env = { ...(options.env ?? process.env) };
      env.NODE_OPTIONS = withPreload(env.NODE_OPTIONS);
      if (deadlinePreload())
        for (const name of DEADLINE_VARIABLES) env[name] ??= process.env[name];
      options.env = env;
      const rest = hasOptions ? args.slice(0, -1) : args;
      return original(...rest, options);
    };
  }
  state.coverage.spawn = true;
  state.coverage.childPreload = true;
}

function installDns() {
  /**
   * @param {string} what
   * @param {unknown} name
   */
  const dnsError = (what, name) =>
    blocked(
      "dns",
      `${what} ${String(name)}`,
      `DNS ${what} for ${String(name)} blocked; dev and tests may only reach loopback`,
      { hostname: String(name) },
    );
  /** localhost and IP literals are answered without the network. @param {unknown} name */
  const local = (name) =>
    typeof name === "string" && (isLoopback(name) || net.isIP(name) !== 0);

  const anyDns = /** @type {any} */ (dns);
  const originalLookup = anyDns.lookup;
  anyDns.lookup = (/** @type {any[]} */ ...args) => {
    if (local(args[0])) return originalLookup(...args);
    const callback = args[args.length - 1];
    const error = dnsError("lookup", args[0]);
    if (typeof callback === "function") process.nextTick(callback, error);
    return {};
  };
  // Keep what Node attached to the original (the custom promisify form).
  for (const key of Reflect.ownKeys(originalLookup)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const descriptor = Object.getOwnPropertyDescriptor(originalLookup, key);
    if (descriptor) Object.defineProperty(anyDns.lookup, key, descriptor);
  }

  const promises = /** @type {any} */ (dns.promises);
  const originalPromiseLookup = promises.lookup;
  promises.lookup = (/** @type {any[]} */ ...args) =>
    local(args[0])
      ? originalPromiseLookup(...args)
      : Promise.reject(dnsError("lookup", args[0]));

  /** resolve*, reverse and lookupService always ask a name server. @param {string} name */
  const asksServer = (name) =>
    name.startsWith("resolve") ||
    name === "reverse" ||
    name === "lookupService";

  for (const target of [anyDns, anyDns.Resolver?.prototype]) {
    if (!target) continue;
    for (const name of Object.getOwnPropertyNames(target)) {
      if (!asksServer(name) || typeof target[name] !== "function") continue;
      target[name] = (/** @type {any[]} */ ...args) => {
        const callback = args[args.length - 1];
        const error = dnsError(name, args[0]);
        if (typeof callback === "function") process.nextTick(callback, error);
        else throw error;
      };
    }
  }
  for (const target of [promises, promises.Resolver?.prototype]) {
    if (!target) continue;
    for (const name of Object.getOwnPropertyNames(target)) {
      if (!asksServer(name) || typeof target[name] !== "function") continue;
      target[name] = (/** @type {any[]} */ ...args) =>
        Promise.reject(dnsError(name, args[0]));
    }
  }
  state.coverage.dns = true;
}

function installUdp() {
  const socketProto = /** @type {any} */ (dgram.Socket.prototype);
  const originalSend = socketProto.send;
  const originalConnect = socketProto.connect;

  /**
   * Where a send() goes, by Node's own argument rules:
   *   send(msg, offset, length, port, address, cb)  or  send(msg, port, address, cb)
   *   or, on a connected socket, send(msg, cb) / send(msg, offset, length, cb).
   *
   * @this {import("node:dgram").Socket}
   * @param {any[]} args
   * @returns {{address: unknown, callback: unknown}}
   */
  function sendTarget(args) {
    const [, , length, port, address] = args;
    const callback = [...args]
      .reverse()
      .find((arg) => typeof arg === "function");
    try {
      // Throws when the socket is not connected.
      return { address: this.remoteAddress().address, callback };
    } catch {}
    if (address || (port && typeof port !== "function"))
      return { address, callback };
    return {
      address: typeof length === "function" ? undefined : length,
      callback,
    };
  }

  /**
   * @this {import("node:dgram").Socket}
   * @param {...any} args
   */
  socketProto.send = function guardedSend(...args) {
    const { address, callback } = sendTarget.call(this, args);
    if (isLoopback(address)) return originalSend.apply(this, args);
    const error = blocked(
      "udp",
      String(address),
      `datagram to ${String(address)} blocked; dev and tests may only reach loopback`,
      { address: String(address) },
    );
    if (typeof callback === "function") process.nextTick(callback, error);
    else process.nextTick(() => this.emit("error", error));
  };

  /**
   * @this {import("node:dgram").Socket}
   * @param {...any} args connect(port, address?, callback?)
   */
  socketProto.connect = function guardedConnect(...args) {
    const address = typeof args[1] === "string" ? args[1] : undefined;
    if (isLoopback(address)) return originalConnect.apply(this, args);
    const callback = args.find((arg) => typeof arg === "function");
    const error = blocked(
      "udp",
      String(address),
      `datagram socket to ${String(address)} blocked; dev and tests may only reach loopback`,
      { address: String(address) },
    );
    if (typeof callback === "function") process.nextTick(callback, error);
    else process.nextTick(() => this.emit("error", error));
  };
  state.coverage.udp = true;
}

function installWorker() {
  const OriginalWorker = workerThreads.Worker;
  const guardFile = import.meta.filename;
  class GuardedWorker extends OriginalWorker {
    /**
     * @param {string|URL} filename
     * @param {import("node:worker_threads").WorkerOptions} [options]
     */
    constructor(filename, options = {}) {
      if (options.eval === true && typeof filename === "string") {
        // Source text runs as a script; load the guard before its first line.
        super(`require(${JSON.stringify(guardFile)});\n${filename}`, options);
        return;
      }
      const own = options.execArgv ?? [];
      super(filename, {
        ...options,
        execArgv: own.includes(PRELOAD) ? own : [...own, PRELOAD],
      });
    }
  }
  /** @type {any} */ (workerThreads).Worker = GuardedWorker;
  state.coverage.workerPreload = true;
}

if (!(/** @type {any} */ (globalThis)[KEY])) {
  /** @type {any} */ (globalThis)[KEY] = state;
  installConnect();
  installSpawn();
  installWorker();
  installDns();
  installUdp();
  syncBuiltinESMExports();
}

/** @returns {boolean} true when the guard is active in this process */
export function guardInstalled() {
  return Boolean(/** @type {any} */ (globalThis)[KEY]);
}

/** @returns {GuardCoverage} which doors are closed in this process */
export function coverage() {
  return { ...state.coverage };
}

/** @returns {BlockedAttempt[]} what was blocked so far, oldest first */
export function blockedAttempts() {
  return state.blocked.slice();
}
