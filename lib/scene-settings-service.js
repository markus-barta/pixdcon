function structuredCloneSafe(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseBoolean(raw) {
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return null;
}

function normalizeTime(raw) {
  const s = String(raw).trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const [hh, mm] = s.split(":").map((v) => parseInt(v, 10));
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function normalizeNumber(raw, schema, kind) {
  const n = kind === "int" ? parseInt(raw, 10) : parseFloat(raw);
  if (!Number.isFinite(n)) return null;

  let value = kind === "int" ? Math.round(n) : n;
  if (typeof schema.min === "number") value = Math.max(schema.min, value);
  if (typeof schema.max === "number") value = Math.min(schema.max, value);
  return value;
}

export function normalizeSceneSchema(schema = {}) {
  const normalized = {};

  for (const [key, field] of Object.entries(schema || {})) {
    normalized[key] = {
      type: field.type || "string",
      label: field.label || key,
      group: field.group || "General",
      description: field.description || "",
      default: structuredCloneSafe(field.default),
      min: field.min,
      max: field.max,
      step: field.step,
      options: Array.isArray(field.options) ? field.options : undefined,
      placeholder: field.placeholder || "",
    };
  }

  return normalized;
}

export function normalizeSettingValue(rawValue, schema) {
  if (!schema) return null;
  if (rawValue === undefined) return structuredCloneSafe(schema.default);

  switch (schema.type) {
    case "int":
      return normalizeNumber(rawValue, schema, "int");
    case "float":
      return normalizeNumber(rawValue, schema, "float");
    case "boolean":
      return parseBoolean(rawValue);
    case "enum": {
      const value = String(rawValue).trim();
      const options = schema.options || [];
      const values = options.map((opt) =>
        typeof opt === "object" ? String(opt.value) : String(opt),
      );
      return values.includes(value) ? value : null;
    }
    case "time":
      return normalizeTime(rawValue);
    case "json": {
      if (typeof rawValue === "object" && rawValue !== null) {
        return structuredCloneSafe(rawValue);
      }
      try {
        return JSON.parse(String(rawValue));
      } catch {
        return null;
      }
    }
    case "string":
    case "color":
    default:
      return String(rawValue).trim();
  }
}

function buildSceneKey(deviceName, sceneName) {
  return `${deviceName}::${sceneName}`;
}

export class SceneSettingsService {
  constructor(options = {}) {
    this.getConfig = options.getConfig;
    this.getSceneMetadata = options.getSceneMetadata;
    this.mqttService = options.mqttService || null;
    this.logger = options.logger || console;
    this.overlay = new Map();
    this.watchers = new Map();
    this.namespace = "_scene_settings_service";
  }

  async start() {
    if (!this.mqttService?.connected) return;

    this.mqttService.subscribeWildcard(
      this.namespace,
      "pixdcon/+/+/settings/+",
      (topic, payload) => this._handleOverlayMessage(topic, payload),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  stop() {
    if (this.mqttService) {
      this.mqttService.unsubscribeWildcard(this.namespace);
    }
    this.watchers.clear();
  }

  getSchema(sceneName) {
    const meta = this.getSceneMetadata?.()?.[sceneName] || {};
    return normalizeSceneSchema(meta.settingsSchema || {});
  }

  getSavedValues(deviceName, sceneName) {
    const config = this.getConfig?.() || { devices: [] };
    const device = config.devices?.find((d) => d.name === deviceName);
    return structuredCloneSafe(device?.sceneSettings?.[sceneName] || {});
  }

  getOverlayValues(deviceName, sceneName) {
    return structuredCloneSafe(
      this.overlay.get(buildSceneKey(deviceName, sceneName)) || {},
    );
  }

  getEffectiveValues(deviceName, sceneName) {
    const schema = this.getSchema(sceneName);
    const saved = this.getSavedValues(deviceName, sceneName);
    const overlay = this.getOverlayValues(deviceName, sceneName);
    const values = {};

    for (const [key, field] of Object.entries(schema)) {
      let value = structuredCloneSafe(field.default);

      if (saved[key] !== undefined) {
        const normalized = normalizeSettingValue(saved[key], field);
        if (normalized !== null) value = normalized;
      }

      if (overlay[key] !== undefined) {
        const normalized = normalizeSettingValue(overlay[key], field);
        if (normalized !== null) value = normalized;
      }

      values[key] = value;
    }

    return values;
  }

  getUiState() {
    const config = this.getConfig?.() || { devices: [] };
    const state = {};

    for (const device of config.devices || []) {
      state[device.name] = {};
      for (const sceneName of device.scenes || []) {
        state[device.name][sceneName] = {
          saved: this.getSavedValues(device.name, sceneName),
          overlay: this.getOverlayValues(device.name, sceneName),
          effective: this.getEffectiveValues(device.name, sceneName),
        };
      }
    }

    return state;
  }

  createRuntimeContext(deviceName, sceneName) {
    return {
      schema: this.getSchema(sceneName),
      values: this.getEffectiveValues(deviceName, sceneName),
      get: (key) => this.getEffectiveValues(deviceName, sceneName)[key],
      all: () => this.getEffectiveValues(deviceName, sceneName),
      subscribe: (callback) => this._watch(deviceName, sceneName, callback),
    };
  }

  async applyOverlay(deviceName, sceneName, values = {}) {
    if (!this.mqttService?.connected) {
      throw new Error("MQTT not connected");
    }

    const schema = this.getSchema(sceneName);
    for (const [key, field] of Object.entries(schema)) {
      if (values[key] === undefined) continue;
      const normalized = normalizeSettingValue(values[key], field);
      if (normalized === null) continue;

      const payload =
        field.type === "json" ? JSON.stringify(normalized) : String(normalized);
      this.mqttService.publishRaw(
        `pixdcon/${deviceName}/${sceneName}/settings/${key}`,
        payload,
        true,
      );
    }
  }

  async clearOverlay(deviceName, sceneName) {
    if (!this.mqttService?.connected) {
      throw new Error("MQTT not connected");
    }

    const schema = this.getSchema(sceneName);
    for (const key of Object.keys(schema)) {
      this.mqttService.publishRaw(
        `pixdcon/${deviceName}/${sceneName}/settings/${key}`,
        "",
        true,
      );
    }
  }

  _watch(deviceName, sceneName, callback) {
    const watchKey = buildSceneKey(deviceName, sceneName);
    if (!this.watchers.has(watchKey)) this.watchers.set(watchKey, new Set());
    this.watchers.get(watchKey).add(callback);
    callback(this.getEffectiveValues(deviceName, sceneName));

    return () => {
      const set = this.watchers.get(watchKey);
      if (!set) return;
      set.delete(callback);
      if (set.size === 0) this.watchers.delete(watchKey);
    };
  }

  _handleOverlayMessage(topic, payload) {
    const parts = topic.split("/");
    if (parts.length < 5) return;

    const [, deviceName, sceneName, settingsLiteral, ...rest] = parts;
    if (settingsLiteral !== "settings") return;
    const key = rest.join("/");
    const schema = this.getSchema(sceneName);
    const field = schema[key];
    if (!field) return;

    const mapKey = buildSceneKey(deviceName, sceneName);
    if (!this.overlay.has(mapKey)) this.overlay.set(mapKey, {});
    const current = this.overlay.get(mapKey);

    if (payload === "" || payload === "null") {
      delete current[key];
    } else {
      const normalized = normalizeSettingValue(payload, field);
      if (normalized === null) return;
      current[key] = normalized;
    }

    this._emit(deviceName, sceneName);
  }

  _emit(deviceName, sceneName) {
    const watchKey = buildSceneKey(deviceName, sceneName);
    const callbacks = this.watchers.get(watchKey);
    if (!callbacks || callbacks.size === 0) return;
    const values = this.getEffectiveValues(deviceName, sceneName);
    for (const callback of callbacks) {
      try {
        callback(values);
      } catch (error) {
        this.logger.error(
          `[SceneSettingsService] watcher failed for ${deviceName}/${sceneName}`,
          error,
        );
      }
    }
  }
}

export default SceneSettingsService;
