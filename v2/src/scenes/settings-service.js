/**
 * Settings service: the values a scene sees, layer by layer.
 *
 *   schema default  <  saved in config.json  <  MQTT overlay  <  preview session
 *
 * Kept from v1 (lib/scene-settings-service.js; matrix A-083 to A-102, C-088 to C-107):
 *  - saved values live in config.json under devices[].sceneSettings[scene][key]
 *  - a value that is not valid for its field is ignored in its layer
 *  - only settings the user changed are saved ("sparse save", B-084);
 *    "Reset to default" removes the saved value (B-086)
 *  - a scene's subscribers are called only when an effective value really changed (C-103)
 *
 * New in v2 (approved spec, section 8):
 *  - Preview sessions replace v1's retained auto-overlay (B-085, S-2, C-214).
 *    A preview is a layer in this process, for one device and scene, owned by
 *    one browser page. It is never published to MQTT, so it cannot be
 *    retained. It ends on Revert, on Save, when the page leaves, and when the
 *    page's live connection is gone for longer than `previewGraceMs`.
 *  - Drafts (B-176). The page numbers its edits: every preview request
 *    carries `draft`, a counter that rises with each edit on that page for
 *    that device and scene. Save names the draft it commits. The service
 *    remembers, per page, device and scene, the highest draft it has seen,
 *    previewed or committed.
 *      preview with a draft not higher than that           → ignored, the answer shows the state as it is (a late or repeated request)
 *      Save of draft n while the held preview is draft ≤ n → the preview ends
 *      Save of draft n while the held preview is draft > n → the saved keys are stored; the newer preview stays as it is,
 *                                                            because it holds what the user typed while Save was under way
 *    So a Save can never throw away an edit made after the click, and an
 *    older preview can never come back after a Save, whatever order the
 *    requests arrive in.
 *  - Save writes the changed keys to config.json and clears the MQTT overlay
 *    of each saved key (overlay service). It never writes overlay values or
 *    untouched preview values.
 *  - The saved layer a scene sees is the one of the effective config
 *    (runtime.device(name).sceneSettings): a blob entry may replace it
 *    (A-071), and the state then says `savedFrom: "blob"`. Writes always go
 *    to config.json. A device that exists only in the blob has nothing to
 *    save into: 409 overlay_only_device until it is adopted (A-151).
 *  - Subscriptions belong to a scene instance, not to a (scene, device) pair:
 *    runtimeContext() and releaseContext() take the InstanceRef. During a hot
 *    reload the running instance and its replacement both have a context;
 *    releasing one leaves the other's subscribers in place.
 *  - Saved values reach the running scene at once; no restart (A-102).
 *  - A JSON field that does not parse is rejected by the API with the parse
 *    error; it is never stored as {} (S-5, B-090).
 *  - State is kept per device and scene in nested maps; names cannot collide
 *    (A-186, A-BUG-37).
 *
 * Order (core/ordering.js).
 *  - A preview request carries its page's session and draft number: one
 *    with a draft that is not higher than the highest seen from that page
 *    for that device and scene is dropped.
 *  - The grace time after a page's stream closed is a timer. It ends the
 *    preview, which is the conservative side (the saved values show). It is
 *    armed by `sessionConnection(session, false)`, which the live channel
 *    calls only when the page's last stream closed, and cancelled by
 *    `sessionConnection(session, true)`; a timer of an earlier disconnect
 *    that fires after the page came back ends nothing.
 *  - runtime "changed" is applied only when `effective.rev` is higher than
 *    the one held; overlay and registry "changed" say "compute again".
 *  - A setting overlay whose scene or key has no schema yet is held, and
 *    judged when the registry reports the schema.
 *
 * Events (EventEmitter): "settings" (SettingsState) for a device and scene whose state changed.
 *
 * Owner: core/state worker.
 */

import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { HttpError } from "../core/errors.js";
import { commandLane } from "../core/commands.js";
import { decideStamp } from "../core/ordering.js";
import { NotImplementedError } from "../core/todo.js";
import { freeze, object } from "../core/values.js";
import { normalizeSettingValue, resolveSetting } from "../state/precedence.js";

/** @typedef {import("../types.js").SettingsState} SettingsState */

/**
 * @typedef {object} SettingsServiceDeps
 * @property {import("../config/config-store.js").ConfigStore} config for writes
 * @property {import("../state/runtime-config.js").RuntimeConfig} runtime the saved layer as it runs, and which devices exist
 * @property {import("../overlay/overlay-service.js").OverlayService} overlays
 * @property {import("./scene-registry.js").SceneRegistry} registry
 * @property {import("../types.js").Epoch} epoch stamped into every SettingsState
 * @property {import("../types.js").Clock} clock
 * @property {import("../types.js").Logger} logger
 * @property {number} [previewGraceMs] default 5000
 */

