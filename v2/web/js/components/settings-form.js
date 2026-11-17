/* global document, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLButtonElement */
/**
 * Component: scene settings (heading band and rows).
 * Approved mockups: pixd-device-{default,previewing,json-error,empty,error}.
 *
 * Heading band: title "Settings · <scene>", one description line, and a fixed
 * 340 px block with the slots [Clear N overlays] [Revert] [Save] and a
 * two-line status. Empty slots keep their width, so Save never moves.
 * Rows from the schema in v1's group order: label with range, control by
 * type, and a marker: default · saved (+ "Reset to default") · violet "from
 * MQTT overlay · saved 19" · blue "previewing · was 30".
 *
 * Behaviour (approved spec section 8, build rules 1 and 2):
 *  - a changed field is previewed on the display at once (PUT …/preview with
 *    this page's session); Revert and leaving the page end the preview
 *  - every edit raises the form's draft number, and the preview request
 *    carries it (`draft`); Save names the draft it commits
 *  - Save sends only the changed keys; while it runs the button shows its busy
 *    label and takes no second click, the fields stay editable, and edits made
 *    meanwhile become a new preview with a higher draft. The server keeps
 *    that newer preview when the Save finishes, and the form shows what the
 *    answer says is still previewed (`state.preview.draft`), so nothing
 *    typed after the click is thrown away (B-176)
 *  - a JSON field that does not parse shows its error in its reserved line, is
 *    not previewed and blocks Save (mockup pixd-device-json-error)
 *  - while the values of a newly chosen scene are loading: the heading stays
 *    and "Loading settings for <scene>" stands in the form's place; on
 *    failure "Settings could not be loaded" with Retry. Never an empty form,
 *    never a "default" badge on a value that was not read.
 *
 * Order: every answer (preview, save, revert, clear, load) is a
 * SettingsState and goes through the store's fence (decideView: epoch,
 * incarnation, rev); the form shows only what the store holds. An answer
 * for an older draft than the one on screen changes no field the user is
 * editing: the fields show the form's own edits until the store holds a
 * state whose preview draft is at least theirs.
 *
 * Operations (ops.js, the operation rule):
 *  - Save, Revert and Clear are user actions in the slot of the form's
 *    scope, `settings:<device>/<scene>@<epoch>/<incarnation>`: one busy
 *    owner, also for a form that opens while one runs; the outcome is kept
 *    in the slot and said beside Save, and the action stays to try again
 *  - the load of the values is `load:…` of the scope; values of the scope
 *    that arrive by another way (the live channel) make it obsolete, so a
 *    late failure of the load cannot take them off the screen
 *  - every preview request of a scene, from this form or the next one,
 *    runs in that scene's lane, one after the other in the order they
 *    were started: a preview (PUT), Revert's end and the end on leaving
 *    (DELETE). So an end never overtakes a newer preview, and a preview
 *    typed during Revert leaves after Revert's end. Each request is
 *    bounded in time (api.js); one that runs out fails and frees the lane
 *  - an end that fails is kept in the slot `end:<device>/<scene>`; the
 *    device page says it with Retry (failedEnds, retryEnd). A newer
 *    preview of the scene, or an end that works, replaces it
 *
 * Owner: UI worker.
 */

import { ApiError, request } from "../api.js";
import { esc, grouped } from "../format.js";
import { icon, setAttr, setClass, setHtml } from "../dom.js";
import { busy as slotBusy, clearNote, drop, failureText, follow, op, start } from "../ops.js";
import { applyAnswer, getState } from "../store.js";
import { createDraftBook } from "../view/drafts.js";

let ids = 0;

/** What a Save that worked says. */
const SAVED = "Saved to config.json";

/**
 * Parse what was typed into a field, by its type.
 *
 * @param {any} field SettingField
 * @param {string} raw
 * @param {boolean} [checked] for booleans
 * @returns {{value?: unknown, error?: string}}
 */
export function parseField(field, raw, checked) {
  switch (field?.type) {
    case "boolean":
      return { value: Boolean(checked) };
    case "int":
    case "float": {
      if (raw.trim() === "") return { error: "Enter a number." };
      const value = Number(raw);
      if (!Number.isFinite(value)) return { error: "Enter a number." };
      return { value: field.type === "int" ? Math.round(value) : value };
    }
    case "json":
      try {
        return { value: JSON.parse(raw) };
      } catch (error) {
        return {
          error: `Not valid JSON: ${error instanceof Error ? error.message.replace(/^JSON\.parse: /, "") : "it does not parse"}. Not previewed or saved until it parses.`,
        };
      }
    case "time":
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.trim())
        ? { value: raw.trim() }
        : { error: "Enter a time as HH:MM, 24-hour." };
    case "enum": {
      const option = (field.options ?? []).find(
        (/** @type {any} */ o) => String(typeof o === "object" ? o.value : o) === raw,
      );
      const value = option === undefined ? raw : typeof option === "object" ? option.value : option;
      return { value };
    }
    default:
      return { value: raw };
  }
}

