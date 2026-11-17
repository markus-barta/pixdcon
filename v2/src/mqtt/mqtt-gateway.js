/**
 * MQTT gateway: the only module that talks to the broker.
 *
 * Connection (v1 values kept, matrix C-001 to C-018):
 *  - MQTT is optional. It is on when MOSQUITTO_PASS is set (v1 rule), or when
 *    PIXDCON2_MQTT_ANONYMOUS=1 (dev and tests with the in-memory broker, no
 *    credentials anywhere). Otherwise fromEnv() returns null.
 *  - MOSQUITTO_HOST (localhost), MQTT_PORT (1883, validated), MOSQUITTO_USER
 *    (smarthome), plain mqtt://, reconnect every 5 s, connect timeout 10 s.
 *  - start() waits at most 5 s for the first connection and then goes on;
 *    the client keeps reconnecting in the background.
 *  - Client id "<instance>-<random>", clean session.
 *
 * What v2 adds:
 *  - A last will on <statusBase>/health (retained, the v1 health shape with
 *    status "offline"), so Home Assistant marks the entities unavailable when
 *    the process dies (B-C02). The will is part of the CONNECT packet, which
 *    is why the namespace must be known before this object is built.
 *  - Every connection has a number (1, 2, …). Messages, publish results and
 *    the connect and disconnect events carry it.
 *  - Every message carries its retain flag as delivered. That flag is the one
 *    and only signal for "stored" versus "new" (PIXD-75):
 *      retain true   a copy from the broker's retained store, sent because of
 *                    a SUBSCRIBE of this connection (a replay)
 *      retain false  published while this connection was subscribed (live)
 *    When a message arrives says nothing: a broker may send the SUBACK first
 *    and the retained messages later (aedes does, handlers/subscribe.js), and
 *    a replay may arrive after other traffic.
 *  - settle(): a pacing hint for the start, replacing v1's fixed 200 ms sleep
 *    (A-013). After the SUBACKs a QoS-1 marker is published to
 *    topics.sync(nonce) and awaited; a timeout is the fallback. It answers
 *    "the replay has probably been delivered, go on". It is never proof that
 *    a retained message does not exist. Nothing that cannot be undone may be
 *    decided on it: no saved state is changed and nothing is published
 *    because the hint passed.
 *  - publish() reports what happened to the message (C-021, B-C15), and a
 *    publish belongs to the connection it was sent on. When that connection
 *    ends before the acknowledgement, the answer is "offline" and the message
 *    is removed from the client's store: the gateway never sends it again on
 *    a later connection. Who wants it delivered publishes again, from the
 *    state of that moment. (v1 sent its blob rewrite with QoS 0 for the same
 *    reason, lib/config-overlay.js:177.)
 *  - One subscribe call for exact topics and filters. A filter passed where
 *    v1's exact subscribe was meant delivers nothing and is logged (C-225).
 *  - Every new logical subscription gets the broker's retained messages for
 *    its filter, also when another owner already subscribed it: the gateway
 *    subscribes again on the wire (C-036). Those replays reach every owner of
 *    the filter, as in v1, so handlers treat a repeated replay as no change.
 *  - Owners are opaque strings. Subscriptions are released per owner, and an
 *    owner's handlers are never replaced or removed by another owner's calls.
 *    A scene instance owns its subscriptions under its InstanceRef (scene,
 *    device, token), so the instance that runs and the replacement a hot
 *    reload is initialising beside it are two owners.
 *  - A handler that throws or rejects is logged and never stops the delivery
 *    to other owners (C-039).
 *
 * Order (core/ordering.js). The gateway is where MQTT input gets its
 * identity, and it guarantees what the fences of its consumers rest on:
 *  - connection numbers only rise. "connect" for a connection is emitted
 *    before its first message is delivered, "disconnect" after its last.
 *  - a handler is called synchronously, in the order the packets arrived on
 *    the connection; for one topic that is the order the broker processed
 *    them. The gateway never reorders, batches or delays messages.
 *  - the own echo of a publish is delivered like any message, on the
 *    connection it was published on, and never on a later one.
 *  - settle() and "settled" are a hint. No consumer may release, retire,
 *    drive or publish because of them.
 *  - the timers in here (reconnect every 5 s, connect timeout, the settle
 *    timeout, the acknowledgement timeout) decide when something is tried or
 *    given up, never what is stored on the broker.
 *
 * Events (EventEmitter):
 *   "status"      (MqttStatus)
 *   "connect"     ({connection: number})
 *   "disconnect"  ({connection: number})   every publish of that connection that is not confirmed has been answered "offline"
 *   "settled"     ({connection: number, complete: boolean})
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import mqtt from "mqtt";
import { decideStamp } from "../core/ordering.js";
import { freeze } from "../core/values.js";

/** @typedef {import("../types.js").MqttStatus} MqttStatus */
/** @typedef {import("../types.js").IsoTime} IsoTime */
/** @typedef {import("../types.js").InstanceRef} InstanceRef */

