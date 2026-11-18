/* global document, HTMLSelectElement, HTMLButtonElement, HTMLFormElement */
/**
 * Page: Devices overview.
 * Approved mockups: pixd-devices-{default,loading,empty,stale,offline,error,disconnected} (PIXD-81, -v1-approved-2026-11-16).
 * States without a mockup, as Tick decided them (tick-states-0030.md):
 * a device in shadow (item 7: neutral filled dot, "Shadow · not driving the
 * display" with the reason, counted separately in the title line) and a
 * device that exists only in the MQTT config overlay (item 8: "from the
 * MQTT config overlay · not saved" under the name).
 *
 * Table in config order: preview (click enlarges), device, scene select with its source lines, status, brightness, mode. 'Add device' in the title line and as the empty state.
 *
 * Every row keeps its height in every state; values are written into their
 * slots only when they changed. A scene change and a Restore are
 * operations (ops.js) in the slot of the device's life,
 * `scene:<device>@<epoch>/<incarnation>` and `restore:…`, the same slots
 * the Device page uses: whichever page started one, both show it busy, a
 * second start is ignored before anything is said (B-176), and its outcome
 * is shown only while it is the slot's current one. Answers go through the
 * store's fence. A failure stays beside its action, which stays (B-175):
 * "Not switched: …" in the select's own line, "Not restored: …" after the
 * Restore button.
 *
 * Owner: UI worker.
 */

import { request } from "../api.js";
import { createPixelPreview } from "../components/pixel-preview.js";
import { dot, icon, lineHtml, setAttr, setClass, setHtml, setStatusLine } from "../dom.js";
import { esc } from "../format.js";
import { deviceSlot, forgetIdle, op, start } from "../ops.js";
import { applyAnswer, getState, subscribe } from "../store.js";
import {
  brightnessCell,
  deviceCell,
  deviceStatus,
  deviceTitle,
  devicesSummary,
  modeCell,
  pageCondition,
  previewState,
  sceneChoices,
  sceneName,
  sizeOf,
  sourceLines,
} from "../view/model.js";

/**
 * @typedef {object} Row
 * @property {HTMLElement} el
 * @property {HTMLElement} pvLink
 * @property {ReturnType<typeof createPixelPreview>} preview
 * @property {string} type
 * @property {HTMLAnchorElement} name
 * @property {HTMLElement} meta
 * @property {HTMLSelectElement} select
 * @property {string} options signature of the options in the select
 * @property {HTMLElement} first
 * @property {HTMLElement} second
 * @property {HTMLElement} status
 * @property {HTMLElement} brightness
 * @property {HTMLElement} mode
 */

/** @type {HTMLElement|null} */
let root = null;
/** @type {(() => void)|null} */
let unsubscribe = null;
/** @type {Map<string, Row>} */
let rows = new Map();

const ADD_LINK = `<a class="btn" href="#/config/add">${icon("plus")}Add device</a>`;

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
  el.innerHTML = `
      <div role="cell" class="c-pv"><a class="pvlink"></a></div>
      <div role="cell" class="c-dev"><a class="name"></a><div class="dev-meta"></div></div>
      <div role="cell" class="c-show"><span class="select"><select></select>${icon("down", "")}</span>
        <div class="lines"><div class="src"></div><div class="src2 wrap"></div></div></div>
      <div role="cell" class="c-st"></div>
      <div role="cell" class="c-bri"></div>
      <div role="cell" class="c-mode"></div>`;
  const q = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (el.querySelector(selector));
  const pvLink = q(".pvlink");
  const select = /** @type {HTMLSelectElement} */ (q("select"));
  select.dataset.device = view.name;
  const size = sizeOf(view);
  const scale = view.type === "pixoo" ? 2 : 4;
  return {
    el,
    pvLink,
    preview: createPixelPreview(pvLink, {
      scale,
      grid: false,
      veil: 0.55,
      size,
      label: `Last frame on ${deviceTitle(view)}`,
    }),
    type: view.type,
    name: /** @type {HTMLAnchorElement} */ (q(".name")),
    meta: q(".dev-meta"),
    select,
    options: "",
    first: q(".src"),
    second: q(".src2"),
    status: q(".c-st"),
    brightness: q(".c-bri"),
    mode: q(".c-mode"),
  };
}

