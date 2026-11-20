/* global document, HTMLSelectElement, HTMLButtonElement, HTMLFormElement, HTMLInputElement */
/**
 * Page: Devices overview, the remote control (PIXD-114, package 1).
 * Approved mockups: pixd-devices-{default,loading,empty,stale,offline,error,disconnected} (PIXD-81, -v1-approved-2026-11-16);
 * the rows as PIXD-114 draws them (mockups/devices-{desktop,phone}-{light,dark}).
 * States without a mockup, as Tick decided them (tick-states-0030.md):
 * a device in shadow (item 7: neutral filled dot, "Shadow · not driving the
 * display" with the reason in the tooltip, counted separately in the title
 * line; its controls stay usable) and a device that exists only in the MQTT
 * config overlay (item 8: "from the MQTT config overlay · not saved" under
 * the name).
 *
 * One row per display, in config order: preview (click enlarges), name with
 * one status line, scene select, Play/Pause/Stop, Auto with slider and
 * value, open. 'Add device' in the title line and as the empty state.
 *
 * Every row is 120 px in every state (B7), and every cell is one control
 * with one reserved line under it (A1): nothing moves when a status, a busy
 * label or a failure appears. Values are written into their slots only when
 * they changed. Each control is an operation (ops.js) in the slot of the
 * device's life, the same slot and the same request the Device page uses:
 * `scene:`, `mode:`, `brightness:` and `restore:<device>@<epoch>/<incarnation>`.
 * Whichever page started one, both show it busy, a second start is ignored
 * before anything is said (B-176), and its outcome is shown only while it
 * is the slot's current one. Answers go through the store's fence. A
 * failure stays beside its control, which stays for a retry (B-175, C3):
 * "Not switched: …" in the select's line, "Not paused: …" under the mode
 * buttons, "Not changed: …" under the slider, "Not restored: …" before its
 * button. After a switch in the select, its line offers "Switched from X ·
 * Undo" for 15 s from the moment pixdcon made the switch (C1), bound to the
 * choice it made: pixdcon's stamp of it (`choice.chosenAt`) in the switch's
 * own answer. A newer choice from any page or tab, also of the same scene,
 * drops the offer. A click checks the 15 s again on the browser's clock,
 * then reads the device again and sends the switch back only while that
 * choice still stands; otherwise it sends nothing and the offer goes.
 *
 * Owner: UI worker.
 */

import { request } from "../api.js";
import { createPixelPreview } from "../components/pixel-preview.js";
import { dot, icon, setAttr, setClass, setHtml, setStatusLine } from "../dom.js";
import { esc, failureMessage, percent } from "../format.js";
import { deviceSlot, forgetIdle, op, start } from "../ops.js";
import { applyAnswer, getState, subscribe } from "../store.js";
import {
  MODE_REFUSED,
  brightnessCell,
  deviceCell,
  deviceTitle,
  devicesSummary,
  modeCell,
  pageCondition,
  previewState,
  rowStatus,
  sceneChoices,
  sceneLine,
  sceneName,
  sizeOf,
} from "../view/model.js";

/**
 * @typedef {object} Row
 * @property {HTMLElement} el
 * @property {HTMLElement} pvLink
 * @property {ReturnType<typeof createPixelPreview>} preview
 * @property {string} type
 * @property {HTMLAnchorElement} name
 * @property {HTMLElement} status the status line under the name
 * @property {HTMLElement} note Tick's item 8 line, empty for other devices
 * @property {HTMLSelectElement} select
 * @property {string} options signature of the options in the select
 * @property {HTMLElement} sceneLine
 * @property {HTMLElement} modes the Play/Pause/Stop group
 * @property {HTMLButtonElement[]} modeButtons
 * @property {HTMLElement} modeLine
 * @property {HTMLElement} brightness the Auto, slider and value group
 * @property {HTMLButtonElement} auto
 * @property {HTMLInputElement} range
 * @property {HTMLElement} value
 * @property {HTMLElement} brightnessLine
 * @property {HTMLAnchorElement} open
 */

/** @type {HTMLElement|null} */
let root = null;
/** @type {(() => void)|null} */
let unsubscribe = null;
/** @type {Map<string, Row>} */
let rows = new Map();
/**
 * Levels typed on a row's slider and not yet sent, by the brightness slot of
 * the device's life: dragging shows its level beside the slider, letting go
 * (`change`) sends it, and from then on the slot says what it asked for.
 * @type {Map<string, number>}
 */
