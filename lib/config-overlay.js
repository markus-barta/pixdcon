/**
 * MQTT Config Overlay for pixdcon
 *
 * Sits on top of config.json as a retained MQTT layer.
 * File is always the safe fallback; overlay is optional and granular.
 *
 * Topic schema (all retained, base = home/hsb1/pixdcon):
 *   {base}/overlay/device/<name>/scenes   → '["clock","health"]'
 *   {base}/overlay/device/<name>/ip       → "192.168.1.200"
 *   {base}/overlay/device/<name>/enabled  → "false"
 *   {base}/overlay/scene/<key>/path       → "./scenes/clock.js"
 *   {base}/overlay/blob                   → full/partial config JSON
 *
 * Clear any overlay: publish empty payload "" → key removed from state.
 *
 * Merge priority: file config < blob overlay < granular overlay.
 */

export class ConfigOverlay {
  /**
   * @param {import('./mqtt-service.js').MqttService} mqttService
   * @param {string}   baseTopic       - e.g. "home/hsb1/pixdcon"
   * @param {Function} onOverlayChange - async () => void, debounced
   * @param {object}   options
   * @param {object}   [options.logger]
   * @param {number}   [options.settleMs=200]   - wait after subscribe for retained burst
   * @param {number}   [options.debounceMs=300] - debounce live changes
   */
  constructor(mqttService, baseTopic, onOverlayChange, options = {}) {
    this.mqtt = mqttService;
    this.baseTopic = baseTopic;
    this._onChange = onOverlayChange;
    this.logger = options.logger || console;

    this._settleMs = options.settleMs ?? 200;
    this._debounceMs = options.debounceMs ?? 300;

    this._blobPatch = null;          // parsed blob object or null
    this._devicePatches = new Map(); // name → { ip?, scenes?, enabled? }
    this._scenePatches = {};         // key → { path? }
    this._debounceTimer = null;
  }

