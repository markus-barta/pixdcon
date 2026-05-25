/**
 * TelemetryCollector — periodic /api/stats poll per Ulanzi device,
 * publishes a JSON snapshot to MQTT for downstream observability
 * (Home Assistant, Grafana, alerting).
 *
 * Topic: `<mqttBaseTopic>/<deviceName>/telemetry` (retained)
 * Payload:
 *   {
 *     uptime: 983,            // seconds since last boot — resets detect reboots
 *     bat: 100,               // % charge (TC001 reads ~100 when on USB)
 *     bat_raw: 666,           // raw ADC of rail voltage — trend detects brick sag
 *     wifi_signal: -52,       // dBm
 *     ram: 129244,            // free heap; declines suggest leak
 *     temp: 28,               // °C internal
 *     hum: 29,                // % internal
 *     lux: 0,                 // ambient light
 *     ldr_raw: 220,           // raw LDR
 *     messages: 2,            // app-cycle/MQTT msg counter
 *     app: "pixdcon_ulanzi-57",
 *     ip_address: "192.168.1.57",
 *     ts: "2026-05-25T15:01:03.000Z"
 *   }
 *
 * Best-effort: a failed poll logs `warn` and skips one cycle; no
 * publish on failure (so HA sees the last good snapshot rather than a
 * spurious "device gone" if it's just a transient).
 *
 * Ulanzi-only for now. Pixoo64 has a different stats surface and would
 * warrant its own collector if needed.
 */

export class TelemetryCollector {
  /**
   * @param {Object} options
   * @param {Object} options.mqttService - MqttService instance (uses .publish + .baseTopic)
   * @param {Object} options.logger      - Logger
   * @param {number} [options.intervalMs=60000]
   * @param {number} [options.timeoutMs=5000]  - per-poll fetch timeout
   */
  constructor({
    mqttService,
    logger,
    intervalMs = 60_000,
    timeoutMs = 5_000,
    haDiscovery = true,
    haDiscoveryPrefix = "homeassistant",
  }) {
    this.mqttService = mqttService;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.haDiscovery = haDiscovery;
    this.haDiscoveryPrefix = haDiscoveryPrefix;
    this._timers = new Map(); // deviceName → intervalId
    this._latest = new Map(); // deviceName → last successful payload (incl. ts)
    this._haPublished = new Set(); // deviceNames with discovery already sent
  }

  /**
   * Return the most recent successful /api/stats snapshot for a device, or
   * null if none has been collected yet. Used by the web UI to show
   * device-specific recovery hints (AP SSID derived from `uid`).
   */
  getLatest(deviceName) {
    return this._latest.get(deviceName) || null;
  }

  /**
   * Start polling a device. No-op if already polling, or if device.type
   * isn't `ulanzi`, or if MQTT isn't connected.
   * @param {{name: string, type: string, ip: string}} device
   */
  start(device) {
    if (device.type !== "ulanzi") return;
    if (this._timers.has(device.name)) return;
    if (!this.mqttService) return;

    const poll = async () => {
      try {
        const res = await fetch(`http://${device.ip}/api/stats`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          this.logger.warn(`[telemetry] ${device.name}: HTTP ${res.status}`);
          return;
        }
        const stats = await res.json();
        const payload = { ...stats, ts: new Date().toISOString() };
        this._latest.set(device.name, payload);
        this.mqttService.publish(
          `${device.name}/telemetry`,
          payload,
          true, // retained — HA picks up last snapshot on reconnect
        );
        // One-shot HA discovery — first successful poll per process start.
        // Skipped if HA discovery disabled, or if already published, or if
        // the payload missing the `uid` we use for HA `identifiers`.
        if (
          this.haDiscovery &&
          !this._haPublished.has(device.name) &&
          stats.uid
        ) {
          this._publishHaDiscovery(device, stats);
          this._haPublished.add(device.name);
        }
        this.logger.debug(
          `[telemetry] ${device.name}: uptime=${stats.uptime}s bat_raw=${stats.bat_raw} wifi=${stats.wifi_signal}dBm ram=${stats.ram}`,
        );
      } catch (err) {
        this.logger.warn(`[telemetry] ${device.name}: ${err.message}`);
      }
    };

    poll(); // initial
    const id = setInterval(poll, this.intervalMs);
    this._timers.set(device.name, id);
    this.logger.info(
      `[telemetry] polling ${device.name} (${device.ip}) every ${this.intervalMs}ms`,
    );
  }

