/**
 * Health model: measured, never assumed.
 *
 * Lesson behind it (matrix index, "silent failure"): a status can show green
 * while the loop behind it is dead. So health here is computed from events
 * that really happened and from how long ago they happened, and the things
 * that produce those events are themselves watched (scheduler watchdog).
 *
 * Per display. The rule is Markus's, taken literally (PIXD-81 approval; it
 * replaces v1's "5 failed renders", B-066, S-14):
 *
 *   With an active scene (mode play and a custom scene), by the clock since
 *   the last frame the display accepted:
 *     less than 30 s              → online   (starting: before the first good frame)
 *     30 s up to less than 2 min  → stale
 *     2 min or more               → offline
 *   Nothing is subtracted and nothing is added: not the delay the scene asked
 *   for, not the render time, not a backoff. The thresholds are inclusive at
 *   their lower end: 29 999 ms is online, 30 000 ms is stale, 119 999 ms is
 *   stale, 120 000 ms is offline. Before the first good frame the same
 *   thresholds count from entry into play (starting, then stale, then
 *   offline). Returning from quiet starts a fresh frame window; an older
 *   frame cannot make the display immediately offline before its next render.
 *
 *   Without an active scene there are no frames to count: pause, stop, a
 *   built-in mode, no scene chosen. There the render loop probes every
 *   probeIntervalMs (10 s), and the same two thresholds apply to the time
 *   since the last good contact. With no scene chosen and a fresh contact the
 *   state is idle.
 *
 *   output shadow                 → shadow   (not measured)
 *
 * `reason` says why a display is not online: device_unreachable (DeviceError),
 * scene_error (the display answers, the scene fails: no hardware steps, no
 * power cycle, S-6), power_cycles_exhausted, not_started.
 *
 * Controller health for GET /api/health and the Docker HEALTHCHECK (A-161):
 * ok when the scheduler watchdog ran within 2 × its interval; degraded when
 * a driven display is stale or offline, config.json on disk is invalid, a
 * configured broker is offline, or a restart is required; failed when the
 * watchdog is overdue. controller() computes it from inputs that main.js
 * collects every second; main.js owns that wiring (the status in snapshots,
 * 503 for failed, the "controller" live event), so building this model is
 * enough to make the health check real.
 *
 * Events (EventEmitter): "health" ({device: string, health: DeviceHealth, previous: DeviceHealth}).
 *
 * Owner: drivers worker.
 */

import { EventEmitter } from "node:events";
import { classifyError } from "../core/errors.js";

/** @typedef {import("../types.js").DeviceHealth} DeviceHealth */
/** @typedef {import("../types.js").HealthConfig} HealthConfig */

/**
 * Facts the model keeps per device. Everything is a time or a counter; the
 * state is derived, never stored.
 *
 * @typedef {object} HealthFacts
 * @property {number} startedAt epoch ms when the runtime started
 * @property {number} framesDueSince epoch ms when this frame window started
 * @property {number|null} lastFrameAt
 * @property {number|null} lastContactAt
 * @property {boolean} framesDue true with an active scene: mode play and a custom scene
 * @property {boolean} hasScene
 * @property {boolean} shadow
 * @property {number} consecutiveErrors
 * @property {{message: string, kind: "device"|"scene"|"config"|"internal", at: number}|null} lastError
 * @property {{count: number, max: number, plugTopic: string|null, exhausted: boolean}} powerCycles
 * @property {string|null} apSsid
 */

/**
 * The rule above as a pure function, so the stale and offline timing can be
 * tested without a clock.
 *
 * @param {HealthFacts} facts
 * @param {number} now epoch ms
 * @param {HealthConfig} config
 * @returns {{state: import("../types.js").HealthState, reason: DeviceHealth["reason"]}}
 */
export function deriveHealth(facts, now, config) {
  if (facts.shadow) return { state: "shadow", reason: null };
  const last = facts.framesDue ? facts.lastFrameAt : facts.lastContactAt;
  const baseline = facts.framesDue ? Math.max(last ?? facts.startedAt, facts.framesDueSince) : last ?? facts.startedAt;
  const age = Math.max(0, now - baseline);
  const reason = facts.powerCycles.exhausted ? "power_cycles_exhausted"
    : facts.lastError?.kind === "scene" || facts.lastError?.kind === "internal" ? "scene_error"
    : facts.lastError?.kind === "device" ? "device_unreachable"
    : last === null ? "not_started" : null;
  if (age >= config.offlineAfterMs) return { state: "offline", reason: reason ?? "device_unreachable" };
  if (age >= config.staleAfterMs) return { state: "stale", reason: reason ?? "device_unreachable" };
  return { state: last === null ? "starting" : !facts.framesDue && !facts.hasScene ? "idle" : "online", reason };
}

export class HealthModel extends EventEmitter {
  /** @param {{config: () => HealthConfig, clock: import("../types.js").Clock, logger: import("../types.js").Logger}} deps */
  constructor(deps) {
    super();
    this.deps = deps;
    /** @type {Map<string, HealthFacts>} */
    this.facts = new Map();
    /** @type {Map<string, DeviceHealth>} */
    this.views = new Map();
    /** @type {{cancel: () => void}|null} */
    this.timer = null;
  }

  /** Re-derive every device on a timer (1 s), so a display turns stale without any new event. */
  start() {
    if (!this.timer) this.timer = this.deps.clock.every(() => {
      for (const device of this.facts.keys()) this.update(device);
    }, 1000);
  }

