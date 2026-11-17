/**
 * v1 ownership: which displays pixdcon v1 still drives.
 *
 * The switch-over moves one display at a time, with v1 and v2 running side
 * by side on the same broker. Two controllers must never drive one display.
 * The interlock rests on this feed: v1 publishes the config it runs, with
 * overlays applied and disabled devices left out, retained, to
 * `<baseTopic>/config/effective` after every start and reload
 * (lib/mqtt-service.js; matrix C-024). A device named there is driven by v1.
 *
 * The transition is on while `mqtt.statusBaseTopic` differs from
 * `mqtt.baseTopic` (topics.transition): v2 then publishes its own controller
 * topics elsewhere, so `<baseTopic>/config/effective` is v1's alone.
 *
 * Answers of owner(device):
 *   "free"     no transition is configured, or v1's list was received and
 *              does not name the device
 *   "v1"       v1's list names the device
 *   "unknown"  the transition is on and no list has been received in this
 *              process yet: MQTT is not configured, the broker was never
 *              reached, or the topic holds nothing
 * The output policy turns "v1" and "unknown" into shadow
 * (state/precedence.js resolveOutput). Unknown means shadow.
 *
 * THE FENCE (core/ordering.js; reduceOwnership below is the whole of it).
 * Releasing a device lets this instance drive a display, so only a list
 * that passed the fence may do it:
 *  - A message of a connection that is gone is dropped. A message of a
 *    newer connection makes that connection the current one.
 *  - Live beats replay on a connection: once a live list arrived, a replay
 *    (retain flag set) on the same connection is dropped. The replay shows
 *    what the broker held when this connection subscribed; a broker may
 *    deliver it after messages that were published later. Without this, an
 *    empty list replayed late would set free a device that the newer live
 *    list names, and both controllers would drive it.
 *  - Only a received list is evidence. That nothing arrived is not; the
 *    gateway's settle hint is not an input here and turns nothing into
 *    "free". A v1 that never published keeps every device in shadow until
 *    the operator ends the transition (statusBaseTopic = baseTopic, then
 *    restart).
 *  - The last received list stays valid while the broker is away. A broker
 *    restart must not blank the displays v2 already drives. After the
 *    reconnect the replay brings the current list.
 *  - A payload that cannot be read (not JSON, no `devices` array) changes
 *    nothing and is logged. A live empty payload (somebody cleared the
 *    topic) means there is no list any more: back to "unknown".
 *  - A device v1 takes back is released by v2 at once: the next list names
 *    it, the policy answers shadow, and the scheduler rebuilds that device
 *    with the shadow driver.
 *
 * Events (EventEmitter): "changed" ({devices: string[]}) names whose answer
 * changed; ["*"] when every answer may have (the first list, or the list
 * was cleared).
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { apply, drop } from "../core/ordering.js";

/**
 * @typedef {object} OwnershipFeed What is held of v1's list.
 * @property {boolean} known false: no list has passed the fence in this process, or the topic was cleared
 * @property {string[]} devices names v1 lists
 * @property {import("../types.js").IsoTime|null} receivedAt
 * @property {number} connection connection of the last message that was looked at; 0 = none
 * @property {number} live connection on which a live message was last applied; 0 = none
 */

/** @returns {OwnershipFeed} */
export function createOwnershipFeed() {
  return {
    known: false,
    devices: [],
    receivedAt: null,
    connection: 0,
    live: 0,
  };
}

/**
 * One message of `<baseTopic>/config/effective` through the fence.
 *
 * @param {OwnershipFeed} feed
 * @param {Pick<import("../mqtt/mqtt-gateway.js").MqttMessage, "payload"|"retain"|"connection"|"receivedAt">} message
 * @returns {{feed: OwnershipFeed, decision: import("../core/ordering.js").Decision, changed: string[]}} changed: devices whose owner answer changed
 */
