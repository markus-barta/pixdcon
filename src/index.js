/**
 * pidicon-light - Main entry point
 * Minimalist pixel display controller
 */

import { ConfigLoader } from '../lib/config-loader.js';
import { SceneLoader } from '../lib/scene-loader.js';
import { RenderLoop } from './render-loop.js';
import { UlanziDriver } from '../lib/ulanzi-driver.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('[pidicon-light] Starting...');

  // Load config
  const configPath = process.env.PIDICON_CONFIG_PATH || join(__dirname, '../config.json');
  const configLoader = new ConfigLoader(configPath);
  const config = await configLoader.load();

  console.log(`[pidicon-light] Loaded config with ${config.devices.length} device(s)`);

  // Initialize scene loader
  const sceneLoader = new SceneLoader(__dirname);

  // Start render loop for each device
  const renderLoops = [];
  for (const device of config.devices) {
    console.log(`[pidicon-light] Starting device: ${device.name} (${device.type})`);

    // Create driver based on device type
    let driver;
    if (device.type === 'ulanzi') {
      driver = new UlanziDriver(device.ip);
    } else if (device.type === 'pixoo') {
      console.warn(`[pidicon-light] Pixoo driver not yet implemented, skipping ${device.name}`);
      continue;
    }

    // Create and start render loop
    const loop = new RenderLoop(driver, sceneLoader, device.scenes);
    renderLoops.push(loop);
    
    loop.start().catch(err => {
      console.error(`[pidicon-light] Device ${device.name} failed: ${err.message}`);
    });
  }

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('[pidicon-light] Shutting down...');
    renderLoops.forEach(loop => loop.stop());
    process.exit(0);
  });

  console.log('[pidicon-light] Running. Press Ctrl+C to stop.');
}

main().catch(err => {
  console.error('[pidicon-light] Fatal error:', err);
  process.exit(1);
});
