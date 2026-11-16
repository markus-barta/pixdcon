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
 * @param {object} handlers
 * @param {(event: {type: string, seq: number, data: any}) => void} handlers.onEvent every event, in seq order
 * @param {(state: LiveState) => void} handlers.onState connection state changes
 * @param {{log?: boolean}} [options] log: also receive log lines (Health page)
 * @returns {{session: string, close: () => void, state: () => LiveState}}
 */
export function connectLive(handlers, options) {
  return todo("live.connectLive", handlers, options, EventSource);
}