  stop() {
    this.timer?.cancel();
    this.timer = null;
  }

  /**
   * @param {string} device
   * @param {{shadow: boolean, powerCycleMax: number, plugTopic: string|null}} options
   */
  register(device, options) {
    this.facts.set(device, {
      startedAt: this.deps.clock.now(), framesDueSince: this.deps.clock.now(), lastFrameAt: null, lastContactAt: null,
      framesDue: false, hasScene: false, shadow: options.shadow, consecutiveErrors: 0, lastError: null,
      powerCycles: { count: 0, max: options.powerCycleMax, plugTopic: options.plugTopic, exhausted: false }, apSsid: null,
    });
    this.views.delete(device);
    this.update(device);
  }

  /** @param {string} device */
  unregister(device) {
    this.facts.delete(device);
    this.views.delete(device);
  }

  /**
   * The display accepted a frame. The time is the clock's now; nothing else
   * about the frame matters to health.
   * @param {string} device
   */
  frameOk(device) {
    const facts = this.facts.get(device);
    if (!facts) return;
    facts.lastFrameAt = facts.lastContactAt = this.deps.clock.now();
    facts.consecutiveErrors = 0;
    facts.lastError = null;
    this.update(device);
  }

  /**
   * The display answered something else: probe, telemetry read, control.
   * @param {string} device
   * @param {{apSsid?: string|null}} [info]
   */
  contactOk(device, info) {
    const facts = this.facts.get(device);
    if (!facts) return;
    facts.lastContactAt = this.deps.clock.now();
    if (info?.apSsid !== undefined) facts.apSsid = info.apSsid;
    if (facts.lastError?.kind === "device") facts.lastError = null;
    this.update(device);
  }

  /**
   * A render attempt failed.
   * @param {string} device
   * @param {unknown} error classified with core/errors.js classifyError
   */
  renderFailed(device, error) {
    const facts = this.facts.get(device);
    if (!facts) return;
    facts.consecutiveErrors += 1;
    facts.lastError = { ...classifyError(error), at: this.deps.clock.now() };
    this.update(device);
  }

  /**
   * The loop's expectations changed (mode, scene, built-in).
   * @param {string} device
   * @param {{framesDue: boolean, hasScene: boolean}} expectation
   */
  expect(device, expectation) {
    const facts = this.facts.get(device);
    if (!facts) return;
    if (expectation.framesDue && !facts.framesDue) facts.framesDueSince = this.deps.clock.now();
    Object.assign(facts, expectation);
    this.update(device);
  }

  /**
   * @param {string} device
   * @param {{count: number, exhausted: boolean}} cycles
   */
  powerCycles(device, cycles) {
    const facts = this.facts.get(device);
    if (!facts) return;
    Object.assign(facts.powerCycles, cycles);
    this.update(device);
  }

  /**
   * @param {string} device
   * @returns {DeviceHealth|undefined}
   */
  get(device) {
    this.update(device);
    const view = this.views.get(device);
    return view ? structuredClone(view) : undefined;
  }

  /**
   * @param {{watchdogAt: string|null, watchdogIntervalMs: number, mqtt: import("../types.js").MqttStatus, configValid: boolean, restartRequired: boolean}} inputs watchdogAt and watchdogIntervalMs from Scheduler.status()
   * @returns {{status: "ok"|"degraded"|"failed", reasons: string[]}} reasons as listed for ControllerStatus (types.js)
   */
  controller(inputs) {
    const reasons = [];
    for (const name of this.facts.keys()) {
      const health = this.get(name);
      if (health?.state === "stale" || health?.state === "offline") reasons.push(`display_${health.state}:${name}`);
    }
    if (!inputs.configValid) reasons.push("config_invalid");
    if (inputs.mqtt.state !== "disabled" && inputs.mqtt.state !== "connected") reasons.push("mqtt_offline");
    if (inputs.restartRequired) reasons.push("restart_required");
    if (!inputs.watchdogAt || this.deps.clock.now() - Date.parse(inputs.watchdogAt) > inputs.watchdogIntervalMs * 2) {
      reasons.push("watchdog_overdue");
      return { status: "failed", reasons };
    }
    return { status: reasons.length ? "degraded" : "ok", reasons };
  }

  /** @param {string} device */
  update(device) {
    const facts = this.facts.get(device);
    if (!facts) return;
    const previous = this.views.get(device);
    const now = this.deps.clock.now();
    const derived = deriveHealth(facts, now, this.deps.config());
    const iso = (/** @type {number|null} */ at) => at === null ? null : new Date(at).toISOString();
    const { count, max, plugTopic } = facts.powerCycles;
    const powerCycles = { count, max, plugTopic };
    const health = {
      ...derived, since: previous?.state === derived.state ? previous.since : new Date(now).toISOString(),
      lastFrameAt: iso(facts.lastFrameAt), lastContactAt: iso(facts.lastContactAt),
      consecutiveErrors: facts.consecutiveErrors,
      lastError: facts.lastError ? { ...facts.lastError, at: new Date(facts.lastError.at).toISOString() } : null,
      powerCycles, apSsid: facts.apSsid,
    };
    this.views.set(device, health);
    if (JSON.stringify(health) !== JSON.stringify(previous)) this.emit("health", { device, health: structuredClone(health), previous: previous ? structuredClone(previous) : health });
  }
}
