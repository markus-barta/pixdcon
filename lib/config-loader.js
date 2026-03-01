/**
 * Config file loader
 * Reads and validates config.json
 */

import { readFile } from 'fs/promises';

export class ConfigLoader {
  constructor(configPath) {
    this.configPath = configPath;
  }

  async load() {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      const config = JSON.parse(content);

      if (!config.devices || !Array.isArray(config.devices)) {
        throw new Error('Config missing "devices" array');
      }

      if (!config.scenes || typeof config.scenes !== 'object') {
        throw new Error('Config missing "scenes" object');
      }

      for (const device of config.devices) {
        if (!device.name || !device.type || !device.ip) {
          throw new Error(`Device missing required fields: ${JSON.stringify(device)}`);
        }

        if (!['ulanzi', 'pixoo'].includes(device.type)) {
          throw new Error(`Unknown device type: ${device.type}`);
        }
      }

      return config;
    } catch (error) {
      console.error(`[ConfigLoader] Failed to load config: ${error.message}`);
      throw error;
    }
  }
}

export default ConfigLoader;
