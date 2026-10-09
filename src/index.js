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
import { ConfigOverlay, recomputeWithSavedSceneSettings } from "../lib/config-overlay.js";
import { ScenesWatcher } from "../lib/scenes-watcher.js";
import { WebServer } from "../lib/web-server.js";
import { FramePreviewStore } from "../lib/frame-preview-store.js";
import { SceneSettingsService } from "../lib/scene-settings-service.js";
import { TelemetryCollector } from "../lib/telemetry-collector.js";
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
let configOverlay = null; // MQTT overlay layer (optional, null when MQTT disabled)
let baseConfig = null; // Raw file config; overlay merges on top of this
let effectiveConfig = null; // Last computed merged config (served by WebServer)
let webServer = null;
let framePreviewStore = null;
let sceneMetadata = {};
let sceneSettingsService = null;
let telemetryCollector = null;
let lifecycleQueue = Promise.resolve();
let shuttingDown = false;

// Startup, config/overlay reloads and scene teardown must never overlap.
function queueLifecycle(action) {
  const next = lifecycleQueue.then(() => {
    if (!shuttingDown) return action();
  });
  lifecycleQueue = next.catch(() => {}); // callers log their own errors
  return next;
}

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
    await svc.connect({ keepReconnecting: true, timeoutMs: 5000 });
    svc.startPeriodicPublish(30000);
    return svc;
  } catch (error) {
    // Only setup failures reach here; broker errors keep reconnecting in svc.
    logger.error(`[MQTT] Setup failed, continuing without MQTT`, error);
    await svc.disconnect();
    return null;
  }
}

function startScenesWatcher() {
  if (shuttingDown) return;
  const configDir = dirname(configPath);
  const dirs = sceneLoader.getSceneDirs();
  scenesWatcher = new ScenesWatcher(
    dirs,
    (filename, directory) => queueLifecycle(async () => {
      const names = sceneLoader.findScenesByFilename(filename, directory);
      if (names.length === 0) {
        logger.debug(
          `[pixdcon] Scene file "${filename}" changed but no matching scene found`,
        );
        return;
      }
      // Let active renders/init finish before destroying their scene resources.
      const affected = renderLoops.filter(({ loop }) => names.includes(loop.scene));
      await Promise.all(affected.map(({ loop }) => loop.stop()));
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
      if (!shuttingDown) {
        for (const { loop, device } of affected) {
          loop.start().catch((err) => {
            logger.error(`[pixdcon] Render loop for ${device.name} exited after scene reload`, err);
          });
        }
      }
    }),
    { logger },
  );
  scenesWatcher.start();
}

/**
 * Create driver + render loop for a single device, start the loop.
 * Returns the loop instance, or null if the device cannot be started.
 */