/**
 * A value as the field shows it.
 *
 * @param {any} field
 * @param {unknown} value
 * @returns {string}
 */
export function showValue(field, value) {
  if (value === undefined || value === null) return "";
  if (field?.type === "json") return JSON.stringify(value);
  if (field?.type === "boolean") return value ? "on" : "off";
  return String(value);
}

/**
 * The marker text of a value: "19", "on", "#ff0000".
 *
 * @param {any} field
 * @param {unknown} value
 * @returns {string}
 */
function markValue(field, value) {
  if (field?.type === "boolean") return value ? "on" : "off";
  if (field?.type === "json") return "JSON";
  if (typeof value === "number") return String(value);
  return value === undefined || value === null || value === "" ? "empty" : String(value);
}

/**
 * The fields of a schema in v1's group order: groups in the order of their
 * first field, fields in schema order.
 *
 * @param {Record<string, any>} schema
 * @returns {Array<{group: string, keys: string[]}>}
 */
export function groupsOf(schema) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const [key, field] of Object.entries(schema ?? {})) {
    const group = field?.group || "General";
    if (!groups.has(group)) groups.set(group, []);
    /** @type {string[]} */ (groups.get(group)).push(key);
  }
  return [...groups].map(([group, keys]) => ({ group, keys }));
}

/**
 * The preview lanes, per "<device>/<scene>": the tail of the steps started
 * so far, from any form of the page (the page was left and opened again).
 *
 * @type {Map<string, Promise<void>>}
 */
const lanes = new Map();

/**
 * Run a step in a scene's lane: after every step started before it was
 * answered or ran out of time, and before every step started after it.
 * pixdcon gets the preview requests of a scene in the order the page
 * started them: an end (DELETE) before the next preview (PUT).
 *
 * @template T
 * @param {string} lane "<device>/<scene>"
 * @param {() => Promise<T>} step
 * @returns {Promise<T>}
 */
function enqueue(lane, step) {
  const before = lanes.get(lane);
  const result = (async () => {
    if (before) await before;
    return step();
  })();
  /** @type {Promise<void>} */
  const tail = (async () => {
    try {
      await result;
    } catch {
      // The step's own operation keeps its failure; the lane moves on.
    }
    if (lanes.get(lane) === tail) lanes.delete(lane);
  })();
  lanes.set(lane, tail);
  return result;
}

/** @param {string} device @param {string} scene */
const previewPath = (device, scene) =>
  `/api/v2/devices/${encodeURIComponent(device)}/settings/${encodeURIComponent(scene)}/preview`;

/**
 * The slot of the end of this page's preview of a scene, in one life of
 * the device: a restart of pixdcon or another incarnation of the device
 * ends every preview anyway, so an end that failed before it is moot.
 *
 * @param {string} device
 * @param {string} scene
 * @param {{epoch?: string|null, incarnation?: number|string|null}} life
 */
const endSlot = (device, scene, life) =>
  `end:${device}/${scene}@${life.epoch ?? ""}/${Number(life.incarnation ?? 0)}`;

/**
 * The ends of this page's previews that failed, for one life of a device:
 * what the device page says in its title status line, with Retry.
 *
 * @param {{name: string, epoch?: string|null, incarnation?: number|string|null}} view
 * @returns {Array<{scene: string, failure: string, busy: boolean}>}
 */
export function failedEnds(view) {
  const prefix = `end:${view.name}/`;
  const life = `@${view.epoch ?? ""}/${Number(view.incarnation ?? 0)}`;
  /** @type {Array<{scene: string, failure: string, busy: boolean}>} */
  const list = [];
  for (const [key, slot] of getState().ops) {
    if (!key.startsWith(prefix) || !key.endsWith(life)) continue;
    const scene = key.slice(prefix.length, key.length - life.length);
    if (slot.failure) list.push({ scene, failure: slot.failure, busy: false });
    else if (slot.busy && slot.value === "retry") list.push({ scene, failure: slot.label, busy: true });
  }
  return list;
}

/**
 * Retry a failed end (a person asked): in the scene's lane, and not sent
 * when a newer preview of the scene took its place meanwhile.
 *
 * @param {{name: string, epoch?: string|null, incarnation?: number|string|null}} view the device, in the life the end belongs to
 * @param {string} scene
 * @param {string|null} session
 */
export function retryEnd(view, scene, session) {
  if (!session) return;
  const device = view.name;
  const key = endSlot(device, scene, view);
  start(
    key,
    (current) =>
      enqueue(`${device}/${scene}`, async () => {
        if (!current()) return;
        applyAnswer(
          await request("DELETE", `${previewPath(device, scene)}?session=${encodeURIComponent(session)}`, {
            resource: `settings:${device}/${scene}`,
          }),
        );
      }),
    { value: "retry", label: op(key).failure ?? "" },
  );
}

