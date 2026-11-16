/**
 * Scene runtime: loaded scene instances, one per (scene, device).
 *
 * Kept from v1 (lib/scene-loader.js; matrix B-003 to B-007, B-013 to B-015):
 *  - a scene file is imported with a file:// URL and a `?t=<token>` that
 *    changes when the file changed, so Node evaluates it again
 *  - each (scene, device) pair has its own instance; init() runs once per
 *    instance and is awaited before the first render
 *  - releasing an instance calls destroy(), and afterwards always removes the
 *    scene's MQTT subscriptions and settings subscriptions for that device,
 *    also when destroy() threw (B-007, C-046)
 *
 * Fixed:
 *  - one pending load per (scene, device): a second caller gets the same
 *    promise, never a half-initialised instance (B-165, S-48)
 *  - hot reload keeps the last good instance running when the new file does
 *    not import or init; the scene is reported broken with the reason (B-022)
 *  - only the changed file is imported again; the token is per file (S-18)
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
 * @property {string} scene scene key
 * @property {string} device device name
 * @property {string} token import token; changes with every reload
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
 * @property {import("./settings-service.js").SettingsService} settings
 * @property {import("../mqtt/mqtt-gateway.js").MqttGateway|null} mqtt
 * @property {(scene: string, device: string) => import("../types.js").OutputMode} outputOf
 * @property {import("../types.js").Logger} logger
 */

export class SceneRuntime {
  /** @param {SceneRuntimeDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /**
   * Get the instance of a scene for a device, loading and initialising it
   * when needed.
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
   * Release a device's instance after its frame in flight has finished.
   * @param {string} scene
   * @param {string} device
   */
  async release(scene, device) {
    return todo("SceneRuntime.release", scene, device);
  }

  /**
   * Is this still the instance to render with? False after a hot reload.
   * @param {SceneInstance} instance
   * @returns {boolean}
   */
  isCurrent(instance) {
    return todo("SceneRuntime.isCurrent", instance);
  }

  /**
   * The file of these scenes changed: mark them for reload. Devices running
   * them pick the new code up at their next frame boundary.
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
