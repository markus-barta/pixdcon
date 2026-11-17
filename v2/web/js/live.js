/* global EventSource */
/**
 * Live channel client: one EventSource on GET /api/v2/events.
 *
 *  - reconnects by itself, every 5 s, with `since=<epoch>-<seq>`. When
 *    pixdcon was restarted meanwhile, that cursor names an epoch that is
 *    gone, and the server answers with a snapshot instead of a replay; the
 *    store then starts over from it (store.js)
 *  - reports its own state, so the title line can say "No answer from pixdcon
 *    since 18:41:52 · retrying every 5 s · values below are from 18:41:52"
 *    (mockup pixd-devices-disconnected) and "Live updates paused · retrying"
 *  - a connection without any event for 20 s counts as lost (the server pings
 *    every 15 s)
 *  - names the page with a session id; the server ends this page's settings
 *    previews when the connection is gone
 *
 * Order (ordering.js). Every connect and every reconnect creates a new
 * EventSource and takes a new stream generation (`openSource(fence,
 * "stream")`); the browser's own retry is never left running. Every event
 * is handed on as an envelope: its type and data, the epoch and seq parsed
 * from the event id "<epoch>-<seq>" (never from the payload: removal,
 * preview and overlay events have no epoch inside), and the generation of
 * the stream it arrived on. An event of a stream that was replaced, also one
 * that was already queued when the stream was closed, carries the old
 * generation and is dropped by the store. An event whose id cannot be read
 * is not handed on.
 *
 * The two timers are hints (ordering rule 3.0): the reconnect timer opens
 * a new stream, the silence timer declares the stream lost. Neither changes
 * a value on screen; the page keeps the last values with their time.
 *
 * Owner: UI worker.
 */

import { openSource, parsePosition } from "./ordering.js";

/**
 * @typedef {object} LiveState
 * @property {"connecting"|"live"|"lost"} state
 * @property {number|null} lastEventAt epoch ms of the last event received
 * @property {number|null} lostSince epoch ms
 * @property {number} retryEveryMs
 */

/**
 * One live event as the store gets it.
 *
 * @typedef {object} LiveEnvelope
 * @property {string} type
 * @property {string} epoch from the event id
 * @property {number} seq from the event id
 * @property {number} stream generation of the stream it arrived on
 * @property {any} data
 */

/** The event types of the live channel (types.js LiveEvent). */
export const EVENT_TYPES = Object.freeze([
  "snapshot",
  "device",
  "device-removed",
  "preview",
  "overlays",
  "settings",
  "scenes",
  "config",
  "mqtt",
  "controller",
  "log",
  "ping",
]);

const RETRY_MS = 5000;
const SILENCE_MS = 20000;

/** @returns {string} a page id: 16 hex characters */
function newSession() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {object} handlers
 * @param {(event: LiveEnvelope) => void} handlers.onEvent every event, in the order of its stream
 * @param {(state: LiveState) => void} handlers.onState connection state changes
 * @param {{log?: boolean, fence: import("./ordering.js").ClientFence}} options log: also receive log lines (Health page); fence: the store's fence, from which stream generations are taken
 * @returns {{session: string, close: () => void, state: () => LiveState}}
 */
export function connectLive(handlers, options) {
  const session = newSession();
  /** @type {LiveState} */
  let current = {
    state: "connecting",
    lastEventAt: null,
    lostSince: null,
    retryEveryMs: RETRY_MS,
  };
  /** @type {EventSource|null} */
  let source = null;
  let generation = 0;
  /** "<epoch>-<seq>" of the last event read on the current stream. */
  let cursor = "";
  let closed = false;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let retryTimer;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let silenceTimer;

  /** @param {Partial<LiveState>} patch */
  function setState(patch) {
    const next = { ...current, ...patch };
    if (
      next.state === current.state &&
      next.lastEventAt === current.lastEventAt &&
      next.lostSince === current.lostSince
    )
      return;
    current = next;
    handlers.onState({ ...current });
  }

  function stopStream() {
    if (source) {
      source.close();
      source = null;
    }
    clearTimeout(silenceTimer);
  }

  /** The stream is gone: say since when, and try again in 5 s. */
  function lose() {
    stopStream();
    if (closed) return;
    setState({
      state: "lost",
      lostSince: current.lostSince ?? current.lastEventAt ?? Date.now(),
    });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, RETRY_MS);
  }

  /** Arm the silence watchdog again: 20 s without an event is a lost stream. */
  function armSilence() {
    clearTimeout(silenceTimer);
    const mine = generation;
    silenceTimer = setTimeout(() => {
      if (mine === generation) lose();
    }, SILENCE_MS);
  }

  function open() {
    if (closed) return;
    stopStream();
    generation = openSource(options.fence, "stream");
    const mine = generation;
    const query = new URLSearchParams({ session });
    if (cursor) query.set("since", cursor);
    if (options.log) query.set("log", "1");
    const stream = new EventSource(`/api/v2/events?${query}`);
    source = stream;
    stream.onopen = () => {
      if (mine !== generation) return;
      setState({ state: "live", lostSince: null });
      armSilence();
    };
    stream.onerror = () => {
      // The browser would retry on its own with the old cursor and the old
      // generation; this module replaces the stream instead.
      if (mine !== generation) return;
      lose();
    };
    for (const type of EVENT_TYPES) {
      stream.addEventListener(type, (/** @type {any} */ message) => {
        if (mine !== generation) return;
        receive(mine, type, message);
      });
    }
    armSilence();
  }

  /**
   * @param {number} stream generation of the stream it came on
   * @param {string} type
   * @param {{lastEventId?: string, data?: string}} message
   */
  function receive(stream, type, message) {
    const position = parsePosition(message.lastEventId);
    if (!position) return;
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(message.data ?? "null");
    } catch {
      return;
    }
    cursor = `${position.epoch}-${position.seq}`;
    setState({ state: "live", lastEventAt: Date.now(), lostSince: null });
    armSilence();
    handlers.onEvent({
      type,
      epoch: position.epoch,
      seq: position.seq,
      stream,
      data,
    });
  }

  open();
  return {
    session,
    close() {
      closed = true;
      clearTimeout(retryTimer);
      stopStream();
    },
    state: () => ({ ...current }),
  };
}