/**
 * @typedef {object} MqttMessage
 * @property {string} topic
 * @property {string} payload UTF-8 text; "" is the empty payload that clears a retained topic
 * @property {boolean} retain retain flag as delivered: true = replay from the broker's retained store, false = live
 * @property {number} connection number of the connection on which it arrived
 * @property {IsoTime} receivedAt
 */

/**
 * @typedef {object} PublishResult
 * @property {boolean} ok
 * @property {"confirmed"|"sent"|"offline"|"timeout"|"error"} outcome confirmed = broker acknowledged (QoS 1); sent = handed to the client (QoS 0); offline = not connected, or the connection ended before the acknowledgement; timeout = no acknowledgement within the time on a connection that is still up (the broker may have stored the message: only its echo or the end of the connection tells); error = it was certainly not sent
 * @property {number} connection connection it was sent on; 0 when it was never sent
 * @property {string|null} error
 */

/** @typedef {{topic: string, payload: string, retain: boolean, qos: 0|1}} LastWill */

/**
 * @typedef {object} MqttGatewayOptions
 * @property {string} host
 * @property {number} port
 * @property {string} [username]
 * @property {string} [password] from the environment only; never logged, never served
 * @property {string} clientId
 * @property {LastWill} [will]
 * @property {(nonce: string) => string} syncTopic topics.sync
 * @property {import("../types.js").Logger} logger
 * @property {import("../types.js").Clock} clock
 */

/**
 * v1 `ctx.mqtt` (matrix B-008, C-045): scoped to one scene instance on one device.
 *
 * @typedef {object} V1MqttContext
 * @property {string|null} deviceName
 * @property {(topic: string, cb: (payload: string) => unknown) => void} subscribe exact topic
 * @property {(pattern: string, cb: (payload: string, topic: string) => unknown) => void} subscribeWildcard note the argument order
 * @property {() => void} unsubscribeAll releases the subscriptions of this instance, and of no other
 */

