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
 * Order (finding 1 of the first and second gate): every request belongs
 * to the opening of the page it was sent from (`opened`); what comes back
 * after the page was left, or left and opened again, changes nothing on
 * it. The text of an answer reaches the editor only after the store's
 * fence took the answer's state (the newest request for "config", not
 * standing before the copy the page holds), and only while the editor is
 * still at the revision the load started from (`revision`, raised by every
 * input): what was typed since stays. A load that is asked again (its
 * answer stood before the copy the page holds) keeps that revision.
 * A newer config event replaces the read of an untouched editor through
 * ops.observeResource; equal reconnect snapshots keep the existing read.
 *
 * Operations (ops.js): the loads are one slot, `raw-load`, where the newest
 * load makes older ones obsolete; Save and Reload are `raw-save` and
 * `raw-reload` (busy across openings). The line under the editor says the
 * newest outcome of the three; a failure stays there until the next one.
 *
 * Owner: UI worker.
 */

import { ApiError, request } from "../api.js";
import { capture, clearNote, dropOwn as drop, effect, failureText, follow, forgetIdle, observeResource, op, start } from "../ops.js";
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
/** Line marked in the gutter by pixdcon's answer. @type {number|null} */
let errorLine = null;
/** Counts the openings of the page; a request answers to the opening it was sent from. */
let opened = 0;
/** The editor's revision in this opening: raised by every input. */
let revision = 0;
/** Epoch whose opening load supplies the editor. @type {string|null} */
let epoch = null;
/**
 * Where a load started: the opening and the editor's revision then. A load
 * that is asked again keeps it (rule 6), so what was typed after the first
 * request left is never replaced by the text of the retry.
 * The non-enumerable owner is immutable capture metadata, shared by retries.
 *
 * @typedef {{opened: number, revision: number, owner?: import("../ops.js").Ownership}} Base
 */
/** A load whose answer the store did not take: asked again, from the same base, when the store changes next. @type {Base|null} */
let again = null;
const SLOTS = ["raw-load", "raw-save", "raw-reload"];

