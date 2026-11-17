/**
 * Ordering: the one rule every asynchronous input obeys.
 *
 * An asynchronous input is anything that reaches a module later than the
 * call that asked for it: a message callback, an event, a timer, a resolved
 * promise, an HTTP answer. Three rounds of cross-reads found the same defect
 * in different clothes: an input that is older, or less authoritative, than
 * a decision already taken wins over that decision (a retained message held
 * past the settle hint, an own echo that comes back late, an empty ownership
 * replay after a live list, a slow scene import, a stale snapshot in the
 * browser). So there is one rule, and it is code:
 *
 * 1. IDENTITY. Every input carries the identity of the source instance that
 *    produced it and its position in that source's order (`Stamp`). The
 *    sources and their stamps:
 *      MQTT message            connection number; retain flag (replay = the
 *                              store as it was when this connection
 *                              subscribed, live = published after that)
 *      own publish, its echo   connection, own-write number, and for scene
 *      and its acknowledgement clears and blob rewrites the choice generation
 *                              of each device they carry
 *      settle hint             connection
 *      config.json             config revision
 *      effective config        effective revision
 *      scene registry work     position in the registry lane
 *      render reports          runtime token of the device
 *      scene callbacks         instance token
 *      settings preview        page session, draft number
 *      live event (browser)    server epoch, seq; stream generation
 *      HTTP answer (browser)   server epoch, position; request generation
 *      timer                   the generation of whatever armed it
 *
 * 2. ONE DECISION. Before an input may change anything it gets exactly one
 *    of three answers (`Decision`):
 *      drop   the source instance is not the current one, or the position is
 *             not newer than what is held from that source
 *      hold   the input is current, but a fact it depends on is not known
 *             yet; it is decided again when that fact arrives, never because
 *             time passed
 *      apply  otherwise
 *
 * 3. OUTWARD EFFECTS need authoritative evidence (`mayCause`). Outward means:
 *    drive a display, release a device (shadow to drive, unknown owner to
 *    free, disabled to enabled), retire or narrow a suppression, publish.
 *    Authoritative: a delivered message that passed the fence, a broker
 *    acknowledgement of an own publish, config.json at its current revision,
 *    the environment, a command of the user, a measured fact. Never: a hint
 *    (the settle hint), a timeout, a connect or disconnect as such, or the
 *    fact that nothing arrived. A timer says when to look, never what is
 *    true: it may pace a start, repeat a publish that evidence already
 *    authorised, and move a measured state towards the conservative side.
 *    Unknown is conservative: shadow, suppression kept, record kept, entity
 *    unavailable, last good version running.
 *
 * The fences for the single input kinds build on this file:
 *   overlay/scene-layers.js   MQTT scene layers, suppressions, own writes
 *   state/v1-ownership.js     v1's device list
 *   web/js/ordering.js        the browser's twin of decideStamp
 *
 * Pure functions, no I/O, no clock. Owner: core/state worker.
 */

/** @typedef {"apply"|"hold"|"drop"} Action */

/**
 * @typedef {object} Decision
 * @property {Action} action
 * @property {string} reason stable code, e.g. "current", "superseded_source", "not_newer", "replay_after_live"
 */

/**
 * Identity and position of an input.
 *
 * @typedef {object} Stamp
 * @property {string|number} source the source instance that produced the input: gateway connection number, server epoch, stream or request generation, runtime or instance token, page session
 * @property {number} [position] position in that source's order: seq, rev, draft, lane position. Absent when the source has no order of its own (a token is then the whole fence)
 */

/**
 * @param {string} [reason]
 * @returns {Decision}
 */
export const apply = (reason = "current") => ({ action: "apply", reason });

/**
 * @param {string} reason
 * @returns {Decision}
 */
export const hold = (reason) => ({ action: "hold", reason });

/**
 * @param {string} reason
 * @returns {Decision}
 */
export const drop = (reason) => ({ action: "drop", reason });

/**
 * The generic fence: is this input from the source instance the consumer
 * holds now, and newer than what the consumer holds from it?
 *
 * A consumer never adopts a new source through this function. Adoption is
 * its own explicit step (a connect event, a new stream, a snapshot that is
 * accepted): until then an input of another source is dropped.
 *
 * @param {{source: string|number|null, position?: number|null}} held source null: the consumer holds no source yet. position null or absent: nothing held yet from this source
 * @param {Stamp} input
 * @returns {Decision}
 */
export function decideStamp(held, input) {
  if (held.source === null || held.source === undefined)
    return drop("no_current_source");
  if (input.source !== held.source) return drop("superseded_source");
  if (
    input.position !== undefined &&
    held.position !== null &&
    held.position !== undefined &&
    !(input.position > held.position)
  )
    return drop("not_newer");
  return apply();
}

/**
 * What an input is as evidence. Only the first group may cause an outward
 * effect.
 */
