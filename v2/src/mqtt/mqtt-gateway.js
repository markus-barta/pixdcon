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
import { todo } from "../core/todo.js";

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
    return todo("MqttGateway.fromEnv", env, deps);
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
  }

  /**
   * @param {{timeoutMs?: number}} [options] default 5000
   * @returns {Promise<boolean>} true when connected within the time
   */
  async start(options) {
    return todo("MqttGateway.start", options);
  }

  /** Clean close, forced after 2 s (C-016, C-017). Removes every subscription. */
  async stop() {
    return todo("MqttGateway.stop");
  }

  /** @returns {MqttStatus} */
  status() {
    return todo("MqttGateway.status");
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
    return todo("MqttGateway.subscribe", owner, filter, handler);
  }

  /**
   * Remove every subscription of this owner. The wire subscription of a
   * filter ends when its last owner is gone.
   *
   * @param {string} owner
   */
  unsubscribeAll(owner) {
    return todo("MqttGateway.unsubscribeAll", owner);
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
    return todo("MqttGateway.publish", topic, payload, options);
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
    return todo("MqttGateway.settle", options);
  }

  /**
   * v1 scene context for one scene instance. Owner: sceneOwner(ref).
   *
   * @param {InstanceRef} ref
   * @returns {V1MqttContext}
   */
  sceneContext(ref) {
    return todo("MqttGateway.sceneContext", ref);
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
  return todo("offlineSceneContext", ref, logger);
}
