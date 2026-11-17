/**
 * Status publisher: the controller-level topics, in the v1 shape, and the
 * per-device availability.
 *
 *   <statusBase>/health            retained  {status, timestamp, devices:[{name,status,lastSeen}], errorCount, lastError}   C-022
 *   <statusBase>/state             retained  {running, currentScene, uptime, devices:[{name,scene,frameCount}]}           C-023
 *   <statusBase>/config            retained  {configPath, deviceCount, sceneCount, timestamp}                             C-024
 *   <statusBase>/config/effective  retained  the running config with overlays applied (StateStore.runningConfigV1)       C-024
 *   <base>/<device>/availability   retained  "online" | "offline"                                                          new, C-121, C-137, C-138
 *
 * Kept: topic names, field names, retained, republished on connect and every
 * 30 s (C-013, C-031). The Home Assistant availability template of the Ulanzi
 * entities reads `health.status in ['ok','degraded']`, and the pixoo-189 scene
 * toggle reads the reported scene, so these payloads are an outside contract.
 *
 * Fixed:
 *  - Health follows the measured state and recovers: online → "ok", stale →
 *    "degraded", offline → "failed" per device; overall "ok" or "degraded".
 *    One display that is down no longer turns every entity unavailable
 *    (B-C03). `errorCount` stays the lifetime counter; `lastSeen` is the last
 *    contact, not the time of the status write (C-027, B-C04).
 *  - Per-device availability. v1's entities have no freshness of their own:
 *    an unplugged Ulanzi keeps showing its last values as long as the
 *    controller is healthy (C-121), and the Pixoo entities never expire
 *    (C-137, C-138). v2 publishes <base>/<device>/availability for every
 *    driven device from its measured health: "offline" while the health
 *    state is offline, "online" otherwise; on every change, on every connect
 *    and with the 30 s republish. The discovery payloads name this topic
 *    next to the controller health (ha-discovery.js), so one display that is
 *    down takes its own entities down and nobody else's.
 *  - Availability is retired, not abandoned. A retained "online" that
 *    nobody takes back would keep the entities of a display available for
 *    ever while the controller is healthy. So when this instance stops
 *    driving a display for which it published "online" (the device left the
 *    effective config, was disabled, or its output changed from drive to
 *    shadow, also by the v1 interlock), it publishes "offline" for it once
 *    more, retained, and only then forgets it. This is the last message of
 *    the driving phase and the one publish for a device that is not driven;
 *    it says less, never more. It is owed until the broker confirmed it:
 *    after a reconnect it is sent again. On a clean stop every display this
 *    instance drives is retired the same way. planAvailability() below is
 *    the rule, finished code.
 *    What is owed is counted from the moment an "online" is handed to the
 *    gateway, not from its acknowledgement: the broker may have stored it
 *    although the acknowledgement was lost with the connection, and an
 *    "online" nobody remembers is exactly what must not stay. The ledger
 *    below (createAvailabilityLedger, availabilitySent, availabilityOutcome)
 *    keeps that: a device owes an "offline" from the first "online" that
 *    may have reached the broker until the broker confirmed an "offline"
 *    that was sent after it. No timer and no reconnect ends the debt.
 *    What this cannot cover is a process that dies, or a device that is
 *    removed while the process is down: then the last will takes the
 *    controller health down, and after the next start the discovery
 *    payloads' `expire_after` (ha-discovery.js, now on the Ulanzi sensors
 *    too) ends the entities of a display that nobody publishes telemetry
 *    for.
 *  - A device that left the config leaves both lists (C-028).
 *  - `state.devices[].scene` is the scene on the display and is published at
 *    once when it changes, not only every 100 frames (C-081). Added fields per
 *    device: mode, source. `currentScene` stays null (C-026).
 *  - On a clean stop: state running false and health status "offline"; on a
 *    crash the last will says the same (C-033, B-C02).
 *  - Only devices this instance drives are listed and get an availability
 *    message. "Drives" is the resolved output policy (RuntimeConfig), so a
 *    device held back by the v1 interlock is not listed. An instance that
 *    drives nothing (edge lane, shadow) must not use v1's status base.
 *  - Nothing is rebuilt here: device entries come from the runtime config,
 *    the v1-shaped running config from the state store.
 *
 * Owner: API + live channel worker. The last will below is finished code, so
 * the gateway (core/state worker) does not depend on this file being built.
 */

