/**
 * Main render loop
 * Cycles through scenes for each device
 */

export class RenderLoop {
  constructor(driver, sceneLoader, scenes) {
    this.driver = driver;
    this.sceneLoader = sceneLoader;
    this.scenes = scenes;
    this.running = false;
    this.currentIndex = 0;
  }

  async start() {
    this.running = true;
    console.log('[RenderLoop] Started');

    while (this.running) {
      const sceneName = this.scenes[this.currentIndex];
      await this.runScene(sceneName);
      this.currentIndex = (this.currentIndex + 1) % this.scenes.length;
    }
  }

  async runScene(sceneName) {
    try {
      const scene = await this.sceneLoader.load(sceneName);
      console.log(`[RenderLoop] Running scene: ${sceneName}`);

      let result;
      do {
        result = await scene.render(this.driver);
        if (typeof result === 'number' && result > 0) {
          await this.sleep(result);
        }
      } while (this.running && result !== null);

    } catch (error) {
      console.error(`[RenderLoop] Scene ${sceneName} failed: ${error.message}`);
    }
  }

  stop() {
    this.running = false;
    console.log('[RenderLoop] Stopped');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default RenderLoop;
