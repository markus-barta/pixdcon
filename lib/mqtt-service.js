/**
 * MQTT Service for pidicon-light
 * Handles health, state, and config publishing
 */

import mqtt from "mqtt";

export class MqttService {
  constructor(options = {}) {
    this.host = options.host || "localhost";
    this.port = options.port || 1883;
    this.user = options.user || "smarthome";
    this.pass = options.pass;
    this.baseTopic = options.baseTopic || "home/hsb1/pidicon-light";
    this.logger = options.logger || console;

    this.client = null;
    this.connected = false;
    this.publishInterval = null;

    // State tracking
    this.state = {
      running: false,
      currentScene: null,
      startTime: null,
      devices: [],
    };

    this.health = {
      status: "unknown",
      errorCount: 0,
      lastError: null,
      devices: [],
    };
  }

  async connect() {
    const url = `mqtt://${this.host}:${this.port}`;
    this.logger.info(`[MQTT] Connecting to ${url}...`);

    this.client = mqtt.connect(url, {
      clientId: `pidicon-light-${Date.now()}`,
      username: this.user,
      password: this.pass,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    // Each scene subscription adds one 'message' listener.
    // Raise limit well above the max expected subscription count.
    this.client.setMaxListeners(50);

    // Persistent lifecycle handlers (survive reconnects)
    this.client.on("connect", () => {
      this.connected = true;
      this.logger.info("[MQTT] Connected");
      this.publishHealth();
    });

    this.client.on("error", (error) => {
      this.connected = false;
      this.logger.error(`[MQTT] Error: ${error.message}`);
    });

    this.client.on("offline", () => {
      this.connected = false;
      this.logger.warn("[MQTT] Offline — will reconnect automatically");
    });

    this.client.on("reconnect", () => {
      this.logger.info("[MQTT] Reconnecting...");
    });

    // Wait only for the *initial* connection attempt
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.client.removeListener("connect", onConnect);
        this.client.removeListener("error", onError);
      };

      this.client.once("connect", onConnect);
      this.client.once("error", onError);
    });
  }

  async disconnect() {
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
    }

    if (this.client) {
      return new Promise((resolve) => {
        this.client.end(() => {
          this.connected = false;
          this.logger.info("[MQTT] Disconnected");
          resolve();
        });
      });
    }
  }

  /**
   * Publish to an exact topic (no baseTopic prefix).
   * Used for external integrations like z2m plug control.
   */
  publishRaw(topic, message, retain = false) {
    if (!this.connected || !this.client) {
      this.logger.warn(`[MQTT] publishRaw: not connected, dropping "${topic}"`);
      return false;
    }
    try {
      const payload =
        typeof message === "object" ? JSON.stringify(message) : String(message);
      this.client.publish(topic, payload, { retain }, (err) => {
        if (err) this.logger.error(`[MQTT] publishRaw failed: ${err.message}`);
      });
      return true;
    } catch (error) {
      this.logger.error(`[MQTT] publishRaw error: ${error.message}`);
      return false;
    }
  }

  publish(topic, message, retain = false) {
    if (!this.connected || !this.client) {
      return false;
    }

    try {
      const fullTopic = `${this.baseTopic}/${topic}`;
      const payload =
        typeof message === "object" ? JSON.stringify(message) : message;

      this.client.publish(fullTopic, payload, { retain }, (err) => {
        if (err) {
          this.logger.error(`[MQTT] Publish failed: ${err.message}`);
        }
      });

      return true;
    } catch (error) {
      this.logger.error(`[MQTT] Publish error: ${error.message}`);
      return false;
    }
  }

  publishHealth() {
    const health = {
      status: this.health.status,
      timestamp: new Date().toISOString(),
      devices: this.health.devices,
      errorCount: this.health.errorCount,
      lastError: this.health.lastError,
    };

    return this.publish("health", health, true);
  }

  publishState() {
    const state = {
      running: this.state.running,
      currentScene: this.state.currentScene,
      uptime: this.state.startTime
        ? Math.floor((Date.now() - this.state.startTime) / 1000)
        : 0,
      devices: this.state.devices,
    };

    return this.publish("state", state, true);
  }

  publishConfig(config) {
    const configInfo = {
      configPath: config.configPath || "unknown",
      deviceCount: config.devices?.length || 0,
      sceneCount: Object.keys(config.scenes || {}).length,
      timestamp: new Date().toISOString(),
    };

    this.publish("config", configInfo, true);
    this.publish("config/effective", config, true);
  }

  setRunning(running) {
    this.state.running = running;
    if (running && !this.state.startTime) {
      this.state.startTime = Date.now();
    }
    this.publishState();
  }

  setCurrentScene(sceneName) {
    this.state.currentScene = sceneName;
    this.publishState();
  }

  updateDeviceStatus(deviceName, status, lastSeen = null) {
    const existing = this.health.devices.findIndex(
      (d) => d.name === deviceName,
    );
    const deviceInfo = {
      name: deviceName,
      status,
      lastSeen: lastSeen || new Date().toISOString(),
    };

    if (existing >= 0) {
      this.health.devices[existing] = deviceInfo;
    } else {
      this.health.devices.push(deviceInfo);
    }

    this.publishHealth();
  }

  updateDeviceState(deviceName, scene, frameCount) {
    const existing = this.state.devices.findIndex((d) => d.name === deviceName);
    const deviceInfo = {
      name: deviceName,
      scene,
      frameCount,
    };

    if (existing >= 0) {
      this.state.devices[existing] = deviceInfo;
    } else {
      this.state.devices.push(deviceInfo);
    }

    this.publishState();
  }

  recordError(error) {
    this.health.errorCount++;
    this.health.lastError = {
      message: error.message,
      timestamp: new Date().toISOString(),
    };

    // Update status based on error count
    if (this.health.errorCount >= 10) {
      this.health.status = "failed";
    } else if (this.health.errorCount > 0) {
      this.health.status = "degraded";
    } else {
      this.health.status = "ok";
    }

    this.publishHealth();
  }

  /**
   * Explicitly set the overall health status string.
   * @param {'ok'|'degraded'|'failed'|'unknown'} status
   */
  updateStatus(status) {
    this.health.status = status;
    this.publishHealth();
  }

  resetHealth() {
    this.health.errorCount = 0;
    this.health.lastError = null;
    this.health.status = "ok";
    this.publishHealth();
  }

  // ---------------------------------------------------------------------------
  // Scene subscription support
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to a raw MQTT topic on behalf of a scene.
   * All subscriptions are namespaced by sceneName so they can be bulk-removed.
   *
   * @param {string} sceneName  - Scene that owns this subscription (for cleanup)
   * @param {string} topic      - Full MQTT topic to subscribe to
   * @param {Function} callback - (payload: string) => void
   */
  subscribe(sceneName, topic, callback) {
    if (!this.client || !this.connected) {
      this.logger.warn(`[MQTT] Cannot subscribe to "${topic}" — not connected`);
      return;
    }

    if (!this._subscriptions) this._subscriptions = new Map();
    if (!this._subscriptions.has(sceneName)) {
      this._subscriptions.set(sceneName, new Map());
    }
    if (!this._topicEntries) this._topicEntries = new Map();

    const existingSceneHandler = this._subscriptions.get(sceneName)?.get(topic);
    if (existingSceneHandler) {
      const topicEntry = this._topicEntries.get(topic);
      topicEntry?.callbacks.delete(sceneName);
      this._subscriptions.get(sceneName).delete(topic);
    }

    let topicEntry = this._topicEntries.get(topic);
    const firstLogicalOwner = !topicEntry;
    if (!topicEntry) {
      const callbacks = new Map();
      const sharedHandler = (_topic, message) => {
        if (_topic !== topic) return;
        const payload = message.toString();
        for (const [owner, ownerCallback] of callbacks) {
          try {
            ownerCallback(payload);
          } catch (err) {
            this.logger.error(
              `[MQTT] Scene "${owner}" callback error on "${topic}"`,
              err,
            );
          }
        }
      };
      topicEntry = { callbacks, sharedHandler };
      this._topicEntries.set(topic, topicEntry);
      this.client.on("message", sharedHandler);
    }

    topicEntry.callbacks.set(sceneName, callback);
    this._subscriptions.get(sceneName).set(topic, callback);

    const deliverRetainedAgain = !firstLogicalOwner;
    const subscribeOpts = deliverRetainedAgain ? { qos: 1, rh: 0 } : { qos: 1 };

    this.client.subscribe(topic, subscribeOpts, (err) => {
      if (err) {
        this.logger.error(
          `[MQTT] Subscribe to "${topic}" failed: ${err.message}`,
        );
        topicEntry.callbacks.delete(sceneName);
        this._subscriptions.get(sceneName).delete(topic);
        if (topicEntry.callbacks.size === 0) {
          this.client.removeListener("message", topicEntry.sharedHandler);
          this._topicEntries.delete(topic);
        }
      } else {
        this.logger.info(
          `[MQTT] Scene "${sceneName}" subscribed to "${topic}"${deliverRetainedAgain ? " (forced retained replay)" : ""}`,
        );
      }
    });
  }

  /**
   * Unsubscribe all topics registered by a scene.
   * Call this from scene.destroy() to avoid memory leaks on config reload.
   *
   * @param {string} sceneName
   */
  unsubscribeAll(sceneName) {
    if (!this._subscriptions || !this._subscriptions.has(sceneName)) return;

    const topics = this._subscriptions.get(sceneName);
    for (const [topic] of topics) {
      if (this.client) {
        const topicEntry = this._topicEntries?.get(topic);
        if (topicEntry) {
          topicEntry.callbacks.delete(sceneName);
          if (topicEntry.callbacks.size === 0) {
            this.client.unsubscribe(topic);
            this.client.removeListener("message", topicEntry.sharedHandler);
            this._topicEntries.delete(topic);
          }
        }
      }
      this.logger.info(
        `[MQTT] Scene "${sceneName}" unsubscribed from "${topic}"`,
      );
    }

    this._subscriptions.delete(sceneName);
  }

  /**
   * Subscribe to a topic on behalf of a device (e.g. mode control).
   * Namespaced as `_device_{deviceName}` so it can be bulk-removed.
   *
   * @param {string}   deviceName
   * @param {string}   topic
   * @param {Function} callback   - (payload: string) => void
   */
  subscribeDevice(deviceName, topic, callback) {
    this.subscribe(`_device_${deviceName}`, topic, callback);
  }

  /**
   * Unsubscribe all topics registered for a device.
   * Call when tearing down a device (hot-reload, shutdown).
   *
   * @param {string} deviceName
   */
  unsubscribeDevice(deviceName) {
    this.unsubscribeAll(`_device_${deviceName}`);
  }

  /**
   * Match an MQTT topic pattern (with `+` / `#` wildcards) against a concrete topic.
   * @param {string} pattern - e.g. "home/hsb1/pidicon-light/overlay/device/+/scenes"
   * @param {string} topic   - concrete topic from broker
   * @returns {boolean}
   */
  _topicMatches(pattern, topic) {
    const pp = pattern.split("/");
    const tp = topic.split("/");
    let i = 0;
    for (; i < pp.length; i++) {
      const seg = pp[i];
      if (seg === "#") return true;
      if (i >= tp.length) return false;
      if (seg !== "+" && seg !== tp[i]) return false;
    }
    return i === tp.length;
  }

  /**
   * Subscribe to a wildcard MQTT topic pattern on behalf of a namespace.
   * Unlike subscribe(), the callback receives (fullTopic, payloadString) and
   * no exact-match filter is applied — broker-level + client-level pattern
   * matching handles routing.
   *
   * @param {string}   namespace    - Logical owner (for cleanup via unsubscribeAll)
   * @param {string}   topicPattern - MQTT topic pattern, may contain `+`
   * @param {Function} callback     - (topic: string, payload: string) => void
   */
  subscribeWildcard(namespace, topicPattern, callback) {
    if (!this.client || !this.connected) {
      this.logger.warn(
        `[MQTT] Cannot subscribe to "${topicPattern}" — not connected`,
      );
      return;
    }

    if (!this._subscriptions) this._subscriptions = new Map();
    if (!this._subscriptions.has(namespace))
      this._subscriptions.set(namespace, new Map());

    if (!this._wildcardEntries) this._wildcardEntries = new Map();

    const existingSceneHandler = this._subscriptions
      .get(namespace)
      ?.get(topicPattern);
    if (existingSceneHandler) {
      const wildcardEntry = this._wildcardEntries.get(topicPattern);
      wildcardEntry?.callbacks.delete(namespace);
      this._subscriptions.get(namespace).delete(topicPattern);
    }

    let wildcardEntry = this._wildcardEntries.get(topicPattern);
    const firstLogicalOwner = !wildcardEntry;
    if (!wildcardEntry) {
      const callbacks = new Map();
      const sharedHandler = (topic, message) => {
        if (!this._topicMatches(topicPattern, topic)) return;
        const payload = message.toString();
        for (const [owner, ownerCallback] of callbacks) {
          try {
            ownerCallback(topic, payload);
          } catch (err) {
            this.logger.error(`[MQTT] "${owner}" error on "${topic}"`, err);
          }
        }
      };
      wildcardEntry = { callbacks, sharedHandler };
      this._wildcardEntries.set(topicPattern, wildcardEntry);
      this.client.on("message", sharedHandler);
    }

    wildcardEntry.callbacks.set(namespace, callback);
    this._subscriptions.get(namespace).set(topicPattern, callback);

    const deliverRetainedAgain = !firstLogicalOwner;
    const subscribeOpts = deliverRetainedAgain ? { qos: 1, rh: 0 } : { qos: 1 };

    this.client.subscribe(topicPattern, subscribeOpts, (err) => {
      if (err) {
        this.logger.error(
          `[MQTT] Subscribe to "${topicPattern}" failed: ${err.message}`,
        );
        wildcardEntry.callbacks.delete(namespace);
        this._subscriptions.get(namespace).delete(topicPattern);
        if (wildcardEntry.callbacks.size === 0) {
          this.client.removeListener("message", wildcardEntry.sharedHandler);
          this._wildcardEntries.delete(topicPattern);
        }
      } else {
        this.logger.info(
          `[MQTT] "${namespace}" subscribed to "${topicPattern}"${deliverRetainedAgain ? " (forced retained replay)" : ""}`,
        );
      }
    });
  }

  /**
   * Unsubscribe all wildcard topics registered under a namespace.
   * @param {string} namespace
   */
  unsubscribeWildcard(namespace) {
    this.unsubscribeAll(namespace);
  }

  /**
   * Returns a context.mqtt object scoped to a scene — passed into scene.init/destroy.
   * @param {string} sceneName
   */
  getSceneContext(sceneName, deviceName = null) {
    return {
      deviceName,
      subscribe: (topic, cb) => this.subscribe(sceneName, topic, cb),
      subscribeWildcard: (topicPattern, cb) =>
        this.subscribeWildcard(sceneName, topicPattern, (fullTopic, payload) =>
          cb(payload, fullTopic),
        ),
      unsubscribeAll: () => this.unsubscribeAll(sceneName),
    };
  }

  startPeriodicPublish(intervalMs = 30000) {
    // Clear any existing interval first
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
      this.publishInterval = null;
    }

    this.publishInterval = setInterval(() => {
      this.publishHealth();
      this.publishState();
    }, intervalMs);

    this.logger.info(`[MQTT] Starting periodic publish every ${intervalMs}ms`);
  }
}

export default MqttService;