/**
 * @typedef {object} V1HealthPayload
 * @property {"ok"|"degraded"|"failed"|"offline"|"unknown"} status
 * @property {string|null} timestamp
 * @property {Array<{name: string, status: "ok"|"degraded"|"failed"|"unreachable"|"offline"|"dead", lastSeen: string|null}>} devices
 * @property {number} errorCount
 * @property {{message: string, timestamp: string}|null} lastError
 */

/**
 * @typedef {object} V1StatePayload
 * @property {boolean} running
 * @property {null} currentScene
 * @property {number} uptime seconds
 * @property {Array<{name: string, scene: string|null, frameCount: number, mode?: string, source?: string}>} devices
 */

/**
 * @typedef {object} StatusPublisherDeps
 * @property {import("./mqtt-gateway.js").MqttGateway} mqtt
 * @property {import("./topics.js").Topics} topics
 * @property {import("../state/state-store.js").StateStore} state device states, health, and runningConfigV1()
 * @property {import("../state/runtime-config.js").RuntimeConfig} runtime which devices exist and which are driven
 * @property {import("../config/config-store.js").ConfigStore} config path of config.json for the summary topic
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 * @property {number} [intervalMs] default 30000
 */

/**
 * What the broker may hold on the availability topics, per device. Every
 * availability publish gets a number in the order it is handed to the
 * gateway; on one connection that is the order in which the broker stores
 * them, and a publish of a connection that ended is never sent again.
 *
 * @typedef {object} AvailabilityLedger
 * @property {number} sent number of the last availability publish, of any device
 * @property {Map<string, {online: number, offlineConfirmed: number}>} devices per device: the number of the last "online" that was handed to the gateway (0 = never), and the number of the newest "offline" the broker confirmed (0 = none). The broker may hold "online" exactly while online > offlineConfirmed
 */

/** @returns {AvailabilityLedger} */
export function createAvailabilityLedger() {
  return { sent: 0, devices: new Map() };
}

/**
 * An availability publish is handed to the gateway. Call this before the
 * publish is awaited: from here on the broker may hold the payload, whatever
 * becomes of the acknowledgement.
 *
 * @param {AvailabilityLedger} ledger changed in place
 * @param {string} device
 * @param {"online"|"offline"} payload
 * @returns {number} the number of this publish; hand it back with its outcome
 */
export function availabilitySent(ledger, device, payload) {
  const number = ++ledger.sent;
  if (payload === "online") {
    const entry = ledger.devices.get(device) ?? {
      online: 0,
      offlineConfirmed: 0,
    };
    entry.online = number;
    ledger.devices.set(device, entry);
  }
  return number;
}

/**
 * The outcome of an availability publish (mqtt-gateway.js PublishResult).
 * Only one outcome changes anything: the broker confirmed an "offline". Then
 * every "online" that was sent before it is taken back; when none was sent
 * after it, the device owes nothing and is forgotten. A lost acknowledgement,
 * a timeout, an error and the end of the connection leave the debt as it is.
 *
 * @param {AvailabilityLedger} ledger changed in place
 * @param {string} device
 * @param {"online"|"offline"} payload what was published
 * @param {number} number what availabilitySent returned for it
 * @param {import("./mqtt-gateway.js").PublishResult["outcome"]} outcome
 */
export function availabilityOutcome(ledger, device, payload, number, outcome) {
  if (payload !== "offline" || outcome !== "confirmed") return;
  const entry = ledger.devices.get(device);
  if (!entry) return;
  entry.offlineConfirmed = Math.max(entry.offlineConfirmed, number);
  if (entry.online < entry.offlineConfirmed) ledger.devices.delete(device);
}

/**
 * Does the broker possibly hold "online" for this device: an "online" was
 * handed to the gateway, and no "offline" sent after it has been confirmed?
 *
 * @param {AvailabilityLedger} ledger
 * @param {string} device
 * @returns {boolean}
 */
export function owesOffline(ledger, device) {
  const entry = ledger.devices.get(device);
  return entry !== undefined && entry.online > entry.offlineConfirmed;
}

/**
 * What to publish on the per-device availability topics, as a pure function
 * of what the broker may hold and what this instance drives now.
 *
 * @param {AvailabilityLedger} ledger what the broker may hold (see above)
 * @param {Array<{name: string, driven: boolean, health: import("../types.js").HealthState|null}>} devices the devices of the effective config; driven = enabled and output drive; a device that left the config is simply not in the list
 * @returns {Array<{device: string, payload: "online"|"offline", retire: boolean}>} in the order of `devices`, then retirements of devices that left. retire = the device is no longer driven and may still be "online" on the broker: this "offline" is owed, and repeated with every plan, until the broker confirmed it
 */