async function startDevice(device) {
  if (shuttingDown) return null;
  logger.info(
    `[pixdcon] Starting device: ${device.name} (${device.type} @ ${device.ip})`,
  );

  let driver;
  if (device.type === "ulanzi") {
    driver = new UlanziDriver(device.ip, {
      appName: `pixdcon_${device.name}`,
      logger,
      cleanupLegacyApps: device.cleanupLegacyApps === true,
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
  if (shuttingDown) return null;
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

  if (telemetryCollector) telemetryCollector.start(device);

  return loop;
}

async function stopAllDevices() {
  logger.info(`[pixdcon] Stopping ${renderLoops.length} device(s)...`);
  const stopped = renderLoops.map(({ loop }) => loop.stop());
  await Promise.all(stopped);
  for (const { device } of renderLoops) {
    if (telemetryCollector) telemetryCollector.stop(device.name);
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
    const nextConfig = new ConfigLoader(configPath).parse(
      JSON.stringify(configOverlay.merge(baseConfig)),
    );

    if (scenesWatcher) {
      scenesWatcher.stop();
      scenesWatcher = null;
    }
    await stopAllDevices();
    await sceneLoader.clearCache();
    effectiveConfig = nextConfig;

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
    const nextBase = loader.parse(newConfigContent);
    const nextConfig = configOverlay
      ? loader.parse(JSON.stringify(configOverlay.merge(nextBase)))
      : nextBase;

    if (scenesWatcher) {
      scenesWatcher.stop();
      scenesWatcher = null;
    }
    await stopAllDevices();
    await sceneLoader.clearCache(); // destroy() hooks + re-import from disk
    baseConfig = nextBase;
    effectiveConfig = nextConfig;

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

// The UI persisted scene settings: reflect them in the running config now, as the
// reload paths would (overlay merge + loader), instead of waiting ~500 ms for the
// file watcher. The reload then recomputes the same result.
function applySavedSceneSettings(deviceName, sceneName, values) {
  if (shuttingDown || !baseConfig) return;
  try {
    const next = recomputeWithSavedSceneSettings({
      baseConfig,
      overlay: configOverlay,
      loader: new ConfigLoader(configPath),
      deviceName,
      sceneName,
      values,
    });
    if (!next) return;
    baseConfig = next.base;
    effectiveConfig = next.effective;
  } catch (error) {
    logger.warn(`[pixdcon] Saved scene settings wait for the config reload: ${error.message}`);
  }
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[pixdcon] Received ${signal}, shutting down gracefully...`);
  // Stay inside Docker's 10 s stop grace period even if a device or the
  // broker is slow to answer: a SIGKILL would skip the cleanup entirely.
  setTimeout(() => {
    logger.warn("[pixdcon] Graceful shutdown took over 8 s, exiting now");
    process.exit(exitCode);
  }, 8000).unref();

  if (configWatcher) await configWatcher.stop();
  if (scenesWatcher) scenesWatcher.stop();
  if (configOverlay) configOverlay.unsubscribe();
  if (telemetryCollector) telemetryCollector.stopAll();
  if (webServer) webServer.stop();

  await lifecycleQueue;
  // Startup/reloads may have been awaiting I/O when the signal arrived.
  if (configWatcher) await configWatcher.stop();
  if (scenesWatcher) scenesWatcher.stop();
  if (configOverlay) configOverlay.unsubscribe();
  await stopAllDevices();
  if (sceneLoader) await sceneLoader.clearCache();
  if (sceneSettingsService) sceneSettingsService.stop();

  if (mqttService) {
    mqttService.setRunning(false);
    await mqttService.disconnect();
  }

  process.exit(exitCode);
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

  // Observe edits during slow MQTT/device startup; their reloads wait on startup.
  if (shuttingDown) return;
  configWatcher = new ConfigWatcher(
    configPath, (content) => queueLifecycle(() => reloadConfig(content)), { logger },
  );
  await configWatcher.start();
  if (shuttingDown) return;

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
      () => queueLifecycle(applyOverlayReload),
      { logger },
    );
    await configOverlay.subscribe(); // 200ms settle, clears debounce
  }

  effectiveConfig = baseConfig;
  if (configOverlay) {
    try {
      effectiveConfig = configLoader.parse(
        JSON.stringify(configOverlay.merge(baseConfig)),
      );
    } catch (error) {
      logger.error("[pixdcon] Invalid startup overlay — using base config", error);
    }
  }

  framePreviewStore = new FramePreviewStore({ logger });
  sceneSettingsService = new SceneSettingsService({
    getConfig: () => effectiveConfig,
    getSceneMetadata: () => sceneMetadata,
    mqttService,
    logger,
  });

  // Telemetry — per-Ulanzi periodic /api/stats poll → retained MQTT.
  // Polling survives an offline broker and publishes once it reconnects.
  if (mqttService) {
    telemetryCollector = new TelemetryCollector({
      mqttService,
      logger,
      intervalMs: baseConfig.telemetryIntervalMs ?? 60_000,
    });
  }

  if (mqttService) mqttService.publishConfig(effectiveConfig); // publish merged result

  // SceneLoader resolves paths relative to config file's directory
  // so ./scenes/clock.js works both locally and in /data volume
  const configDir = dirname(configPath);
  sceneMetadata = await loadSceneMetadata(configDir, effectiveConfig.scenes, {
    logger,
  });
  // Retained settings need the schema before the subscription's first messages.
  await sceneSettingsService.start();
  sceneLoader = new SceneLoader(configDir, effectiveConfig.scenes, {
    logger,
    mqttService,
    sceneSettingsService,
  });
  startScenesWatcher();

  for (const device of effectiveConfig.devices) {
    await startDevice(device);
  }

  if (shuttingDown) return;

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
    telemetryCollector,
    onSceneSettingsSaved: applySavedSceneSettings,
    logger,
  });
  webServer.start();

  logger.info("[pixdcon] Running. Send SIGINT or SIGTERM to stop.");
}

// Register before startup I/O so Docker stop also works during initialization.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal).catch((err) => {
      logger.error("[pixdcon] Shutdown failed", err);
      process.exit(1);
    });
  });
}

const startup = main();
lifecycleQueue = startup.catch(() => {});
startup.catch((err) => {
  logger.error("[pixdcon] Fatal startup error", err);
  shutdown("startup failure", 1).catch((error) => {
    logger.error("[pixdcon] Startup cleanup failed", error);
    process.exit(1);
  });
});
