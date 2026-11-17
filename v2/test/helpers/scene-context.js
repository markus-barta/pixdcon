/** In-process scene contract peer: live settings and per-instance MQTT owners. */

/** @type {import('../../src/types.js').Logger} */
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * @param {Record<string, unknown>} [initial]
 * @param {Record<string, import('../../src/types.js').SettingField>} [schema]
 */
export function sceneContexts(initial = {}, schema = {}) {
  let values = structuredClone(initial);
  /** @type {Map<string, Set<(values: Record<string, unknown>) => unknown>>} */
  const settings = new Map();
  /** @type {Map<string, Array<{pattern: string, callback: (payload: string, topic: string) => unknown}>>} */
  const subscriptions = new Map();
  /** @param {import('../../src/types.js').InstanceRef} ref */
  const settingsContext = (ref) => {
    const callbacks = settings.get(ref.token) ?? new Set();
    settings.set(ref.token, callbacks);
    return {
      get schema() { return structuredClone(schema); },
      get values() { return structuredClone(values); },
      /** @param {string} key */
      get: (key) => structuredClone(values[key]),
      all: () => structuredClone(values),
      /** @param {(values: Record<string, unknown>) => unknown} callback */
      subscribe(callback) {
        callbacks.add(callback);
        void callback(structuredClone(values));
        return () => { callbacks.delete(callback); };
      },
    };
  };
  /** @param {import('../../src/types.js').InstanceRef} ref */
  const mqttContext = (ref) => {
    const callbacks = subscriptions.get(ref.token) ?? [];
    subscriptions.set(ref.token, callbacks);
    return {
      deviceName: ref.device,
      /** @param {string} pattern @param {(payload: string) => unknown} callback */
      subscribe(pattern, callback) { callbacks.push({ pattern, callback }); },
      /** @param {string} pattern @param {(payload: string, topic: string) => unknown} callback */
      subscribeWildcard(pattern, callback) { callbacks.push({ pattern, callback }); },
      unsubscribeAll() { callbacks.length = 0; subscriptions.delete(ref.token); },
    };
  };
  return {
    settingsContext, mqttContext, subscriptions, settings,
    /** @param {import('../../src/types.js').InstanceRef} ref */
    releaseContext(ref) { settings.delete(ref.token); },
    /** @param {Record<string, unknown>} next */
    async update(next) {
      values = structuredClone(next);
      for (const callbacks of settings.values()) {
        for (const callback of callbacks) await callback(structuredClone(values));
      }
    },
    /** @param {string} topic @param {unknown} payload */
    async deliver(topic, payload) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      for (const callbacks of subscriptions.values()) {
        for (const { pattern, callback } of callbacks.slice()) {
          const filter = pattern.split('/'), parts = topic.split('/');
          const match = filter.every((part, i) => part === '#' || part === '+' || part === parts[i]) &&
            (filter.at(-1) === '#' || filter.length === parts.length);
          if (match) await callback(text, topic);
        }
      }
    },
  };
}

/** @returns {import('../../src/drivers/driver.js').DeviceDriver} */
export function sinkDriver() {
  return {
    info: { type: 'pixoo', width: 64, height: 64, brightness: { min: 1, max: 100 }, drives: false },
    ready: true, async init() {}, async probe() { return { at: new Date().toISOString() }; },
    async show() {}, async blank() {}, async setBrightness() {}, async setPower() {},
    async activateBuiltin() {}, async reclaim() {}, async readTelemetry() { return {}; },
    readScreen: null, notify: null, switchApp: null, selectChannel: null, async close() {},
  };
}
