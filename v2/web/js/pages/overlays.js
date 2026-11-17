/* global HTMLButtonElement */
/**
 * Page: Overlays.
 * Approved mockups: pixd-overlays-{default,empty} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Device overlays, scene setting overlays, mode and brightness, config overlays; each with topic, value, what it replaces, when it was received, Clear. A cleared row stays, greyed, with its time.
 *
 * Without a mockup, the defaults of the interfaces entry, section 13:
 *  - item 11, a record the broker has not delivered again since the last
 *    reconnect: the row stays in its place; "Waiting for the broker · not in
 *    effect" in the neutral colour, "received 18:18 · not confirmed since
 *    the reconnect at 18:42" under the time; Clear works as for any row. A
 *    switch-off reads "Switched off by an MQTT overlay since 18:18" with
 *    "… · still off"; an address that is not confirmed reads "Waiting for
 *    the broker · display on hold"
 *  - item 12, the config overlay row while this instance is not its writer:
 *    Clear is disabled, with the reason beside it in the small text
 *
 * Owner: UI worker.
 */

import { request } from "../api.js";
import { forgetIdle, op, start } from "../ops.js";
import { icon, setHtml, setStatusLine } from "../dom.js";
import { esc } from "../format.js";
import { applyAnswer, getState, subscribe } from "../store.js";
import { deviceTitle, overlayRows, overlaysInEffect, pageCondition, typeLabel } from "../view/model.js";

/** @type {HTMLElement|null} */
let root = null;
/** @type {(() => void)|null} */
let unsubscribe = null;
/** Row ids the page has shown, in order: a row that leaves the list keeps its place. @type {string[]} */
let shown = [];
let since = 0;
/**
 * A row's Clear is an operation in the slot `overlay:<id>` (ops.js): one
 * busy owner across openings of the page, its failure or note kept in the
 * slot and said beside the button, which stays.
 *
 * @param {string} id
 */
const slotOf = (id) => `overlay:${id}`;

const SECTIONS = [
  { id: "device", title: "Device overlays", note: "Scene, IP address or enabled, per device" },
  { id: "setting", title: "Scene setting overlays", note: "One value of a scene setting, per device" },
  { id: "control", title: "Mode and brightness", note: "Retained controls, per device" },
  { id: "config", title: "Config overlays", note: "Whole config and scene file paths" },
];

const HEAD = `<div class="ot-head" role="row"><span role="columnheader">Device</span><span role="columnheader">Overlay and topic</span><span role="columnheader">Value</span><span role="columnheader">Received</span><span role="columnheader"><span class="vh">Action</span></span></div>`;

/**
 * @param {import("../store.js").ClientState} state
 * @param {import("../view/model.js").OverlayRow} row
 * @returns {string}
 */
function rowHtml(state, row) {
  const view = row.device ? state.devices.get(row.device) : undefined;
  let who;
  if (view) {
    const named = view.displayName && view.displayName !== view.name;
    who = `<a class="name" href="#/devices/${encodeURIComponent(view.name)}">${esc(deviceTitle(view))}</a><div class="meta">${named ? `<span class="mono">${esc(view.name)}</span> · ` : ""}${esc(typeLabel(view.type))}</div>`;
  } else if (row.device) who = `<span class="name mono">${esc(row.device)}</span><div class="meta">not a device of this config</div>`;
  else who = `<span class="name">${row.section === "config" ? "All displays" : "—"}</span>`;
  const value = `<span class="v${row.value.cls ? "" : " off"}">${esc(row.value.text)}</span>${row.value.key ? ` <span class="mono t3">${esc(row.value.key)}</span>` : ""}<div class="meta"${row.statusCls ? ` style="color:var(--${row.statusCls})"` : ""}>${esc(row.status)}</div>`;
  let action;
  if (row.cleared) action = `<span class="t3 num" style="font-size:12px">${esc(row.cleared)}</span>`;
  else if (row.clear) {
    const clearing = op(slotOf(row.id));
    const busy = clearing.busy;
    const disabled = row.clear.disabled || busy || state.live.state === "lost";
    action = `<button class="btn" type="button" data-act="clear" data-id="${esc(row.id)}"${disabled ? " disabled" : ""}${row.clear.reason ? ` title="${esc(row.clear.reason)}"` : ""}>${busy ? `${icon("spinner")}Clearing…` : `${icon("x")}Clear`}</button>`;
    if (row.clear.disabled && row.clear.reason)
      action += `<div class="meta act-why">${esc(row.clear.reason)}</div>`;
    const said = busy ? null : clearing.failure ? `Not cleared: ${clearing.failure}` : clearing.note;
    if (said) action += `<div class="meta act-why" style="color:var(--bad)">${esc(said)}</div>`;
  } else action = "";
  return `<div class="ot-row${row.cleared ? " cleared" : ""}" role="row">
        <div role="cell">${who}</div>
        <div role="cell">${esc(row.what)}<div class="meta mono">${esc(row.topic)}</div></div>
        <div role="cell">${value}</div>
        <div role="cell" class="num">${esc(row.received.time)}<div class="meta">${esc(row.received.sub)}</div></div>
        <div role="cell" class="act">${action}</div>
      </div>`;
}