export class MqttGateway extends EventEmitter {
  /**
   * @param {NodeJS.ProcessEnv} env
   * @param {{instance: string, will?: LastWill, syncTopic: (nonce: string) => string, logger: import("../types.js").Logger, clock: import("../types.js").Clock}} deps
   * @returns {MqttGateway|null} null when MQTT is not configured
   */
  static fromEnv(env, deps) {
    if (!env.MOSQUITTO_PASS && env.PIXDCON2_MQTT_ANONYMOUS !== "1") return null;
    const port = env.MQTT_PORT ?? "1883";
    if (!/^\d+$/.test(port) || +port < 1 || +port > 65535)
      throw new Error("Invalid MQTT_PORT: expected 1 to 65535");
    const host = env.MOSQUITTO_HOST || "localhost";
    if (/[\s/@?#]/.test(host))
      throw new Error("Invalid MOSQUITTO_HOST: expected a host");
    return new MqttGateway({
      ...deps,
      host,
      port: +port,
      ...(env.MOSQUITTO_PASS
        ? {
            username: env.MOSQUITTO_USER || "smarthome",
            password: env.MOSQUITTO_PASS,
          }
        : {}),
      clientId: `${deps.instance}-${randomBytes(5).toString("hex")}`,
    });
  }

  /**
   * Owner string of a scene instance: "scene:<scene>:<device>:<token>".
   *
   * @param {InstanceRef} ref
   * @returns {string}
   */
  static sceneOwner(ref) {
    return `scene:${ref.scene}:${ref.device}:${ref.token}`;
  }

  /** @param {MqttGatewayOptions} options */
  constructor(options) {
    super();
    this.options = options;
    /** @type {import("mqtt").MqttClient|null} A fresh transport per attempt; no outgoing store survives it. */
    this.client = null;
    this.active = false;
    this.attempt = 0;
    this.connection = 0;
    /** @type {MqttStatus} */
    this.info = {
      state: "offline",
      url: `mqtt://${options.host}:${options.port}`,
      since: null,
      connection: 0,
      lastError: null,
      settled: false,
    };
    /** @type {Map<number, {owner: string, filter: string, handler: (message: MqttMessage) => unknown}>} */
    this.subscriptions = new Map();
    this.subscriptionId = 0;
    /** @type {Set<Promise<void>>} */
    this.subacks = new Set();
    /** @type {Set<(result: PublishResult) => void>} */
    this.publishes = new Set();
    /** @type {AbortController|null} */
    this.reconnectWait = null;
  }

  /**
   * @param {{timeoutMs?: number}} [options] default 5000
   * @returns {Promise<boolean>} true when connected within the time
   */
  async start(options) {
    if (this.info.state === "connected") return true;
    if (!this.active) {
      this.active = true;
      this.open();
    }
    const wait = new AbortController();
    let connected = false;
    const ready = () => {
      connected = true;
      wait.abort();
    };
    this.once("connect", ready);
    await this.options.clock.sleep(options?.timeoutMs ?? 5000, wait.signal);
    this.off("connect", ready);
    return connected || this.status().state === "connected";
  }

  /** Clean close, forced after 2 s (C-016, C-017). Removes every subscription. */
  async stop() {
    if (!this.active && !this.client) return;
    this.active = false;
    this.reconnectWait?.abort();
    this.offline(this.attempt);
    const client = this.client;
    this.client = null;
    this.attempt += 1;
    this.subscriptions.clear();
    this.subacks.clear();
    if (!client) return;
    if (client.disconnected || client.stream.destroyed) return;
    const limit = new AbortController();
    const closed = new Promise((resolve) =>
      client.end(false, {}, () => resolve(undefined)),
    );
    await Promise.race([closed, this.options.clock.sleep(2000, limit.signal)]);
    limit.abort();
    client.end(true);
  }

  /** @returns {MqttStatus} */
  status() {
    return freeze(structuredClone(this.info));
  }

  /**
   * Subscribe on behalf of an owner. Registered while offline as well; the
   * wire subscription follows on connect (C-037).
   *
   * @param {string} owner opaque; its subscriptions are removed together and by nobody else
   * @param {string} filter exact topic or filter with + and #
   * @param {(message: MqttMessage) => unknown} handler
   * @returns {() => void} unsubscribe this one
   */
  subscribe(owner, filter, handler) {
    if (!validFilter(filter)) throw new Error(`Invalid MQTT filter: ${filter}`);
    const id = ++this.subscriptionId;
    this.subscriptions.set(id, { owner, filter, handler });
    if (this.info.state === "connected") void this.wireSubscribe(filter);
    return () => {
      if (!this.subscriptions.delete(id)) return;
      if (
        ![...this.subscriptions.values()].some(
          (entry) => entry.filter === filter,
        ) &&
        this.info.state === "connected"
      )
        this.client?.unsubscribe(filter);
    };
  }

  /**
   * Remove every subscription of this owner. The wire subscription of a
   * filter ends when its last owner is gone.
   *
   * @param {string} owner
   */
  unsubscribeAll(owner) {
    const filters = new Set();
    for (const [id, entry] of this.subscriptions) {
      if (entry.owner !== owner) continue;
      filters.add(entry.filter);
      this.subscriptions.delete(id);
    }
    for (const filter of filters) {
      if (
        ![...this.subscriptions.values()].some(
          (entry) => entry.filter === filter,
        ) &&
        this.info.state === "connected"
      )
        this.client?.unsubscribe(filter);
    }
  }

  /**
   * Publish and learn the outcome. `retain: true` with an empty payload clears
   * a retained topic. Never throws, and never sends the message again on a
   * later connection.
   *
   * @param {string} topic full topic
   * @param {string|Record<string, unknown>} payload objects are sent as JSON
   * @param {{retain?: boolean, qos?: 0|1, timeoutMs?: number}} [options] default QoS 1 with a 5 s wait for the acknowledgement
   * @returns {Promise<PublishResult>}
   */
  async publish(topic, payload, options) {
    const client = this.client;
    const attempt = this.attempt;
    const connection = this.connection;
    const offline = {
      ok: false,
      outcome: /** @type {const} */ ("offline"),
      connection: 0,
      error: "MQTT is offline",
    };
    if (!this.current(attempt) || this.info.state !== "connected" || !client)
      return offline;
    if (!topic || /[+#\0]/.test(topic))
      return {
        ok: false,
        outcome: "error",
        connection,
        error: "Invalid publish topic",
      };
    let text;
    try {
      text = typeof payload === "string" ? payload : JSON.stringify(payload);
    } catch {
      return {
        ok: false,
        outcome: "error",
        connection,
        error: "Payload is not JSON",
      };
    }
    const qos = options?.qos ?? 1;
    const limit = new AbortController();
    return new Promise((resolve) => {
      let done = false;
      /** @param {PublishResult} result */
      const finish = (result) => {
        if (done) return;
        done = true;
        this.publishes.delete(finish);
        limit.abort();
        resolve(result);
      };
      this.publishes.add(finish);
      void this.options.clock
        .sleep(options?.timeoutMs ?? 5000, limit.signal)
        .then((elapsed) => {
          if (!elapsed || done) return;
          finish(
            this.current(attempt) && this.info.state === "connected"
              ? {
                  ok: false,
                  outcome: "timeout",
                  connection,
                  error: "MQTT acknowledgement timed out",
                }
              : { ...offline, connection },
          );
        });
      try {
        client.publish(
          topic,
          text,
          { qos, retain: options?.retain ?? false },
          (error) => {
            if (!this.current(attempt) || this.info.state !== "connected") {
              finish({ ...offline, connection });
              return;
            }
            // Once handed to the transport an error cannot prove that the
            // broker did not store it. Keep that outcome conservative.
            finish(
              error
                ? {
                    ok: false,
                    outcome: "timeout",
                    connection,
                    error: error.message,
                  }
                : {
                    ok: true,
                    outcome: qos === 1 ? "confirmed" : "sent",
                    connection,
                    error: null,
                  },
            );
          },
        );
      } catch (error) {
        finish({
          ok: false,
          outcome: "error",
          connection,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Pacing hint: resolves when the retained messages for the filters
   * subscribed so far on the current connection have probably been delivered
   * (marker round trip), or after the timeout. See the header for what may
   * not be concluded from it.
   *
   * @param {{timeoutMs?: number}} [options] default 2000
   * @returns {Promise<{connection: number, complete: boolean}>} complete false = the timeout decided, or there is no connection
   */
  async settle(options) {
    const connection = this.connection;
    const attempt = this.attempt;
    if (!this.current(attempt) || this.info.state !== "connected")
      return { connection, complete: false };
    const limit = new AbortController();
    const topic = this.options.syncTopic(randomBytes(8).toString("hex"));
    let marker = false;
    const unsubscribe = this.subscribe(`settle:${topic}`, topic, (message) => {
      if (
        decideStamp({ source: connection }, { source: message.connection })
          .action !== "apply"
      )
        return;
      marker = true;
      limit.abort();
    });
    const timeout = this.options.clock.sleep(
      options?.timeoutMs ?? 2000,
      limit.signal,
    );
    const roundTrip = async () => {
      await Promise.all([...this.subacks]);
      if (
        !this.current(attempt) ||
        this.info.state !== "connected" ||
        limit.signal.aborted
      )
        return;
      await this.publish(topic, "sync", {
        qos: 1,
        timeoutMs: options?.timeoutMs ?? 2000,
      });
      if (!marker) await timeout;
    };
    await Promise.race([roundTrip(), timeout]);
    limit.abort();
    unsubscribe();
    const complete =
      marker && this.current(attempt) && this.info.state === "connected";
    if (this.current(attempt) && this.connection === connection) {
      this.info = { ...this.info, settled: complete };
      this.emit("status", this.status());
      this.emit("settled", { connection, complete });
    }
    return { connection, complete };
  }

  /**
   * v1 scene context for one scene instance. Owner: sceneOwner(ref).
   *
   * @param {InstanceRef} ref
   * @returns {V1MqttContext}
   */
  sceneContext(ref) {
    const owner = MqttGateway.sceneOwner(ref);
    let released = false;
    return {
      deviceName: ref.device,
      subscribe: (topic, callback) => {
        if (released) return;
        if (/[+#]/.test(topic)) {
          this.options.logger.warn(
            `[MQTT] Exact subscription refused a filter: ${topic}`,
          );
          return;
        }
        this.subscribe(owner, topic, (message) => {
          if (!released) return callback(message.payload);
        });
      },
      subscribeWildcard: (pattern, callback) => {
        if (released) return;
        this.subscribe(owner, pattern, (message) => {
          if (!released) return callback(message.payload, message.topic);
        });
      },
      unsubscribeAll: () => {
        released = true;
        this.unsubscribeAll(owner);
      },
    };
  }

  /** @param {number} attempt @returns {boolean} */
  current(attempt) {
    return (
      this.active &&
      decideStamp({ source: this.attempt }, { source: attempt }).action ===
        "apply"
    );
  }

  /** @param {MqttStatus["state"]} state */
  setStatus(state) {
    this.info = {
      ...this.info,
      state,
      connection: this.connection,
      settled: false,
      since:
        state === this.info.state
          ? this.info.since
          : new Date(this.options.clock.now()).toISOString(),
    };
    this.emit("status", this.status());
  }

  /** Start a disposable transport. MQTT.js never reconnects or replays it. */
  open() {
    if (!this.active) return;
    const attempt = ++this.attempt;
    this.setStatus("connecting");
    const client = (this.client = mqtt.connect(this.info.url ?? "", {
      clientId: this.options.clientId,
      clean: true,
      reconnectPeriod: 0,
      resubscribe: false,
      queueQoSZero: false,
      connectTimeout: 10000,
      username: this.options.username,
      password: this.options.password,
      will: this.options.will,
      manualConnect: true,
    }));
    client.on("connect", () => {
      if (!this.current(attempt)) return;
      this.connection += 1;
      this.setStatus("connected");
      this.emit("connect", { connection: this.connection });
      for (const filter of new Set(
        [...this.subscriptions.values()].map((entry) => entry.filter),
      ))
        void this.wireSubscribe(filter);
    });
    client.on("message", (topic, payload, packet) => {
      if (!this.current(attempt) || this.info.state !== "connected") return;
      const message = {
        topic,
        payload: payload.toString("utf8"),
        retain: packet.retain,
        connection: this.connection,
        receivedAt: new Date(this.options.clock.now()).toISOString(),
      };
      for (const [id, entry] of [...this.subscriptions]) {
        if (!this.subscriptions.has(id) || !matches(entry.filter, topic))
          continue;
        try {
          const returned = entry.handler(message);
          if (returned !== undefined)
            void Promise.resolve(returned).catch((error) =>
              this.options.logger.error("[MQTT] Handler rejected", error),
            );
        } catch (error) {
          this.options.logger.error("[MQTT] Handler threw", error);
        }
      }
    });
    client.on("error", (error) => {
      if (!this.current(attempt)) return;
      // Broker errors can include URLs or credentials. Serve a fixed,
      // actionable description; never include authentication material.
      this.info = {
        ...this.info,
        lastError: {
          message:
            /** @type {NodeJS.ErrnoException} */ (error).code === "ECONNREFUSED"
              ? "MQTT connection refused"
              : "MQTT connection failed",
          at: new Date(this.options.clock.now()).toISOString(),
        },
      };
      this.emit("status", this.status());
    });
    client.on("close", () => {
      if (!this.current(attempt)) return;
      this.offline(attempt);
      client.end(true);
      const wait = (this.reconnectWait = new AbortController());
      void this.options.clock.sleep(5000, wait.signal).then((elapsed) => {
        if (!elapsed || !this.current(attempt)) return;
        this.open();
      });
    });
    client.connect();
  }

  /** @param {number} attempt */
  offline(attempt) {
    if (
      decideStamp({ source: this.attempt }, { source: attempt }).action !==
      "apply"
    )
      return;
    const connected = this.info.state === "connected";
    for (const finish of [...this.publishes])
      finish({
        ok: false,
        outcome: "offline",
        connection: this.connection,
        error: "MQTT disconnected",
      });
    this.subacks.clear();
    this.setStatus("offline");
    if (connected) this.emit("disconnect", { connection: this.connection });
  }

  /** @param {string} filter @returns {Promise<void>} */
  wireSubscribe(filter) {
    const attempt = this.attempt;
    const client = this.client;
    if (!client || !this.current(attempt) || this.info.state !== "connected")
      return Promise.resolve();
    const ack = new Promise((resolve) => {
      client.subscribe(filter, { qos: 1 }, () => resolve(undefined));
    });
    this.subacks.add(ack);
    void ack.then(() => {
      this.subacks.delete(ack);
    });
    return ack;
  }
}

/**
 * Scene context when MQTT is not configured. Offers the same methods as the
 * real one (v1's stub lacked subscribeWildcard, matrix S-17); they do nothing
 * and log once per scene instance.
 *
 * @param {InstanceRef} ref
 * @param {import("../types.js").Logger} logger
 * @returns {V1MqttContext}
 */
export function offlineSceneContext(ref, logger) {
  let logged = false;
  const warn = () => {
    if (logged) return;
    logged = true;
    logger.debug(`[MQTT] Offline scene context: ${ref.scene}/${ref.device}`);
  };
  return {
    deviceName: ref.device,
    subscribe: () => warn(),
    subscribeWildcard: () => warn(),
    unsubscribeAll() {},
  };
}

/** @param {string} filter @returns {boolean} */
function validFilter(filter) {
  return (
    filter !== "" &&
    !filter.includes("\0") &&
    filter
      .split("/")
      .every(
        (part, index, parts) =>
          (!part.includes("+") || part === "+") &&
          (!part.includes("#") || (part === "#" && index === parts.length - 1)),
      )
  );
}
/** @param {string} filter @param {string} topic @returns {boolean} */
function matches(filter, topic) {
  if (topic.startsWith("$") && !filter.startsWith("$")) return false;
  const words = topic.split("/");
  const pattern = filter.split("/");
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === "#") return true;
    if (
      words[index] === undefined ||
      (pattern[index] !== "+" && pattern[index] !== words[index])
    )
      return false;
  }
  return words.length === pattern.length;
}
