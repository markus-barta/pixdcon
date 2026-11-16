/**
 * v1 scene adapter: runs an unchanged v1 scene module inside v2.
 *
 * THE v1 SCENE CONTRACT, exactly (matrix B-004 to B-012, section 4.1; source
 * lib/scene-loader.js:98-164 and 286-314 at 5819dcb):
 *
 *   const exported = module.default || module      // object with the hooks
 *   const scene = Object.create(exported)          // one per (scene, device); methods on the prototype,
 *                                                  // instance fields (this._state, this._settings, …) per device
 *   scene.render must be a function, else the load fails
 *   if (typeof scene.init === "function") await scene.init(ctx)        // once, before the first render
 *   delay = await scene.render(device)                                 // every frame
 *   if (typeof scene.destroy === "function") await scene.destroy(ctx)  // on release; a throw is logged
 *
 *   ctx = {
 *     logger,                                   // {debug, info, warn, error}
 *     deviceName, sceneName,
 *     settingsTopic,                            // "<settingsBase>/<device>/<scene>/settings"
 *     settings: { schema, values, get(key), all(), subscribe(cb) → unsubscribe },
 *     mqtt: { deviceName, subscribe(topic, cb(payload)), subscribeWildcard(pattern, cb(payload, topic)), unsubscribeAll() },
 *   }
 *   A fresh ctx object is built for init and for destroy, as in v1.
 *
 *   device = the v1 driver surface, see v1-device-facade.js
 *
 *   render's return value: a number > 0 is the delay in ms until the next
 *   frame. v1 ran anything else without a pause (S-7); v2's loop applies the
 *   frame floor instead, so the adapter reports "no delay given" as null.
 *
 * Metadata fields read from the exported object: name, pretty_name,
 * description, deviceType, settingsSchema (scene-registry.js).
 *
 * Deliberate differences, all invisible to the shipped scenes:
 *  - ctx.settings.schema and ctx.settings.values are live getters, not
 *    snapshots taken at init (B-167); the fields stay
 *  - ctx.mqtt has subscribeWildcard also when MQTT is not configured (S-17)
 *  - a callback given to ctx.settings.subscribe gets its own copy of the
 *    values, and a promise it returns is awaited and its rejection logged
 *    (A-188, A-189, A-BUG-41)
 *  - errors are classified: a DeviceError thrown by the device surface passes
 *    through; everything else becomes a SceneError with the phase
 *
 * Per-instance overrides. Scenes are files v2 must not edit, yet two of them
 * write a history file next to themselves (home2, home3: `this._boilerStatePath
 * ??= <scene dir>/.state/<scene>-boiler.json`, B-153). For a device in shadow
 * output the adapter sets that field on the instance before init, pointing
 * into v2's own data directory, so a shadow never writes into the scenes
 * directory that v1 is using. SCENE_OVERRIDES is the complete list.
 *
 * Owner: fixtures + edge lane worker.
 */

import { todo } from "../core/todo.js";

/** @typedef {import("./scene-runtime.js").SceneInstance} SceneInstance */

/**
 * Instance fields set before init for a device in shadow output.
 * Value: path relative to "<data dir>/.pixdcon2/shadow-state/<device>/".
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const SCENE_OVERRIDES = Object.freeze({
  home2: Object.freeze({ _boilerStatePath: "home2-boiler.json" }),
  home3: Object.freeze({ _boilerStatePath: "home3-boiler.json" }),
});

/**
 * v1 `ctx.settings` (matrix A-094, A-095, B-012).
 *
 * @typedef {object} V1SettingsContext
 * @property {Record<string, import("../types.js").SettingField>} schema
 * @property {Record<string, unknown>} values
 * @property {(key: string) => unknown} get effective value now
 * @property {() => Record<string, unknown>} all effective values now
 * @property {(cb: (values: Record<string, unknown>) => unknown) => () => void} subscribe called at once and after every change of an effective value
 */

/**
 * @typedef {object} V1SceneContext
 * @property {import("../types.js").Logger} logger
 * @property {string} deviceName
 * @property {string} sceneName
 * @property {string} settingsTopic
 * @property {V1SettingsContext} settings
 * @property {import("../mqtt/mqtt-gateway.js").V1MqttContext} mqtt
 */

/**
 * @typedef {object} V1AdapterDeps
 * @property {(scene: string, device: string) => V1SettingsContext} settingsContext
 * @property {(scene: string, device: string) => import("../mqtt/mqtt-gateway.js").V1MqttContext} mqttContext
 * @property {(device: string, scene: string) => string} settingsTopic topics.settingsRoot
 * @property {string|null} shadowStateDir set for a device in shadow output, else null
 * @property {import("../types.js").Logger} logger
 */

/**
 * Does this module satisfy the v1 contract?
 *
 * @param {unknown} moduleNamespace result of import()
 * @returns {{ok: true, exported: Record<string, unknown>} | {ok: false, problem: string}}
 */
export function checkV1Module(moduleNamespace) {
  return todo("checkV1Module", moduleNamespace);
}

/**
 * Create and initialise the instance of a v1 scene for one device.
 *
 * @param {{scene: string, device: string, token: string, moduleNamespace: unknown}} target
 * @param {V1AdapterDeps} deps
 * @returns {Promise<SceneInstance>}
 * @throws {import("../core/errors.js").SceneError} phase "contract" or "init"
 */
export async function createV1Instance(target, deps) {
  return todo("createV1Instance", target, deps);
}