export class SettingsService extends EventEmitter {
  /** @param {SettingsServiceDeps} deps */
  constructor(deps) {
    super();
    this.deps = deps;
    this.active = false;
    this.runtimeRev = 0;
    /** @type {Map<string, Map<string, SettingsState>>} */
    this.states = new Map();
    /** @type {Map<string, {session: string, draft: number, values: Record<string, unknown>}>} */
    this.previews = new Map();
    /** @type {Map<string, number>} */
    this.drafts = new Map();
    /** @type {Map<string, number>} */
    this.committed = new Map();
    /** @type {Map<string, {ref: import("../types.js").InstanceRef, incarnation: number, callbacks: Set<(values: Record<string, unknown>) => unknown>, lane: ReturnType<typeof commandLane>}>} */
    this.contexts = new Map();
    /** @type {Map<string, AbortController>} */
    this.grace = new Map();
    /** @type {Array<() => void>} */
    this.unwire = [];
  }

  /** Follow runtime "changed", overlay "changed" and registry "changed". */
  start() {
    if (this.active) return;
    this.active = true;
    this.runtimeRev = this.deps.runtime.get().rev;
    /** @param {{effective: import("../types.js").EffectiveConfig}} event */
    const runtime = ({ effective }) => {
      if (
        !this.active ||
        decideStamp(
          { source: this.deps.epoch, position: this.runtimeRev },
          { source: this.deps.epoch, position: effective.rev },
        ).action !== "apply"
      )
        return;
      this.runtimeRev = effective.rev;
      this.refreshStates();
    };
    const overlays = () => {
      if (this.active) this.refreshStates();
    };
    this.deps.runtime.on("changed", runtime);
    this.deps.overlays.on("changed", overlays);
    this.deps.registry.on("changed", overlays);
    this.unwire.push(
      () => this.deps.runtime.off("changed", runtime),
      () => this.deps.overlays.off("changed", overlays),
      () => this.deps.registry.off("changed", overlays),
    );
  }

  stop() {
    this.active = false;
    for (const off of this.unwire.splice(0)) off();
    for (const timer of this.grace.values()) timer.abort();
    for (const entry of this.contexts.values()) entry.lane.close();
    this.grace.clear();
    this.previews.clear();
    this.contexts.clear();
  }

  /**
   * @param {string} device
   * @param {string} scene
   * @returns {SettingsState}
   * @throws {import("../core/errors.js").HttpError} 404 unknown_device or unknown_scene
   */
  state(device, scene) {
    const runtime = this.deps.runtime.device(device);
    if (!runtime)
      throw new HttpError(404, "unknown_device", `Unknown device: ${device}`);
    let meta;
    try {
      meta = this.deps.registry.get(scene);
    } catch (error) {
      if (!(error instanceof NotImplementedError)) throw error;
      meta = Object.hasOwn(this.deps.runtime.scenes(), scene)
        ? { settingsSchema: {} }
        : undefined;
    }
    if (!meta)
      throw new HttpError(404, "unknown_scene", `Unknown scene: ${scene}`);
    const incarnation = this.deps.runtime.incarnationOf(device) ?? 0;
    const cached = this.states.get(device)?.get(scene);
    const previous = cached?.incarnation === incarnation ? cached : undefined;
    if (cached && !previous) this.previews.delete(pair(device, scene));
    const preview = this.previews.get(pair(device, scene));
    const overlay = this.deps.overlays.settingValues(device, scene);
    const saved = Object.hasOwn(runtime.sceneSettings, scene)
      ? runtime.sceneSettings[scene]
      : {};
    const values = Object.fromEntries(
      Object.entries(meta.settingsSchema).map(([key, field]) => [
        key,
        resolveSetting(field, {
          ...(Object.hasOwn(saved, key) ? { saved: saved[key] } : {}),
          ...(Object.hasOwn(overlay, key) ? { overlay: overlay[key] } : {}),
          ...(preview && Object.hasOwn(preview.values, key)
            ? { preview: preview.values[key] }
            : {}),
        }),
      ]),
    );
    /** @type {SettingsState} */
    const next = {
      device,
      scene,
      epoch: this.deps.epoch,
      incarnation,
      rev: previous?.rev ?? 0,
      schema: meta.settingsSchema,
      values,
      savedFrom: runtime.blobKeys.includes("sceneSettings") ? "blob" : "config",
      preview: preview
        ? { session: preview.session, draft: preview.draft }
        : null,
    };
    if (previous && isDeepStrictEqual(previous, next)) return previous;
    next.rev += 1;
    const frozen = freeze(next);
    if (!this.states.has(device)) this.states.set(device, new Map());
    this.states.get(device)?.set(scene, frozen);
    if (this.active) {
      this.emit("settings", frozen);
      if (
        !previous ||
        !isDeepStrictEqual(effectiveValues(previous), effectiveValues(frozen))
      )
        this.notify(frozen);
    }
    return frozen;
  }

