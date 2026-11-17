/**
 * Live channel: one server-sent-events stream per page (GET /api/v2/events).
 *
 * Replaces v1's polling (previews and status every second, scene metadata
 * every 10 s, nothing else ever; matrix A-123, B-063, S-3). The page gets the
 * state pushed: devices with scene, source, mode, brightness, health and last
 * error, overlays, settings state, config reload results, MQTT state, and
 * previews at their 1 s cadence.
 *
 * Wire format:
 *   id: <epoch>-<seq>    epoch: this run of the process; seq: one counter for the whole stream, increasing
 *   event: <type>        see LiveEvent in types.js
 *   data: <JSON>         one line
 *
 * Rules:
 *  - On connect the first event is "snapshot" (the same content as
 *    GET /api/v2/bootstrap). With `since=<epoch>-<seq>` or a Last-Event-ID
 *    header the missed events are replayed from a ring instead. A snapshot
 *    is sent when the ring no longer reaches back that far, and always when
 *    the cursor names another epoch or cannot be read: `seq` and every `rev`
 *    start again with the process, so a number from an earlier run means
 *    nothing here (B-177). A bare number without an epoch is such a cursor.
 *  - Events are delivered in seq order. A view inside an event carries its
 *    `epoch` and its own `rev`; the page drops what is not of its snapshot's
 *    epoch or not newer than what it shows (build rule 3).
 *  - "preview" events are sent at most once per second and device, and not at
 *    all when the frame did not change, except to refresh `receivedAt`.
 *  - "ping" every 15 s keeps proxies from closing the stream and lets the page
 *    notice a dead connection within 20 s ("No answer from pixdcon since …").
 *  - A page names itself with `session=<id>`. When its last stream closes,
 *    its settings previews end after the grace time (settings-service.js).
 *    A page that reconnects opens its new stream before the old one is seen
 *    as closed, so the channel counts the open streams of a session:
 *    `onSession(session, true)` when the first one opens,
 *    `onSession(session, false)` only when none is left. The close of an
 *    older stream never reports a page as gone that has a newer stream.
 *  - The id is the envelope. The page takes epoch and seq of every event
 *    from `id:`, so every event, also one whose payload has no epoch inside
 *    (removal, preview, overlays), can be ordered and told from an earlier
 *    run (web/js/ordering.js).
 *  - A slow reader is cut off instead of growing a queue in memory; it
 *    reconnects and gets a snapshot.
 *
 * Owner: API + live channel worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").LiveEvent} LiveEvent */
/** @typedef {import("../types.js").Snapshot} Snapshot */

/**
 * @typedef {object} LiveChannelDeps
 * @property {import("../types.js").Epoch} epoch
 * @property {() => Omit<Snapshot, "seq"|"epoch">} snapshot built by main.js from the stores
 * @property {(session: string, connected: boolean) => void} onSession true: the session's first stream opened; false: its last stream closed
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 * @property {number} [ringSize] events kept for replay, default 500
 * @property {number} [pingMs] default 15000
 */

export class LiveChannel {
  /** @param {LiveChannelDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /**
   * Route handler for GET /api/v2/events. Takes the response over.
   *
   * @param {import("./http-server.js").RequestContext} ctx
   * @returns {symbol} HANDLED
   */
  handle(ctx) {
    return todo("LiveChannel.handle", ctx);
  }

  /**
   * Send an event to every connected page.
   *
   * @param {LiveEvent["type"]} type
   * @param {unknown} data
   * @returns {number} its seq
   */
  publish(type, data) {
    return todo("LiveChannel.publish", type, data);
  }

  /** @returns {number} seq of the last event */
  seq() {
    return todo("LiveChannel.seq");
  }

  /** @returns {{clients: number, sessions: string[]}} */
  status() {
    return todo("LiveChannel.status");
  }

  /** Close every stream (shutdown). */
  stop() {
    return todo("LiveChannel.stop");
  }
}

/**
 * Wire the stores to the channel: every store event becomes a live event.
 * One place, so the mapping can be read at a glance and tested as a contract.
 *
 *   state "device" / "device-added"   → "device"
 *   state "device-removed"            → "device-removed"
 *   previews "frame"                  → "preview"   (throttled)
 *   overlays "changed"                → "overlays"
 *   settings "settings"               → "settings"
 *   scenes "changed"                  → "scenes"
 *   config "file" / "changed"         → "config"
 *   mqtt "status"                     → "mqtt"
 *   logger line                       → "log"       (only to streams opened with log=1)
 * The "controller" event is not wired here: main.js publishes it when the
 * measured controller status, its reasons or `restartRequired` change.
 *
 * @param {LiveChannel} channel
 * @param {import("./routes-v1.js").ApiDeps} deps
 * @returns {() => void} unwire
 */
export function wireLiveChannel(channel, deps) {
  return todo("wireLiveChannel", channel, deps);
}
