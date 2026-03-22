/**
 * Render loop — drives scene execution for a single device.
 *
 * Error handling strategy:
 *   - Each failed render attempt increments a consecutive-error counter.
 *   - Backoff doubles per failure: 1s → 2s → 4s → … → 10 min (cap).
 *   - After 10 consecutive errors the circuit opens.
 *   - If a powerCyclePlugin is configured: power-cycle the device via MQTT,
 *     then reset the error counter and retry.  After maxPowerCycles failed
 *     cycles the loop gives up permanently and logs a fatal error.
 *   - Without powerCyclePlugin: sleep for the capped backoff duration then retry.
 *   - A single successful render resets the counter and backoff to defaults.
 *
 * Frame-rate throttling (minFrameMs):
 *   - Measures wall-clock time each render() call takes.
 *   - Sleeps for max(0, minFrameMs − renderTime) after a successful frame
 *     when the scene returns a delay > 0.
 *   - Scene-returned delay is used as-is when it already exceeds minFrameMs.
 *   - Ensures actual frame cadence is at least minFrameMs regardless of how
 *     fast render() completes, without adding flat overhead on slow renders.
 *
 * CPU protection:
 *   - All waits use async sleep (setTimeout) — never busy-loops.
 *   - Even with a completely dead device the loop sits idle during backoff /
 *     power-cycle waits, not hammering the network or CPU.
 */

export class RenderLoop {
  /**
   * @param {Object}      driver      - Device driver (UlanziDriver or compatible)
   * @param {SceneLoader} sceneLoader - Scene loader instance
   * @param {string[]}    scenes      - Ordered array of scene names
   * @param {Object}      options
   * @param {Object}      options.logger            - Logger instance
   * @param {string}      options.deviceName        - Device name for log context
   * @param {Object}      [options.mqttService]     - Optional MQTT service for state updates
   * @param {number}      [options.minFrameMs=500]  - Minimum ms between frames (0 = no throttle)
   * @param {Object}      [options.powerCyclePlugin]- MQTT power-cycle config (see below)
   *   powerCyclePlugin: {
   *     topic:      string   — e.g. "z2m/wz/plug/zisp32/set"
   *     offPayload: string   — e.g. '{"state":"OFF"}'
   *     onPayload:  string   — e.g. '{"state":"ON"}'
   *     offWaitMs:  number   — ms to wait after OFF before ON  (default 10000)
   *     onWaitMs:   number   — ms to wait after ON before retrying render (default 30000)
   *   }
   * @param {number}      [options.maxPowerCycles=10] - Give up after this many failed cycles
   */
  constructor(driver, sceneLoader, scenes, options = {}) {
    this.driver = driver;
    this.sceneLoader = sceneLoader;
    this.scenes = (scenes || []).filter(Boolean);
    this.logger = options.logger || console;
    this.deviceName = options.deviceName || "unknown";
    this.mqtt = options.mqttService || null;

    // Frame-rate floor: minimum ms between frame starts (0 = no throttle)
    this.minFrameMs =
      typeof options.minFrameMs === "number" ? options.minFrameMs : 500;

    // Power-cycle plugin config (optional)
    this.powerCyclePlugin = options.powerCyclePlugin || null;
    this.maxPowerCycles = options.maxPowerCycles ?? 10;
    this.powerCycleCount = 0;

    // State
    this.running = false;
    this.currentIndex = 0;

    // Error / backoff tracking
    this.consecutiveErrors = 0;
    this.maxErrors = 10;
    this.initialBackoff = 1000;
    this.maxBackoff = 600_000; // 10 minutes
    this.currentBackoff = this.initialBackoff;

    // Stats (exposed for MQTT state publishing)
    this.frameCount = 0;
    this.currentScene = null;
    this.lastSuccessTime = null;

    // Mode control
    this._mode = "play"; // "play" | "pause" | "stop"
    this._modeChanged = null; // Promise resolve fn for wake-up
  }

  // ---------------------------------------------------------------------------

  /**
   * Start the render loop. Runs until stop() is called.
   * Never throws — all errors are caught and handled internally.
   */
  async start() {
    if (this.scenes.length === 0) {
      this.logger.warn(
        `[RenderLoop:${this.deviceName}] No scenes configured — idle`,
      );
      return;
    }

    this.running = true;
    this.logger.info(
      `[RenderLoop:${this.deviceName}] Started with scenes: [${this.scenes.join(", ")}]`,
    );

    while (this.running) {
      const sceneName = this.scenes[this.currentIndex];
      await this._runScene(sceneName);

      // Advance to next scene only when no active errors
      // (retry same scene on failure so transient errors don't skip scenes)
      if (this.running && this.consecutiveErrors === 0) {
        this.currentIndex = (this.currentIndex + 1) % this.scenes.length;
      }
    }
  }