/** @returns {HTMLTextAreaElement|null} */
const editorOf = () =>
  /** @type {HTMLTextAreaElement|null} */ (root?.querySelector("textarea") ?? null);

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
  if (state.epoch !== epoch) {
    epoch = state.epoch;
    again = null;
    errorLine = null;
    load();
  }
  const saving = op("raw-save");
  const reloading = op("raw-reload");
  if (again && state.loaded && !saving.busy && !reloading.busy) {
    const base = again;
    again = null;
    load(base);
  }
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
  const working = saving.busy || reloading.busy;
  save.disabled = loading || !check.ok || !changed || working || state.live.state === "lost";
  setHtml(save, saving.busy ? `${icon("spinner")}Saving…` : `${icon("save")}Save`);
  const reload = /** @type {HTMLButtonElement} */ (q('[data-act="reload"]'));
  reload.disabled = working || state.live.state === "lost";
  setHtml(reload, reloading.busy ? `${icon("spinner")}Reloading…` : `${icon("reload")}Reload from disk`);
  gutter(text, check.ok ? errorLine : (check.line ?? errorLine));
  // The newest outcome of a load, Save or Reload (the highest token).
  const said = SLOTS.map((key) => op(key))
    .filter((slot) => !slot.busy && (slot.failure || slot.note))
    .sort((a, b) => b.token - a.token)[0];
  const bad = Boolean(said?.failure);
  setHtml(
    q(".errline"),
    said ? `${bad ? icon("alert") : icon("check")}<span${bad ? "" : ' style="color:var(--text-2)"'}>${esc(said.failure ?? said.note ?? "")}</span>` : "",
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

/**
 * Ask pixdcon for the text, in the slot `raw-load`: a newer load makes
 * this one obsolete, so its late answer or failure changes nothing.
 *
 * @param {Base} [base] where the load started; a retry passes its own on
 * @param {number} [tries] answers that stood before the copy the page holds, so far
 */
function load(base = { opened, revision }, tries = 0) {
  if (!base.owner) Object.defineProperty(base, "owner", {
    value: capture({ opening: () => opened, revision: () => revision }),
  });
  loading = true;
  follow(
    "raw-load",
    async () => {
      const answer = await request("GET", "/api/v2/config/raw", { resource: "config" });
      // The fence first: the text and the state of one answer go together.
      return { answer, decision: applyAnswer(answer) };
    },
    {
      owner: base.owner,
      done: ({ answer, decision }) => {
        if (base.opened !== opened || !root) return;
        if (decision.action === "apply") {
          takeText(answer, base);
          return;
        }
        // A newer request of this page brings the text (Reload from disk).
        if (decision.reason === "superseded_source") return;
        // The page holds a newer copy of the config: the file changed after
        // this answer was built. Ask again, from the same base.
        if (decision.reason === "not_newer" && tries < 3) load(base, tries + 1);
        else again = base;
      },
      describe: (error) => `config.json could not be loaded: ${failureText(error)}`,
      failed: () => {
        if (base.opened !== opened || !root) return;
        loading = false;
        redraw();
      },
    },
  );
}

/**
 * The text of an answer the store took: it is pixdcon's copy now, and it
 * goes into the editor only while the editor is at the revision the load
 * started from.
 *
 * @param {import("../api.js").Answer} answer
 * @param {Base} base
 */
function takeText(answer, base) {
  loaded = String(answer.body?.text ?? "");
  const editor = editorOf();
  effect(/** @type {import("../ops.js").Ownership} */ (base.owner), ["epoch", "opening", "revision"], () => {
    if (editor && base.opened === opened && base.revision === revision) editor.value = loaded;
  });
  loading = false;
  redraw();
}

function save() {
  const editor = editorOf();
  if (!editor) return;
  const mine = opened;
  const owner = capture({ opening: () => opened, revision: () => revision });
  const text = editor.value;
  const started = start(
    "raw-save",
    async () => {
      const answer = await request("PUT", "/api/v2/config/raw", {
        resource: "config",
        key: "raw-save",
        body: { text },
      });
      applyAnswer(answer);
      return answer;
    },
    {
      owner,
      label: "Saving…",
      done: (answer) => {
        effect(owner, ["epoch", "opening"], () => {
          if (mine === opened && root) loaded = text;
        });
        const diff = answer.body?.diff ?? {};
        const changed = [
          ...(diff.devicesAdded ?? []),
          ...(diff.devicesRemoved ?? []),
          ...Object.keys(diff.devicesChanged ?? {}),
        ];
        return changed.length
          ? `Saved · applied to ${changed.join(", ")}`
          : "Saved · nothing that runs changed";
      },
      describe: (error) =>
        error instanceof ApiError && error.code === "invalid_config"
          ? `Not saved. ${error.message}`
          : `Not saved: ${failureText(error)}`,
      failed: (error) => {
        if (mine !== opened || !root) return;
        effect(owner, ["epoch", "opening", "revision"], () => {
          if (error instanceof ApiError && error.code === "invalid_config")
            errorLine = typeof error.extra.line === "number" ? error.extra.line : null;
        });
      },
    },
  );
  if (started) errorLine = null;
  redraw();
}

/**
 * Reload from disk, then the text: one operation in `raw-reload`. The load
 * it brings takes the place of any load still on its way (`raw-load` is
 * dropped), so an older load's late answer or failure says nothing.
 */
function reloadFromDisk() {
  const owner = capture({ opening: () => opened, revision: () => revision });
  const base = { opened, revision, owner };
  const superseded = op("raw-load").token;
  start(
    "raw-reload",
    async (current) => {
      applyAnswer(await request("POST", "/api/v2/config/reload", { resource: "config", key: "raw-reload", body: {} }));
      if (!current(["epoch", "opening"])) return;
      drop("raw-load", superseded);
      const answer = await request("GET", "/api/v2/config/raw", { resource: "config" });
      if (!current(["epoch", "opening"])) return;
      if (applyAnswer(answer).action === "apply" && base.opened === opened && root) takeText(answer, base);
      else if (base.opened === opened) loading = false;
    },
    {
      owner,
      label: "Reloading…",
      done: () => "Reloaded from disk",
      describe: (error) => `Not reloaded: ${failureText(error)}`,
    },
  );
  redraw();
}

/** @param {Event} event */
function onClick(event) {
  const button = /** @type {HTMLElement} */ (event.target).closest?.("[data-act]");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  if (button.dataset.act === "save") save();
  else if (button.dataset.act === "reload") reloadFromDisk();
}

/** Draw again from the store after a local change. */
function redraw() {
  render(getState());
}

/** @param {Event} event */
function onInput(event) {
  if (!(event.target instanceof HTMLTextAreaElement)) return;
  revision += 1;
  errorLine = null;
  // What the last success said goes; a failure stays until the next try.
  for (const key of SLOTS) clearNote(key);
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
    opened += 1;
    root = target;
    root.className = "p-raw";
    again = null;
    loaded = "";
    loading = true;
    revision = 0;
    epoch = getState().epoch;
    errorLine = null;
    // A fresh opening says nothing of the last one; a Save or Reload that
    // still runs keeps its slot (busy), and says its outcome when it comes.
    forgetIdle((key) => SLOTS.includes(key));
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
    // A newer streamed config replaces an untouched editor's read even when
    // its old request fails. Typed text stays under its captured revision.
    const unobserve = observeResource("config", () => load(), {
      eligible: () => editorOf()?.value === loaded,
      slots: ["raw-load", "raw-reload"],
    });
    unsubscribe = subscribe((state) => state, render);
    load();
    const unrender = unsubscribe;
    unsubscribe = () => { unobserve(); unrender(); };
  },
  unmount() {
    opened += 1;
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
