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
 * Rules:
 *  - Only a received list is evidence. That nothing arrived is not; in
 *    particular the gateway's settle hint does not turn "unknown" into
 *    "free". A v1 that never published keeps every device in shadow until the
 *    operator ends the transition (statusBaseTopic = baseTopic, then restart).
 *  - The last received list stays valid while the broker is away. A broker
 *    restart must not blank the displays v2 already drives. After the
 *    reconnect the replay brings the current list.
 *  - A payload that cannot be read (not JSON, no `devices` array) changes
 *    nothing and is logged. An empty payload (somebody cleared the topic)
 *    means there is no list any more: back to "unknown".
 *  - A device v1 takes back is released by v2 at once: the next list names
 *    it, the policy answers shadow, and the scheduler rebuilds that device
 *    with the shadow driver.
 *
 * Events (EventEmitter): "changed" ({devices: string[]}) names whose answer changed.
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { todo } from "../core/todo.js";

/**
 * @typedef {object} V1OwnershipDeps
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway|null} mqtt
 * @property {import("../mqtt/topics.js").Topics} topics uses `transition` and `v1ConfigEffective`
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

export class V1Ownership extends EventEmitter {
  /** @param {V1OwnershipDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /** Subscribe to v1's list when the transition is on. Does nothing otherwise. */
  start() {
    return todo("V1Ownership.start");
  }

  stop() {
    return todo("V1Ownership.stop");
  }

  /**
   * @param {string} device
   * @returns {import("../types.js").V1Owner}
   */
  owner(device) {
    return todo("V1Ownership.owner", device);
  }

  /**
   * For the Health page and the log.
   *
   * @returns {{transition: boolean, known: boolean, receivedAt: import("../types.js").IsoTime|null, devices: string[]}} devices: what v1 lists
   */
  status() {
    return todo("V1Ownership.status");
  }
}