/**
 * @param {Row} row
 * @param {any} view
 * @param {import("../store.js").ClientState} state
 */
function updateRow(row, view, state) {
  const frozen = state.live.state === "lost";
  const title = deviceTitle(view);
  // Preview
  setAttr(row.pvLink, "href", `${deviceHash(view.name)}/enlarged`);
  setAttr(row.pvLink, "aria-label", `Enlarge the preview of ${title}`);
  const pv = previewState(state, view);
  row.preview.draw(pv.frame, { veil: pv.veil, reason: pv.reason, spinner: false });
  // Device
  setAttr(row.name, "href", deviceHash(view.name));
  if (row.name.textContent !== title) row.name.textContent = title;
  const cell = deviceCell(view);
  setHtml(
    row.meta,
    cell.lines
      .map((line) => {
        if (line.icon)
          return `<div class="meta ovr-line">${icon(line.icon)}${esc(line.text)}</div>`;
        if (line.mono) return `<div class="meta mono">${esc(line.text)}</div>`;
        if (line.name)
          return `<div class="meta"><span class="mono">${esc(line.name)}</span> · ${esc(line.text)}</div>`;
        return `<div class="meta">${esc(line.text)}</div>`;
      })
      .join(""),
  );
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
  // The scene select: the switch that runs (from this page or the Device
  // page) shows what it asked for and takes no other choice meanwhile.
  const switching = op(deviceSlot("scene", view));
  const value = switching.busy ? String(switching.value ?? "") : choices.value;
  if (row.select.value !== value) row.select.value = value;
  row.select.disabled = frozen || switching.busy;
  setAttr(row.select, "aria-label", `Scene on ${title}`);
  const lines = sourceLines(state, view);
  setAttr(row.first, "title", null);
  if (switching.busy) {
    setClass(row.first, "src");
    setHtml(row.first, lineHtml({ icon: "spinner", text: switching.label }));
  } else if (switching.failure) {
    const text = `Not switched: ${switching.failure}`;
    setClass(row.first, "src bad");
    setAttr(row.first, "title", text);
    setHtml(row.first, `${icon("alert")}<span class="ell">${esc(text)}</span>`);
  } else {
    setClass(row.first, `src${lines.first.cls ? ` ${lines.first.cls}` : ""}`);
    setHtml(row.first, lineHtml(lines.first));
  }
  let second = "";
  if (lines.second.restore !== undefined) {
    const restore = lines.second.restore;
    const restoring = op(deviceSlot("restore", view));
    const busy = restoring.busy;
    const disabled = restore.disabled || frozen || busy;
    // Both labels stand in the button, one of them unseen, so the button
    // keeps the width of the wider one and nothing beside it moves (B-176).
    const idle = `${icon("undo")}Restore`;
    const working = `${icon("spinner")}Restoring…`;
    // A failed Restore keeps its button, to try again, with the error
    // after it (Tick, B4; B-175).
    const failure = restoring.failure && !busy
      ? `<span class="fail">${icon("alert")}${esc(`Not restored: ${restoring.failure}`)}</span>`
      : "";
    second = `${esc(lines.second.text)} <button class="link rw" type="button" data-act="restore"${disabled ? " disabled" : ""}${busy ? ' aria-busy="true"' : ""}${restore.title ? ` title="${esc(restore.title)}"` : ""}><span>${busy ? working : idle}</span><span aria-hidden="true">${busy ? idle : working}</span></button>${failure ? ` ${failure}` : ""}`;
  } else if (lines.second.cls === "ovr")
    second = `<span style="color:var(--ovr);display:inline-flex;align-items:center;gap:6px">${lines.second.icon ? icon(lines.second.icon) : ""}${esc(lines.second.text)}</span>`;
  else second = esc(lines.second.text);
  setHtml(row.second, second);
  // Status
  const status = deviceStatus(view, state);
  const stCls = status.kind === "shadow" ? "st shadow" : `st ${status.dot === "idle" ? "" : status.dot}`.trim();
  let statusHtml = `<span class="${stCls}">${dot(status.dot)}<span>${esc(status.label)}</span></span>`;
  for (const meta of status.meta)
    statusHtml += `<div class="meta num"${meta.cls ? ` style="color:var(--${meta.cls})"` : ""}>${esc(meta.text)}</div>`;
  if (status.kind === "bad")
    statusHtml += `<div class="meta"><a class="link" href="${deviceHash(view.name)}/recovery">${icon("info")}Recovery steps</a></div>`;
  setHtml(row.status, statusHtml);
  // Brightness
  const bri = brightnessCell(view);
  setHtml(
    row.brightness,
    `<div class="big num${bri.muted ? " t3" : ""}">${esc(bri.big)}</div><div class="meta"${bri.meta.cls ? ` style="color:var(--${bri.meta.cls})"` : ""}>${esc(bri.meta.text)}</div>`,
  );
  // Mode
  const mode = modeCell(view);
  setHtml(
    row.mode,
    `<span class="mode${mode.cls ? ` ${mode.cls}` : ""}">${icon(mode.icon)}${esc(mode.label)}</span>`,
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
 * A scene was chosen in a row's select: an operation in the slot of the
 * device's life, shared with the Device page. While one runs, from either
 * page, a choice sends nothing and says nothing; the select shows the
 * switch that runs again.
 *
 * @param {string} name
 * @param {string} scene "" for none
 */
function chooseScene(name, scene) {
  const state = getState();
  const view = state.devices.get(name);
  if (!view) return;
  const key = deviceSlot("scene", view);
  start(
    key,
    async () =>
      applyAnswer(
        await request("PUT", `/api/v2/devices/${encodeURIComponent(name)}/scene`, {
          resource: `device:${name}`,
          key,
          body: { scene: scene === "" ? null : scene },
        }),
      ),
    { device: name, label: `Switching to ${sceneName(state, scene, view.type)}…`, value: scene },
  );
  render(getState());
}

/**
 * Restore: clear the scene overlay of a row's device, in the slot of the
 * device's life, shared with the Device page's "Return to your choice".
 * While it runs the button shows "Restoring…" and takes no click (B-176);
 * a failure follows the unchanged choice and button, which stays to retry.
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

/** @param {Event} event */
function onChange(event) {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target instanceof HTMLSelectElement && target.dataset.device)
    chooseScene(target.dataset.device, target.value);
}

/** @param {Event} event */
function onClick(event) {
  const button = /** @type {HTMLElement} */ (event.target).closest?.("[data-act]");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  const row = button.closest(".dt-row");
  const name = row
    ? [...rows.entries()].find(([, value]) => value.el === row)?.[0]
    : undefined;
  if (button.dataset.act === "restore" && name) restore(name);
}

/** @param {Event} event */
function onInput(event) {
  const form = /** @type {HTMLElement} */ (event.target).closest?.("form.addf");
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
        <div class="dt-head" role="row"><span role="columnheader">Display</span><span role="columnheader">Device</span><span role="columnheader">Showing</span><span role="columnheader">Status</span><span role="columnheader">Brightness</span><span role="columnheader">Mode</span></div>
        <div class="dt-body" role="rowgroup"></div>
      </div>
      <div class="empty-slot" hidden></div>`;
    rows = new Map();
    // A fresh opening: what idle controls said before is gone; a control
    // whose operation runs keeps it, and its outcome is said when it comes.
    forgetIdle((key) => /^(scene|restore):/.test(key) || key === "add-device");
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
    root = null;
  },
};
