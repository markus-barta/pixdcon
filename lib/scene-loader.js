/**
 * Minimal scene loader
 * Loads scene modules from config
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SceneLoader {
  constructor(basePath) {
    this.basePath = basePath;
    this.cache = new Map();
  }

  /**
   * Load a scene module
   * @param {string} scenePath - Path to scene file
   * @returns {Promise<object>}
   */
  async load(scenePath) {
    if (this.cache.has(scenePath)) {
      return this.cache.get(scenePath);
    }

    try {
      const fullPath = join(this.basePath, scenePath);
      const module = await import(fullPath);
      const scene = module.default || module;

      // Validate scene contract
      if (!scene.render || typeof scene.render !== "function") {
        throw new Error(`Scene ${scenePath} missing render function`);
      }

      this.cache.set(scenePath, scene);
      return scene;
    } catch (error) {
      console.error(
        `[SceneLoader] Failed to load ${scenePath}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Clear cache (for hot reload)
   */
  clearCache() {
    this.cache.clear();
  }
}

export default SceneLoader;