let sliding = new Map();
/**
 * The last switch made in a row's select (C1): the operation that switched
 * (`token`), the scene it switched from and to, the choice pixdcon made
 * (`chosenAt`, its stamp in the switch's answer) and when the switch
 * succeeded (`at`, the browser's clock), both null while the switch runs;
 * `undo`: the operation of an Undo of it, 0 while there is none.
 * @typedef {{token: number, from: string, to: string, chosenAt: string|null, at: number|null, undo: number}} UndoRecord
 */
/** The switch each row remembers, by the scene slot of the device's life. @type {Map<string, UndoRecord>} */
let undos = new Map();
/** How long a row offers Undo after a switch succeeded (C1). */
const UNDO_MS = 15_000;

/** Play, Pause, Stop: the value, the name and the tooltip of each button. */
const MODES = /** @type {const} */ ([
  ["play", "Play", "Play"],
  ["pause", "Pause", "Pause: hold the current frame"],
  ["stop", "Stop", "Stop: blank the display"],
]);
/** The busy labels of the Device page's mode slot, which both pages show. */
const MODE_BUSY = /** @type {Record<string, string>} */ ({ play: "Starting play…", pause: "Pausing…", stop: "Stopping…" });

const ADD_LINK = `<a class="btn" href="#/config/add" aria-label="Add device">${icon("plus")}<span>Add device</span></a>`;

/**
 * @param {string} name
 * @returns {string} the hash of a device page
 */
const deviceHash = (name) => `#/devices/${encodeURIComponent(name)}`;

/**
 * @param {any} view DeviceView
 * @returns {Row}
 */
function createRow(view) {
  const el = document.createElement("div");
  el.className = "dt-row";
  el.setAttribute("role", "row");
  el.setAttribute("data-name", view.name);
  el.innerHTML = `
      <div role="cell" class="c-pv" data-cell="preview" data-type="${view.type === "pixoo" ? "pixoo" : "ulanzi"}"><a class="pvlink"></a></div>
      <div role="cell" class="c-dev" data-cell="device"><a class="name"></a><div class="row-line st-line" data-line="status"></div><div class="row-line dev-note"></div></div>
      <div role="cell" class="c-show" data-cell="scene"><span class="select"><select></select>${icon("down", "")}</span><div class="row-line" data-line="scene"></div></div>
      <div role="cell" class="c-mode" data-cell="mode"><div class="seg icons" role="group">${MODES.map(([mode, label, title]) => `<button type="button" data-act="mode" data-mode="${mode}" aria-label="${label}" title="${title}">${icon(mode, "")}</button>`).join("")}</div><div class="row-line" data-line="mode"></div></div>
      <div role="cell" class="c-bri" data-cell="brightness"><div class="bri" role="group"><button class="auto" type="button" data-act="auto">Auto</button><input type="range" min="1" max="100" value="50"><span class="val num"></span></div><div class="row-line" data-line="brightness"></div></div>
      <div role="cell" class="c-open" data-cell="open"><a class="ibtn">${icon("right", "")}</a></div>`;
  const q = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (el.querySelector(selector));
  const pvLink = q(".pvlink");
  const select = /** @type {HTMLSelectElement} */ (q("select"));
  select.dataset.device = view.name;
  const size = sizeOf(view);
  return {
    el,
    pvLink,
    // The stylesheet gives the box its size (B7); the canvas keeps a whole-number scale.
    preview: createPixelPreview(pvLink, {
      scale: view.type === "pixoo" ? 2 : 11,
      grid: false,
      veil: 0.55,
      size,
      label: `Last frame on ${deviceTitle(view)}`,
      box: "css",
    }),
    type: view.type,
    name: /** @type {HTMLAnchorElement} */ (q(".name")),
    status: q('[data-line="status"]'),
    note: q(".dev-note"),
    select,
    options: "",
    sceneLine: q('[data-line="scene"]'),
    modes: q(".seg"),
    modeButtons: /** @type {HTMLButtonElement[]} */ ([...el.querySelectorAll('[data-act="mode"]')]),
    modeLine: q('[data-line="mode"]'),
    brightness: q(".bri"),
    auto: /** @type {HTMLButtonElement} */ (q('[data-act="auto"]')),
    range: /** @type {HTMLInputElement} */ (q('input[type="range"]')),
    value: q(".val"),
    brightnessLine: q('[data-line="brightness"]'),
    open: /** @type {HTMLAnchorElement} */ (q(".c-open a")),
  };
}

