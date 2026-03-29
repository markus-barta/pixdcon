/**
 * Scene loader
 *
 * Resolves scene names → file paths using the scenes map from config.json,
 * then dynamically imports the module.
 *
 * Path resolution:
 *   - Scene paths in config are relative to the config file's directory.
 *   - Example: config at /data/config.json + path ./scenes/clock.js
 *             → /data/scenes/clock.js
 *
 * This means the same config works locally (./config.json) and in Docker
 * (/data/config.json) without any code changes.
 */

import { resolve, dirname, basename } from "path";
import { normalizeSceneSchema } from "./scene-settings-service.js";

export async function loadSceneMetadata(baseDir, scenesMap, options = {}) {
  const logger = options.logger || console;
  const metadata = {};
  const token = Date.now();

  for (const [sceneKey, sceneConfig] of Object.entries(scenesMap || {})) {
    const path = sceneConfig?.path || "";

    metadata[sceneKey] = {
      key: sceneKey,
      path,
      name: sceneKey,
      pretty_name: sceneKey,
      description: "",
      deviceType: null,
      settingsSchema: {},
    };

    if (!path) continue;

    try {
      const absolutePath = resolve(baseDir, path);
      const mod = await import(`${absolutePath}?meta=${token}-${sceneKey}`);
      const scene = mod.default || mod;

      metadata[sceneKey] = {
        key: sceneKey,
        path,
        name: scene.name || sceneKey,
        pretty_name: scene.pretty_name || scene.name || sceneKey,
        description: scene.description || "",
        deviceType: scene.deviceType || null,
        settingsSchema: normalizeSceneSchema(scene.settingsSchema || {}),
      };
    } catch (error) {
      logger.warn(
        `[SceneLoader] Failed to read metadata for scene "${sceneKey}": ${error.message}`,
      );
    }
  }

  return metadata;
}

export class SceneLoader {
  /**
   * @param {string} baseDir           - Absolute path to config file's directory
   * @param {Object} scenesMap         - scenes section from config.json (name → {path, ...})
   * @param {Object} options
   * @param {Object} options.logger
   * @param {Object} options.mqttService  - MqttService instance for scene context
   * @param {Object} options.sceneSettingsService - SceneSettingsService for scene context
   * @param {string} options.deviceName   - Device name (e.g. "ulanzi-56"), used in MQTT topic paths
   */
  constructor(baseDir, scenesMap, options = {}) {
    this.baseDir = baseDir;
    this.scenesMap = scenesMap || {};
    this.logger = options.logger || console;
    this.mqtt = options.mqttService || null;
    this.sceneSettingsService = options.sceneSettingsService || null;
    this.cache = new Map(); // `${sceneName}::${deviceName}` → { scene, deviceName }
    this._reloadTokens = new Map(); // sceneName → timestamp (triggers cache-bust on next load)
  }

