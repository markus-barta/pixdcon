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
 *  - Home Assistant discovery, retained, built by the injected `discovery`
 *    functions (mqtt/ha-discovery.js through main.js)
 *  - the last snapshot per device is kept for the UI (uid = access-point name in the recovery dialog)
 *
 * Fixed:
 *  - reads go through the device's driver (one request queue per display) and
 *    count as contact for the health model
 *  - the interval follows config changes (C-110, D-192)
 *  - discovery is published again after every reconnect and when uid, firmware
 *    or address changed (C-139, B-C05)
 *  - the latest snapshot is published again after a reconnect (C-117)
 *  - a shadow device is not polled and nothing is published for it; "shadow"
 *    is the resolved output policy, so a device the v1 interlock holds back
 *    is not polled either (v1 is polling it)
 *  - the per-device availability topic that the discovery payloads name is
 *    published by the status publisher from the measured health, not here
 *
 * Owner: drivers worker.
 */


/**
 * @typedef {object} TelemetryDeps
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway} mqtt
 * @property {import("../mqtt/topics.js").Topics} topics
 * @property {import("./health-model.js").HealthModel} health
 * @property {() => number} intervalMs read on every tick
 * @property {boolean} haDiscovery
 * @property {import("../types.js").Factories["discovery"]} discovery the payload builders
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 */

export class TelemetryCollector {
  /** @param {TelemetryDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, {active: boolean, snapshot: Record<string, unknown>|null, cancel: () => void, replay: () => Promise<void>}>} */
    this.pollers = new Map();
    this.onConnect = () => { for (const poller of this.pollers.values()) void poller.replay().catch((error) => deps.logger.error("[Telemetry] replay", error)); };
    this.listening = false;
  }

  /**
   * @param {{name: string, type: import("../types.js").DeviceType, address: string}} device from the EffectiveDevice; the scheduler calls this for driven devices only
   * @param {import("../drivers/driver.js").DeviceDriver} driver
   * @param {Pick<import('./health-model.js').HealthModel, 'contactOk'>} [health] current runtime's fenced view
   */
  start(device, driver, health = this.deps.health) {
    this.stop(device.name);
    if (!driver.info.drives) return;
    if (!this.listening) { this.deps.mqtt.on("connect", this.onConnect); this.listening = true; }
    const abort = new AbortController();
    const poller = { active: true, snapshot: /** @type {Record<string, unknown>|null} */ (null), cancel: () => {}, replay: async () => {} };
    const current = () => poller.active && this.pollers.get(device.name) === poller;
    let busy = false;
    let lastRead = -Infinity;
    let discoveryKey = "";
    const publish = async (force = false) => {
      if (!current() || !poller.snapshot) return;
      const key = JSON.stringify([poller.snapshot.uid, poller.snapshot.version, device.address, this.deps.intervalMs()]);
      if (this.deps.haDiscovery && (force || discoveryKey !== key)) {
        const options = { telemetryIntervalMs: this.deps.intervalMs() };
        const messages = device.type === "pixoo" ? this.deps.discovery.pixoo(device, this.deps.topics, options)
          : this.deps.discovery.ulanzi(device, poller.snapshot, this.deps.topics, options);
        let complete = true;
        for (const message of messages) {
          if (!current()) return;
          const result = await this.deps.mqtt.publish(message.topic, message.payload, { retain: true, qos: 1 });
          complete = complete && result.ok;
        }
        if (current() && complete) discoveryKey = key;
      }
      if (current()) await this.deps.mqtt.publish(this.deps.topics.telemetry(device.name), poller.snapshot, { retain: true, qos: 1 });
    };
    poller.replay = () => publish(true);
    const tick = async () => {
      if (!current() || busy || this.deps.clock.now() - lastRead < Math.max(1, this.deps.intervalMs())) return;
      busy = true;
      lastRead = this.deps.clock.now();
      try {
        let snapshot;
        try {
          snapshot = await driver.readTelemetry({ signal: abort.signal });
          if (!current()) return;
          health.contactOk(device.name, { apSsid: typeof snapshot.uid === "string" ? snapshot.uid : undefined });
        } catch (error) {
          if (!current()) return;
          this.deps.logger.debug(`[Telemetry] ${device.name}: ${String(error)}`);
          if (device.type !== "pixoo") return;
          snapshot = { reachable: false, brightness: null, cur_clock_id: null };
        }
        if (!current()) return;
        poller.snapshot = { ...snapshot, ...(device.type === "pixoo" ? { ip_address: device.address } : {}), ts: new Date(this.deps.clock.now()).toISOString() };
        await publish();
      } catch (error) { if (current()) this.deps.logger.error(`[Telemetry] ${device.name}`, error); }
      finally { busy = false; }
    };
    const timer = this.deps.clock.every(() => { void tick(); }, Math.max(1, Math.min(1000, this.deps.intervalMs())));
    poller.cancel = () => { abort.abort(); timer.cancel(); };
    this.pollers.set(device.name, poller);
    void tick();
  }

  /** Abort the read in flight and forget the device. @param {string} name */
  stop(name) {
    const poller = this.pollers.get(name);
    if (!poller) return;
    poller.active = false;
    poller.cancel();
    this.pollers.delete(name);
    if (!this.pollers.size && this.listening) { this.deps.mqtt.off("connect", this.onConnect); this.listening = false; }
  }

  stopAll() {
    for (const name of this.pollers.keys()) this.stop(name);
  }

  /**
   * @param {string} name
   * @returns {Record<string, unknown>|null} a copy of the last snapshot
   */
  latest(name) {
    const snapshot = this.pollers.get(name)?.snapshot;
    return snapshot ? structuredClone(snapshot) : null;
  }
}