/**
 * What the form shows, and everything that belongs to it: the scene, the
 * life of the device its values belong to (the epoch of the run and the
 * device's incarnation), the edits, the request that runs, the outcome of
 * the last action and of the last preview. Another scene, a restart of
 * pixdcon or another life of the device is another scope; an answer that
 * comes back for a scope that is no longer shown goes to the store (its
 * fence decides) and changes nothing else: no edit, no busy label, no
 * outcome, no status line (findings 2, 4, 5 of the first gate).
 *
 * @typedef {object} Scope
 * @property {string|null} scene
 * @property {string|null} epoch null: not said
 * @property {number} incarnation 0: not said
 * @property {ReturnType<typeof createDraftBook>} book what the user typed, numbered by the page's draft counter
 * @property {string|null} previewFailure why the last preview failed; null when it worked
 * @property {boolean} queued a preview step waits in the lane; it sends the newest draft when its turn comes
 * @property {boolean} previewed a preview of this scope was sent: pixdcon may hold one for this page
 * @property {boolean} left the form shows another scope now, or was left
 */

/**
 * @param {string|null} scene
 * @param {{epoch?: string|null, incarnation?: number}|undefined} life
 * @returns {Scope}
 */
function newScope(scene, life) {
  return {
    scene,
    epoch: life?.epoch ?? null,
    incarnation: Number(life?.incarnation ?? 0),
    book: createDraftBook(),
    previewFailure: null,
    queued: false,
    previewed: false,
    left: false,
  };
}

/**
 * @param {HTMLElement} host
 * @param {{device: string, session: string|(() => string|null), onPreviewFailure?: (message: string|null) => void}} options session: the page's id, or a function that answers it when a request is sent; onPreviewFailure: called when the last preview failed (its sentence) or works again (null), so the page says it in its title status line and on the Display line (B-175)
 * @returns {{setScene: (scene: string|null, name?: string, life?: {epoch?: string|null, incarnation?: number}) => void, update: (settingsState: any, context?: {frozen?: boolean, mqttConnected?: boolean, shadow?: boolean, configInvalid?: boolean, overlayOnly?: boolean, waiting?: string|null, builtin?: boolean}) => void, destroy: () => void, hasEdits: () => boolean, end: () => Promise<void>}}
 */
