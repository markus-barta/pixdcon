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
 *    the process dies (B-C02) without any change to the discovery payloads.
 *  - Every message carries its retain flag and an origin: "startup" for the
 *    retained replay after a (re)connect, "live" afterwards. The overlay rules
 *    depend on this difference (PIXD-75).
 *  - retainedBoundary(): a deterministic end of the retained replay instead of
 *    a fixed sleep (A-013): after the SUBACKs a QoS-1 marker is published to
 *    topics.sync(nonce) and awaited; a timeout is the fallback.
 *  - publish() reports what happened to the message (C-021, B-C15).
 *  - One subscribe call for exact topics and filters. A filter passed where
 *    v1's exact subscribe was meant delivers nothing and is logged (C-225).
 *  - Every new logical subscription gets the broker's retained messages for
 *    its filter, also when another owner already subscribed it (C-036).
 *  - A handler that throws or rejects is logged and never stops the delivery
 *    to other owners (C-039).
 *
 * Events (EventEmitter): "status" (MqttStatus), "connect" (), "boundary" ().
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { todo } from "../core/todo.js";

/** @typedef {import("../types.js").MqttStatus} MqttStatus */
/** @typedef {import("../types.js").IsoTime} IsoTime */

/**
 * @typedef {object} MqttMessage
 * @property {string} topic
 * @property {string} payload UTF-8 text; "" is the empty payload that clears a retained topic
 * @property {boolean} retain retain flag as delivered: true only for a replay from the broker's retained store
 * @property {"startup"|"live"} origin
 * @property {IsoTime} receivedAt
 */

/**
 * @typedef {object} PublishResult
 * @property {boolean} ok
 * @property {"confirmed"|"sent"|"offline"|"error"} outcome confirmed = broker acknowledged (QoS 1); sent = handed to the client (QoS 0)
 * @property {string|null} error
 */

/**
 * @typedef {object} MqttGatewayOptions
 * @property {string} host
 * @property {number} port
 * @property {string} [username]
 * @property {string} [password] from the environment only; never logged, never served
 * @property {string} clientId
 * @property {{topic: string, payload: string, retain: boolean, qos: 0|1}} [will]
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
 * @property {() => void} unsubscribeAll
 */

export class MqttGateway extends EventEmitter {
  /**
   * @param {NodeJS.ProcessEnv} env
   * @param {{instance: string, will?: MqttGatewayOptions["will"], syncTopic: (nonce: string) => string, logger: import("../types.js").Logger, clock: import("../types.js").Clock}} deps
   * @returns {MqttGateway|null} null when MQTT is not configured
   */
  static fromEnv(env, deps) {
    return todo("MqttGateway.fromEnv", env, deps);
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
   * @param {string} owner logical owner, used to remove its subscriptions together
   * @param {string} filter exact topic or filter with + and #
   * @param {(message: MqttMessage) => unknown} handler
   * @returns {() => void} unsubscribe this one
   */
  subscribe(owner, filter, handler) {
    return todo("MqttGateway.subscribe", owner, filter, handler);
  }

  /** @param {string} owner */
  unsubscribeAll(owner) {
    return todo("MqttGateway.unsubscribeAll", owner);
  }

  /**
   * Publish and learn the outcome. `retain: true` with an empty payload clears
   * a retained topic. Never throws.
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
   * Resolves when the retained messages for every filter subscribed so far on
   * the current connection have been delivered, or after the timeout.
   *
   * @param {{timeoutMs?: number}} [options] default 2000
   * @returns {Promise<{complete: boolean}>} complete false = the timeout decided
   */
  async retainedBoundary(options) {
    return todo("MqttGateway.retainedBoundary", options);
  }

  /**
   * v1 scene context. Owner name "<scene>__<device>" as in v1.
   *
   * @param {string} sceneName
   * @param {string} deviceName
   * @returns {V1MqttContext}
   */
  sceneContext(sceneName, deviceName) {
    return todo("MqttGateway.sceneContext", sceneName, deviceName);
  }
}

/**
 * Scene context when MQTT is not configured. Offers the same methods as the
 * real one (v1's stub lacked subscribeWildcard, matrix S-17); they do nothing
 * and log once per scene.
 *
 * @param {string} sceneName
 * @param {string} deviceName
 * @param {import("../types.js").Logger} logger
 * @returns {V1MqttContext}
 */
export function offlineSceneContext(sceneName, deviceName, logger) {
  return todo("offlineSceneContext", sceneName, deviceName, logger);
}
