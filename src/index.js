/**
 * pixdcon - Main entry point
 * Config-file driven pixel display controller with MQTT monitoring
 */

import { ConfigLoader } from "../lib/config-loader.js";
import { SceneLoader, loadSceneMetadata } from "../lib/scene-loader.js";
import { RenderLoop } from "./render-loop.js";
import { UlanziDriver } from "../lib/ulanzi-driver.js";
import { PixooDriver } from "../lib/pixoo-driver.js";
import { MqttService } from "../lib/mqtt-service.js";
import { ConfigWatcher } from "../lib/config-watcher.js";
import { ConfigOverlay } from "../lib/config-overlay.js";
import { ScenesWatcher } from "../lib/scenes-watcher.js";
import { WebServer } from "../lib/web-server.js";
import { FramePreviewStore } from "../lib/frame-preview-store.js";
import { SceneSettingsService } from "../lib/scene-settings-service.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Logger ---------------------------------------------------------------

function createLogger() {
  const levelNames = { error: 0, warn: 1, info: 2, debug: 3 };
  const levelNum =
    levelNames[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 2;
  const ts = () => new Date().toISOString();

  return {
    error: (msg, err) => {
      const detail =
        err instanceof Error
          ? ` — ${err.stack || err.message}`
          : err
            ? ` — ${err}`
            : "";
      console.error(`${ts()} ERROR ${msg}${detail}`);
    },
    warn: (msg) => levelNum >= 1 && console.warn(`${ts()}  WARN ${msg}`),
    info: (msg) => levelNum >= 2 && console.info(`${ts()}  INFO ${msg}`),
    debug: (msg) => levelNum >= 3 && console.log(`${ts()} DEBUG ${msg}`),
  };
}

const logger = createLogger();

// --- Global state ----------------------------------------------------------
// Kept at module level so signal handlers and reloadConfig() share state.

let mqttService = null;
let configWatcher = null;
let scenesWatcher = null;
let renderLoops = []; // Array of { device, loop }
let sceneLoader = null;
let configPath = null; // Set once in main(), used in reloadConfig()
let configOverlay = null; // MQTT overlay layer (optional, null when MQTT unavailable)
let baseConfig = null; // Raw file config; overlay merges on top of this
let effectiveConfig = null; // Last computed merged config (served by WebServer)
let webServer = null;
let framePreviewStore = null;
let sceneMetadata = {};
let sceneSettingsService = null;

// ---------------------------------------------------------------------------

async function initializeMqtt() {
  const mqttConfig = {
    host: process.env.MOSQUITTO_HOST || "localhost",
    port: parseInt(process.env.MQTT_PORT || "1883", 10),
    user: process.env.MOSQUITTO_USER || "smarthome",
    pass: process.env.MOSQUITTO_PASS,
    baseTopic: "home/hsb1/pixdcon",
    logger,
  };

  if (!mqttConfig.pass) {
    logger.warn(
      "[MQTT] MOSQUITTO_PASS not set — MQTT disabled (display still works).",
    );
    return null;
  }

  const svc = new MqttService(mqttConfig);

  try {
    await svc.connect();
    svc.startPeriodicPublish(30000);
    return svc;
  } catch (error) {
    // MQTT failure is non-fatal — display still works without it
    logger.error(`[MQTT] Connection failed, continuing without MQTT`, error);
    return null;
  }
}

function startScenesWatcher() {
  const configDir = dirname(configPath);
  const dirs = sceneLoader.getSceneDirs();
  scenesWatcher = new ScenesWatcher(
    dirs,
    async (filename) => {
      const names = sceneLoader.findScenesByFilename(filename);
      if (names.length === 0) {
        logger.debug(
          `[pixdcon] Scene file "${filename}" changed but no matching scene found`,
        );
        return;
      }
      sceneMetadata = await loadSceneMetadata(
        configDir,
        effectiveConfig.scenes,
        {
          logger,
        },
      );
      for (const name of names) {
        await sceneLoader.clearScene(name);
      }
    },
    { logger },
  );
  scenesWatcher.start();
}

/**
 * Create driver + render loop for a single device, start the loop.
 * Returns the loop instance, or null if the device cannot be started.
 */
async function startDevice(device) {
  logger.info(
    `[pixdcon] Starting device: ${device.name} (${device.type} @ ${device.ip})`,
  );

  let driver;
  if (device.type === "ulanzi") {
    driver = new UlanziDriver(device.ip, {
      appName: `pixdcon_${device.name}`,
      logger,
    });
  } else if (device.type === "pixoo") {
    driver = new PixooDriver(device.ip, {
      logger,
      deviceName: device.name,
      previewStore: framePreviewStore,
    });
  } else {
    logger.warn(
      `[pixdcon] Unknown device type "${device.type}" — skipping ${device.name}`,
    );
    return null;
  }

  const initialized = await driver.initialize();
  if (!initialized) {
    logger.warn(
      `[pixdcon] Device ${device.name} not reachable — will retry via render loop backoff`,
    );
    if (mqttService) mqttService.updateDeviceStatus(device.name, "unreachable");
    // Don't bail out — the render loop will keep retrying with backoff
  } else {
    if (mqttService) mqttService.updateDeviceStatus(device.name, "ok");
  }

  const loop = new RenderLoop(driver, sceneLoader, device.scene, {
    logger,
    deviceName: device.name,
    mqttService,
    minFrameMs: typeof device.minFrameMs === "number" ? device.minFrameMs : 500,
    powerCyclePlugin: device.powerCyclePlugin || null,
    maxPowerCycles:
      typeof device.maxPowerCycles === "number" ? device.maxPowerCycles : 10,
    brightnessMax: device.type === "ulanzi" ? 255 : 100,
  });

  renderLoops.push({ device, loop });
  if (framePreviewStore) framePreviewStore.registerDevice(device, driver);

  // Subscribe to per-device mode control topic (retained — survives restarts)
  if (mqttService) {
    const modeTopic = `${mqttService.baseTopic}/${device.name}/mode`;
    mqttService.subscribeDevice(device.name, modeTopic, (msg) => {
      const mode = msg.trim().toLowerCase();
      if (["play", "pause", "stop"].includes(mode)) {
        loop.setMode(mode);
      }
    });

    // Per-device brightness override (retained)
    // Payload: JSON {"enabled":true,"value":50} (0-100%) or empty string to clear
    const briTopic = `${mqttService.baseTopic}/${device.name}/brightness_override`;
    mqttService.subscribeDevice(device.name, briTopic, (msg) => {
      const trimmed = msg.trim();
      if (!trimmed) {
        loop.setBrightnessOverride(null);
        return;
      }
      try {
        const data = JSON.parse(trimmed);
        if (data.enabled && typeof data.value === "number") {
          const native =
            device.type === "ulanzi"
              ? Math.round((data.value * 255) / 100)
              : Math.round(data.value);
          loop.setBrightnessOverride(native);
        } else {
          loop.setBrightnessOverride(null);
        }
      } catch {
        loop.setBrightnessOverride(null);
      }
    });
  }

  // start() runs forever; errors are caught inside the loop with backoff.
  // The only way it ever rejects is a truly unexpected throw — log and update MQTT.
  loop.start().catch((err) => {
    logger.error(
      `[pixdcon] Render loop for ${device.name} exited unexpectedly`,
      err,
    );
    if (mqttService) {
      mqttService.recordError(err);
      mqttService.updateDeviceStatus(device.name, "failed");
    }
  });

  return loop;
}

async function stopAllDevices() {
  logger.info(`[pixdcon] Stopping ${renderLoops.length} device(s)...`);
  for (const { loop, device } of renderLoops) {
    loop.stop();
    if (framePreviewStore) framePreviewStore.unregisterDevice(device.name);
    if (mqttService) {
      mqttService.unsubscribeDevice(device.name);
      mqttService.updateDeviceStatus(device.name, "offline");
    }
  }
  renderLoops = [];
}

/**
 * Called by ConfigOverlay when any overlay topic changes (debounced).
 * Re-merges overlay with current baseConfig and restarts devices.
 */
async function applyOverlayReload() {
  logger.info("[pixdcon] Overlay changed, applying effective config...");
  try {
    effectiveConfig = configOverlay.merge(baseConfig);

    if (scenesWatcher) {
      scenesWatcher.stop();
      scenesWatcher = null;
    }
    await stopAllDevices();
    await sceneLoader.clearCache();

    const configDir = dirname(configPath);
    sceneMetadata = await loadSceneMetadata(configDir, effectiveConfig.scenes, {
      logger,
    });
    sceneLoader = new SceneLoader(configDir, effectiveConfig.scenes, {
      logger,
      mqttService,
      sceneSettingsService,
    });
    startScenesWatcher();

    for (const device of effectiveConfig.devices) {
      await startDevice(device);
    }

    if (mqttService) mqttService.publishConfig(effectiveConfig);

    logger.info("[pixdcon] Overlay reload complete");
  } catch (err) {
    logger.error(
      "[pixdcon] Overlay reload failed — keeping previous state",
      err,
    );
  }
}

/**
 * Hot-reload handler — called by ConfigWatcher with the raw file content.
 * Re-parses and validates before applying; errors leave the old config running.
 */
async function reloadConfig(newConfigContent) {
  logger.info("[pixdcon] Config change detected, reloading...");
  try {
    // Validate before touching anything running
    const loader = new ConfigLoader(configPath);
    baseConfig = loader.parse(newConfigContent); // update base for future merges

    effectiveConfig = configOverlay
      ? configOverlay.merge(baseConfig)
      : baseConfig;

    if (scenesWatcher) {
      scenesWatcher.stop();
      scenesWatcher = null;
    }
    await stopAllDevices();
    await sceneLoader.clearCache(); // destroy() hooks + re-import from disk

    // Re-create SceneLoader with effective config's scenes map
    const configDir = dirname(configPath);
    sceneMetadata = await loadSceneMetadata(configDir, effectiveConfig.scenes, {
      logger,
    });
    sceneLoader = new SceneLoader(configDir, effectiveConfig.scenes, {
      logger,
      mqttService,
      sceneSettingsService,
    });
    startScenesWatcher();

    for (const device of effectiveConfig.devices) {
      await startDevice(device);
    }

    if (mqttService) mqttService.publishConfig(effectiveConfig);

    logger.info("[pixdcon] Config reloaded successfully");
  } catch (error) {
    logger.error(
      "[pixdcon] Config reload failed — keeping previous state",
      error,
    );
  }
}

async function shutdown(signal) {
  logger.info(
    `[pixdcon] Received ${signal}, shutting down gracefully...`,
  );

  if (configWatcher) await configWatcher.stop();
  if (scenesWatcher) scenesWatcher.stop();
  if (configOverlay) configOverlay.unsubscribe();
  if (sceneSettingsService) sceneSettingsService.stop();
  if (webServer) webServer.stop();

  await stopAllDevices();

  if (mqttService) {
    mqttService.setRunning(false);
    await mqttService.disconnect();
  }

  process.exit(0);
}

async function main() {
  logger.info("[pixdcon] Starting...");

  // Resolve config path once; shared with reloadConfig() via module scope
  configPath =
    process.env.PIXDCON_CONFIG_PATH || join(__dirname, "../config.json");

  const configLoader = new ConfigLoader(configPath);
  baseConfig = await configLoader.load();
  logger.info(
    `[pixdcon] Loaded config: ${baseConfig.devices.length} device(s), ${Object.keys(baseConfig.scenes).length} scene(s)`,
  );

  // MQTT — optional; failures are non-fatal
  mqttService = await initializeMqtt();
  if (mqttService) {
    mqttService.publishConfig(baseConfig);
    mqttService.setRunning(true);
    mqttService.updateStatus("ok");
  }

  // Bootstrap overlay — subscribe and wait for retained burst before starting devices.
  // This ensures retained overlay topics are applied before the first render.
  if (mqttService) {
    configOverlay = new ConfigOverlay(
      mqttService,
      mqttService.baseTopic,
      applyOverlayReload,
      { logger },
    );
    await configOverlay.subscribe(); // 200ms settle, clears debounce
  }

  effectiveConfig = configOverlay
    ? configOverlay.merge(baseConfig)
    : baseConfig;

  framePreviewStore = new FramePreviewStore({ logger });
  sceneSettingsService = new SceneSettingsService({
    getConfig: () => effectiveConfig,
    getSceneMetadata: () => sceneMetadata,
    mqttService,
    logger,
  });
  await sceneSettingsService.start();

  if (mqttService) mqttService.publishConfig(effectiveConfig); // publish merged result

  // SceneLoader resolves paths relative to config file's directory
  // so ./scenes/clock.js works both locally and in /data volume
  const configDir = dirname(configPath);
  sceneMetadata = await loadSceneMetadata(configDir, effectiveConfig.scenes, {
    logger,
  });
  sceneLoader = new SceneLoader(configDir, effectiveConfig.scenes, {
    logger,
    mqttService,
    sceneSettingsService,
  });
  startScenesWatcher();

  for (const device of effectiveConfig.devices) {
    await startDevice(device);
  }

  // Watch config for hot reload
  configWatcher = new ConfigWatcher(configPath, reloadConfig, { logger });
  await configWatcher.start();

  // Web UI
  webServer = new WebServer({
    configPath,
    getEffectiveConfig: () => effectiveConfig,
    getSceneMetadata: () => sceneMetadata,
    getSceneSettingsState: () => sceneSettingsService?.getUiState() || {},
    getFramePreviews: () => framePreviewStore?.list() || {},
    getRenderLoops: () => renderLoops,
    getDeviceModes: () => {
      const modes = {};
      for (const { device, loop } of renderLoops) {
        modes[device.name] = loop.getStatus().mode;
      }
      return modes;
    },
    mqttService,
    sceneSettingsService,
    logger,
  });
  webServer.start();

  // Handle both SIGINT (Ctrl+C) and SIGTERM (Docker stop)
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("[pixdcon] Running. Send SIGINT or SIGTERM to stop.");
}

main().catch((err) => {
  logger.error("[pixdcon] Fatal startup error", err);
  process.exit(1);
});
