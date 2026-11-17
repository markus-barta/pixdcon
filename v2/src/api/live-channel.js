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
 *    `epoch`, device `incarnation` and its own `rev`; the page drops what is not of its snapshot's
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
 *    reconnects and gets a snapshot. Backpressure may buffer up to 2 MiB
 *    for up to 10 s without drain. Replay has the same byte budget;
 *    previews are transient and never retained in the replay ring.
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
    this.replayFloor = 0;
    this.ringBytes = 0;
    /** @type {Map<import("node:http").ServerResponse, {session: string, log: boolean, deadline: {cancel: () => void}|null, drain: () => void}>} */
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
      since >= this.replayFloor;
    const missed = replay ? this.ring.filter((event) => event.seq > since) : [];
    const initial =
      replay &&
      missed.reduce(
        (bytes, event) => bytes + Buffer.byteLength(event.wire),
        0,
      ) <=
        2 * 1024 * 1024
        ? missed
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
    const client = {
      session,
      log: query.get("log") === "1",
      deadline: /** @type {{cancel: () => void}|null} */ (null),
      drain: () => {
        client.deadline?.cancel();
        client.deadline = null;
      },
    };
    this.clients.set(res, client);
    res.on("drain", client.drain);
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
    if (type !== "preview") {
      this.ring.push(event);
      this.ringBytes += Buffer.byteLength(event.wire);
    }
    const limit = Math.max(0, this.deps.ringSize ?? 500);
    while (this.ring.length > limit || this.ringBytes > 2 * 1024 * 1024) {
      const removed = this.ring.shift();
      if (!removed) break;
      this.ringBytes -= Buffer.byteLength(removed.wire);
      this.replayFloor = Math.max(this.replayFloor, removed.seq);
    }
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
    if (res.destroyed) {
      this.#remove(res);
      res.destroy();
      return false;
    }
    const drained = res.write(event.wire);
    if (res.writableLength > 2 * 1024 * 1024) {
      this.#cutOff(res);
      return false;
    }
    if (!drained && !client.deadline) {
      const deadline = this.deps.clock.every(() => {
        if (this.clients.get(res) === client && client.deadline === deadline)
          this.#cutOff(res);
      }, 10000);
      client.deadline = deadline;
    }
    return true;
  }

  /** @param {import("node:http").ServerResponse} res */
  #cutOff(res) {
    // Conservatively invalidate replay through this position for reconnects,
    // including anonymous pages. No unbounded per-session recovery ledger.
    this.replayFloor = this.position + 1;
    this.#remove(res);
    res.destroy();
  }

  /** @param {import("node:http").ServerResponse} res */
  #remove(res) {
    const client = this.clients.get(res);
    if (!client) return;
    this.clients.delete(res);
    client.deadline?.cancel();
    res.off("drain", client.drain);
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
  /** @type {Map<string, {frame: import("../types.js").PreviewFrame, abort: AbortController}>} */
  const pending = new Map();
  /** @param {import("../types.js").PreviewFrame} frame */
  const sendPreview = (frame) => {
    previews.set(frame.device, deps.clock.now());
    channel.publish("preview", {
      device: frame.device,
      width: frame.width,
      height: frame.height,
      source: frame.source,
      receivedAt: frame.receivedAt,
      frameSeq: frame.seq,
      rgbBase64: Buffer.from(frame.rgb).toString("base64"),
    });
  };
  follow(deps.previews, "frame", (frame) => {
    const remaining =
      1000 - (deps.clock.now() - (previews.get(frame.device) ?? -Infinity));
    const held = pending.get(frame.device);
    if (held) {
      held.frame = frame;
      return;
    }
    if (remaining <= 0) {
      sendPreview(frame);
      return;
    }
    const entry = { frame, abort: new AbortController() };
    pending.set(frame.device, entry);
    void deps.clock.sleep(remaining, entry.abort.signal).then((elapsed) => {
      if (!elapsed || pending.get(frame.device) !== entry) return;
      pending.delete(frame.device);
      sendPreview(entry.frame);
    });
  });
  stops.push(() => {
    for (const entry of pending.values()) entry.abort.abort();
    pending.clear();
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