export function createSettingsForm(host, options) {
  const device = options.device;
  const session = () =>
    typeof options.session === "function" ? options.session() : options.session;
  /** @type {Scope} */
  let scope = newScope(null, undefined);
  let sceneLabel = "";
  /** @type {"none"|"builtin"|"loading"|"failed"|"ready"} */
  let phase = "none";
  let loadError = "";
  /** The SettingsState of the scope, as the store holds it. @type {any} */
  let current = null;
  /** @type {{frozen?: boolean, mqttConnected?: boolean, shadow?: boolean, configInvalid?: boolean, overlayOnly?: boolean, waiting?: string|null, builtin?: boolean}} */
  let context = {};
  let schemaSignature = "";
  /** key → the row's elements. @type {Map<string, {row: HTMLElement, input: HTMLElement, check?: HTMLElement, hex?: HTMLInputElement, error?: HTMLElement, marker: HTMLElement}>} */
  let rows = new Map();
  let destroyed = false;
  /** What onPreviewFailure was told last. @type {string|null} */
  let reported = null;

  host.innerHTML = `
    <div class="set-h">
      <div><h2 id="h-settings">Settings</h2><p class="set-desc"></p></div>
      <div>
        <div class="set-acts"><span class="slot-clear"></span><span class="slot-revert"></span><button class="btn primary" type="button" data-act="save" disabled title="Writes config.json and clears the MQTT overlay of each saved setting">${icon("save")}Save</button></div>
        <div class="set-status" role="status"></div>
      </div>
    </div>
    <div class="set-body"></div>`;
  const q = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (host.querySelector(selector));
  const title = q("#h-settings");
  const desc = q(".set-desc");
  const clearSlot = q(".slot-clear");
  const revertSlot = q(".slot-revert");
  const saveButton = /** @type {HTMLButtonElement} */ (q('[data-act="save"]'));
  const status = q(".set-status");
  const body = q(".set-body");

  const resource = (/** @type {Scope} */ of) => `settings:${device}/${of.scene}`;
  const base = (/** @type {Scope} */ of) =>
    `/api/v2/devices/${encodeURIComponent(device)}/settings/${encodeURIComponent(String(of.scene))}`;
  /** The scope as a slot key: the scene in one life of the device. */
  const scopeKey = (/** @type {Scope} */ of) => `${device}/${of.scene}@${of.epoch ?? ""}/${of.incarnation}`;
  /** Save, Revert and Clear: one busy owner per scope. */
  const actionKey = (/** @type {Scope} */ of) => `settings:${scopeKey(of)}`;
  const loadKey = (/** @type {Scope} */ of) => `load:${scopeKey(of)}`;
  const laneOf = (/** @type {Scope} */ of) => `${device}/${of.scene}`;
  const endKey = (/** @type {Scope} */ of) => endSlot(device, String(of.scene), of);
  /** Whether what came back for this scope may change the form: it is the one shown. */
  const shown = (/** @type {Scope} */ of) => !destroyed && of === scope;

  /** Tell the page when the last preview of the scope shown failed, or works again. */
  function report() {
    const failure = destroyed ? null : scope.previewFailure;
    if (failure === reported) return;
    reported = failure;
    options.onPreviewFailure?.(failure);
  }

  /**
   * The scope is no longer shown. When this page may hold a preview of it,
   * the preview ends (approved spec 8: switching away and leaving revert
   * what this page previewed): a step in the scene's lane, after the
   * scope's own preview requests. Whether there is anything to end is
   * decided when its turn comes: a preview of the scope was sent, the store
   * showed one of this page, or an earlier end of the scene failed. Its
   * failure is kept in `end:<device>/<scene>` (the device page says it,
   * with Retry); the lane moves on either way.
   *
   * @param {Scope} of
   * @returns {Promise<void>}
   */
  function leave(of) {
    of.left = true;
    const id = session();
    if (!id || !of.scene || of.scene.startsWith("builtin:")) return Promise.resolve();
    const held = of === scope && current?.preview?.session === id;
    return enqueue(laneOf(of), async () => {
      if (!of.previewed && !held && !op(endKey(of)).failure) return;
      try {
        await follow(endKey(of), async () =>
          applyAnswer(
            await request("DELETE", `${base(of)}/preview?session=${encodeURIComponent(id)}`, {
              resource: resource(of),
            }),
          ),
        );
      } catch {
        // Kept in the slot; the device page says it with Retry.
      }
    });
  }

  /**
   * The settings of the scene that is chosen now, from pixdcon (build rule
   * 1); Retry runs it again. The answer goes to the store, whose fence
   * decides; the page hands the store's state of the scope to update(),
   * which also makes the load obsolete once values of the scope are there.
   */
  function load() {
    const mine = scope;
    phase = "loading";
    loadError = "";
    render();
    follow(
      loadKey(mine),
      async () => applyAnswer(await request("GET", base(mine), { resource: resource(mine) })),
      {
        failed: (error) => {
          if (!shown(mine) || phase === "ready") return;
          phase = "failed";
          loadError = failureText(error);
          render();
        },
      },
    );
  }

  /**
   * One preview step, when its turn in the lane comes: the newest draft
   * with every edit that parses. What the answer rejects is marked on the
   * edits that were sent, not on ones typed since (finding 5). A preview
   * that worked is the one the page holds now: a failed end of the scene
   * is replaced by it.
   *
   * @param {Scope} of
   */
  async function sendPreview(of) {
    of.queued = false;
    const id = session();
    // Left while it waited: nothing is sent, and the end is behind it.
    if (of.left || !id) return;
    const plan = of.book.previewPlan(id);
    of.previewed = true;
    try {
      const answer = await request("PUT", `${base(of)}/preview`, {
        resource: resource(of),
        key: `preview:${device}/${of.scene}`,
        body: plan.body,
      });
      applyAnswer(answer);
      of.book.rejected(plan.sent, answer.body?.rejected);
      of.previewFailure = null;
      drop(endKey(of));
    } catch (error) {
      of.previewFailure = failureText(error);
    }
    if (!shown(of)) return;
    report();
    render();
  }

  /** Preview the form's edits: one step in the lane; edits typed while it waits go with it. */
  function preview() {
    const mine = scope;
    if (!session() || !mine.scene || mine.left || mine.queued) return;
    mine.queued = true;
    void enqueue(laneOf(mine), () => sendPreview(mine));
  }

  function save() {
    const mine = scope;
    const key = actionKey(mine);
    if (slotBusy(key)) return;
    const plan = mine.book.saveBody(session());
    if (!plan) return;
    start(
      key,
      async () => {
        const answer = await request("PUT", base(mine), { resource: resource(mine), key, body: plan.body });
        applyAnswer(answer);
        return answer;
      },
      {
        value: "save",
        label: "Saving…",
        done: (answer) => {
          // What was saved leaves the form; what was typed after the click stays.
          mine.book.saved(plan.committed, plan.body.reset);
          if (shown(mine) && mine.book.edits.size > 0) preview();
          const notCleared = answer.body?.overlaysNotCleared ?? [];
          return notCleared.length
            ? `Saved · ${notCleared.length} MQTT ${notCleared.length === 1 ? "overlay" : "overlays"} could not be cleared`
            : SAVED;
        },
        describe: (error) =>
          error instanceof ApiError && error.code === "overlay_only_device"
            ? "Not saved: this device is not in config.json. Add it to config.json first."
            : `Not saved: ${failureText(error)}`,
        // The display keeps showing what is typed: preview it again.
        failed: () => {
          if (shown(mine) && mine.book.edits.size > 0) preview();
        },
      },
    );
    render();
  }

  /**
   * Revert: what was typed goes, and the preview ends, in the scene's lane:
   * after the preview on its way, before any preview typed after the click
   * (which then leaves after the end and stays).
   */
  function revert() {
    const mine = scope;
    const key = actionKey(mine);
    if (slotBusy(key)) return;
    const id = session();
    mine.book.clear();
    start(
      key,
      () =>
        enqueue(laneOf(mine), async () => {
          applyAnswer(
            await request("DELETE", `${base(mine)}/preview${id ? `?session=${encodeURIComponent(id)}` : ""}`, {
              resource: resource(mine),
              key,
            }),
          );
          drop(endKey(mine));
        }),
      {
        value: "revert",
        label: "Reverting…",
        done: () => {
          mine.previewFailure = null;
          if (shown(mine)) report();
        },
        describe: (error) => `Not reverted: ${failureText(error)}`,
      },
    );
    render();
  }

  function clearOverlays() {
    const mine = scope;
    const key = actionKey(mine);
    start(
      key,
      async () => {
        const answer = await request("DELETE", `${base(mine)}/overlays`, { resource: resource(mine), key });
        applyAnswer(answer);
        return answer;
      },
      {
        value: "clear",
        label: "Clearing…",
        done: (answer) => {
          const failed = answer.body?.failed ?? [];
          return failed.length ? `${failed.length} could not be cleared` : null;
        },
        describe: (error) => `Not cleared: ${failureText(error)}`,
      },
    );
    render();
  }

  /** @param {string} key @param {any} field @returns {string} */
  function rowHtml(key, field) {
    const id = `sf-${++ids}`;
    // The format of a time field is its hint (Tick, default 7).
    const range =
      field.type === "time"
        ? `<span class="rng">HH:MM</span>`
        : field.min !== undefined && field.max !== undefined
          ? `<span class="rng">${esc(grouped(field.min))} – ${esc(grouped(field.max))}</span>`
          : "";
    const hint = field.description ? `<span class="hint2">${esc(field.description)}</span>` : "";
    let control;
    const placeholder = field.placeholder || (field.type === "string" ? "not set" : "");
    switch (field.type) {
      case "boolean":
        control = `<label class="check"><input id="${id}" type="checkbox" data-key="${esc(key)}" aria-describedby="${id}-src"><span class="t2"></span></label>`;
        break;
      case "int":
      case "float":
        control = `<input class="input mono num n" id="${id}" type="number" data-key="${esc(key)}"${field.min !== undefined ? ` min="${esc(field.min)}"` : ""}${field.max !== undefined ? ` max="${esc(field.max)}"` : ""}${field.type === "float" ? ' step="any"' : ""} aria-describedby="${id}-src">`;
        break;
      case "time":
        // A text field, so the time reads in 24-hour form whatever the
        // browser's locale (build note of the approval).
        control = `<input class="input mono num n" id="${id}" type="text" inputmode="numeric" placeholder="HH:MM" maxlength="5" data-key="${esc(key)}" aria-describedby="${id}-src">`;
        break;
      case "enum":
        control = `<span class="select" style="width:100%"><select id="${id}" data-key="${esc(key)}" aria-describedby="${id}-src">${(field.options ?? [])
          .map((/** @type {any} */ o) => {
            const value = typeof o === "object" ? o.value : o;
            const label = typeof o === "object" ? (o.label ?? o.value) : o;
            return `<option value="${esc(value)}">${esc(label)}</option>`;
          })
          .join("")}</select>${icon("down", "")}</span>`;
        break;
      case "color":
        control = `<input id="${id}" type="color" data-key="${esc(key)}" aria-describedby="${id}-src"><input class="input mono" type="text" data-hex="${esc(key)}" aria-label="${esc(field.label || key)}, hex" style="width:96px">`;
        break;
      case "json":
        control = `<div class="jbox"><textarea class="input mono json" id="${id}" rows="3" spellcheck="false" data-key="${esc(key)}" aria-describedby="${id}-src ${id}-err"></textarea><div class="jerr" id="${id}-err" role="alert"></div></div>`;
        break;
      default:
        control = `<input class="input mono" id="${id}" type="text" data-key="${esc(key)}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ""} aria-describedby="${id}-src">`;
    }
    // Why a value is not taken stands beside its field: the JSON box has its
    // own line under the text; every other control has it beside.
    const why = field.type === "json" ? "" : `<span class="ferr" id="${id}-err" role="alert"></span>`;
    return `<div class="fr${field.type === "json" ? " tall" : ""}" data-row="${esc(key)}"><label for="${id}">${esc(field.label || key)}${range}${hint}</label><div class="ctl">${control}${why}</div><div class="mk" id="${id}-src"></div></div>`;
  }

  /** Build the rows when the schema changed; values are written by render(). */
  function buildRows() {
    const schema = current?.schema ?? {};
    const signature = `${scope.scene}|${JSON.stringify(schema)}`;
    if (signature === schemaSignature) return;
    schemaSignature = signature;
    rows = new Map();
    const html = groupsOf(schema)
      .map(
        ({ group, keys }) =>
          `<div class="grp"><h3>${esc(group)}</h3>${keys.map((key) => rowHtml(key, schema[key])).join("")}</div>`,
      )
      .join("");
    // Through setHtml, so its record of what the body shows stays true: the
    // loading line of the same scene, after a restart, is written again.
    setHtml(body, html);
    for (const row of body.querySelectorAll("[data-row]")) {
      const key = /** @type {string} */ (row.getAttribute("data-row"));
      const input = /** @type {HTMLElement} */ (row.querySelector("[data-key]"));
      rows.set(key, {
        row: /** @type {HTMLElement} */ (row),
        input,
        check: /** @type {HTMLElement} */ (row.querySelector(".check .t2") ?? undefined),
        hex: /** @type {HTMLInputElement} */ (row.querySelector("[data-hex]") ?? undefined),
        error: /** @type {HTMLElement} */ (row.querySelector(".jerr, .ferr") ?? undefined),
        marker: /** @type {HTMLElement} */ (row.querySelector(".mk")),
      });
    }
  }

  /** @param {HTMLElement} input @param {any} field @param {unknown} value @param {string|undefined} raw */
  function writeInput(input, field, value, raw) {
    if (document.activeElement === input) return;
    if (input instanceof HTMLInputElement && input.type === "checkbox") {
      input.checked = Boolean(value);
      return;
    }
    const text = raw ?? (field.type === "json" ? JSON.stringify(value ?? null, null, 0) : value === undefined || value === null ? "" : String(value));
    if (
      input instanceof HTMLInputElement ||
      input instanceof HTMLTextAreaElement ||
      input instanceof HTMLSelectElement
    ) {
      if (input.value !== text) input.value = text;
    }
  }

  /**
   * Why an edit is not taken, beside its field: pixdcon's reason when it
   * refused the value (Tick Q2), else what the form found.
   *
   * @param {{error?: string, refused?: boolean}} edit
   * @returns {string}
   */
  function errorText(edit) {
    if (edit.refused) return edit.error ? `pixdcon refused this value: ${edit.error}` : "pixdcon refused this value.";
    return edit.error ?? "";
  }

  /**
   * The status line for the first edit that is not taken.
   *
   * @param {string} key
   * @param {{error?: string, refused?: boolean}} edit
   * @returns {string}
   */
  function errorLine(key, edit) {
    if (edit.refused && edit.error) return `pixdcon refused this value: ${edit.error}`;
    const field = current?.schema?.[key];
    const label = field?.label ?? key;
    if (field?.type === "json" || edit.refused)
      return `${label} is not valid JSON, so it is not previewed and nothing can be saved yet`;
    return `${label} is not valid, so it is not previewed and nothing can be saved yet`;
  }

  function render() {
    if (destroyed) return;
    const frozen = Boolean(context.frozen);
    const { book } = scope;
    const edits = book.edits;
    // Save, Revert and Clear of this scope, from its slot (ops.js): a form
    // that opens while one runs shows it busy; the outcome is kept there.
    const action = op(actionKey(scope));
    const busy = action.busy ? /** @type {string} */ (action.value) : null;
    // Heading
    if (phase === "none") {
      title.textContent = "Settings";
      desc.textContent = "Choose a scene to see its settings.";
    } else {
      title.textContent = `Settings · ${sceneLabel}`;
      desc.textContent =
        phase === "builtin"
          ? "Built-in modes are drawn by the display itself."
          : context.overlayOnly
            ? context.shadow
              ? "Changes show in the preview at once. Add the device to config.json to save them."
              : "Changes show on the display at once. Add the device to config.json to save them."
            : context.shadow
              ? "Changes show in the preview at once. Saving a setting writes config.json."
              : "Changes show on the display at once. Saving a setting writes config.json and clears its MQTT overlay.";
    }
    // Body
    if (phase === "none" || phase === "builtin") {
      setHtml(body, "");
      schemaSignature = "";
      rows = new Map();
    } else if (phase === "loading") {
      schemaSignature = "";
      rows = new Map();
      setHtml(body, `<div class="below">${icon("spinner")}Loading settings for ${esc(sceneLabel)}</div>`);
    } else if (phase === "failed") {
      schemaSignature = "";
      rows = new Map();
      setHtml(
        body,
        `<div class="below" style="color:var(--bad)">${icon("alert")}Settings could not be loaded: ${esc(loadError)} <button class="btn" type="button" data-act="retry">${icon("reload")}Retry</button></div>`,
      );
    } else if (current) {
      const keys = Object.keys(current.schema ?? {});
      if (keys.length === 0) {
        schemaSignature = "";
        rows = new Map();
        setHtml(body, "");
      } else {
        buildRows();
        for (const [key, parts] of rows) {
          const field = current.schema[key];
          const layer = current.values?.[key] ?? {};
          const edit = edits.get(key);
          /** The edit is not taken: it does not parse, or pixdcon refused it (also without a reason). */
          const bad = edit !== undefined && edit.error !== undefined;
          const shown = edit && !bad ? edit.value : edit ? undefined : layer.effective;
          writeInput(parts.input, field, shown, edit?.raw);
          if (parts.check) parts.check.textContent = (edit ? Boolean(edit.value) : Boolean(layer.effective)) ? "On" : "Off";
          if (parts.hex && document.activeElement !== parts.hex) parts.hex.value = String(shown ?? "");
          /** @type {HTMLInputElement} */ (parts.input).disabled = frozen;
          if (parts.error) setHtml(parts.error, bad && edit ? `${icon("alert")}<span>${esc(errorText(edit))}</span>` : "");
          setAttr(parts.input, "aria-invalid", bad ? "true" : null);
          const was = "saved" in layer ? layer.saved : layer.default;
          let marker;
          let changed = false;
          if (bad) marker = `<span class="bad">not previewed, not saved</span>`;
          else if (edit && scope.previewFailure) {
            // The last preview failed: this edit is not on the display (Tick Q1).
            changed = true;
            marker = `<span class="warn">not previewed · was ${esc(markValue(field, "overlay" in layer ? layer.overlay : was))}</span>`;
          } else if (edit || "preview" in layer) {
            changed = true;
            marker = `<span class="chg">previewing · was ${esc(markValue(field, "overlay" in layer ? layer.overlay : was))}</span>`;
          } else if ("overlay" in layer)
            marker = `<span class="ov">${icon("layers")}from MQTT overlay</span><span class="under">· ${"saved" in layer ? `saved ${esc(markValue(field, layer.saved))}` : `default ${esc(markValue(field, layer.default))}`}</span>`;
          else if ("saved" in layer)
            marker =
              JSON.stringify(layer.saved) !== JSON.stringify(layer.default)
                ? `<span class="saved">saved</span><button class="link" type="button" data-act="reset" data-key="${esc(key)}"${frozen ? " disabled" : ""}>Reset to default</button>`
                : `<span class="saved">saved</span>`;
          else marker = `<span class="dflt">default</span>`;
          setHtml(parts.marker, marker);
          setClass(parts.row, `fr${changed ? " changed" : ""}${field.type === "json" ? " tall" : ""}${bad ? " err" : ""}`);
        }
      }
    }
    // Actions and status
    const overlays = current
      ? Object.values(current.values ?? {}).filter((layer) => layer && "overlay" in layer).length
      : 0;
    const firstError = book.errors()[0];
    const changes = book.changes();
    const serverPreview =
      current?.preview && current.preview.session === session()
        ? Object.values(current.values ?? {}).filter((layer) => layer && "preview" in layer).length
        : 0;
    if (overlays > 0 && phase === "ready") {
      const disabled = frozen || context.mqttConnected === false || context.shadow;
      const reason = context.shadow
        ? "This display is in shadow: pixdcon does not write its topics"
        : context.mqttConnected === false
          ? "Clearing an overlay needs MQTT"
          : `Clears the MQTT overlay values of ${sceneLabel} on this device`;
      setHtml(
        clearSlot,
        `<button class="btn" type="button" data-act="clear"${disabled || busy ? " disabled" : ""} title="${esc(reason)}">${busy === "clear" ? `${icon("spinner")}Clearing…` : `${icon("x")}Clear ${overlays} ${overlays === 1 ? "overlay" : "overlays"}`}</button>`,
      );
    } else setHtml(clearSlot, "");
    if ((changes > 0 || serverPreview > 0 || busy === "revert") && phase === "ready")
      setHtml(
        revertSlot,
        `<button class="btn" type="button" data-act="revert"${busy || frozen ? " disabled" : ""} title="Puts the display back to the saved values">${busy === "revert" ? `${icon("spinner")}Reverting…` : `${icon("undo")}Revert`}</button>`,
      );
    else setHtml(revertSlot, "");
    const blocked = Boolean(context.configInvalid);
    saveButton.disabled =
      phase !== "ready" ||
      changes === 0 ||
      Boolean(firstError) ||
      blocked ||
      Boolean(context.overlayOnly) ||
      frozen ||
      busy !== null;
    saveButton.title = blocked
      ? "config.json is not valid JSON"
      : context.overlayOnly
        ? "This device is not in config.json: add it to config.json to save its settings"
        : "Writes config.json and clears the MQTT overlay of each saved setting";
    setHtml(saveButton, busy === "save" ? `${icon("spinner")}Saving…` : `${icon("save")}Save`);

    /** @type {{text: string, cls: string}} */
    let line;
    if (phase === "none") line = { text: "No scene chosen", cls: "" };
    else if (phase === "builtin") line = { text: "This scene has no settings", cls: "" };
    else if (phase === "loading") line = { text: "", cls: "" };
    else if (phase === "failed") line = { text: "", cls: "" };
    else if (current && Object.keys(current.schema ?? {}).length === 0)
      line = { text: "This scene has no settings", cls: "" };
    // Every failure is said beside the action (B-175), also while edits
    // are unsaved: a failed Save, Revert or Clear (kept in the scope's
    // slot until the next one), then a failed preview.
    else if (action.failure && !action.busy) line = { text: action.failure, cls: "warn" };
    else if (action.note && action.note !== SAVED && !action.busy) line = { text: action.note, cls: "warn" };
    else if (scope.previewFailure)
      line = { text: `Not previewed: ${scope.previewFailure}`, cls: "warn" };
    else if (firstError)
      line = { text: errorLine(firstError[0], firstError[1]), cls: "chg warn" };
    else if (blocked) line = { text: "Saving is blocked until config.json is valid JSON again", cls: "warn" };
    else if (action.note && changes === 0) line = { text: action.note, cls: "" };
    else if (changes > 0 || serverPreview > 0) {
      const n = Math.max(changes, serverPreview);
      line = {
        text: `Previewing ${n} ${n === 1 ? "change" : "changes"} · not saved; leaving this page reverts them`,
        cls: "chg",
      };
    } else if (context.overlayOnly)
      line = { text: "Changes are applied but not saved", cls: "" };
    else line = { text: "No unsaved changes", cls: "" };
    setClass(status, `set-status${line.cls ? ` ${line.cls}` : ""}`);
    const waiting = context.waiting
      ? `<br><span class="t3" style="font-weight:400">${esc(context.waiting.replace(/ · Overlays$/, ""))} · <a class="link" style="font-size:12px;height:18px" href="#/overlays">Overlays</a></span>`
      : "";
    setHtml(status, `${esc(line.text)}${waiting}`);
  }

  /** @param {Event} event */
  function onEdit(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const hexKey = target.getAttribute?.("data-hex");
    const key = hexKey ?? target.getAttribute?.("data-key");
    if (!key || !current?.schema?.[key]) return;
    const field = current.schema[key];
    if (event.type === "input" && (field.type === "boolean" || field.type === "enum")) return;
    if (event.type === "change" && !(field.type === "boolean" || field.type === "enum" || field.type === "color")) return;
    const input = /** @type {HTMLInputElement} */ (target);
    const raw = input.value ?? "";
    const parsed = parseField(field, raw, input.checked);
    scope.book.edit(key, raw, parsed);
    // A new edit: what the last success said goes; a failure stays (rule 3).
    clearNote(actionKey(scope));
    render();
    if (!parsed.error) preview();
  }

  /** @param {Event} event */
  function onClick(event) {
    const button = /** @type {HTMLElement} */ (event.target).closest?.("[data-act]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    switch (button.dataset.act) {
      case "save":
        save();
        break;
      case "revert":
        revert();
        break;
      case "clear":
        clearOverlays();
        break;
      case "retry":
        load();
        break;
      case "reset": {
        const key = String(button.dataset.key);
        const field = current?.schema?.[key];
        const layer = current?.values?.[key];
        if (!field || !layer) return;
        scope.book.reset(
          key,
          layer.default,
          field.type === "json" ? JSON.stringify(layer.default) : showValue(field, layer.default),
        );
        render();
        preview();
        break;
      }
    }
  }

  host.addEventListener("input", onEdit);
  host.addEventListener("change", onEdit);
  host.addEventListener("click", onClick);

  return {
    /**
     * The scene the form shows, and the life of the device it belongs to.
     * Another scene, epoch or incarnation is another scope: what the user
     * typed for the one before is gone, the preview this page holds of it
     * ends, and the values are loaded again (finding 2: the store throws
     * away what it held of the run or the device before; so does the form).
     */
    setScene(next, name, life) {
      const label = name ?? next ?? "";
      const epoch = life?.epoch ?? null;
      const incarnation = Number(life?.incarnation ?? 0);
      if (next === scope.scene && epoch === scope.epoch && incarnation === scope.incarnation) {
        if (label !== sceneLabel) {
          sceneLabel = label;
          render();
        }
        return;
      }
      void leave(scope);
      drop(loadKey(scope));
      scope = newScope(next, { epoch, incarnation });
      sceneLabel = label;
      current = null;
      loadError = "";
      schemaSignature = "";
      report();
      if (next === null || next === "") {
        phase = "none";
        render();
      } else if (next.startsWith("builtin:")) {
        phase = "builtin";
        render();
      } else void load();
    },
    update(settingsState, nextContext = {}) {
      context = nextContext;
      const scene = scope.scene;
      const life = Number(settingsState?.incarnation ?? 0);
      if (
        scene &&
        !scene.startsWith("builtin:") &&
        settingsState &&
        settingsState.scene === scene &&
        (scope.epoch === null || settingsState.epoch === scope.epoch) &&
        (scope.incarnation === 0 || life === 0 || life === scope.incarnation)
      ) {
        current = settingsState;
        phase = "ready";
        // Values of the scope are here: its load is no longer wanted, and
        // a late failure of it changes nothing (the operation rule, 2).
        drop(loadKey(scope));
      }
      render();
    },
    destroy() {
      destroyed = true;
      drop(loadKey(scope));
      host.removeEventListener("input", onEdit);
      host.removeEventListener("change", onEdit);
      host.removeEventListener("click", onClick);
      host.replaceChildren();
    },
    hasEdits: () => scope.book.edits.size > 0,
    /** Leaving the page ends what it previewed (approved spec 8); scopes left before ended when they were left. */
    end() {
      return leave(scope);
    },
  };
}
