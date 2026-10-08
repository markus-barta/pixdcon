/**
 * Config file loader
 * Reads and validates config.json
 */

import { readFile } from "fs/promises";

const DEFAULT_PREVIEW_POLL_MS = 2000;
const MIN_PREVIEW_POLL_MS = 1000;
const MAX_PREVIEW_POLL_MS = 10000;

function clampPreviewPollMs(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_PREVIEW_POLL_MS;
  return Math.max(MIN_PREVIEW_POLL_MS, Math.min(MAX_PREVIEW_POLL_MS, n));
}

function normalizeDevice(device) {
  const preview =
    device.preview && typeof device.preview === "object" ? device.preview : {};
  const sceneSettings =
    device.sceneSettings && typeof device.sceneSettings === "object"
      ? device.sceneSettings
      : {};

  // Auto-migrate scenes array → single scene string
  let scene = device.scene;
  if (!scene && Array.isArray(device.scenes) && device.scenes.length > 0) {
    scene = device.scenes[0];
  }

  return {
    ...device,
    scene: scene || null,
    scenes: undefined, // remove old scenes array from output
    displayName:
      typeof device.displayName === "string" ? device.displayName.trim() : "",
    comment: typeof device.comment === "string" ? device.comment.trim() : "",
    preview: {
      showGrid: Boolean(preview.showGrid),
      pollMs: clampPreviewPollMs(preview.pollMs),
    },
    sceneSettings,
  };
}

export class ConfigLoader {
  constructor(configPath) {
    this.configPath = configPath;
  }

  async load() {
    try {
      const content = await readFile(this.configPath, "utf-8");
      return this.parse(content);
    } catch (error) {
      console.error(`[ConfigLoader] Failed to load config: ${error.message}`);
      throw error;
    }
  }

  async loadFromContent(content) {
    return this.parse(content);
  }

  parse(content) {
    const config = JSON.parse(content);

    if (!config || !Array.isArray(config.devices)) {
      throw new Error('Config missing "devices" array');
    }

    if (!config.scenes || typeof config.scenes !== "object" || Array.isArray(config.scenes)) {
      throw new Error('Config missing "scenes" object');
    }

    for (const [name, scene] of Object.entries(config.scenes)) {
      if (!scene || typeof scene.path !== "string" || !scene.path.trim()) {
        throw new Error(`Invalid scene path for scene: ${name}`);
      }
    }

    for (const device of config.devices) {
      if (!device || typeof device !== "object" || Array.isArray(device)) {
        throw new Error("Invalid device entry");
      }
      const scene = device.scene ?? device.scenes?.[0];
      if (scene != null && typeof scene !== "string") {
        throw new Error(`Invalid scene for device: ${device.name}`);
      }
    }

    config.devices = config.devices.map(normalizeDevice);

    for (const device of config.devices) {
      if (device.scene != null && typeof device.scene !== "string") {
        throw new Error(`Invalid scene for device: ${device.name}`);
      }
      if (
        typeof device.name !== "string" || !device.name.trim() ||
        !device.type || typeof device.ip !== "string" || !device.ip.trim()
      ) {
        throw new Error(
          `Device missing required fields: ${JSON.stringify(device)}`,
        );
      }

      if (!["ulanzi", "pixoo"].includes(device.type)) {
        throw new Error(`Unknown device type: ${device.type}`);
      }

      if (typeof device.displayName !== "string") {
        throw new Error(`Invalid displayName for device: ${device.name}`);
      }

      if (typeof device.comment !== "string") {
        throw new Error(`Invalid comment for device: ${device.name}`);
      }

      if (typeof device.preview !== "object" || device.preview === null) {
        throw new Error(`Invalid preview settings for device: ${device.name}`);
      }

      if (
        typeof device.sceneSettings !== "object" ||
        device.sceneSettings === null ||
        Array.isArray(device.sceneSettings)
      ) {
        throw new Error(`Invalid sceneSettings for device: ${device.name}`);
      }

      if (typeof device.preview.showGrid !== "boolean") {
        throw new Error(`Invalid preview.showGrid for device: ${device.name}`);
      }

      if (!Number.isInteger(device.preview.pollMs)) {
        throw new Error(`Invalid preview.pollMs for device: ${device.name}`);
      }
    }

    return config;
  }
}

export default ConfigLoader;