  /**
   * v1 GET /api/scene-settings: {<device>: {<its current scene>: {saved, overlay, effective}}} (A-093, A-128).
   *
   * @returns {Record<string, Record<string, {saved: Record<string, unknown>, overlay: Record<string, unknown>, effective: Record<string, unknown>}>>}
   */
  toV1() {
    return Object.fromEntries(
      this.deps.runtime.get().devices.flatMap((device) => {
        const overlays = this.deps.overlays.sceneInputs(device.name);
        const scene = overlays.granular?.inEffect
          ? overlays.granular.scene
          : overlays.blob?.inEffect
            ? overlays.blob.scene
            : device.savedScene;
        if (!scene) return [];
        try {
          const state = this.state(device.name, scene);
          const saved = Object.fromEntries(
            Object.entries(state.values)
              .filter(([, field]) => Object.hasOwn(field, "saved"))
              .map(([key, field]) => [key, field.saved]),
          );
          const overlay = Object.fromEntries(
            Object.entries(state.values)
              .filter(([, field]) => Object.hasOwn(field, "overlay"))
              .map(([key, field]) => [key, field.overlay]),
          );
          return [
            [
              device.name,
              {
                [scene]: { saved, overlay, effective: effectiveValues(state) },
              },
            ],
          ];
        } catch (error) {
          if (error instanceof HttpError && error.statusCode === 404) return [];
          throw error;
        }
      }),
    );
  }

