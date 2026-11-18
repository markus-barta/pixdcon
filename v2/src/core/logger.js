/**
 * One logger for every module (matrix A-003: v1 has one bypass in the config
 * loader). Line shape stays grep-able as in v1:
 *   <ISO-8601 UTC> <LEVEL right-aligned in 5 chars> <message>
 * with the component prefix in brackets inside the message. error and warn go
 * to stderr, info and debug to stdout. The last lines are kept in a ring for
 * Health › Recent log (approved: Health log panel yes).
 */

/** @typedef {import("../types.js").Logger} Logger */
/** @typedef {import("../types.js").LogLine} LogLine */

const LEVELS = /** @type {const} */ ({ error: 0, warn: 1, info: 2, debug: 3 });

/**
 * @param {object} [options]
 * @param {string} [options.level] LOG_LEVEL: error, warn, info, debug (case-insensitive). Unknown values mean info and are reported once (A-002).
 * @param {number} [options.ringSize] lines kept for the Health page, default 200
 * @param {() => number} [options.now]
 * @param {{out: (line: string) => void, err: (line: string) => void}} [options.sink]
 * @returns {Logger & {ring: () => LogLine[], onLine: (cb: (line: LogLine) => void) => () => void}}
 */
export function createLogger(options = {}) {
  const now = options.now ?? Date.now;
  const ringSize = options.ringSize ?? 200;
  const sink = options.sink ?? {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  const wanted = String(options.level ?? "info").toLowerCase();
  const known = Object.hasOwn(LEVELS, wanted);
  const threshold = known
    ? LEVELS[/** @type {keyof typeof LEVELS} */ (wanted)]
    : LEVELS.info;

  /** @type {LogLine[]} */
  const ring = [];
  /** @type {Set<(line: LogLine) => void>} */
  const listeners = new Set();
  let seq = 0;

  /**
   * @param {keyof typeof LEVELS} level
   * @param {string} message
   * @param {unknown} [err]
   */
  function write(level, message, err) {
    if (level !== "error" && LEVELS[level] > threshold) return;
    const at = new Date(now()).toISOString();
    const detail =
      err === undefined
        ? ""
        : ` — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    const text = `${message}${detail}`;
    const upper = /** @type {LogLine["level"]} */ (level.toUpperCase());
    const line = `${at} ${upper.padStart(5)} ${text}`;
    if (level === "error" || level === "warn") sink.err(line);
    else sink.out(line);

    const entry = { seq: ++seq, at, level: upper, message: text };
    ring.push(entry);
    if (ring.length > ringSize) ring.shift();
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {}
    }
  }

  const logger = {
    /** @param {string} msg @param {unknown} [err] */
    error: (msg, err) => write("error", msg, err),
    /** @param {string} msg */
    warn: (msg) => write("warn", msg),
    /** @param {string} msg */
    info: (msg) => write("info", msg),
    /** @param {string} msg */
    debug: (msg) => write("debug", msg),
    /** The kept lines, oldest first. */
    ring: () => ring.slice(),
    /**
     * Follow new lines (live channel).
     * @param {(line: LogLine) => void} cb
     * @returns {() => void} unsubscribe
     */
    onLine: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  if (!known)
    logger.warn(`[pixdcon2] Unknown LOG_LEVEL "${options.level}", using info`);
  return logger;
}