/**
 * A reserved line: its class, its tooltip and what it says.
 *
 * @param {HTMLElement} line
 * @param {string} cls the line's own classes: "" or "ovr", "warn" for a source; "st-line <kind>", "dev-note"
 * @param {string} html
 * @param {string|null} [title] the whole sentence, for a line that clips
 */
function writeLine(line, cls, html, title = null) {
  setClass(line, `row-line${cls ? ` ${cls}` : ""}`);
  setAttr(line, "title", title || null);
  setHtml(line, html);
}

/**
 * The device's choice is still the one a switch made: the same stamp of
 * pixdcon's (`choice.chosenAt`), of the same scene, which the display shows
 * as your choice. A newer choice has a newer stamp, also when it is of the
 * same scene (another tab chose it again).
 *
 * @param {any} view DeviceView, as the page holds it or as pixdcon answered it
 * @param {UndoRecord} record
 * @returns {boolean}
 */
function sameChoice(view, record) {
  const choice = view?.desired?.choice;
  const scene = view?.desired?.scene;
  return (
    record.chosenAt !== null &&
    choice?.chosenAt === record.chosenAt &&
    (choice.scene ?? "") === record.to &&
    (scene?.scene ?? "") === record.to &&
    scene?.source === "ui"
  );
}

/**
 * The last switch made in a row's select while it can still be undone
 * (C1): for 15 s from the moment it succeeded, and while the device's
 * choice is still the one it made (sameChoice). A newer state drops it, for
 * good: another choice from any page or tab, an overlay, a new life of the
 * device (another slot); so does a switch that ended without succeeding.
 * Called only while no operation of the scene slot runs.
 *
 * @param {any} view
 * @param {number} now the clock the 15 s are read on: the page's (its last tick) to draw the offer, the browser's for a click
 * @returns {UndoRecord|null}
 */
function undoRecord(view, now) {
  const key = deviceSlot("scene", view);
  const record = undos.get(key);
  if (!record) return null;
  if (record.at !== null && now - record.at < UNDO_MS && sameChoice(view, record)) return record;
  undos.delete(key);
  return null;
}

/**
 * The Undo a row offers: the switch it remembers, while that switch is the
 * scene slot's current operation and succeeded; or, with `retry`, an Undo
 * of it that failed, so Undo stays beside its failure (B-175).
 *
 * @param {import("../store.js").ClientState} state
 * @param {any} view
 * @param {import("../store.js").OpSlot} switching the scene slot
 * @returns {{from: string, name: string, retry: boolean}|null}
 */
function undoOffer(state, view, switching) {
  const record = switching.busy ? null : undoRecord(view, state.now);
  if (!record) return null;
  const switched = !switching.failure && switching.token === record.token;
  const retry = Boolean(switching.failure) && switching.token === record.undo;
  if (!switched && !retry) return null;
  return { from: record.from, name: sceneName(state, record.from, view.type), retry };
}

/**
 * @param {Row} row
 * @param {any} view
 * @param {import("../store.js").ClientState} state
 */