  /**
   * Subscribe to all overlay topics and wait for the retained message burst.
   * main() calls merge() directly after this resolves — debounce is cleared
   * so applyOverlayReload() doesn't double-fire on startup.
   */
  async subscribe() {
    const ns = "_config_overlay";
    const b = this.baseTopic;

    this.mqtt.subscribeWildcard(
      ns,
      `${b}/overlay/device/+/scene`,
      (t, p) => this._handleGranular(t, p),
    );
    this.mqtt.subscribeWildcard(
      ns,
      `${b}/overlay/device/+/ip`,
      (t, p) => this._handleGranular(t, p),
    );
    this.mqtt.subscribeWildcard(
      ns,
      `${b}/overlay/device/+/enabled`,
      (t, p) => this._handleGranular(t, p),
    );
    this.mqtt.subscribeWildcard(
      ns,
      `${b}/overlay/scene/+/path`,
      (t, p) => this._handleGranular(t, p),
    );
    this.mqtt.subscribeWildcard(
      ns,
      `${b}/overlay/blob`,
      (_t, p) => this._handleBlob(p),
    );

    // Wait for retained burst, then cancel any pending debounce.
    // main() performs the first merge directly after subscribe() returns.
    await new Promise((r) => setTimeout(r, this._settleMs));
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  /** Unsubscribe all overlay topics (call on shutdown). */
  unsubscribe() {
    this.mqtt.unsubscribeWildcard("_config_overlay");
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  /** Current overlay state snapshot (for external inspection). */
  getOverlay() {
    return {
      blob: this._blobPatch,
      devicePatches: new Map(this._devicePatches),
      scenePatches: { ...this._scenePatches },
    };
  }

  /**
   * Merge base config with current overlay state.
   * Blob applied first; granular wins on top.
   *
   * @param {object} base - raw config from ConfigLoader
   * @returns {object}    - effectiveConfig (throws on validation failure)
   */
  merge(base) {
    let result = JSON.parse(JSON.stringify(base)); // deep clone

    // --- Apply blob (lower priority) ---
    if (this._blobPatch) {
      if (this._blobPatch.devices && !Array.isArray(this._blobPatch.devices)) {
        this.logger.warn("[ConfigOverlay] blob devices must be an array, skipped");
      }
      const devices = Array.isArray(this._blobPatch.devices) ? this._blobPatch.devices : [];
      for (const bd of devices) {
        if (
          !bd || typeof bd !== "object" || Array.isArray(bd) ||
          typeof bd.name !== "string" || !bd.name.trim() ||
          (bd.type !== undefined && !["ulanzi", "pixoo"].includes(bd.type)) ||
          (bd.ip !== undefined && (typeof bd.ip !== "string" || !bd.ip.trim())) ||
          (bd.scene != null && typeof bd.scene !== "string")
        ) {
          this.logger.warn("[ConfigOverlay] invalid blob device entry, skipped");
          continue;
        }
        const i = result.devices.findIndex((d) => d.name === bd.name);
        if (i >= 0) {
          result.devices[i] = { ...result.devices[i], ...bd };
        } else if (bd.name && bd.type && bd.ip) {
          result.devices.push(bd);
        } else {
          this.logger.warn(
            `[ConfigOverlay] blob device missing required fields (name/type/ip), skipped: ${bd.name ?? "(unnamed)"}`,
          );
        }
      }
      if (
        this._blobPatch.scenes &&
        typeof this._blobPatch.scenes === "object" &&
        !Array.isArray(this._blobPatch.scenes)
      ) {
        for (const [k, v] of Object.entries(this._blobPatch.scenes)) {
          if (typeof v?.path === "string" && v.path.trim()) {
            result.scenes[k] = { ...result.scenes[k], ...v };
          } else {
            this.logger.warn(
              `[ConfigOverlay] blob scene "${k}" missing path, skipped`,
            );
          }
        }
      }
    }

    // --- Apply granular device patches (win over blob) ---
    for (const [name, patch] of this._devicePatches) {
      const i = result.devices.findIndex((d) => d.name === name);
      if (i >= 0) {
        result.devices[i] = { ...result.devices[i], ...patch };
      }
      // granular-only device (not in file or blob) → skip silently
    }

    // --- Apply granular scene patches (win over blob) ---
    for (const [key, val] of Object.entries(this._scenePatches)) {
      if (val?.path) {
        result.scenes[key] = { ...result.scenes[key], ...val };
      }
    }

    // --- Filter disabled devices ---
    result.devices = result.devices.filter(
      (d) => d.enabled !== false && d.enabled !== "false",
    );

    // --- Warn on dangling scene refs (don't throw) ---
    for (const d of result.devices) {
      if (d.scene && !d.scene.startsWith("builtin:") && !result.scenes[d.scene]) {
        this.logger.warn(
          `[ConfigOverlay] device "${d.name}" refs unknown scene "${d.scene}"`,
        );
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------

  _handleGranular(topic, payload) {
    // Strip "{baseTopic}/overlay/" prefix
    const rest = topic.slice(this.baseTopic.length + "/overlay/".length);

    if (rest.startsWith("device/")) {
      const parts = rest.split("/"); // ["device", name, field]
      const [, name, field] = parts;
      if (!name || !field) return;

      if (!this._devicePatches.has(name)) this._devicePatches.set(name, {});
      const patch = this._devicePatches.get(name);

      if (!payload) {
        delete patch[field];
        if (Object.keys(patch).length === 0) this._devicePatches.delete(name);
      } else {
        patch[field] = payload;
      }
    } else if (rest.startsWith("scene/")) {
      const parts = rest.split("/"); // ["scene", key, "path"]
      const [, key, field] = parts;
      if (!key || !field) return;

      if (!payload) {
        delete this._scenePatches[key];
      } else {
        this._scenePatches[key] = {
          ...this._scenePatches[key],
          [field]: payload,
        };
      }
    } else {
      return; // unknown subtopic
    }

    this._scheduleChange();
  }

  _handleBlob(payload) {
    if (!payload) {
      this._blobPatch = null;
    } else {
      try {
        const blob = JSON.parse(payload);
        if (!blob || typeof blob !== "object" || Array.isArray(blob)) {
          this.logger.warn("[ConfigOverlay] blob must be an object — ignored");
          return;
        }
        this._blobPatch = blob;
      } catch {
        this.logger.warn(
          "[ConfigOverlay] blob JSON parse failed — ignored",
        );
        return;
      }
    }
    this._scheduleChange();
  }

  _scheduleChange() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(async () => {
      this._debounceTimer = null;
      try {
        await this._onChange();
      } catch (err) {
        this.logger.error("[ConfigOverlay] onOverlayChange error", err);
      }
    }, this._debounceMs);
  }
}

export default ConfigOverlay;

/**
 * A UI save persisted scene settings to config.json, and the file watcher's
 * reload lags ~500 ms. Returns the next base config and the effective config
 * recomputed exactly like the reload paths do — through the overlay merge (so an
 * MQTT config blob or granular overlay keeps precedence) and the loader. Pure:
 * the inputs are not modified. Returns null when the device is not in the base
 * config (it then only exists via an overlay; the reload handles it).
 */
export function recomputeWithSavedSceneSettings({ baseConfig, overlay, loader, deviceName, sceneName, values }) {
  const base = JSON.parse(JSON.stringify(baseConfig));
  const device = base.devices?.find((d) => d.name === deviceName);
  if (!device) return null;
  const current = device.sceneSettings && typeof device.sceneSettings === "object" ? device.sceneSettings : {};
  device.sceneSettings = { ...current, [sceneName]: JSON.parse(JSON.stringify(values)) };
  const effective = overlay ? loader.parse(JSON.stringify(overlay.merge(base))) : base;
  return { base, effective };
}