export function planAvailability(ledger, devices) {
  /** @type {Array<{device: string, payload: "online"|"offline", retire: boolean}>} */
  const plan = [];
  const listed = new Set();
  for (const device of devices) {
    listed.add(device.name);
    if (device.driven) {
      plan.push({
        device: device.name,
        payload: device.health === "offline" ? "offline" : "online",
        retire: false,
      });
    } else if (owesOffline(ledger, device.name)) {
      plan.push({ device: device.name, payload: "offline", retire: true });
    }
  }
  for (const device of ledger.devices.keys()) {
    if (!listed.has(device) && owesOffline(ledger, device))
      plan.push({ device, payload: "offline", retire: true });
  }
  return plan;
}

export class StatusPublisher {
  /**
   * The last will for the gateway: the health topic of this process's status
   * base, retained, in the v1 health shape with status "offline". Home
   * Assistant's availability template turns that into "offline" for every
   * entity (B-C02). The broker stores it at connect time, so it has no
   * timestamp of the death; `timestamp` is null.
   *
   * Built from the topics, and the topics from the loaded config: main.js
   * calls this after config.json was read, never with defaults.
   *
   * @param {import("./topics.js").Topics} topics
   * @returns {import("./mqtt-gateway.js").LastWill}
   */
  static lastWill(topics) {
    /** @type {V1HealthPayload} */
    const payload = {
      status: "offline",
      timestamp: null,
      devices: [],
      errorCount: 0,
      lastError: null,
    };
    return {
      topic: topics.health,
      payload: JSON.stringify(payload),
      retain: true,
      qos: 1,
    };
  }