  /**
   * Signal the loop to stop after the current sleep/render completes.
   */
  stop() {
    this.running = false;
    this.logger.info(
      `[RenderLoop:${this.deviceName}] Stop requested (frames rendered: ${this.frameCount})`,
    );
    // Wake any sleep or mode-wait so the loop can exit cleanly
    if (this._sleepWake) {
      this._sleepWake();
    }
    if (this._modeChanged) {
      this._modeChanged();
      this._modeChanged = null;
    }
  }

  /**
   * Change the render mode at runtime.
   * @param {"play"|"pause"|"stop"} mode
   */
  setMode(mode) {
    const prev = this._mode;
    this._mode = mode;
    this.logger.info(`[RenderLoop:${this.deviceName}] Mode: ${prev} → ${mode}`);
    // play→play: force device re-init on next frame (recovery from silent failures)
    if (mode === "play" && prev === "play") {
      this._reinitRequested = true;
    }
    // Wake any current sleep so the mode takes effect immediately
    if (this._sleepWake) {
      this._sleepWake();
    }
    if (this._modeChanged) {
      this._modeChanged();
      this._modeChanged = null;
    }
  }

  // ---------------------------------------------------------------------------

  /** Returns a promise that resolves on the next setMode() or stop() call. */
  _waitForModeChange() {
    return new Promise((resolve) => {
      this._modeChanged = resolve;
    });
  }

  async _applyStop() {
    try {
      await this.driver.clear();
      if (typeof this.driver.setPower === "function")
        await this.driver.setPower(false);
    } catch (err) {
      this.logger.warn(
        `[RenderLoop:${this.deviceName}] stop: clear failed: ${err.message}`,
      );
    }
  }

