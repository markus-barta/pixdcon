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
 * Best-effort: a failed poll logs `warn` and skips one cycle for Ulanzi.
 * Pixoo always publishes a `reachable: false` snapshot on failure so the
 * HA connectivity sensor flips immediately.
 *
 * Per-type telemetry surfaces:
 *   - ulanzi: GET /api/stats — rich (uptime, bat_raw, wifi_signal, ram, …)
 *   - pixoo:  POST /post {Command:"Channel/GetAllConf"} — sparse
 *             (Brightness + CurClockId; no uptime/voltage/ram/signal)
 *             plus a `reachable` boolean derived from request success.
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
   * Start polling a device. No-op if already polling, MQTT isn't connected,
   * or device.type is unknown. Dispatches per-type for the very different
   * telemetry surfaces:
   *   - ulanzi: GET /api/stats (rich payload — uptime, bat_raw, wifi…)
   *   - pixoo:  POST /post {Command: Channel/GetAllConf} (Brightness only)
   *             + a reachable boolean derived from request success.
   */
  start(device) {
    if (this._timers.has(device.name)) return;
    if (!this.mqttService) return;
    if (device.type === "ulanzi") {
      this._startUlanziPoll(device);
    } else if (device.type === "pixoo") {
      this._startPixooPoll(device);
    }
  }

  _startUlanziPoll(device) {
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
    poll();
    const id = setInterval(poll, this.intervalMs);
    this._timers.set(device.name, id);
    this.logger.info(
      `[telemetry] polling ${device.name} (${device.ip}, ulanzi) every ${this.intervalMs}ms`,
    );
  }

  _startPixooPoll(device) {
    // Pixoo64 exposes ~nothing useful for health: no uptime, voltage, ram,
    // or signal. The best we can do is poll Channel/GetAllConf for the
    // brightness setting + derive `reachable` from whether the POST
    // succeeded. Lets HA show a connectivity sensor + brightness sensor.
    const poll = async () => {
      let reachable = false;
      let brightness = null;
      let cur_clock_id = null;
      try {
        const res = await fetch(`http://${device.ip}/post`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ Command: "Channel/GetAllConf" }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.error_code === 0) {
            reachable = true;
            brightness = data.Brightness ?? null;
            cur_clock_id = data.CurClockId ?? null;
          }
        }
      } catch (err) {
        this.logger.debug(`[telemetry] ${device.name}: ${err.message}`);
      }
      const payload = {
        reachable,
        brightness,
        cur_clock_id,
        ip_address: device.ip,
        ts: new Date().toISOString(),
      };
      this._latest.set(device.name, payload);
      this.mqttService.publish(`${device.name}/telemetry`, payload, true);
      if (this.haDiscovery && !this._haPublished.has(device.name)) {
        this._publishPixooHaDiscovery(device);
        this._haPublished.add(device.name);
      }
      this.logger.debug(
        `[telemetry] ${device.name}: reachable=${reachable} brightness=${brightness}`,
      );
    };
    poll();
    const id = setInterval(poll, this.intervalMs);
    this._timers.set(device.name, id);
    this.logger.info(
      `[telemetry] polling ${device.name} (${device.ip}, pixoo) every ${this.intervalMs}ms`,
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

  /**
   * Minimal HA discovery for Pixoo64: just reachable (connectivity binary
   * sensor) + brightness. Pixoo has no `uid` field, so the HA `device`
   * identifier is keyed on the configured device name + IP — stable enough
   * across reboots since pixdcon's config is the source of truth.
   */
  _publishPixooHaDiscovery(device) {
    const baseTopic = this.mqttService.baseTopic;
    const stateTopic = `${baseTopic}/${device.name}/telemetry`;
    const deviceObj = {
      identifiers: [`pixdcon_${device.name}`],
      name: device.name,
      model: "Divoom Pixoo64",
      manufacturer: "Divoom",
      configuration_url: `http://${device.ip}`,
    };

    // 1) Reachable — binary_sensor with connectivity device_class.
    const reachableUid = `pixdcon_${device.name}_reachable`;
    this.mqttService.publishRaw(
      `${this.haDiscoveryPrefix}/binary_sensor/${reachableUid}/config`,
      {
        name: "Reachable",
        unique_id: reachableUid,
        object_id: reachableUid,
        state_topic: stateTopic,
        value_template: "{{ value_json.reachable }}",
        payload_on: "True",
        payload_off: "False",
        device_class: "connectivity",
        device: deviceObj,
        entity_category: "diagnostic",
      },
      true,
    );

    // 2) Brightness — regular sensor (0–100).
    const briUid = `pixdcon_${device.name}_brightness`;
    this.mqttService.publishRaw(
      `${this.haDiscoveryPrefix}/sensor/${briUid}/config`,
      {
        name: "Brightness",
        unique_id: briUid,
        object_id: briUid,
        state_topic: stateTopic,
        value_template: "{{ value_json.brightness }}",
        unit_of_measurement: "%",
        state_class: "measurement",
        icon: "mdi:brightness-percent",
        device: deviceObj,
        entity_category: "diagnostic",
      },
      true,
    );

    this.logger.info(
      `[telemetry] HA discovery: published 2 sensors for ${device.name} (pixoo)`,
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