  /**
   * Publish per-sensor MQTT Discovery configs so Home Assistant auto-creates
   * sensors for this device. Retained on `<haDiscoveryPrefix>/sensor/<unique_id>/config`.
   * All sensors share one HA device card (keyed by `uid` from /api/stats).
   *
   * Re-runs only on first successful poll per process start; HA preserves
   * its in-memory entities across pixdcon restarts because the discovery
   * topics are retained on the broker.
   */
  _publishHaDiscovery(device, stats) {
    const baseTopic = this.mqttService.baseTopic; // "home/hsb1/pixdcon"
    const stateTopic = `${baseTopic}/${device.name}/telemetry`;
    const deviceObj = {
      identifiers: [`pixdcon_${stats.uid}`],
      name: device.name,
      model: `Ulanzi TC001 / AWTRIX ${stats.version || ""}`.trim(),
      manufacturer: "Ulanzi",
      sw_version: stats.version || undefined,
      configuration_url: `http://${device.ip}`,
    };

    // (field, sensorName, options)
    const sensors = [
      [
        "uptime",
        "Uptime",
        {
          unit_of_measurement: "s",
          device_class: "duration",
          state_class: "total_increasing",
          entity_category: "diagnostic",
        },
      ],
      [
        "bat",
        "Battery",
        {
          unit_of_measurement: "%",
          device_class: "battery",
          state_class: "measurement",
          entity_category: "diagnostic",
        },
      ],
      [
        "bat_raw",
        "Rail ADC",
        {
          state_class: "measurement",
          icon: "mdi:flash",
          entity_category: "diagnostic",
        },
      ],
      [
        "wifi_signal",
        "WiFi signal",
        {
          unit_of_measurement: "dBm",
          device_class: "signal_strength",
          state_class: "measurement",
          entity_category: "diagnostic",
        },
      ],
      [
        "ram",
        "Free heap",
        {
          unit_of_measurement: "B",
          device_class: "data_size",
          state_class: "measurement",
          entity_category: "diagnostic",
        },
      ],
      [
        "temp",
        "Temperature",
        {
          unit_of_measurement: "°C",
          device_class: "temperature",
          state_class: "measurement",
        },
      ],
      [
        "hum",
        "Humidity",
        {
          unit_of_measurement: "%",
          device_class: "humidity",
          state_class: "measurement",
        },
      ],
      [
        "lux",
        "Illuminance",
        {
          unit_of_measurement: "lx",
          device_class: "illuminance",
          state_class: "measurement",
        },
      ],
      [
        "messages",
        "Message count",
        {
          state_class: "total_increasing",
          icon: "mdi:message-text",
          entity_category: "diagnostic",
        },
      ],
      [
        "app",
        "Active app",
        { icon: "mdi:application", entity_category: "diagnostic" },
      ],
    ];

    for (const [key, name, opts] of sensors) {
      const unique_id = `pixdcon_${device.name}_${key}`;
      const config = {
        name,
        unique_id,
        object_id: unique_id,
        state_topic: stateTopic,
        value_template: `{{ value_json.${key} }}`,
        availability_topic: `${baseTopic}/health`,
        availability_template:
          "{{ 'online' if value_json.status in ['ok', 'degraded'] else 'offline' }}",
        device: deviceObj,
        ...opts,
      };
      this.mqttService.publishRaw(
        `${this.haDiscoveryPrefix}/sensor/${unique_id}/config`,
        config,
        true, // retained
      );
    }
    this.logger.info(
      `[telemetry] HA discovery: published ${sensors.length} sensors for ${device.name}`,
    );
  }

  /** Stop polling a specific device. */
  stop(deviceName) {
    const id = this._timers.get(deviceName);
    if (!id) return;
    clearInterval(id);
    this._timers.delete(deviceName);
    this.logger.info(`[telemetry] stopped ${deviceName}`);
  }

  /** Stop polling all devices. */
  stopAll() {
    for (const [name, id] of this._timers) {
      clearInterval(id);
      this.logger.info(`[telemetry] stopped ${name}`);
    }
    this._timers.clear();
  }
}

export default TelemetryCollector;