  /**
   * Save settings for one device and scene: `set` are stored, `reset` are
   * removed from the saved set. Other saved keys stay (v1's save replaced the
   * whole set, A-137, A-190). Clears the MQTT overlay of every key in `set`.
   * With `session` and `draft` it commits that draft of the page's preview
   * (see "Drafts" above): the preview ends unless it already holds a newer
   * draft.
   *
   * @param {string} device
   * @param {string} scene
   * @param {{set?: Record<string, unknown>, reset?: string[], session?: string, draft?: number}} change
   * @returns {Promise<{state: SettingsState, rejected: Record<string, string>, overlaysNotCleared: string[]}>} rejected: key → reason; nothing is saved when any key is rejected
   * @throws {import("../core/errors.js").HttpError} 404, 409 config_invalid, 409 overlay_only_device
   */
  async save(device, scene, change) {
    if (!this.active)
      throw new HttpError(503, "stopping", "Settings service is stopped");
    const before = this.state(device, scene);
    const runtime = this.deps.runtime.device(device);
    if (runtime?.origin === "blob")
      throw new HttpError(
        409,
        "overlay_only_device",
        "Adopt this device before saving settings",
      );
    const checked = this.validate(before.schema, change.set ?? {});
    for (const key of change.reset ?? [])
      if (!Object.hasOwn(before.schema, key))
        checked.rejected[key] = "unknown setting";
    if (Object.keys(checked.rejected).length)
      return {
        state: before,
        rejected: checked.rejected,
        overlaysNotCleared: [],
      };
    const scoped = change.session !== undefined || change.draft !== undefined;
    let draftKey = "";
    if (scoped) {
      checkDraft(change.session, change.draft);
      draftKey = JSON.stringify([change.session, device, scene]);
      if ((change.draft ?? 0) <= (this.committed.get(draftKey) ?? -1))
        return { state: before, rejected: {}, overlaysNotCleared: [] };
      this.drafts.set(
        draftKey,
        Math.max(change.draft ?? 0, this.drafts.get(draftKey) ?? -1),
      );
    }
    await this.deps.config.updateDevice(device, (raw) => {
      if (
        !this.active ||
        this.deps.runtime.incarnationOf(device) !== before.incarnation
      )
        throw new HttpError(
          409,
          "device_replaced",
          "Device was replaced while saving",
        );
      const settings = object(raw.sceneSettings) ? raw.sceneSettings : {};
      const saved = object(settings[scene]) ? { ...settings[scene] } : {};
      for (const [key, value] of Object.entries(checked.values))
        saved[key] = value;
      for (const key of change.reset ?? []) delete saved[key];
      Object.defineProperty(settings, scene, {
        value: saved,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      raw.sceneSettings = settings;
    });
    if (
      !this.active ||
      this.deps.runtime.incarnationOf(device) !== before.incarnation
    )
      throw new HttpError(
        409,
        "device_replaced",
        "Device was replaced while saving",
      );
    if (scoped)
      this.committed.set(
        draftKey,
        Math.max(change.draft ?? 0, this.committed.get(draftKey) ?? -1),
      );
    const held = this.previews.get(pair(device, scene));
    if (
      held &&
      (!scoped ||
        (held.session === change.session && held.draft <= (change.draft ?? 0)))
    )
      this.previews.delete(pair(device, scene));
    const cleared = await this.deps.overlays.clearSettings(
      device,
      scene,
      Object.keys(checked.values),
    );
    if (
      !this.active ||
      this.deps.runtime.incarnationOf(device) !== before.incarnation
    )
      throw new HttpError(
        409,
        "device_replaced",
        "Device was replaced while saving",
      );
    return {
      state: this.state(device, scene),
      rejected: {},
      overlaysNotCleared: cleared.failed,
    };
  }

  /**
   * Try values on the display without saving. Replaces the session's earlier
   * preview values for this device and scene, when `draft` is higher than
   * every draft seen from that page; otherwise nothing changes and `applied`
   * is false.
   *
   * @param {string} device
   * @param {string} scene
   * @param {{session: string, draft: number, values: Record<string, unknown>}} preview session: id chosen by the page, tied to its live connection; draft: the page's edit counter; values: only the fields the user changed
   * @returns {{state: SettingsState, rejected: Record<string, string>, applied: boolean}}
   */
  preview(device, scene, preview) {
    if (!this.active)
      throw new HttpError(503, "stopping", "Settings service is stopped");
    checkDraft(preview.session, preview.draft);
    const key = JSON.stringify([preview.session, device, scene]);
    if (
      decideStamp(
        { source: preview.session, position: this.drafts.get(key) ?? -1 },
        { source: preview.session, position: preview.draft },
      ).action !== "apply"
    )
      return { state: this.state(device, scene), rejected: {}, applied: false };
    const state = this.state(device, scene);
    this.drafts.set(key, preview.draft);
    const checked = this.validate(state.schema, preview.values);
    if (Object.keys(checked.rejected).length)
      return { state, rejected: checked.rejected, applied: false };
    this.previews.set(pair(device, scene), {
      session: preview.session,
      draft: preview.draft,
      values: checked.values,
    });
    return { state: this.state(device, scene), rejected: {}, applied: true };
  }

  /**
   * End a preview: Revert, page left, or connection lost.
   *
   * @param {string} session
   * @param {{device?: string, scene?: string}} [scope] default: everything the session previews
   * @returns {SettingsState[]} states that changed
   */
  endPreview(session, scope) {
    const changed = [];
    for (const [key, preview] of this.previews) {
      const [device, scene] = /** @type {[string, string]} */ (JSON.parse(key));
      if (
        preview.session !== session ||
        (scope?.device && scope.device !== device) ||
        (scope?.scene && scope.scene !== scene)
      )
        continue;
      this.previews.delete(key);
      if (this.deps.runtime.device(device))
        changed.push(this.state(device, scene));
    }
    return changed;
  }

  /**
   * The live connection of a page opened or closed. A closed connection ends
   * the page's previews after the grace time unless it came back.
   *
   * @param {string} session
   * @param {boolean} connected
   */
  sessionConnection(session, connected) {
    this.grace.get(session)?.abort();
    this.grace.delete(session);
    if (connected || !this.active) return;
    const mine = new AbortController();
    this.grace.set(session, mine);
    void this.deps.clock
      .sleep(this.deps.previewGraceMs ?? 5000, mine.signal)
      .then((elapsed) => {
        if (
          !this.active ||
          !elapsed ||
          mine.signal.aborted ||
          this.grace.get(session) !== mine
        )
          return;
        this.grace.delete(session);
        this.endPreview(session);
      });
  }

  /**
   * v1 `ctx.settings` for one scene instance. Subscribers registered through
   * it belong to that instance.
   *
   * @param {import("../types.js").InstanceRef} ref
   * @returns {import("./v1-scene-adapter.js").V1SettingsContext}
   */
  runtimeContext(ref) {
    const owner = JSON.stringify(ref);
    const state = this.state(ref.device, ref.scene);
    const entry = this.contexts.get(owner) ?? {
      ref: { ...ref },
      incarnation: state.incarnation,
      callbacks: new Set(),
      lane: commandLane(),
    };
    this.contexts.set(owner, entry);
    const current = () =>
      this.active &&
      this.contexts.get(owner) === entry &&
      this.deps.runtime.incarnationOf(ref.device) === entry.incarnation;
    const all = () =>
      current()
        ? structuredClone(effectiveValues(this.state(ref.device, ref.scene)))
        : {};
    return {
      get schema() {
        return structuredClone(state.schema);
      },
      get values() {
        return all();
      },
      get: (key) => all()[key],
      all,
      subscribe: (callback) => {
        if (!current()) return () => {};
        entry.callbacks.add(callback);
        this.call(entry, callback, all());
        return () => entry.callbacks.delete(callback);
      },
    };
  }

  /**
   * Drop the subscribers of this instance, and of no other instance of the
   * same scene and device.
   *
   * @param {import("../types.js").InstanceRef} ref
   */
  releaseContext(ref) {
    this.contexts.get(JSON.stringify(ref))?.lane.close();
    this.contexts.delete(JSON.stringify(ref));
  }

  refreshStates() {
    for (const [device, states] of this.states) {
      if (!this.deps.runtime.device(device)) {
        for (const scene of states.keys())
          this.previews.delete(pair(device, scene));
        this.states.delete(device);
        continue;
      }
      for (const scene of [...states.keys()]) {
        try {
          this.state(device, scene);
        } catch (error) {
          if (error instanceof HttpError && error.statusCode === 404)
            states.delete(scene);
          else throw error;
        }
      }
    }
  }

  /** @param {Record<string, import("../types.js").SettingField>} schema @param {Record<string, unknown>} raw */
  validate(schema, raw) {
    /** @type {Record<string, unknown>} */
    const values = {};
    /** @type {Record<string, string>} */
    const rejected = {};
    for (const [key, input] of Object.entries(raw)) {
      const field = Object.hasOwn(schema, key) ? schema[key] : null;
      if (!field) {
        rejected[key] = "unknown setting";
        continue;
      }
      if (field.type === "json" && typeof input === "string") {
        try {
          JSON.parse(input);
        } catch (error) {
          rejected[key] =
            error instanceof Error ? error.message : "invalid JSON";
          continue;
        }
      }
      const value = normalizeSettingValue(input, field);
      if (value === undefined) rejected[key] = `invalid ${field.type} value`;
      else
        Object.defineProperty(values, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    return { values, rejected };
  }

  /** @param {SettingsState} state */
  notify(state) {
    for (const entry of this.contexts.values()) {
      if (
        entry.ref.device !== state.device ||
        entry.ref.scene !== state.scene ||
        entry.incarnation !== state.incarnation
      )
        continue;
      for (const callback of entry.callbacks)
        this.call(entry, callback, effectiveValues(state));
    }
  }

  /** @param {{ref: import("../types.js").InstanceRef, incarnation: number, lane: ReturnType<typeof commandLane>, callbacks: Set<(values: Record<string, unknown>) => unknown>}} entry @param {(values: Record<string, unknown>) => unknown} callback @param {Record<string, unknown>} values */
  call(entry, callback, values) {
    const copy = structuredClone(values);
    void entry.lane
      .run(async () => {
        if (
          !this.active ||
          this.contexts.get(JSON.stringify(entry.ref)) !== entry ||
          !entry.callbacks.has(callback) ||
          this.deps.runtime.incarnationOf(entry.ref.device) !==
            entry.incarnation
        )
          return;
        await callback(copy);
      })
      .catch((error) => {
        if (this.active && this.contexts.has(JSON.stringify(entry.ref)))
          this.deps.logger.error("[Settings] Subscriber failed", error);
      });
  }
}

/** @param {string} device @param {string} scene @returns {string} */
function pair(device, scene) {
  return JSON.stringify([device, scene]);
}
/** @param {SettingsState} state @returns {Record<string, unknown>} */
function effectiveValues(state) {
  return Object.fromEntries(
    Object.entries(state.values).map(([key, field]) => [key, field.effective]),
  );
}
/** @param {unknown} session @param {unknown} draft */
function checkDraft(session, draft) {
  if (
    typeof session !== "string" ||
    !session ||
    !Number.isSafeInteger(draft) ||
    Number(draft) < 0
  )
    throw new HttpError(
      400,
      "invalid_draft",
      "Expected a page session and a non-negative draft number",
    );
}