  async _applyPlay() {
    try {
      await this.driver.initialize();
      if (typeof this.driver.setPower === "function") {
        await this.driver.setPower(true);
      }
      if (this.currentScene && typeof this.driver.switchToApp === "function") {
        await this.driver.switchToApp(this.driver.appName || "pixdcon");
      }
    } catch (err) {
      this.logger.warn(
        `[RenderLoop:${this.deviceName}] play: re-init failed: ${err.message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Execute one power-cycle sequence via MQTT plug.
   * Returns true if the cycle completed (regardless of whether device recovered).
   * Returns false if the loop was stopped mid-cycle.
   */
  async _doPowerCycle() {
    const pc = this.powerCyclePlugin;
    this.powerCycleCount++;
    const attempt = `${this.powerCycleCount}/${this.maxPowerCycles}`;

    this.logger.warn(
      `[RenderLoop:${this.deviceName}] Power-cycling device via ${pc.topic} (attempt ${attempt})`,
    );

    if (!this.mqtt) {
      this.logger.error(
        `[RenderLoop:${this.deviceName}] powerCyclePlugin configured but no mqttService — cannot power cycle`,
      );
      return true; // fall through to normal retry
    }

    // OFF
    this.mqtt.publishRaw(pc.topic, pc.offPayload ?? '{"state":"OFF"}');
    this.logger.info(
      `[RenderLoop:${this.deviceName}] Power-cycle: sent OFF → waiting ${pc.offWaitMs ?? 10000}ms`,
    );
    await this._sleep(pc.offWaitMs ?? 10_000);
    if (!this.running) return false;

    // ON
    this.mqtt.publishRaw(pc.topic, pc.onPayload ?? '{"state":"ON"}');
    this.logger.info(
      `[RenderLoop:${this.deviceName}] Power-cycle: sent ON → waiting ${pc.onWaitMs ?? 30000}ms for reboot`,
    );
    await this._sleep(pc.onWaitMs ?? 30_000);
    if (!this.running) return false;

    // Force driver re-init on next push
    if (typeof this.driver.initialized !== "undefined") {
      this.driver.initialized = false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------

  async _runScene(sceneName) {
    // --- Circuit breaker check -------------------------------------------
    if (this.consecutiveErrors >= this.maxErrors) {
      if (this.powerCyclePlugin) {
        // Check if we've exhausted power-cycle attempts
        if (this.powerCycleCount >= this.maxPowerCycles) {
          this.logger.error(
            `[RenderLoop:${this.deviceName}] Device unresponsive after ${this.powerCycleCount} power-cycle(s). Giving up — device left OFF.`,
          );
          if (this.mqtt) this.mqtt.updateDeviceStatus(this.deviceName, "dead");
          this.running = false;
          return;
        }

        const cycleCompleted = await this._doPowerCycle();
        if (!cycleCompleted || !this.running) return;

        // Reset error state so we attempt the next render fresh
        this.consecutiveErrors = 0;
        this.currentBackoff = this.initialBackoff;
      } else {
        // No power-cycle plugin — original sleep-and-retry behaviour
        this.logger.warn(
          `[RenderLoop:${this.deviceName}] Circuit open after ${this.consecutiveErrors} errors. ` +
            `Sleeping ${this.currentBackoff}ms before retry...`,
        );
        await this._sleep(this.currentBackoff);
        // Reset so we attempt again; if it fails the counter climbs again
        this.consecutiveErrors = 0;
        this.currentBackoff = this.initialBackoff;
      }
      return;
    }

    // --- Load scene --------------------------------------------------------
    let scene;
    try {
      scene = await this.sceneLoader.load(sceneName, this.deviceName);
    } catch (loadError) {
      this._handleError(loadError, `loading scene "${sceneName}"`);
      await this._sleep(this.currentBackoff);
      return;
    }

    this.currentScene = sceneName;

    // --- Frame loop --------------------------------------------------------
    let result;
    do {
      if (!this.running) break;

      // --- Mode: stop -------------------------------------------------------
      if (this._mode === "stop") {
        await this._applyStop();
        await this._waitForModeChange();
        if (this._mode === "play") await this._applyPlay();
        break; // restart outer scene loop
      }

      // play→play recovery: re-init device, then restart scene loop
      if (this._reinitRequested) {
        this._reinitRequested = false;
        this.logger.info(
          `[RenderLoop:${this.deviceName}] Re-init requested (play→play recovery)`,
        );
        await this._applyPlay();
        break; // restart outer scene loop with fresh state
      }

      const frameStart = Date.now();

      try {
        result = await scene.render(this.driver);

        // Success path
        this._handleSuccess();

        if (typeof result === "number" && result > 0) {
          const renderTime = Date.now() - frameStart;
          // Enforce: total frame time (render + sleep) >= minFrameMs
          // sleep = max(scene-requested delay, minFrameMs − renderTime)
          // This means a slow render that already consumed minFrameMs won't add more delay.
          const sleepMs =
            this.minFrameMs > 0
              ? Math.max(result, Math.max(0, this.minFrameMs - renderTime))
              : result;
          if (sleepMs > 0) await this._sleep(sleepMs);
        }

        // --- Hot-reload: scene evicted from cache — break inner loop ------
        if (!this.sceneLoader.isLoaded(sceneName)) {
          this.logger.info(
            `[RenderLoop:${this.deviceName}] Scene "${sceneName}" hot-reloaded, restarting...`,
          );
          break;
        }

        // --- Mode: pause — rendered once, now freeze ----------------------
        if (this._mode === "pause") {
          await this._waitForModeChange();
          if (this._mode === "play") await this._applyPlay();
          break; // restart outer scene loop → re-render on play
        }
      } catch (renderError) {
        this._handleError(renderError, `rendering scene "${sceneName}"`);

        // Apply backoff and break the inner frame loop on any render error;
        // the outer while-loop will retry from the circuit-breaker check.
        await this._sleep(this.currentBackoff);
        break;
      }
    } while (this.running && result !== null);
  }

  // ---------------------------------------------------------------------------

  _handleSuccess() {
    if (this.consecutiveErrors > 0) {
      this.logger.info(
        `[RenderLoop:${this.deviceName}] Recovered after ${this.consecutiveErrors} error(s)`,
      );
    }

    // Successful render after a power cycle — reset the cycle counter too
    if (this.powerCycleCount > 0) {
      this.logger.info(
        `[RenderLoop:${this.deviceName}] Device recovered after ${this.powerCycleCount} power-cycle(s) — resetting cycle counter`,
      );
      this.powerCycleCount = 0;
    }

    this.consecutiveErrors = 0;
    this.currentBackoff = this.initialBackoff;
    this.frameCount++;
    this.lastSuccessTime = Date.now();

    // Throttle MQTT state updates: only every 100 frames to avoid flooding
    if (this.mqtt && this.frameCount % 100 === 0) {
      this.mqtt.updateDeviceState(
        this.deviceName,
        this.currentScene,
        this.frameCount,
      );
    }
  }

  _handleError(error, context) {
    this.consecutiveErrors++;
    // Double backoff each time, capped at maxBackoff
    this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoff);

    const level = this.consecutiveErrors >= this.maxErrors ? "error" : "warn";
    this.logger[level](
      `[RenderLoop:${this.deviceName}] Error ${context}: ${error.message}. ` +
        `Consecutive: ${this.consecutiveErrors}/${this.maxErrors}, next wait: ${this.currentBackoff}ms`,
    );

    if (this.mqtt) {
      this.mqtt.recordError(error);
      if (this.consecutiveErrors >= this.maxErrors) {
        this.mqtt.updateDeviceStatus(this.deviceName, "failed");
      } else {
        this.mqtt.updateDeviceStatus(this.deviceName, "degraded");
      }
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Interruptible sleep — resolves early if setMode() or stop() is called.
   * This ensures mode changes (especially stop) take effect promptly even
   * during long backoff sleeps.
   */
  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._sleepWake = null;
        resolve();
      }, ms);
      this._sleepWake = () => {
        clearTimeout(timer);
        this._sleepWake = null;
        resolve();
      };
    });
  }

  /** For external status inspection (e.g. debugging). */
  getStatus() {
    return {
      running: this.running,
      mode: this._mode,
      currentScene: this.currentScene,
      frameCount: this.frameCount,
      consecutiveErrors: this.consecutiveErrors,
      currentBackoff: this.currentBackoff,
      lastSuccessTime: this.lastSuccessTime,
      powerCycleCount: this.powerCycleCount,
    };
  }
}

export default RenderLoop;