export function reduceOwnership(feed, message) {
  const unchanged = (/** @type {string} */ reason) => ({
    feed,
    decision: drop(reason),
    changed: /** @type {string[]} */ ([]),
  });
  if (message.connection < feed.connection)
    return unchanged("superseded_source");
  const connection = message.connection;
  // On a new connection nothing has been seen live yet.
  const live = connection === feed.connection ? feed.live : 0;
  const seen = { ...feed, connection, live };
  const skipped = (/** @type {string} */ reason) => ({
    feed: seen,
    decision: drop(reason),
    changed: /** @type {string[]} */ ([]),
  });

  if (message.retain && live === connection)
    return skipped("replay_after_live");

  if (message.payload === "") {
    // A store never replays an empty payload; live it means "cleared".
    if (message.retain) return skipped("empty_replay");
    const next = {
      ...seen,
      known: false,
      devices: [],
      receivedAt: message.receivedAt,
      live: connection,
    };
    return {
      feed: next,
      decision: apply(),
      // Every answer changes: what v1 listed, and what was free.
      changed: feed.known ? ["*"] : [],
    };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(message.payload);
  } catch {
    return skipped("unreadable");
  }
  const list =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? /** @type {{devices?: unknown}} */ (parsed).devices
      : undefined;
  if (!Array.isArray(list)) return skipped("unreadable");
  const devices = [
    ...new Set(
      list
        .map((entry) =>
          entry && typeof entry === "object" ? entry.name : undefined,
        )
        .filter(
          /** @returns {name is string} */ (name) =>
            typeof name === "string" && name !== "",
        ),
    ),
  ];
  const next = {
    known: true,
    devices,
    receivedAt: message.receivedAt,
    connection,
    live: message.retain ? live : connection,
  };
  const changed = !feed.known
    ? ["*"]
    : [...new Set([...feed.devices, ...devices])].filter(
        (name) => feed.devices.includes(name) !== devices.includes(name),
      );
  return { feed: next, decision: apply(), changed };
}

/**
 * @param {OwnershipFeed} feed
 * @param {boolean} transition
 * @param {string} device
 * @returns {import("../types.js").V1Owner}
 */
export function ownerOf(feed, transition, device) {
  if (!transition) return "free";
  if (!feed.known) return "unknown";
  return feed.devices.includes(device) ? "v1" : "free";
}

/**
 * @typedef {object} V1OwnershipDeps
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway|null} mqtt
 * @property {import("../mqtt/topics.js").Topics} topics uses `transition` and `v1ConfigEffective`
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

export class V1Ownership extends EventEmitter {
  /** @type {OwnershipFeed} */
  #feed = createOwnershipFeed();
  /** @type {(() => void)|null} */
  #unsubscribe = null;

  /** @param {V1OwnershipDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /** Subscribe to v1's list when the transition is on. Does nothing otherwise. */
  start() {
    const { mqtt, topics } = this.deps;
    if (!topics.transition || !mqtt || this.#unsubscribe) return;
    this.#unsubscribe = mqtt.subscribe(
      "v1-ownership",
      topics.v1ConfigEffective,
      (message) => this.accept(message),
    );
  }

  stop() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /**
   * One message of v1's list. The subscription calls this; it is public so
   * that the fence can be exercised without a broker.
   *
   * @param {import("../mqtt/mqtt-gateway.js").MqttMessage} message
   * @returns {import("../core/ordering.js").Decision}
   */
  accept(message) {
    const { feed, decision, changed } = reduceOwnership(this.#feed, message);
    this.#feed = feed;
    if (decision.reason === "unreadable")
      this.deps.logger.warn(
        `[Interlock] v1's device list on ${this.deps.topics.v1ConfigEffective} cannot be read; the last list stays`,
      );
    if (changed.length > 0) this.emit("changed", { devices: changed });
    return decision;
  }

  /**
   * @param {string} device
   * @returns {import("../types.js").V1Owner}
   */
  owner(device) {
    return ownerOf(this.#feed, this.deps.topics.transition, device);
  }

  /**
   * For the Health page and the log.
   *
   * @returns {{transition: boolean, known: boolean, receivedAt: import("../types.js").IsoTime|null, devices: string[]}} devices: what v1 lists
   */
  status() {
    return {
      transition: this.deps.topics.transition,
      known: this.#feed.known,
      receivedAt: this.#feed.receivedAt,
      devices: [...this.#feed.devices],
    };
  }
}
