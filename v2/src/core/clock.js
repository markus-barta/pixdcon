/**
 * Injected time source. Production uses the system clock; the smoke tests use
 * a manual clock to cross the stale (30 s) and offline (2 min) thresholds in
 * milliseconds. Modules must take time from here and never call Date.now()
 * or setTimeout() directly.
 */

/** @typedef {import("../types.js").Clock} Clock */

/** @returns {Clock} */
export function systemClock() {
  return {
    now: () => Date.now(),
    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(true);
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(false);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    every(fn, ms) {
      const timer = setInterval(fn, ms);
      timer.unref();
      return { cancel: () => clearInterval(timer) };
    },
  };
}

/**
 * Manual clock for tests: time only moves when `advance()` is called.
 *
 * @param {number} [startMs] epoch ms of "now"
 * @returns {Clock & {advance: (ms: number) => Promise<void>, pending: () => number}}
 */
export function manualClock(startMs = Date.UTC(2026, 10, 16, 17, 42, 7)) {
  let now = startMs;
  /** @type {Array<{at: number, run: () => void, id: number}>} */
  let queue = [];
  let nextId = 0;

  /**
   * @param {number} delay
   * @param {() => void} run
   * @returns {number} id
   */
  const schedule = (delay, run) => {
    const id = ++nextId;
    queue.push({ at: now + Math.max(0, delay), run, id });
    return id;
  };
  /** @param {number} id */
  const unschedule = (id) => {
    queue = queue.filter((entry) => entry.id !== id);
  };

  return {
    now: () => now,
    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        const id = schedule(ms, () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(true);
        });
        const onAbort = () => {
          unschedule(id);
          resolve(false);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    every(fn, ms) {
      let cancelled = false;
      let id = 0;
      const tick = () => {
        if (cancelled) return;
        fn();
        id = schedule(ms, tick);
      };
      id = schedule(ms, tick);
      return {
        cancel: () => {
          cancelled = true;
          unschedule(id);
        },
      };
    },
    /** Move time forward, running every timer that falls due, in order. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = queue[0];
        if (!next || next.at > target) break;
        queue.shift();
        now = next.at;
        next.run();
        // let promise continuations run before the next timer
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
      await new Promise((resolve) => setImmediate(resolve));
    },
    pending: () => queue.length,
  };
}
