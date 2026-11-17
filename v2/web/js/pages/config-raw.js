/* global HTMLButtonElement, HTMLTextAreaElement */
/**
 * Page: Raw config.json.
 * Approved mockups: pixd-config-{raw,error} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Line-number gutter and textarea, validity bar, 'Reload from disk', Save; the error line is marked and its message sits in a reserved line under the editor.
 *
 * The text is pixdcon's (GET /api/v2/config/raw); the bar checks it as
 * JSON while it is typed, and pixdcon checks it again before it writes
 * (PUT …/raw answers 400 invalid_config with line and column, and nothing
 * is written). One request at a time per button (build rule 2).
 *
 * Owner: UI worker.
 */

import { ApiError, request } from "../api.js";
import { icon, setHtml, setStatusLine } from "../dom.js";
import { clock, esc } from "../format.js";
import { applyAnswer, getState, subscribe } from "../store.js";
import { pageCondition } from "../view/model.js";

/** @type {HTMLElement|null} */
let root = null;
/** @type {(() => void)|null} */
let unsubscribe = null;
/** The text as pixdcon last gave it. */
let loaded = "";
let loading = true;
/** @type {string|null} */
let busy = null;
/** The reserved line under the editor: what the last Save or Reload said. @type {{text: string, bad: boolean}|null} */
let outcome = null;
/** Line marked in the gutter by pixdcon's answer. @type {number|null} */
let errorLine = null;

/**
 * Check the text as JSON, with the line and column of the first error.
 *
 * @param {string} text
 * @returns {{ok: true, devices: number, scenes: number}|{ok: false, message: string, line: number|null, column: number|null}}
 */
export function checkJson(text) {
  try {
    const value = JSON.parse(text);
    return {
      ok: true,
      devices: Array.isArray(value?.devices) ? value.devices.length : 0,
      scenes: value?.scenes && typeof value.scenes === "object" ? Object.keys(value.scenes).length : 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const where = /line (\d+) column (\d+)/.exec(message);
    const position = /position (\d+)/.exec(message);
    let line = where ? Number(where[1]) : null;
    let column = where ? Number(where[2]) : null;
    if (!where && position) {
      const before = text.slice(0, Number(position[1]));
      line = before.split("\n").length;
      column = before.length - before.lastIndexOf("\n");
    }
    return { ok: false, message: message.replace(/^JSON\.parse: /, ""), line, column };
  }
}

/** @param {import("../store.js").ClientState} state */
function render(state) {
  if (!root) return;
  const q = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (root).querySelector(selector));
  const config = state.config ?? {};
  const condition = pageCondition(state);
  setStatusLine(
    q(".head .sub"),
    condition && condition.cls === "bad"
      ? condition
      : config.valid === false
        ? {
            text: `config.json on disk is invalid (since ${clock(config.invalidSince)}) · pixdcon runs the version loaded at ${clock(config.loadedAt)}`,
            cls: "bad",
            icon: "alert",
          }
        : { text: `${config.path ?? "config.json"} · advanced: pixdcon checks the file before it writes it` },
  );
  const editor = /** @type {HTMLTextAreaElement} */ (q("textarea"));
  const text = editor.value;
  const check = checkJson(text);
  const changed = text !== loaded;
  const stateSlot = q(".edbar .state");
  if (loading) {
    stateSlot.className = "state";
    setHtml(stateSlot, `${icon("spinner")}<span>Loading config.json…</span>`);
  } else if (check.ok) {
    stateSlot.className = "state ok";
    setHtml(stateSlot, `${icon("check")}<span class="num">Valid · ${check.devices} ${check.devices === 1 ? "device" : "devices"} · ${check.scenes} ${check.scenes === 1 ? "scene" : "scenes"} · ${changed ? "unsaved changes" : "no unsaved changes"}</span>`);
  } else {
    stateSlot.className = "state bad";
    setHtml(stateSlot, `${icon("x")}<span class="num">${check.line ? `Line ${check.line}, column ${check.column}: ` : ""}${esc(check.message)}</span>`);
  }
  const save = /** @type {HTMLButtonElement} */ (q('[data-act="save"]'));
  save.disabled = loading || !check.ok || !changed || busy !== null || state.live.state === "lost";
  setHtml(save, busy === "save" ? `${icon("spinner")}Saving…` : `${icon("save")}Save`);
  const reload = /** @type {HTMLButtonElement} */ (q('[data-act="reload"]'));
  reload.disabled = busy !== null || state.live.state === "lost";
  setHtml(reload, busy === "reload" ? `${icon("spinner")}Reloading…` : `${icon("reload")}Reload from disk`);
  gutter(text, check.ok ? errorLine : (check.line ?? errorLine));
  setHtml(
    q(".errline"),
    outcome ? `${outcome.bad ? icon("alert") : icon("check")}<span${outcome.bad ? "" : ' style="color:var(--text-2)"'}>${esc(outcome.text)}</span>` : "",
  );
}