export const EVIDENCE = Object.freeze({
  /** A message delivered on the current connection that passed its fence. */
  message: "authoritative",
  /** The broker acknowledged, or echoed, an own publish. */
  ack: "authoritative",
  /** config.json at its current revision. */
  config: "authoritative",
  /** The environment the process started with. */
  environment: "authoritative",
  /** A request of the user through the API. */
  command: "authoritative",
  /** A measured fact: a frame the display accepted, an answered probe, and the clock since then. */
  measurement: "authoritative",
  /** The settle hint. */
  hint: "hint",
  /** Any timer: retry, debounce, grace time, deadline, watchdog. */
  timer: "hint",
  /** A connection came up or went away. Says nothing about what is stored. */
  connection: "hint",
  /** Nothing arrived. */
  absence: "hint",
});

/** @typedef {keyof typeof EVIDENCE} EvidenceKind */

/**
 * Effects that leave the process or give up a protection.
 *  - drive:   any request to a display
 *  - release: shadow to drive, unknown owner to free, disabled to enabled
 *  - retire:  remove a suppression
 *  - narrow:  shrink what a suppression hides
 *  - publish: any MQTT publish
 */
export const OUTWARD_EFFECTS = Object.freeze(
  /** @type {const} */ (["drive", "release", "retire", "narrow", "publish"]),
);

/** @typedef {typeof OUTWARD_EFFECTS[number]} OutwardEffect */

/**
 * May this kind of evidence cause this outward effect? One exception is
 * part of the rule and named here instead of being made by callers: a timer
 * may repeat a publish that authoritative evidence already authorised
 * (`repeatOf`), built again from the state of that moment.
 *
 * @param {OutwardEffect} effect
 * @param {EvidenceKind} evidence
 * @param {{repeatOf?: EvidenceKind}} [options]
 * @returns {boolean}
 */
export function mayCause(effect, evidence, options = {}) {
  if (EVIDENCE[evidence] === "authoritative") return true;
  if (
    effect === "publish" &&
    evidence === "timer" &&
    options.repeatOf !== undefined
  )
    return EVIDENCE[options.repeatOf] === "authoritative";
  return false;
}

/**
 * The fence for reports of something that can be replaced while a call of
 * its is still running: a device runtime, a scene instance. `target` is
 * seen through a view whose methods do nothing, and return undefined, once
 * `isCurrent()` answers false. The owner hands the view out instead of the
 * target; a late result of the replaced thing then changes nothing.
 *
 * @template {object} T
 * @template {keyof T} K
 * @param {() => boolean} isCurrent
 * @param {T} target
 * @param {readonly K[]} methods
 * @returns {Pick<T, K>}
 */
export function whileCurrent(isCurrent, target, methods) {
  const view = /** @type {Record<string, unknown>} */ ({});
  for (const name of methods) {
    const method = target[name];
    if (typeof method !== "function") continue;
    view[String(name)] = (/** @type {unknown[]} */ ...args) =>
      isCurrent() ? method.apply(target, args) : undefined;
  }
  return /** @type {Pick<T, K>} */ (view);
}

/**
 * A lane: asynchronous work that must not overlap runs one piece at a time,
 * in the order it was asked for. The result of an earlier, slower piece can
 * therefore never land after a later one (a scene import that takes long,
 * followed by a newer path for the same key).
 *
 *   run(name, task)  queue a task; resolves with {ran: true, value}, or with
 *                    {ran: false} when the lane was closed before its turn.
 *                    A task that throws is reported to onError and the lane
 *                    goes on.
 *   drain()          resolves when everything queued so far has finished
 *   close()          tasks that have not started are skipped; the running
 *                    one finishes
 *
 * @param {{onError?: (name: string, error: unknown) => void}} [options]
 */
export function createLane(options = {}) {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  let closed = false;
  let pending = 0;
  let position = 0;

  return {
    /**
     * @template V
     * @param {string} name
     * @param {(position: number) => V|Promise<V>} task gets its position in the lane, starting at 1
     * @returns {Promise<{ran: true, value: V}|{ran: false}>}
     */
    run(name, task) {
      const mine = ++position;
      pending += 1;
      const result = tail.then(async () => {
        try {
          if (closed) return /** @type {const} */ ({ ran: false });
          return /** @type {const} */ ({ ran: true, value: await task(mine) });
        } catch (error) {
          options.onError?.(name, error);
          return /** @type {const} */ ({ ran: false });
        } finally {
          pending -= 1;
        }
      });
      tail = result;
      return result;
    },
    /** @returns {Promise<void>} */
    async drain() {
      // New work may be queued while waiting: wait until the lane is empty.
      while (pending > 0) await tail;
    },
    close() {
      closed = true;
    },
    /** @returns {number} tasks queued or running */
    pending: () => pending,
    /** @returns {boolean} */
    closed: () => closed,
  };
}