/**
 * @param {import("../store.js").ClientState} state
 */
function render(state) {
  if (!root) return;
  const sub = /** @type {HTMLElement} */ (root.querySelector(".head .sub"));
  const body = /** @type {HTMLElement} */ (root.querySelector(".ov-body"));
  if (!state.loaded) {
    setStatusLine(sub, pageCondition(state) ?? { text: "Loading…" });
    setHtml(body, "");
    return;
  }
  for (const record of state.overlays) if (!shown.includes(record.id)) shown.push(record.id);
  const rows = overlayRows(state, { shown, since });
  const inEffect = overlaysInEffect(state.overlays);
  setStatusLine(
    sub,
    pageCondition(state) ?? { text: inEffect > 0 ? `${inEffect} in effect` : "None in effect" },
  );
  if (rows.length === 0) {
    const ns = state.controller?.mqttNamespace ?? {};
    const base = esc(ns.baseTopic ?? "home/hsb1/pixdcon");
    const settings = esc(ns.settingsBaseTopic ?? "pixdcon");
    setHtml(
      body,
      `<p class="lead">No overlays are stored. Every display shows your choice with its saved settings.</p>
  <section class="sec" aria-labelledby="h-l">
    <h2 id="h-l">Where overlays come from</h2>
    <p class="none" style="max-width:760px">pixdcon listens for retained MQTT messages on these topics. Publish an empty message to clear one.</p>
    <dl class="kv">
      <dt>Scene per device</dt><dd class="mono">${base}/overlay/device/&lt;device&gt;/scene</dd>
      <dt>IP or enabled per device</dt><dd class="mono">${base}/overlay/device/&lt;device&gt;/ip · …/enabled</dd>
      <dt>Scene file path</dt><dd class="mono">${base}/overlay/scene/&lt;scene&gt;/path</dd>
      <dt>Whole config</dt><dd class="mono">${base}/overlay/blob</dd>
      <dt>Scene settings</dt><dd class="mono">${settings}/&lt;device&gt;/&lt;scene&gt;/settings/&lt;key&gt;</dd>
      <dt>Mode, brightness override</dt><dd class="mono">${base}/&lt;device&gt;/mode · …/brightness_override</dd>
    </dl>
  </section>`,
    );
    return;
  }
  const devices = state.devices.size;
  const html = SECTIONS.map((section) => {
    const list = rows.filter((row) => row.section === section.id);
    let content;
    if (list.length > 0)
      content = `<div role="table" aria-labelledby="h-${section.id}">${HEAD}${list.map((row) => rowHtml(state, row)).join("")}</div>`;
    else if (section.id === "control")
      content = `<p class="none">${devices === 1 ? "The display is" : `All ${devices} displays are`} set to Play. No brightness override is set; the scenes control brightness.</p>`;
    else content = `<p class="none">None.</p>`;
    return `<section class="sec" aria-labelledby="h-${section.id}">
    <div class="sec-h"><h2 id="h-${section.id}">${esc(section.title)}</h2><span class="t3">${esc(section.note)}</span></div>
    ${content}
  </section>`;
  }).join("");
  setHtml(
    body,
    `<p class="lead">Overlays are retained MQTT messages from Home Assistant, Node-RED or any other client. They change what a display shows and stay in effect across restarts until they are cleared. Choosing a scene in this UI clears the scene overlay it replaces.</p>${html}`,
  );
}

/** @param {string} id */
function clear(id) {
  const key = slotOf(id);
  start(
    key,
    async () => {
      const answer = await request("DELETE", `/api/v2/overlays/${encodeURIComponent(id)}`, {
        resource: "overlays",
        key,
      });
      applyAnswer(answer);
      return answer;
    },
    {
      done: (answer) =>
        answer.body?.pending && !answer.body?.confirmed ? "Sent; waiting for the broker to confirm" : null,
    },
  );
  render(getState());
}

/** @param {Event} event */
function onClick(event) {
  const button = /** @type {HTMLElement} */ (event.target).closest?.("[data-act]");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  if (button.dataset.act === "clear" && button.dataset.id) clear(button.dataset.id);
}

/** @type {import("../router.js").Page} */
export const page = {
  mount(target, _params) {
    root = target;
    root.className = "p-overlays";
    shown = [];
    since = Date.now();
    // A fresh opening: what idle rows said before is gone; a Clear that runs
    // keeps its slot and says its outcome when it comes.
    forgetIdle((key) => key.startsWith("overlay:"));
    root.innerHTML = `<div class="head"><h1 tabindex="-1">Overlays</h1><span class="sub" role="status"></span></div><div class="ov-body"></div>`;
    root.addEventListener("click", onClick);
    unsubscribe = subscribe((state) => state, render);
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    root?.removeEventListener("click", onClick);
    root = null;
  },
};
