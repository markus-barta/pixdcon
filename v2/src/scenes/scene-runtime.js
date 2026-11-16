/**
 * Scene runtime: loaded scene instances, one per (scene, device).
 *
 * Kept from v1 (lib/scene-loader.js; matrix B-003 to B-007, B-013 to B-015):
 *  - a scene file is imported with a file:// URL and a `?t=<token>` that
 *    changes when the file changed, so Node evaluates it again
 *  - each (scene, device) pair has its own instance; init() runs once per
 *    instance and is awaited before the first render
 *  - releasing an instance calls destroy(), and afterwards always removes the
 *    instance's MQTT subscriptions and settings subscribers, also when
 *    destroy() threw (B-007, C-046)
 *
 * Fixed:
 *  - Real isolation per device (B-005, S-16). v1 evaluates a scene file once
 *    and gives every device `Object.create(module)`: fields assigned on
 *    `this` are per device, but module-level variables and objects reached
 *    through the prototype are shared (scenes/pixoo/health.js keeps its glow
 *    phase in a module variable). v2 evaluates the scene file once per
 *    device: the import URL is `<file>?t=<file token>&d=<device>`. Helper
 *    modules a scene imports (lib/pixoo-image.js, the collectors) keep one
 *    URL and stay shared, as their caches are meant to be.
 *  - one pending load per (scene, device): a second caller gets the same
 *    promise, never a half-initialised instance (B-165, S-48)
 *  - hot reload keeps the last good instance running when the new file does
 *    not import or init; the scene is reported broken with the reason (B-022).
 *    For that, the replacement is created and initialised beside the running
 *    instance. The two are told apart by their InstanceRef: each has its own
 *    token, its own MQTT owner and its own settings subscribers. When init
 *    succeeded, the loop switches at its next frame boundary and the old
 *    instance is released; when import or init failed, only the
 *    replacement's subscriptions are released and the old instance never
 *    notices.
 *  - only the changed file is imported again; the file token is per file (S-18)
 *
 * The runtime knows nothing about the v1 contract itself. It asks an adapter
 * (v1-scene-adapter.js is the only one today) to turn a module into a
 * SceneInstance, so a later native v2 scene format plugs in here.
 *
 * Owner: fixtures + edge lane worker.
 */

import { todo } from "../core/todo.js";

/**
 * What the render loop drives. One instance per (scene, device).
 *
 * @typedef {object} SceneInstance
 * @property {import("../types.js").InstanceRef} ref scene key, device name and the token of this instance
 * @property {string} scene scene key (same as ref.scene)
 * @property {string} device device name (same as ref.device)
 * @property {(surface: import("./v1-device-facade.js").SceneSurface) => Promise<number|null>} renderFrame
 *   one frame. Resolves with the delay in ms the scene asked for, or null for
 *   "no delay given" (the loop then waits minFrameMs). Rejects with a
 *   DeviceError when the display refused the frame, with a SceneError for
 *   anything else.
 * @property {() => Promise<void>} release destroy and unsubscribe; never rejects
 */

/**
 * @typedef {object} SceneRuntimeDeps
 * @property {import("./scene-registry.js").SceneRegistry} registry
 * @property {import("./settings-service.js").SettingsService} settings runtimeContext(ref) and releaseContext(ref)
 * @property {(ref: import("../types.js").InstanceRef) => import("../mqtt/mqtt-gateway.js").V1MqttContext} mqttContext built by main.js: the gateway's sceneContext, or the offline stand-in when MQTT is not configured
 * @property {(device: string, scene: string) => string} settingsTopic topics.settingsRoot
 * @property {(device: string) => import("../types.js").OutputMode} outputOf the one resolved output policy; "shadow" redirects the scene's state files
 * @property {string} dataDir directory of config.json; shadow state lives in "<dataDir>/.pixdcon2/shadow-state/<device>/"
 * @property {import("../types.js").Logger} logger
 */

export class SceneRuntime {
  /** @param {SceneRuntimeDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /**
   * Get the instance to render with for a scene on a device, loading and
   * initialising it when needed. After a hot reload this is the replacement,
   * once its init succeeded; until then, and when it failed, the instance
   * that was running.
   *
   * @param {string} scene
   * @param {string} device
   * @returns {Promise<SceneInstance>}
   * @throws {import("../core/errors.js").SceneError} unknown scene, import failed, no render(), init failed
   */
  async acquire(scene, device) {
    return todo("SceneRuntime.acquire", scene, device);
  }

  /**
   * Release this instance, and no other instance of the same scene and
   * device, after its frame in flight has finished: destroy(), then its MQTT
   * owner and its settings subscribers go.
   *
   * @param {SceneInstance} instance
   */
  async release(instance) {
    return todo("SceneRuntime.release", instance);
  }

  /**
   * Is this still the instance to render with? False once a replacement is
   * ready: the loop then acquires again and releases the one it holds.
   * @param {SceneInstance} instance
   * @returns {boolean}
   */
  isCurrent(instance) {
    return todo("SceneRuntime.isCurrent", instance);
  }

  /**
   * The file of these scenes changed: mark them for reload. Devices running
   * them get a replacement instance, initialised beside the running one, and
   * switch to it at their next frame boundary (see "hot reload" above).
   *
   * @param {string[]} scenes
   * @returns {Promise<{devices: string[]}>} devices that run one of them
   */
  async invalidate(scenes) {
    return todo("SceneRuntime.invalidate", scenes);
  }

  /** Release every instance (shutdown). */
  async releaseAll() {
    return todo("SceneRuntime.releaseAll");
  }
}
