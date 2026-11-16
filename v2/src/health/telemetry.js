/**
 * Telemetry collector: reads each driven display and publishes what it says.
 *
 * Kept from v1 (lib/telemetry-collector.js; matrix C-109 to C-141, D-138 to D-142):
 *  - exists only when MQTT is configured; one poller per device, first read at
 *    once, then every telemetryIntervalMs (default 60000); a tick is skipped
 *    while the previous read is still running
 *  - Ulanzi: GET /api/stats → retained <base>/<name>/telemetry = {...stats, ts}
 *    only for a good read; a failed read keeps the last retained snapshot (C-115)
 *  - Pixoo: Channel/GetAllConf → retained {reachable, brightness, cur_clock_id, ip_address, ts},
 *    also for a failed read (reachable false) (C-134)
 *  - Home Assistant discovery from mqtt/ha-discovery.js, retained
 *  - the last snapshot per device is kept for the UI (uid = access-point name in the recovery dialog)
 *
 * Fixed:
 *  - reads go through the device's driver (one request queue per display) and
 *    count as contact for the health model
 *  - the interval follows config changes (C-110, D-192)
 *  - discovery is published again after every reconnect and when uid, firmware
 *    or address changed (C-139, B-C05)
 *  - the latest snapshot is published again after a reconnect (C-117)
 *  - a shadow device is not polled and nothing is published for it
 *
 * Owner: drivers worker.
 */

import { todo } from "../core/todo.js";

/**
 * @typedef {object} TelemetryDeps
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway} mqtt
 * @property {import("../mqtt/topics.js").Topics} topics
 * @property {import("./health-model.js").HealthModel} health
 * @property {() => number} intervalMs read on every tick
 * @property {boolean} haDiscovery
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

export class TelemetryCollector {
  /** @param {TelemetryDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /**
   * @param {{name: string, type: import("../types.js").DeviceType, address: string}} device
   * @param {import("../drivers/driver.js").DeviceDriver} driver
   */
  start(device, driver) {
    return todo("TelemetryCollector.start", device, driver);
  }

  /** Abort the read in flight and forget the device. @param {string} name */
  stop(name) {
    return todo("TelemetryCollector.stop", name);
  }

  stopAll() {
    return todo("TelemetryCollector.stopAll");
  }

  /**
   * @param {string} name
   * @returns {Record<string, unknown>|null} a copy of the last snapshot
   */
  latest(name) {
    return todo("TelemetryCollector.latest", name);
  }
}
