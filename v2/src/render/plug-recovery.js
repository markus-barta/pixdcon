/**
 * Per-device plug debt, owned by the scheduler rather than a display runtime.
 * Capture the original plug before OFF; only a certainly unsent OFF error or
 * confirmed ON clears it. Retirement, disable, removal and shadow keep retrying
 * that original ON. All restorers share one task, including a late old runtime.
 * OFF must settle before ON; reconnect wakes only the ON retry sleeper, never
 * the render loop's ten-second OFF wait. Shutdown bounds retries by until().
 * Each publish and retry wait sets a fresh watchdog deadline; ON retry times
 * report through the current runtime. Outcomes alone settle the debt (v1 D-124).
 * Owner: drivers worker.
 */
export class PlugRecovery {
  /**
   * @param {{name: string, mqtt: import('../mqtt/mqtt-gateway.js').MqttGateway|null,
   * clock: import('../types.js').Clock, logger: import('../types.js').Logger,
   * until: () => number, report?: (nextRetryAt: string) => void}} deps Infinity while its owner runs, shutdown deadline otherwise
   */
  constructor(deps) {
    this.deps = deps;
    this.plug = /** @type {import('../types.js').PowerCyclePlugin|null} */ (null);
    this.offTask = /** @type {Promise<boolean>|null} */ (null);
    this.task = /** @type {Promise<boolean>|null} */ (null);
    this.sleeper = /** @type {AbortController|null} */ (null);
    this.lastTickAt = /** @type {string|null} */ (null);
    this.nextWakeAt = /** @type {string|null} */ (null);
    this.closed = false;
    this.woken = false;
    this.onConnect = () => { if (this.owed) this.wake(); };
  }

  get owed() { return this.plug !== null; }
  wake() { this.woken = true; this.sleeper?.abort(); }
  allowed() { return !this.closed && this.deps.clock.now() < this.deps.until(); }
  clear() {
    this.plug = null;
    this.lastTickAt = this.nextWakeAt = null;
    this.deps.mqtt?.off("connect", this.onConnect);
  }
  close() { this.closed = true; this.wake(); this.deps.mqtt?.off("connect", this.onConnect); }

  /** @param {import('../types.js').PowerCyclePlugin} plug */
  async powerOff(plug) {
    if (this.owed || !this.allowed() || !this.deps.mqtt) return false;
    this.plug = { ...plug };
    this.lastTickAt = new Date(this.deps.clock.now()).toISOString();
    this.nextWakeAt = new Date(this.deps.clock.now() + 5000).toISOString();
    this.deps.mqtt.on("connect", this.onConnect);
    this.offTask = this.sendOff(this.plug);
    return this.offTask;
  }

  /** @param {import('../types.js').PowerCyclePlugin} plug */
  async sendOff(plug) {
    const mqtt = this.deps.mqtt;
    if (!mqtt) { this.clear(); return false; }
    try {
      const off = await mqtt.publish(plug.topic, plug.offPayload ?? '{"state":"OFF"}', { qos: 1, retain: false, timeoutMs: 5000 });
      if (off.outcome === "error") { this.clear(); return false; }
      this.deps.logger.info(`[PlugRecovery] ${this.deps.name}: plug OFF ${off.outcome}`);
    } catch (error) { this.deps.logger.warn(`[PlugRecovery] ${this.deps.name}: plug OFF uncertain: ${String(error)}`); }
    finally { this.nextWakeAt = null; }
    return true;
  }

  /** @returns {Promise<boolean>} Only one publisher, across all runtime generations. */
  restore() {
    if (this.task) return this.task;
    if (!this.owed) return Promise.resolve(true);
    this.task = this.retry().finally(() => { this.task = null; });
    return this.task;
  }

  async retry() {
    await this.offTask; // ON must never overtake an uncertain OFF still in flight.
    while (this.owed && this.allowed()) {
      const { mqtt, clock, logger, name } = this.deps;
      const plug = this.plug;
      if (!mqtt || !plug) break;
      this.woken = false;
      const timeoutMs = Math.min(5000, this.deps.until() - clock.now());
      this.lastTickAt = new Date(clock.now()).toISOString();
      this.nextWakeAt = new Date(clock.now() + timeoutMs).toISOString();
      this.deps.report?.(this.nextWakeAt);
      try {
        const on = await mqtt.publish(plug.topic, plug.onPayload ?? '{"state":"ON"}', { qos: 1, retain: false, timeoutMs });
        if (on.outcome === "confirmed") this.clear();
        const message = `[PlugRecovery] ${name}: plug ON ${on.outcome}`;
        if (this.owed) logger.warn(message);
        else logger.info(message);
      } catch (error) { logger.warn(`[PlugRecovery] ${name}: plug ON failed: ${String(error)}`); }
      this.nextWakeAt = null;
      if (!this.owed) return true;
      if (this.woken) continue;
      const retryMs = mqtt.status().state === "connected" ? 1000 : 30000;
      const wait = Math.min(retryMs, this.deps.until() - clock.now());
      if (wait <= 0 || !this.allowed()) break;
      const sleeper = new AbortController();
      this.sleeper = sleeper;
      this.nextWakeAt = new Date(clock.now() + wait).toISOString();
      this.deps.report?.(this.nextWakeAt);
      await clock.sleep(wait, sleeper.signal);
      if (this.sleeper === sleeper) this.sleeper = null;
      this.nextWakeAt = null;
    }
    return !this.owed;
  }
}
