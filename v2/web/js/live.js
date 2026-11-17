/* global EventSource */
/**
 * Live channel client: one EventSource on GET /api/v2/events.
 *
 *  - reconnects by itself, every 5 s, with `since=<epoch>-<last seq>`. When
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
 * Owner: UI worker.
 */

import { todo } from "./todo.js";

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

/**
 * @param {object} handlers
 * @param {(event: LiveEnvelope) => void} handlers.onEvent every event, in the order of its stream
 * @param {(state: LiveState) => void} handlers.onState connection state changes
 * @param {{log?: boolean, fence: import("./ordering.js").ClientFence}} options log: also receive log lines (Health page); fence: the store's fence, from which stream generations are taken
 * @returns {{session: string, close: () => void, state: () => LiveState}}
 */
export function connectLive(handlers, options) {
  return todo("live.connectLive", handlers, options, EventSource);
}