function updateRow(row, view, state) {
  const frozen = state.live.state === "lost";
  const shadow = view.desired?.output === "shadow";
  // Mode and brightness travel over MQTT (the Device page's rule): while a
  // configured broker is not connected they wait for it, disabled in place.
  const mqttOk = state.mqtt?.state === "connected" || state.mqtt?.state === "disabled";
  const mqttBlocked = !shadow && state.mqtt?.state !== "disabled" && !mqttOk;
  const title = deviceTitle(view);

  // Preview: the last frame, or a built-in mode's own tile (B2)
  setAttr(row.pvLink, "href", `${deviceHash(view.name)}/enlarged`);
  setAttr(row.pvLink, "aria-label", `Enlarge the preview of ${title}`);
  const pv = previewState(state, view);
  row.preview.draw(pv.frame, { veil: pv.veil, reason: pv.reason, spinner: false, icon: pv.builtin ? "clock" : null });

  // Device: the name and one status line (B1)
  setAttr(row.name, "href", deviceHash(view.name));
  if (row.name.textContent !== title) row.name.textContent = title;
  const status = rowStatus(state, view);
  writeLine(
    row.status,
    `st-line ${status.kind}`,
    `${dot(status.dot)}<span class="ell"><b>${esc(status.label)}</b>${status.detail ? ` · ${esc(status.detail)}` : ""}</span>${status.recovery ? `<span class="sep">·</span><a class="link" href="${deviceHash(view.name)}/recovery">${icon("info")}Recovery steps</a>` : ""}`,
    status.title,
  );
  const note = deviceCell(view).note;
  writeLine(row.note, note ? "dev-note ovr" : "dev-note", note ? `${icon(note.icon ?? "layers")}<span class="ell">${esc(note.text)}</span>` : "");

  // Showing: the select always shows what is showing (B-069).
  const choices = sceneChoices(state, view);
  const signature = JSON.stringify(choices.groups);
  if (signature !== row.options) {
    row.options = signature;
    row.select.innerHTML = choices.groups
      .map(
        (group) =>
          `<optgroup label="${esc(group.label)}">${group.options
            .map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`)
            .join("")}</optgroup>`,
      )
      .join("");
  }
  // The switch that runs (from this page or the Device page) shows what it
  // asked for, and the select takes no other choice meanwhile.
  const switching = op(deviceSlot("scene", view));
  const value = switching.busy ? String(switching.value ?? "") : choices.value;
  if (row.select.value !== value) row.select.value = value;
  row.select.disabled = frozen || switching.busy;
  setAttr(row.select, "aria-label", `Scene on ${title}`);
  sceneCell(row, view, state, switching, frozen);

  // Mode: Play, Pause, Stop, as the Device page's
  const mode = modeCell(view);
  const moding = op(deviceSlot("mode", view));
  setAttr(row.modes, "aria-label", `Mode of ${title}`);
  for (const button of row.modeButtons) {
    const value = String(button.getAttribute("data-mode"));
    setAttr(button, "aria-pressed", String(mode.value === value));
    button.disabled = frozen || mqttBlocked || moding.busy;
    setAttr(button, "title", mqttBlocked ? "Mode needs MQTT; it waits for the broker" : (MODES.find(([each]) => each === value)?.[2] ?? null));
  }
  if (moding.busy) writeLine(row.modeLine, "", `${icon("spinner")}<span class="ell">${esc(moding.label)}</span>`);
  else if (moding.failure) {
    // "Not paused: …" names what was asked; a timeout keeps its own "Not confirmed" (PIXD-105).
    const said = failureMessage(moding.failure, "Not changed");
    const asked = MODE_REFUSED[/** @type {"play"|"pause"|"stop"} */ (String(moding.value))];
    const text = asked && said.startsWith("Not changed: ") ? `${asked}: ${said.slice("Not changed: ".length)}` : said;
    writeLine(row.modeLine, "", failHtml(text), text);
  } else writeLine(row.modeLine, "", `<span class="ell">${esc(mode.label)}</span>`, mode.title);

  // Brightness: Auto, the slider (always live, A6) and the level
  const bri = brightnessCell(view);
  const key = deviceSlot("brightness", view);
  const briOp = op(key);
  const briDisabled = frozen || mqttBlocked || briOp.busy;
  setAttr(row.brightness, "aria-label", `Brightness of ${title}`);
  setAttr(row.auto, "aria-pressed", String(bri.auto));
  row.auto.disabled = briDisabled;
  setAttr(row.auto, "title", mqttBlocked ? "Brightness needs MQTT; it waits for the broker" : bri.auto ? "Auto: the scene sets brightness" : "Auto: give brightness back to the scene");
  const slid = sliding.get(key);
  const asked = briOp.busy && typeof briOp.value === "number" ? briOp.value : null;
  row.range.disabled = briDisabled;
  setAttr(row.range, "aria-label", `Brightness of ${title}`);
  // While a level is being dragged, the slider is the person's.
  const level = String(slid ?? asked ?? bri.level);
  if (slid === undefined && row.range.value !== level) row.range.value = level;
  const shown = slid ?? asked;
  setClass(row.value, `val num${shown === null && bri.muted ? " off" : ""}`);
  setHtml(row.value, esc(shown !== null ? percent(shown) : bri.value));
  if (briOp.busy) writeLine(row.brightnessLine, "", `${icon("spinner")}<span class="ell">${esc(briOp.label)}</span>`);
  else if (briOp.failure) {
    const text = failureMessage(briOp.failure, "Not changed");
    writeLine(row.brightnessLine, "", failHtml(text), text);
  } else writeLine(row.brightnessLine, bri.cls, `<span class="ell">${esc(bri.text)}</span>`, bri.title || bri.text);

  // Open
  setAttr(row.open, "href", deviceHash(view.name));
  setAttr(row.open, "aria-label", `Open ${title}`);
  setAttr(row.open, "title", `Open ${title}`);
}

/** @param {string} text @returns {string} a failure said in a reserved line, after its control's action (Tick, B4) */
const failHtml = (text) => `<span class="fail">${icon("alert")}<span class="ell">${esc(text)}</span></span>`;

/**
 * The line under the select: what runs, the Undo of the last switch, or
 * where the scene comes from, with its action (Undo, or "Back to <your
 * choice>" while an overlay replaced it). A failure follows the action that
 * stays for a retry (Tick, B4: "Not restored" after its button), in place of
 * the source, which the select above still shows.
 *
 * @param {Row} row
 * @param {any} view
 * @param {import("../store.js").ClientState} state
 * @param {import("../store.js").OpSlot} switching
 * @param {boolean} frozen
 */
function sceneCell(row, view, state, switching, frozen) {
  const base = sceneLine(state, view);
  const restoring = op(deviceSlot("restore", view));
  const offer = undoOffer(state, view, switching);
  /** @type {string|null} */
  let failure = null;
  if (switching.busy) {
    writeLine(row.sceneLine, "", `${icon("spinner")}<span class="ell">${esc(switching.label)}</span>`);
    return;
  }
  if (switching.failure) failure = failureMessage(switching.failure, "Not switched");
  else if (restoring.failure && !restoring.busy && base.restore) failure = failureMessage(restoring.failure, "Not restored");
  let action = "";
  if (offer) action = `<button class="link" type="button" data-act="undo"${frozen ? " disabled" : ""}>${icon("undo")}Undo</button>`;
  else if (base.restore) {
    const busy = restoring.busy;
    // Both labels stand in the button, one of them unseen, so it keeps the
    // width of the wider one and nothing beside it moves (B-176).
    const idle = `${icon("undo")}${esc(base.restore.label)}`;
    const working = `${icon("spinner")}Restoring…`;
    action = `<button class="link rw ovr" type="button" data-act="restore"${base.restore.disabled || frozen || busy ? " disabled" : ""}${busy ? ' aria-busy="true"' : ""}${base.restore.title ? ` title="${esc(base.restore.title)}"` : ""}><span>${busy ? working : idle}</span><span aria-hidden="true">${busy ? idle : working}</span></button>`;
  }
  if (failure) {
    writeLine(row.sceneLine, "", `${action ? `${action}<span class="sep">·</span>` : ""}${failHtml(failure)}`, failure);
    return;
  }
  const sep = `<span class="sep">·</span>`;
  if (offer) {
    const text = `Switched from ${offer.name}`;
    writeLine(row.sceneLine, "", `${icon("check")}<span class="ell">${esc(text)}</span>${sep}${action}`, `${text}. Undo switches back.`);
    return;
  }
  const extra = base.extra
    ? `${sep}<span class="x${base.extra.cls ? ` ${base.extra.cls}` : ""}">${base.extra.icon ? icon(base.extra.icon) : ""}${esc(base.extra.text)}</span>`
    : "";
  writeLine(
    row.sceneLine,
    base.cls ?? "",
    `${base.icon ? icon(base.icon) : ""}<span class="ell">${esc(base.text)}</span>${extra}${action ? `${sep}${action}` : ""}`,
    base.extra ? `${base.text} · ${base.extra.title ?? base.extra.text}` : (base.title ?? null),
  );
}

/**
 * Render the whole page from the store's state.
 *
 * @param {import("../store.js").ClientState} state
 */
function render(state) {
  if (!root) return;
  const sub = /** @type {HTMLElement} */ (root.querySelector(".head .sub"));
  const right = /** @type {HTMLElement} */ (root.querySelector(".head .right"));
  const table = /** @type {HTMLElement} */ (root.querySelector(".dt"));
  const body = /** @type {HTMLElement} */ (root.querySelector(".dt-body"));
  const empty = /** @type {HTMLElement} */ (root.querySelector(".empty-slot"));
  const condition = pageCondition(state);

  if (!state.loaded) {
    setStatusLine(sub, condition ?? { text: "Loading…" });
    table.hidden = false;
    empty.hidden = true;
    setAttr(table, "aria-busy", "true");
    setHtml(
      body,
      `<div class="loading-row" role="row"><span role="cell">${icon("spinner", "")}Loading devices from pixdcon…</span></div>`,
    );
    rows = new Map();
    return;
  }
  setAttr(table, "aria-busy", null);
  const views = [...state.devices.values()];
  if (views.length === 0) {
    setStatusLine(sub, condition ?? { text: "No devices yet" });
    setHtml(right, "");
    table.hidden = true;
    if (empty.hidden || !empty.firstChild) {
      empty.hidden = false;
      setHtml(empty, EMPTY_HTML);
    }
    addFormState(empty);
    rows = new Map();
    setHtml(body, "");
    return;
  }
  empty.hidden = true;
  table.hidden = false;
  setHtml(right, ADD_LINK);
  const summary = devicesSummary(state);
  setStatusLine(sub, condition ?? { text: summary.text, parts: summary.parts });
  setClass(table, state.live.state === "lost" ? "dt frozen" : "dt");

  // Rows in config order; a row is built once and kept while its device is listed.
  /** @type {Map<string, Row>} */
  const next = new Map();
  for (const view of views) {
    let row = rows.get(view.name);
    if (!row || row.type !== view.type) {
      row?.preview.destroy();
      row = createRow(view);
    }
    next.set(view.name, row);
    updateRow(row, view, state);
  }
  const wanted = [...next.values()].map((row) => row.el);
  const present = [...body.children];
  if (wanted.length !== present.length || wanted.some((el, i) => present[i] !== el)) {
    setHtml(body, "");
    body.replaceChildren(...wanted);
  }
  rows = next;
}

const EMPTY_HTML = `
  <section class="empty" aria-labelledby="h-empty">
    <h2 id="h-empty">Add your first display</h2>
    <p>pixdcon drives Pixoo64 (64×64) and Ulanzi / AWTRIX (32×8) displays on your network. Give the display a name, pick its type and enter its IP address.</p>
    <form class="addf" aria-label="Add device">
      <label>Name<input class="input mono" name="name" placeholder="ulanzi-58" autocomplete="off"></label>
      <label>Type<span class="select"><select name="type"><option value="ulanzi">Ulanzi / AWTRIX (32×8)</option><option value="pixoo">Pixoo64 (64×64)</option></select>${icon("down", "")}</span></label>
      <label>IP address<input class="input mono" name="ip" placeholder="192.168.1.xx" autocomplete="off" inputmode="decimal"></label>
      <button class="btn primary" type="submit" disabled>${icon("plus")}Add device</button>
    </form>
    <div class="slot" role="status" style="margin-top:10px">pixdcon saves the device to config.json and starts it right away.</div>
  </section>`;

/**
 * The switch's request, the Device page's, in the scene slot of the
 * device's life: what pixdcon answers goes to the store's fence, and is
 * handed back to the operation.
 *
 * @param {string} name
 * @param {string} key the scene slot
 * @param {string} scene "" for none
 * @returns {Promise<import("../api.js").Answer>}
 */
async function sendScene(name, key, scene) {
  const answer = await request("PUT", `/api/v2/devices/${encodeURIComponent(name)}/scene`, {
    resource: `device:${name}`,
    key,
    body: { scene: scene === "" ? null : scene },
  });
  applyAnswer(answer);
  return answer;
}

/**
 * @param {import("../store.js").ClientState} state @param {any} view @param {string} scene
 * @returns {string} the busy label of a switch, the Device page's
 */
const switchLabel = (state, view, scene) => `Switching to ${sceneName(state, scene, view.type)}…`;

/**
 * A switch from the row's select succeeded: its Undo is offered from now
 * on, for 15 s of the browser's clock, bound to the choice pixdcon made,
 * by the stamp in the switch's own answer (C1). Only the record this
 * switch left in this opening of the page is armed. An answer without that
 * stamp, or of another scene, arms nothing: a newer choice could not be
 * told from it. The armed record replaces the pending one.
 *
 * @param {string} key the scene slot
 * @param {UndoRecord} record the pending record this switch left
 * @param {import("../api.js").Answer} answer
 */
function arm(key, record, answer) {
  if (undos.get(key) !== record) return;
  const choice = (answer.body?.device ?? answer.body)?.desired?.choice;
  if (typeof choice?.chosenAt !== "string" || (choice.scene ?? "") !== record.to) undos.delete(key);
  else undos.set(key, { ...record, chosenAt: choice.chosenAt, at: Date.now() });
}

/**
 * A scene was chosen in a row's select: a switch in the slot of the
 * device's life, shared with the Device page. While one runs, from either
 * page, a choice sends nothing and says nothing. The switch is remembered
 * for Undo (C1) unless it replaced an overlay, which Undo would make your
 * choice; its Undo is offered once it succeeded (arm).
 *
 * @param {string} name
 * @param {string} scene "" for none
 */
function chooseScene(name, scene) {
  const state = getState();
  const view = state.devices.get(name);
  if (!view) return;
  const key = deviceSlot("scene", view);
  const from = view.desired?.scene?.scene ?? "";
  const source = view.desired?.scene?.source;
  /** @type {UndoRecord} */
  const record = { token: 0, from, to: scene, chosenAt: null, at: null, undo: 0 };
  const started = start(key, () => sendScene(name, key, scene), {
    device: name,
    label: switchLabel(state, view, scene),
    value: scene,
    done: (answer) => arm(key, record, answer),
  });
  if (started) {
    // A new switch replaces the offer of the one before.
    if (from !== scene && source !== "overlay" && source !== "blob") {
      record.token = op(key).token;
      undos.set(key, record);
    } else undos.delete(key);
  }
  render(getState());
}

/**
 * Undo: the scene the row switched from, through the same switch (C1).
 * The 15 s are checked again on the browser's clock, not the page's last
 * tick (a tab that slept past them sends nothing), and the page's own copy
 * of the device must still hold the choice the switch made. Then the
 * device is read again, as another tab or page may have chosen since the
 * page last heard: the switch back is sent only while that choice still
 * stands. Otherwise nothing is sent, and the offer goes. A failed Undo
 * keeps its button beside the failure, to try again; the button is there
 * only while the row offers it.
 *
 * @param {string} name
 */
function undo(name) {
  const state = getState();
  const view = state.devices.get(name);
  if (!view) return;
  const key = deviceSlot("scene", view);
  const record = op(key).busy ? null : undoRecord(view, Date.now());
  if (!record) {
    render(getState());
    return;
  }
  const started = start(
    key,
    async (current) => {
      const read = await request("GET", `/api/v2/devices/${encodeURIComponent(name)}`, { resource: `device:${name}`, key });
      applyAnswer(read);
      // Changed since the switch: in pixdcon's answer, or in a newer copy the page holds.
      if (!current() || !sameChoice(read.body?.device ?? read.body, record) || !sameChoice(getState().devices.get(name), record)) return read;
      return sendScene(name, key, record.from);
    },
    { device: name, label: switchLabel(state, view, record.from), value: record.from },
  );
  if (started) record.undo = op(key).token;
  render(getState());
}

/**
 * Play, Pause or Stop from a row: the Device page's mode slot and request.
 *
 * @param {string} name
 * @param {string} mode
 */
function setMode(name, mode) {
  const view = getState().devices.get(name);
  if (!view) return;
  const key = deviceSlot("mode", view);
  start(
    key,
    async () =>
      applyAnswer(
        await request("PUT", `/api/v2/devices/${encodeURIComponent(name)}/mode`, {
          resource: `device:${name}`,
          key,
          body: { mode },
        }),
      ),
    { device: name, label: MODE_BUSY[mode] ?? "Changing…", value: mode },
  );
  render(getState());
}

/**
 * A level from a row's slider, or Auto (null): the Device page's brightness
 * slot and request. The slider stays disabled while it runs (gate r4 §5).
 *
 * @param {string} name
 * @param {number|null} override
 */
function setBrightness(name, override) {
  const view = getState().devices.get(name);
  if (!view) return;
  const key = deviceSlot("brightness", view);
  start(
    key,
    async () =>
      applyAnswer(
        await request("PUT", `/api/v2/devices/${encodeURIComponent(name)}/brightness`, {
          resource: `device:${name}`,
          key,
          body: { override },
        }),
      ),
    { device: name, label: override === null ? "Back to Auto…" : `Setting ${override} %…`, value: override },
  );
  render(getState());
}

/**
 * Restore: clear the scene overlay of a row's device, in the slot of the
 * device's life, shared with the Device page's "Return to your choice".
 * While it runs the button shows "Restoring…" and takes no click (B-176);
 * a failure is said before the button, which stays to retry.
 *
 * @param {string} name
 */
function restore(name) {
  const view = getState().devices.get(name);
  if (!view) return;
  const key = deviceSlot("restore", view);
  start(key, async () =>
    applyAnswer(
      await request("DELETE", `/api/v2/devices/${encodeURIComponent(name)}/scene-overlay`, {
        resource: `device:${name}`,
        key,
      }),
    ),
    { device: name },
  );
  render(getState());
}

/**
 * Add device, in the slot `add-device` that the Config page shares.
 *
 * @param {HTMLFormElement} form
 */
function addDevice(form) {
  const data = new FormData(form);
  start(
    "add-device",
    async () =>
      applyAnswer(
        await request("POST", "/api/v2/devices", {
          resource: `device:${data.get("name")}`,
          key: "add-device",
          body: { name: data.get("name"), type: data.get("type"), ip: data.get("ip") },
        }),
      ),
    { label: "Adding…", done: () => "Added. pixdcon starts it now." },
  );
  render(getState());
}

/**
 * The empty state's Add device, from its slot: busy label, the failure
 * beside the button, or what the last add said.
 *
 * @param {HTMLElement} empty
 */
function addFormState(empty) {
  const form = /** @type {HTMLFormElement|null} */ (empty.querySelector("form.addf"));
  const slot = /** @type {HTMLElement|null} */ (empty.querySelector(".slot"));
  if (!form || !slot) return;
  const adding = op("add-device");
  const button = /** @type {HTMLButtonElement} */ (form.querySelector("button"));
  const filled = (/** @type {string} */ field) =>
    String(/** @type {HTMLInputElement|null} */ (form.querySelector(`input[name="${field}"]`))?.value ?? "").trim() !== "";
  button.disabled = adding.busy || !filled("name") || !filled("ip");
  setHtml(button, adding.busy ? `${icon("spinner")}Adding…` : `${icon("plus")}Add device`);
  setHtml(
    slot,
    adding.failure
      ? `<span style="color:var(--bad);display:inline-flex;align-items:center;gap:6px">${icon("alert")}${esc(adding.failure)}</span>`
      : esc(adding.note ?? "pixdcon saves the device to config.json and starts it right away."),
  );
}

/** @param {Element} element @returns {string|null} the device of the row the element is in */
const rowName = (element) => element.closest(".dt-row")?.getAttribute("data-name") ?? null;

/** @param {Event} event */
function onChange(event) {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target instanceof HTMLSelectElement && target.dataset.device)
    chooseScene(target.dataset.device, target.value);
  else if (target instanceof HTMLInputElement && target.type === "range") {
    const name = rowName(target);
    const view = name === null ? undefined : getState().devices.get(name);
    if (!name || !view) return;
    sliding.delete(deviceSlot("brightness", view));
    setBrightness(name, Number(target.value));
  }
}

/** @param {Event} event */
function onClick(event) {
  const button = /** @type {HTMLElement} */ (event.target).closest?.("[data-act]");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  const name = rowName(button);
  if (!name) return;
  switch (button.dataset.act) {
    case "restore":
      restore(name);
      break;
    case "undo":
      undo(name);
      break;
    case "mode":
      setMode(name, String(button.dataset.mode));
      break;
    case "auto": {
      // Auto gives the level back to the scene; pressed, it is already the scene's.
      const override = getState().devices.get(name)?.desired?.brightness?.override;
      if (override !== null && override !== undefined) setBrightness(name, null);
      break;
    }
  }
}

/** @param {Event} event */
function onInput(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type === "range") {
    const name = rowName(target);
    const view = name === null ? undefined : getState().devices.get(name);
    if (view) {
      sliding.set(deviceSlot("brightness", view), Number(target.value));
      render(getState());
    }
    return;
  }
  const form = /** @type {HTMLElement} */ (target).closest?.("form.addf");
  const empty = /** @type {HTMLElement|null} */ (root?.querySelector(".empty-slot") ?? null);
  if (form instanceof HTMLFormElement && empty) addFormState(empty);
}

/** @param {Event} event */
function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  addDevice(form);
}

/** @type {import("../router.js").Page} */
export const page = {
  mount(target, _params) {
    root = target;
    root.className = "p-devices";
    root.innerHTML = `
      <div class="head"><h1 tabindex="-1">Devices</h1><span class="sub" role="status"></span><div class="right"></div></div>
      <div class="dt" role="table" aria-label="Devices">
        <div class="dt-head" role="row"><span role="columnheader">Display</span><span role="columnheader">Device</span><span role="columnheader">Showing</span><span role="columnheader">Mode</span><span role="columnheader">Brightness</span><span role="columnheader"><span class="vh">Open</span></span></div>
        <div class="dt-body" role="rowgroup"></div>
      </div>
      <div class="empty-slot" hidden></div>`;
    rows = new Map();
    sliding = new Map();
    undos = new Map();
    // A fresh opening: what idle controls said before is gone; a control
    // whose operation runs keeps it, and its outcome is said when it comes.
    forgetIdle((key) => /^(scene|restore|mode|brightness):/.test(key) || key === "add-device");
    root.addEventListener("change", onChange);
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("submit", onSubmit);
    unsubscribe = subscribe((state) => state, render);
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    if (root) {
      root.removeEventListener("change", onChange);
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      root.removeEventListener("submit", onSubmit);
    }
    for (const row of rows.values()) row.preview.destroy();
    rows = new Map();
    sliding = new Map();
    undos = new Map();
    root = null;
  },
};
