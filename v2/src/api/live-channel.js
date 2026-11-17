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

import { HANDLED } from "./http-server.js";

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
    this.position = 0;
    /** @type {Array<{seq: number, type: LiveEvent["type"], wire: string}>} */
    this.ring = [];
    /** @type {Map<import("node:http").ServerResponse, {session: string, log: boolean, blocked: boolean}>} */
    this.clients = new Map();
    /** @type {Map<string, number>} */
    this.sessions = new Map();
    /** @type {{cancel: () => void}|null} */
    this.ping = null;
  }

  /**
   * Route handler for GET /api/v2/events. Takes the response over.
   *
   * @param {import("./http-server.js").RequestContext} ctx
   * @returns {symbol} HANDLED
   */
  handle(ctx) {
    const { res, req, query } = ctx;
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end();
      return HANDLED;
    }
    const session = query.get("session") ?? "";
    const count = this.sessions.get(session) ?? 0;
    // Build before taking over the response: a failed snapshot is a JSON error.
    const cursor =
      query.get("since") ?? String(req.headers["last-event-id"] ?? "");
    const prefix = `${this.deps.epoch}-`;
    const number = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : "";
    const since = /^\d+$/.test(number) ? Number(number) : -1;
    const replay =
      Number.isSafeInteger(since) &&
      since >= 0 &&
      since <= this.position &&
      since >= (this.ring[0]?.seq ?? this.position + 1) - 1;
    const initial = replay
      ? this.ring.filter((event) => event.seq > since)
      : [
          {
            seq: this.position,
            type: "snapshot",
            wire: this.#wire(
              "snapshot",
              {
                ...this.deps.snapshot(),
                epoch: this.deps.epoch,
                seq: this.position,
              },
              this.position,
            ),
          },
        ];
    if (session && count === 0) this.deps.onSession(session, true);
    if (session) this.sessions.set(session, count + 1);
    this.clients.set(res, {
      session,
      log: query.get("log") === "1",
      blocked: false,
    });
    res.on("close", () => this.#remove(res));
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    for (const event of initial) {
      if (!this.#send(res, event)) break;
    }
    if (!this.ping && this.clients.size)
      this.ping = this.deps.clock.every(() => {
        this.publish("ping", {
          at: new Date(this.deps.clock.now()).toISOString(),
        });
      }, this.deps.pingMs ?? 15000);
    return HANDLED;
  }

  /**
   * Send an event to every connected page.
   *
   * @param {LiveEvent["type"]} type
   * @param {unknown} data
   * @returns {number} its seq
   */
  publish(type, data) {
    // Serialise once before advancing: failed serialisation consumes no position.
    const seq = this.position + 1;
    const event = { seq, type, wire: this.#wire(type, data, seq) };
    this.position = seq;
    this.ring.push(event);
    const limit = Math.max(0, this.deps.ringSize ?? 500);
    while (this.ring.length > limit) this.ring.shift();
    for (const res of this.clients.keys()) this.#send(res, event);
    return seq;
  }

  /** @returns {number} seq of the last event */
  seq() {
    return this.position;
  }

  /** @returns {{clients: number, sessions: string[]}} */
  status() {
    return { clients: this.clients.size, sessions: [...this.sessions.keys()] };
  }

  /** Close every stream (shutdown). */
  stop() {
    for (const res of this.clients.keys()) {
      this.#remove(res);
      res.end();
    }
  }

  /** @param {LiveEvent["type"]} type @param {unknown} data @param {number} seq */
  #wire(type, data, seq) {
    return `id: ${this.deps.epoch}-${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** @param {import("node:http").ServerResponse} res @param {{type: string, wire: string}} event */
  #send(res, event) {
    const client = this.clients.get(res);
    if (!client) return false;
    if (event.type === "log" && !client.log) return true;
    if (res.destroyed || client.blocked) {
      this.#remove(res);
      res.destroy();
      return false;
    }
    if (!res.write(event.wire)) {
      // One bounded write may fill Node's buffer even for a fast reader
      // (notably a large snapshot). A second event before drain cuts it off.
      client.blocked = true;
      res.once("drain", () => {
        const current = this.clients.get(res);
        if (current) current.blocked = false;
      });
    }
    return true;
  }

  /** @param {import("node:http").ServerResponse} res */
  #remove(res) {
    const client = this.clients.get(res);
    if (!client) return;
    this.clients.delete(res);
    if (client.session) {
      const count = (this.sessions.get(client.session) ?? 1) - 1;
      if (count) this.sessions.set(client.session, count);
      else {
        this.sessions.delete(client.session);
        try {
          this.deps.onSession(client.session, false);
        } catch (error) {
          this.deps.logger.error("[Live] Session close failed", error);
        }
      }
    }
    if (!this.clients.size) {
      this.ping?.cancel();
      this.ping = null;
    }
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
  /** @type {Array<() => void>} */
  const stops = [];
  /** @param {import("node:events").EventEmitter} source @param {string} event @param {(...args: any[]) => void} handler */
  const follow = (source, event, handler) => {
    source.on(event, handler);
    stops.push(() => source.off(event, handler));
  };
  follow(deps.state, "device", (view) => channel.publish("device", view));
  follow(deps.state, "device-added", (view) => channel.publish("device", view));
  follow(deps.state, "device-removed", (value) =>
    channel.publish("device-removed", value),
  );
  /** @type {Map<string, number>} */
  const previews = new Map();
  follow(deps.previews, "frame", (frame) => {
    const now = deps.clock.now();
    if (now - (previews.get(frame.device) ?? -Infinity) < 1000) return;
    previews.set(frame.device, now);
    channel.publish("preview", {
      device: frame.device,
      width: frame.width,
      height: frame.height,
      source: frame.source,
      receivedAt: frame.receivedAt,
      frameSeq: frame.seq,
      rgbBase64: Buffer.from(frame.rgb).toString("base64"),
    });
  });
  follow(deps.overlays, "changed", () =>
    channel.publish("overlays", deps.overlays.list()),
  );
  follow(deps.settings, "settings", (state) =>
    channel.publish("settings", state),
  );
  follow(deps.scenes, "changed", () =>
    channel.publish("scenes", deps.scenes.list()),
  );
  // ConfigFileState carries no separate reload-attempt report. Keep the
  // declared nullable field explicit; validity/error/loadedAt remain authoritative.
  const config = () =>
    channel.publish("config", { ...deps.config.file(), reload: null });
  follow(deps.config, "file", config);
  follow(deps.config, "changed", config);
  if (deps.mqtt)
    follow(deps.mqtt, "status", (status) => channel.publish("mqtt", status));
  stops.push(deps.logger.onLine((line) => channel.publish("log", line)));
  return () => {
    for (const stop of stops) stop();
  };
}
