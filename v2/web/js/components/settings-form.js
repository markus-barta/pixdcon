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
 * Owner: UI worker.
 */

import { ApiError, request } from "../api.js";
import { esc, grouped } from "../format.js";
import { icon, setAttr, setClass, setHtml } from "../dom.js";
import { applyAnswer } from "../store.js";
import { createDraftBook } from "../view/drafts.js";

let ids = 0;

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
 * Ends of previews on their way, per "<device>/<scene>": a preview of the
 * same scene, from this form or from the next one (the page was left and
 * opened again), is sent only after the end, so the end can never overtake
 * it and end the newer preview.
 *
 * @type {Map<string, Promise<void>>}
 */
const ending = new Map();

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
 * @property {string|null} busy "save" | "revert" | "clear" while that request runs
 * @property {{text: string, cls: string, failed: boolean}|null} outcome the last outcome of Save, Revert or Clear
 * @property {string|null} previewFailure why the last preview failed; null when it worked
 * @property {Promise<void>|null} running the preview request on its way
 * @property {boolean} previewAgain an edit came while a preview ran: send the newest draft after it
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
    busy: null,
    outcome: null,
    previewFailure: null,
    running: null,
    previewAgain: false,
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
   * what this page previewed), after the scope's own preview request and
   * after an end of the same scene that is on its way.
   *
   * @param {Scope} of
   * @returns {Promise<void>}
   */
  function leave(of) {
    of.left = true;
    const id = session();
    if (!id || !of.scene || of.scene.startsWith("builtin:")) return Promise.resolve();
    const held = of === scope && current?.preview?.session === id;
    if (!of.previewed && !of.running && !held) return Promise.resolve();
    const key = `${device}/${of.scene}`;
    const before = [of.running, ending.get(key)];
    /** @type {Promise<void>} */
    const done = (async () => {
      await Promise.all(before);
      try {
        applyAnswer(
          await request("DELETE", `${base(of)}/preview?session=${encodeURIComponent(id)}`, {
            resource: resource(of),
          }),
        );
      } catch {
        // The server ends it 5 s after the page's stream is gone (preview rule 2).
      }
      if (ending.get(key) === done) ending.delete(key);
    })();
    ending.set(key, done);
    return done;
  }

  /** The settings of the scene that is chosen now, from pixdcon (build rule 1). */
  async function load() {
    const mine = scope;
    phase = "loading";
    render();
    try {
      // The store's fence decides; the form shows what the store holds for
      // its scope, and the page hands that to update().
      applyAnswer(await request("GET", base(mine), { resource: resource(mine) }));
    } catch (error) {
      if (!shown(mine)) return;
      phase = "failed";
      loadError = error instanceof ApiError ? error.message : "The request failed.";
      render();
    }
  }

  /**
   * One preview request: the newest draft with every edit that parses.
   * What the answer rejects is marked on the edits that were sent, not on
   * ones typed since (finding 5).
   *
   * @param {Scope} of
   * @param {string} id
   */
  async function sendPreview(of, id) {
    of.previewed = true;
    await ending.get(`${device}/${of.scene}`);
    // Left while it waited: its end is queued behind it, so nothing is sent.
    if (of.left) return;
    const plan = of.book.previewPlan(id);
    try {
      const answer = await request("PUT", `${base(of)}/preview`, {
        resource: resource(of),
        key: `preview:${device}/${of.scene}`,
        body: plan.body,
      });
      applyAnswer(answer);
      of.book.rejected(plan.sent, answer.body?.rejected);
      of.previewFailure = null;
    } catch (error) {
      of.previewFailure =
        error instanceof ApiError ? error.message : "The request failed.";
    }
  }

  /** Send the form's edits as the preview, with the newest draft. One request at a time. */
  async function preview() {
    const mine = scope;
    if (mine.running) {
      mine.previewAgain = true;
      return;
    }
    const id = session();
    if (!id || !mine.scene || mine.left) return;
    mine.previewAgain = false;
    mine.running = sendPreview(mine, id);
    await mine.running;
    mine.running = null;
    if (!shown(mine)) return;
    report();
    render();
    if (mine.previewAgain) void preview();
  }

  async function save() {
    const mine = scope;
    if (mine.busy) return;
    const plan = mine.book.saveBody(session());
    if (!plan) return;
    mine.busy = "save";
    mine.outcome = null;
    render();
    try {
      const answer = await request("PUT", base(mine), {
        resource: resource(mine),
        key: `save:${device}/${mine.scene}`,
        body: plan.body,
      });
      applyAnswer(answer);
      // What was saved leaves the form; what was typed after the click stays.
      mine.book.saved(plan.committed, plan.body.reset);
      const notCleared = answer.body?.overlaysNotCleared ?? [];
      mine.outcome = notCleared.length
        ? {
            text: `Saved · ${notCleared.length} MQTT ${notCleared.length === 1 ? "overlay" : "overlays"} could not be cleared`,
            cls: "warn",
            failed: true,
          }
        : { text: "Saved to config.json", cls: "", failed: false };
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "The request failed.";
      mine.outcome = {
        text:
          error instanceof ApiError && error.code === "overlay_only_device"
            ? "Not saved: this device is not in config.json. Add it to config.json first."
            : `Not saved: ${message}`,
        cls: "warn",
        failed: true,
      };
    }
    mine.busy = null;
    if (!shown(mine)) return;
    render();
    if (mine.book.edits.size > 0) void preview();
  }

  async function revert() {
    const mine = scope;
    if (mine.busy) return;
    const id = session();
    mine.busy = "revert";
    mine.book.clear();
    mine.outcome = null;
    render();
    try {
      const answer = await request(
        "DELETE",
        `${base(mine)}/preview${id ? `?session=${encodeURIComponent(id)}` : ""}`,
        { resource: resource(mine), key: `revert:${device}/${mine.scene}` },
      );
      applyAnswer(answer);
      mine.previewFailure = null;
    } catch (error) {
      mine.outcome = {
        text: `Not reverted: ${error instanceof ApiError ? error.message : "the request failed."}`,
        cls: "warn",
        failed: true,
      };
    }
    mine.busy = null;
    if (!shown(mine)) return;
    report();
    render();
  }

  async function clearOverlays() {
    const mine = scope;
    if (mine.busy) return;
    mine.busy = "clear";
    mine.outcome = null;
    render();
    try {
      const answer = await request("DELETE", `${base(mine)}/overlays`, {
        resource: resource(mine),
        key: `clear:${device}/${mine.scene}`,
      });
      applyAnswer(answer);
      const failed = answer.body?.failed ?? [];
      if (failed.length)
        mine.outcome = { text: `${failed.length} could not be cleared`, cls: "warn", failed: true };
    } catch (error) {
      mine.outcome = {
        text: `Not cleared: ${error instanceof ApiError ? error.message : "the request failed."}`,
        cls: "warn",
        failed: true,
      };
    }
    mine.busy = null;
    if (!shown(mine)) return;
    render();
  }

  /** @param {string} key @param {any} field @returns {string} */
  function rowHtml(key, field) {
    const id = `sf-${++ids}`;
    const range =
      field.min !== undefined && field.max !== undefined
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
    return `<div class="fr${field.type === "json" ? " tall" : ""}" data-row="${esc(key)}"><label for="${id}">${esc(field.label || key)}${range}${hint}</label><div class="ctl">${control}</div><div class="mk" id="${id}-src"></div></div>`;
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
        error: /** @type {HTMLElement} */ (row.querySelector(".jerr") ?? undefined),
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

  function render() {
    if (destroyed) return;
    const frozen = Boolean(context.frozen);
    const { book, busy, outcome } = scope;
    const edits = book.edits;
    // Heading
    if (phase === "none") {
      title.textContent = "Settings";
      desc.textContent = "Choose a scene to see its settings.";
    } else {
      title.textContent = `Settings · ${sceneLabel}`;
      desc.textContent =
        phase === "builtin"
          ? "Built-in modes are drawn by the display itself."
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
          const shown = edit && !edit.error ? edit.value : edit ? undefined : layer.effective;
          writeInput(parts.input, field, shown, edit?.raw);
          if (parts.check) parts.check.textContent = (edit ? Boolean(edit.value) : Boolean(layer.effective)) ? "On" : "Off";
          if (parts.hex && document.activeElement !== parts.hex) parts.hex.value = String(shown ?? "");
          /** @type {HTMLInputElement} */ (parts.input).disabled = frozen;
          if (parts.error) setHtml(parts.error, edit?.error ? `${icon("alert")}<span>${esc(edit.error)}</span>` : "");
          if (parts.input instanceof HTMLTextAreaElement) setAttr(parts.input, "aria-invalid", edit?.error ? "true" : null);
          const was = "saved" in layer ? layer.saved : layer.default;
          let marker;
          let changed = false;
          if (edit?.error) marker = `<span class="bad">not previewed, not saved</span>`;
          else if (edit || "preview" in layer) {
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
          setClass(parts.row, `fr${changed ? " changed" : ""}${field.type === "json" ? " tall" : ""}${edit?.error ? " err" : ""}`);
        }
      }
    }
    // Actions and status
    const overlays = current
      ? Object.values(current.values ?? {}).filter((layer) => layer && "overlay" in layer).length
      : 0;
    const jsonError = book.errors()[0];
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
      Boolean(jsonError) ||
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
    // are unsaved: a failed Save, Revert or Clear, then a failed preview.
    else if (outcome?.failed) line = outcome;
    else if (scope.previewFailure)
      line = { text: `Not previewed: ${scope.previewFailure}`, cls: "warn" };
    else if (jsonError)
      line = {
        text: `${current?.schema?.[jsonError[0]]?.label ?? jsonError[0]} is not valid JSON, so it is not previewed and nothing can be saved yet`,
        cls: "chg warn",
      };
    else if (blocked) line = { text: "Saving is blocked until config.json is valid JSON again", cls: "warn" };
    else if (outcome && changes === 0) line = outcome;
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
    if (!scope.outcome?.failed) scope.outcome = null;
    render();
    if (!parsed.error) void preview();
  }

  /** @param {Event} event */
  function onClick(event) {
    const button = /** @type {HTMLElement} */ (event.target).closest?.("[data-act]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    switch (button.dataset.act) {
      case "save":
        void save();
        break;
      case "revert":
        void revert();
        break;
      case "clear":
        void clearOverlays();
        break;
      case "retry":
        void load();
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
        void preview();
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
      }
      render();
    },
    destroy() {
      destroyed = true;
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
