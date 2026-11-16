/**
 * MQTT topics: the single place where topic strings are built and parsed.
 *
 * The strings below are the v1 wire contract (matrix C-005, C-022 to C-024,
 * C-047, C-069, C-070, C-088, C-114, C-120, C-137, C-138). Home Assistant and
 * funkeykid depend on them, e.g. the automation
 * flirc_tv_radio_pixoo189_scene_toggle publishes a retained scene overlay to
 * home/hsb1/pixdcon/overlay/device/pixoo-189/scene. Do not change a string
 * here without a migration of the retained messages and of the consumers.
 * test/contract/topics.test.js pins them.
 *
 * Three bases, all configurable (config.json `mqtt`), all defaulting to v1:
 *   baseTopic         home/hsb1/pixdcon   overlays, per-device controls, telemetry
 *   statusBaseTopic   = baseTopic         controller health, state, config
 *   settingsBaseTopic pixdcon             per-setting overlays (outside the base in v1, A-083)
 *
 * Owner: core/state worker.
 */

/**
 * @param {Partial<import("../types.js").MqttConfig>} [config]
 */
export function createTopics(config = {}) {
  const base = config.baseTopic ?? "home/hsb1/pixdcon";
  const status = config.statusBaseTopic ?? base;
  const settings = config.settingsBaseTopic ?? "pixdcon";
  const discovery = config.discoveryPrefix ?? "homeassistant";

  return Object.freeze({
    base,
    statusBase: status,
    settingsBase: settings,
    discoveryPrefix: discovery,

    // --- structural overlays (subscribe; publish only to clear or through the v1 overlay route) ---
    /** @param {string} device */
    overlayDeviceScene: (device) => `${base}/overlay/device/${device}/scene`,
    /** @param {string} device */
    overlayDeviceIp: (device) => `${base}/overlay/device/${device}/ip`,
    /** @param {string} device */
    overlayDeviceEnabled: (device) =>
      `${base}/overlay/device/${device}/enabled`,
    /** @param {string} sceneKey */
    overlayScenePath: (sceneKey) => `${base}/overlay/scene/${sceneKey}/path`,
    overlayBlob: `${base}/overlay/blob`,
    /** The five filters v1 subscribes (C-047). */
    overlayFilters: Object.freeze([
      `${base}/overlay/device/+/scene`,
      `${base}/overlay/device/+/ip`,
      `${base}/overlay/device/+/enabled`,
      `${base}/overlay/scene/+/path`,
      `${base}/overlay/blob`,
    ]),

    // --- retained controls ---
    /** @param {string} device */
    mode: (device) => `${base}/${device}/mode`,
    /** @param {string} device */
    brightnessOverride: (device) => `${base}/${device}/brightness_override`,

    // --- per-setting overlays ---
    /** @param {string} device @param {string} scene @param {string} key */
    setting: (device, scene, key) =>
      `${settings}/${device}/${scene}/settings/${key}`,
    /** v1 `ctx.settingsTopic` (B-008). @param {string} device @param {string} scene */
    settingsRoot: (device, scene) => `${settings}/${device}/${scene}/settings`,
    settingsFilter: `${settings}/+/+/settings/+`,

    // --- published by the controller ---
    health: `${status}/health`,
    state: `${status}/state`,
    config: `${status}/config`,
    configEffective: `${status}/config/effective`,
    /** @param {string} device */
    telemetry: (device) => `${base}/${device}/telemetry`,

    // --- Home Assistant discovery (retained) ---
    /** @param {string} device @param {string} field */
    discoverySensor: (device, field) =>
      `${discovery}/sensor/pixdcon_${device}_${field}/config`,
    /** @param {string} device @param {string} field */
    discoveryBinarySensor: (device, field) =>
      `${discovery}/binary_sensor/pixdcon_${device}_${field}/config`,

    // --- new in v2, not retained ---
    /** Marker to find the end of the retained replay after a subscribe. @param {string} nonce */
    sync: (nonce) => `${status}/_sync/${nonce}`,

    /**
     * Take an incoming topic apart. Returns null for anything that is not a
     * pixdcon overlay, control or setting topic.
     *
     * @param {string} topic
     * @returns {{kind: import("../types.js").OverlayKind, device: string|null, scene: string|null, key: string|null}|null}
     */
    parse(topic) {
      const overlayPrefix = `${base}/overlay/`;
      if (topic === `${base}/overlay/blob`) {
        return { kind: "blob", device: null, scene: null, key: null };
      }
      if (topic.startsWith(overlayPrefix)) {
        const parts = topic.slice(overlayPrefix.length).split("/");
        if (parts.length !== 3 || !parts[1]) return null;
        const [scope, name, field] = parts;
        if (scope === "device" && field === "scene") {
          return { kind: "device-scene", device: name, scene: null, key: null };
        }
        if (scope === "device" && field === "ip") {
          return { kind: "device-ip", device: name, scene: null, key: null };
        }
        if (scope === "device" && field === "enabled") {
          return {
            kind: "device-enabled",
            device: name,
            scene: null,
            key: null,
          };
        }
        if (scope === "scene" && field === "path") {
          return { kind: "scene-path", device: null, scene: name, key: null };
        }
        return null;
      }
      const settingsPrefix = `${settings}/`;
      if (topic.startsWith(settingsPrefix)) {
        // <settings>/<device>/<scene>/settings/<key…>; a key may contain "/" as in v1
        const parts = topic.slice(settingsPrefix.length).split("/");
        if (
          parts.length >= 4 &&
          parts[2] === "settings" &&
          parts[0] &&
          parts[1]
        ) {
          const key = parts.slice(3).join("/");
          if (key)
            return { kind: "setting", device: parts[0], scene: parts[1], key };
        }
      }
      const basePrefix = `${base}/`;
      if (topic.startsWith(basePrefix)) {
        const parts = topic.slice(basePrefix.length).split("/");
        if (parts.length === 2 && parts[0] && parts[1] === "mode") {
          return { kind: "mode", device: parts[0], scene: null, key: null };
        }
        if (
          parts.length === 2 &&
          parts[0] &&
          parts[1] === "brightness_override"
        ) {
          return {
            kind: "brightness",
            device: parts[0],
            scene: null,
            key: null,
          };
        }
      }
      return null;
    },
  });
}

/** @typedef {ReturnType<typeof createTopics>} Topics */