  /** @param {StatusPublisherDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.ledger = createAvailabilityLedger();
    this.startedAt = deps.clock.now();
    this.running = false;
    this.everDriven = false;
    this.dirty = false;
    this.errorCount = 0;
    /** @type {{message: string, timestamp: string}|null} */
    this.lastError = null;
    /** @type {Map<string, {at: string, count: number}>} */
    this.errors = new Map();
    /** @type {Array<() => void>} */
    this.stops = [];
    /** @type {Promise<void>|null} */
    this.pending = null;
  }

  /** Publish now, on every connect, on every relevant change and every `intervalMs`. */
  start() {
    if (this.running) return;
    this.#devices(); // Fail synchronously while the runtime is still a skeleton.
    this.running = true;
    /** @param {import("node:events").EventEmitter} source @param {string} event */
    const follow = (source, event) => {
      const changed = () => this.#request();
      source.on(event, changed);
      this.stops.push(() => source.off(event, changed));
    };
    for (const event of ["device", "device-added", "device-removed"])
      follow(this.deps.state, event);
    follow(this.deps.runtime, "changed");
    follow(this.deps.mqtt, "connect");
    const timer = this.deps.clock.every(
      () => this.#request(),
      this.deps.intervalMs ?? 30000,
    );
    this.stops.push(() => timer.cancel());
    this.#request();
  }

  /** Publish running false and health "offline", retire the availability of every display that may still be "online" on the broker (planAvailability with no device driven), then stop the timers. */
  async stop() {
    const wasRunning = this.running;
    this.running = false;
    for (const stop of this.stops.splice(0)) stop();
    await this.pending;
    if (wasRunning) await this.#publish(false);
  }

  /** @returns {V1HealthPayload} */
  buildHealth() {
    const devices = this.#devices().filter((device) => device.driven);
    const states = devices.map((device) => ({
      name: device.name,
      health: this.deps.state.get(device.name)?.health,
    }));
    for (const { name, health } of states) {
      const previous = this.errors.get(name);
      if (
        health?.lastError &&
        (!previous ||
          health.lastError.at !== previous.at ||
          health.consecutiveErrors > previous.count)
      ) {
        this.errorCount += Math.max(
          1,
          health.consecutiveErrors - (previous?.count ?? 0),
        );
        this.lastError = {
          message: health.lastError.message,
          timestamp: health.lastError.at,
        };
      }
      if (health)
        this.errors.set(name, {
          at: health.lastError?.at ?? "",
          count: health.consecutiveErrors,
        });
    }
    return {
      status: this.running
        ? states.some(
            ({ health }) =>
              health?.state === "stale" || health?.state === "offline",
          )
          ? "degraded"
          : "ok"
        : "offline",
      timestamp: new Date(this.deps.clock.now()).toISOString(),
      devices: states.map(({ name, health }) => ({
        name,
        status: !this.running
          ? "offline"
          : health?.state === "offline"
            ? "failed"
            : health?.state === "stale"
              ? "degraded"
              : "ok",
        lastSeen: health?.lastContactAt ?? null,
      })),
      errorCount: this.errorCount,
      lastError: this.lastError,
    };
  }

  /** @returns {V1StatePayload} */
  buildState() {
    return {
      running: this.running,
      currentScene: null,
      uptime: Math.floor((this.deps.clock.now() - this.startedAt) / 1000),
      devices: this.#devices()
        .filter((device) => device.driven)
        .map((device) => {
          const state = this.deps.state.get(device.name);
          return {
            name: device.name,
            scene: state?.effective.scene ?? null,
            frameCount: state?.effective.frameCount ?? 0,
            mode: state?.desired.mode.value ?? "play",
            source: state?.desired.scene.source ?? "fallback",
          };
        }),
    };
  }

  /**
   * Availability of one display, for <base>/<device>/availability: the entry
   * of planAvailability() for it.
   *
   * @param {string} device
   * @returns {"online"|"offline"|null} null: nothing to publish. That is a device this instance does not drive and owes no "offline" for (owesOffline)
   */
  buildAvailability(device) {
    return (
      planAvailability(this.ledger, this.running ? this.#devices() : []).find(
        (entry) => entry.device === device,
      )?.payload ?? null
    );
  }

  #devices() {
    return this.deps.runtime
      .get()
      .devices.map((device) => ({
        name: device.name,
        driven: device.enabled && device.output.mode === "drive",
        health: this.deps.state.get(device.name)?.health.state ?? null,
      }));
  }

  #request() {
    if (!this.running) return;
    this.dirty = true;
    if (this.pending) return;
    this.pending = this.#flush()
      .catch((error) => {
        this.deps.logger.error("[Status] Publish failed", error);
      })
      .finally(() => {
        this.pending = null;
        if (this.running && this.dirty) this.#request();
      });
  }

  async #flush() {
    do {
      this.dirty = false;
      await this.#publish(true);
    } while (this.running && this.dirty);
  }

  /** Every batch is built when it is sent, never from the event that woke it.
   * @param {boolean} running
   */
  async #publish(running) {
    const { mqtt, topics } = this.deps;
    const devices = this.#devices();
    this.everDriven ||= devices.some((device) => device.driven);
    /** @type {Array<Promise<unknown>>} */
    const writes = [];
    // A shadow instance never claims v1's status namespace. After driving,
    // it still removes the departed devices from its owned controller lists.
    if (topics.statusBase !== topics.base || this.everDriven) {
      const config = this.deps.state.runningConfigV1();
      const driven = new Set(
        devices.filter((device) => device.driven).map((device) => device.name),
      );
      const effective = {
        ...config,
        devices: /** @type {Array<{name: string}>} */ (
          config.devices ?? []
        ).filter((device) => driven.has(device.name)),
      };
      const options = { retain: true, qos: /** @type {const} */ (1) };
      writes.push(
        mqtt.publish(
          topics.health,
          /** @type {Record<string, unknown>} */ (this.buildHealth()),
          options,
        ),
      );
      writes.push(
        mqtt.publish(
          topics.state,
          /** @type {Record<string, unknown>} */ (this.buildState()),
          options,
        ),
      );
      writes.push(
        mqtt.publish(
          topics.config,
          {
            configPath: this.deps.config.options.path,
            deviceCount: effective.devices.length,
            sceneCount: Object.keys(/** @type {object} */ (config.scenes ?? {}))
              .length,
            timestamp: new Date(this.deps.clock.now()).toISOString(),
          },
          options,
        ),
      );
      writes.push(mqtt.publish(topics.configEffective, effective, options));
    }
    for (const item of planAvailability(this.ledger, running ? devices : [])) {
      const sent = availabilitySent(this.ledger, item.device, item.payload);
      writes.push(this.#availability(item.device, item.payload, sent));
    }
    await Promise.all(writes);
  }

  /** @param {string} device @param {"online"|"offline"} payload @param {number} sent */
  async #availability(device, payload, sent) {
    const { mqtt, topics } = this.deps;
    try {
      const result = await mqtt.publish(topics.availability(device), payload, {
        retain: true,
        qos: 1,
      });
      availabilityOutcome(this.ledger, device, payload, sent, result.outcome);
    } catch (error) {
      availabilityOutcome(this.ledger, device, payload, sent, "error");
      throw error;
    }
  }
}