/**
 * @param {string} text
 * @param {number|null} marked
 */
function gutter(text, marked) {
  const lines = text.split("\n").length;
  let html = "";
  for (let i = 1; i <= lines; i += 1) html += i === marked ? `<b class="err">${i}</b>` : `<b>${i}</b>`;
  setHtml(/** @type {HTMLElement} */ (root?.querySelector(".gut")), html);
}

async function load() {
  loading = true;
  try {
    const answer = await request("GET", "/api/v2/config/raw", { resource: "config" });
    const editor = /** @type {HTMLTextAreaElement|null} */ (root?.querySelector("textarea") ?? null);
    loaded = String(answer.body?.text ?? "");
    if (editor) editor.value = loaded;
    applyAnswer(answer);
  } catch (error) {
    outcome = { text: `config.json could not be loaded: ${error instanceof ApiError ? error.message : "the request failed."}`, bad: true };
  }
  loading = false;
  redraw();
}

async function save() {
  const editor = /** @type {HTMLTextAreaElement|null} */ (root?.querySelector("textarea") ?? null);
  if (!editor || busy) return;
  const text = editor.value;
  busy = "save";
  outcome = null;
  errorLine = null;
  redraw();
  try {
    const answer = await request("PUT", "/api/v2/config/raw", {
      resource: "config",
      key: "raw-save",
      body: { text },
    });
    applyAnswer(answer);
    loaded = text;
    const diff = answer.body?.diff ?? {};
    const changed = [
      ...(diff.devicesAdded ?? []),
      ...(diff.devicesRemoved ?? []),
      ...Object.keys(diff.devicesChanged ?? {}),
    ];
    outcome = {
      text: changed.length
        ? `Saved · applied to ${changed.join(", ")}`
        : "Saved · nothing that runs changed",
      bad: false,
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_config") {
      errorLine = typeof error.extra.line === "number" ? error.extra.line : null;
      outcome = { text: `Not saved. ${error.message}`, bad: true };
    } else
      outcome = { text: `Not saved: ${error instanceof ApiError ? error.message : "the request failed."}`, bad: true };
  }
  busy = null;
  redraw();
}

async function reloadFromDisk() {
  if (busy) return;
  busy = "reload";
  outcome = null;
  redraw();
  try {
    applyAnswer(await request("POST", "/api/v2/config/reload", { resource: "config", key: "raw-reload", body: {} }));
    busy = null;
    await load();
    outcome = { text: "Reloaded from disk", bad: false };
  } catch (error) {
    outcome = { text: `Not reloaded: ${error instanceof ApiError ? error.message : "the request failed."}`, bad: true };
  }
  busy = null;
  redraw();
}

/** @param {Event} event */
function onClick(event) {
  const button = /** @type {HTMLElement} */ (event.target).closest?.("[data-act]");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  if (button.dataset.act === "save") void save();
  else if (button.dataset.act === "reload") void reloadFromDisk();
}

/** Draw again from the store after a local change. */
function redraw() {
  render(getState());
}

/** @param {Event} event */
function onInput(event) {
  if (!(event.target instanceof HTMLTextAreaElement)) return;
  outcome = null;
  errorLine = null;
  redraw();
}

/** @param {Event} event keep the gutter beside its lines */
function onScroll(event) {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  const gut = /** @type {HTMLElement|null} */ (root?.querySelector(".gut") ?? null);
  if (gut) gut.scrollTop = target.scrollTop;
}

/** @type {import("../router.js").Page} */
export const page = {
  mount(target, _params) {
    root = target;
    root.className = "p-raw";
    loaded = "";
    loading = true;
    busy = null;
    outcome = null;
    errorLine = null;
    root.innerHTML = `
  <a class="crumb" href="#/config">${icon("left")}Config</a>
  <div class="head"><h1 tabindex="-1">Raw config.json</h1><span class="sub" role="status"></span></div>
  <div class="edbar">
    <span class="state" role="status"></span>
    <button class="btn" type="button" data-act="reload">${icon("reload")}Reload from disk</button>
    <button class="btn primary" type="button" data-act="save" disabled>${icon("save")}Save</button>
  </div>
  <div class="ed"><pre class="gut" aria-hidden="true"></pre><textarea spellcheck="false" aria-label="config.json" aria-describedby="raw-err"></textarea></div>
  <div class="errline" id="raw-err" role="alert"></div>`;
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("scroll", onScroll, true);
    unsubscribe = subscribe((state) => state, render);
    void load();
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    if (root) {
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      root.removeEventListener("scroll", onScroll, true);
    }
    root = null;
  },
};