  /**
   * Load a scene by name.
   * The name must be a key in the scenes map from config.json.
   *
   * @param {string} sceneName  - Scene name (e.g. "clock_with_homestats")
   * @param {string} deviceName - Device loading the scene (e.g. "ulanzi-56")
   * @returns {Promise<Object>} Scene module with a render() function
   */
  async load(sceneName, deviceName = "unknown") {
    const cacheKey = `${sceneName}::${deviceName}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey).scene;
    }

    const sceneConfig = this.scenesMap[sceneName];
    if (!sceneConfig) {
      throw new Error(
        `Scene "${sceneName}" not found in config. Available: ${Object.keys(this.scenesMap).join(", ")}`,
      );
    }

    if (!sceneConfig.path) {
      throw new Error(
        `Scene "${sceneName}" config is missing required "path" field`,
      );
    }

    // Resolve relative to config dir so /data/scenes/clock.js works in Docker
    const absolutePath = resolve(this.baseDir, sceneConfig.path);

    this.logger.debug(
      `[SceneLoader] Loading "${sceneName}" from ${absolutePath}`,
    );

    try {
      // Cache-bust with a timestamp token when the scene was explicitly cleared
      // (e.g. hot-reload). Node.js ESM caches by URL, so ?t=<n> forces a fresh load.
      const token = this._reloadTokens.get(sceneName);
      this._reloadTokens.delete(sceneName);
      const importPath = token ? `${absolutePath}?t=${token}` : absolutePath;

      // Dynamic import requires a file:// URL on some platforms
      const mod = await import(importPath);
      // Object.create gives each device its own property space (e.g. _settings,
      // _state) while sharing methods from the prototype scene object.
      const scene = Object.create(mod.default || mod);

      if (!scene.render || typeof scene.render !== "function") {
        throw new Error(
          `Scene "${sceneName}" (${absolutePath}) is missing a render() function`,
        );
      }

      this.cache.set(cacheKey, { scene, deviceName });
      this.logger.info(
        `[SceneLoader] Loaded scene "${sceneName}" for device "${deviceName}"`,
      );

      // Call optional lifecycle hook so scene can subscribe to MQTT etc.
      if (typeof scene.init === "function") {
        const ctx = this._buildContext(sceneName, deviceName);
        await scene.init(ctx);
        this.logger.debug(`[SceneLoader] init() called for "${sceneName}"`);
      }

      return scene;
    } catch (error) {
      this.logger.error(
        `[SceneLoader] Failed to load scene "${sceneName}"`,
        error,
      );
      throw error;
    }
  }

  /**
   * Clear the module cache (call on config reload so scenes re-import from disk).
   * Calls destroy() on any cached scene that implements it so subscriptions are cleaned up.
   */
  async clearCache() {
    for (const [cacheKey, { scene, deviceName }] of this.cache) {
      const [sceneName] = cacheKey.split("::");
      if (typeof scene.destroy === "function") {
        try {
          const ctx = this._buildContext(sceneName, deviceName);
          await scene.destroy(ctx);
          this.logger.debug(
            `[SceneLoader] destroy() called for "${sceneName}"`,
          );
        } catch (err) {
          this.logger.error(
            `[SceneLoader] destroy() failed for "${sceneName}"`,
            err,
          );
        }
      }
    }
    this.cache.clear();
    this.logger.debug("[SceneLoader] Cache cleared");
  }

  /**
   * Evict a single scene from cache so the next load() re-imports from disk.
   * Calls destroy() on the scene if implemented, then marks it for cache-busting.
   * The render loop detects the eviction via isLoaded() and re-loads naturally.
   *
   * @param {string} sceneName
   */
  async clearScene(sceneName) {
    const entries = [...this.cache.entries()].filter(([cacheKey]) =>
      cacheKey.startsWith(`${sceneName}::`),
    );
    if (entries.length === 0) return;

    for (const [cacheKey, { scene, deviceName }] of entries) {
      if (typeof scene.destroy === "function") {
        try {
          const ctx = this._buildContext(sceneName, deviceName);
          await scene.destroy(ctx);
        } catch (err) {
          this.logger.error(
            `[SceneLoader] destroy() failed for "${sceneName}" during hot-reload`,
            err,
          );
        }
      }

      this.cache.delete(cacheKey);
    }
    this._reloadTokens.set(sceneName, Date.now());
    this.logger.info(
      `[SceneLoader] Scene "${sceneName}" evicted for hot-reload`,
    );
  }

  /** Returns true if the scene is currently loaded in cache. */
  isLoaded(sceneName) {
    return [...this.cache.keys()].some((cacheKey) =>
      cacheKey.startsWith(`${sceneName}::`),
    );
  }

  /**
   * Returns the unique set of directories containing scene files.
   * Used by ScenesWatcher to know what to watch.
   */
  getSceneDirs() {
    const dirs = new Set();
    for (const config of Object.values(this.scenesMap)) {
      dirs.add(dirname(resolve(this.baseDir, config.path)));
    }
    return [...dirs];
  }

  /**
   * Find scene names whose file matches the given filename (basename only).
   * @param {string} filename - e.g. "home.js"
   * @returns {string[]} matching scene names
   */
  findScenesByFilename(filename) {
    const results = [];
    for (const [name, config] of Object.entries(this.scenesMap)) {
      if (basename(resolve(this.baseDir, config.path)) === filename) {
        results.push(name);
      }
    }
    return results;
  }

  /**
   * Build a context object passed to scene lifecycle hooks.
   *
   * Context shape:
   *   context.logger         - logger instance
   *   context.deviceName     - e.g. "ulanzi-56"
   *   context.sceneName      - e.g. "clock_with_homestats"
   *   context.settingsTopic  - "pixdcon/ulanzi-56/clock_with_homestats/settings"
   *   context.mqtt.subscribe(topic, cb)   - subscribe to raw MQTT topic
   *   context.mqtt.unsubscribeAll()       - unsubscribe all topics for this scene
   *
   * @param {string} sceneName
   * @returns {Object} context
   */
  _buildContext(sceneName, deviceName) {
    const settingsTopic = `pixdcon/${deviceName}/${sceneName}/settings`;

    return {
      logger: this.logger,
      deviceName,
      sceneName,
      settingsTopic,
      settings: this.sceneSettingsService
        ? this.sceneSettingsService.createRuntimeContext(deviceName, sceneName)
        : {
            schema: {},
            values: {},
            get: () => undefined,
            all: () => ({}),
            subscribe: () => () => {},
          },
      mqtt: this.mqtt
        ? this.mqtt.getSceneContext(sceneName, deviceName)
        : {
            deviceName,
            subscribe: () =>
              this.logger.warn(
                `[SceneLoader] MQTT not available for scene "${sceneName}"`,
              ),
            unsubscribeAll: () => {},
          },
    };
  }
}

export default SceneLoader;
