/* global document, HTMLButtonElement, HTMLFormElement */
/**
 * Page: Config.
 * Approved mockups: pixd-config-{default,edit} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Devices list with Edit (display name, comment, preview poll, pixel grid), Add device, registered scenes, theme for this browser. Name, type, address and removal stay in the raw config.
 *
 * Tick, item 8: a device that exists only in the MQTT config overlay shows
 * "from the MQTT config overlay · not saved" in its row, with the action
 * "Add to config.json" (POST …/adopt) where Edit would be: its settings
 * have no entry in config.json to be saved into until it is added.
 *
 * Device settings save per device and answer with the applied values, so
 * the form never falls back to old values (S-1); the answer goes through
 * the store's fence like every other view.
 *
 * Owner: UI worker.
 */

import { ApiError, request } from "../api.js";
import { icon, setHtml, setStatusLine } from "../dom.js";
import { clock, esc } from "../format.js";
import { applyAnswer, getState, subscribe } from "../store.js";
import { savedTheme, setTheme } from "../theme.js";
import { pageCondition, sceneName } from "../view/model.js";

/** @type {HTMLElement|null} */
let root = null;
/** @type {(() => void)|null} */
let unsubscribe = null;
/** The device whose row is open for editing. @type {string|null} */
let open = null;
/** Requests that run, by control. @type {Set<string>} */
const running = new Set();
/** The last outcome per control, said beside it. @type {Map<string, {text: string, bad: boolean}>} */
const outcomes = new Map();

const typeName = (/** @type {string} */ type) =>
  type === "pixoo" ? "Pixoo64" : type === "ulanzi" ? "Ulanzi / AWTRIX" : type;

/**
 * @param {import("../store.js").ClientState} state
 * @returns {{text: string, cls?: string, icon?: string|null}}
 */
function title(state) {
  const config = state.config ?? {};
  const condition = pageCondition(state);
  if (condition && condition.cls === "bad") return condition;
  if (running.has("raw-save")) return { text: "Saved · reloading…", icon: "spinner" };
  if (config.valid === false)
    return {
      text: `config.json on disk is invalid (since ${clock(config.invalidSince)}) · pixdcon runs the version loaded at ${clock(config.loadedAt)}`,
      cls: "bad",
      icon: "alert",
    };
  const reload = config.reload;
  if (reload && reload.ok === false)
    return { text: `config.json not applied at ${clock(reload.at)}: ${reload.message ?? "the loader failed"}`, cls: "bad", icon: "alert" };
  const count = reload?.devicesRunning ?? state.devices.size;
  return {
    text: `config.json reloaded at ${clock(reload?.at ?? config.loadedAt)} · ${count} ${count === 1 ? "device" : "devices"} running`,
    icon: "check",
  };
}

/**
 * @param {import("../store.js").ClientState} state
 * @param {any} view
 * @returns {string}
 */
function rowHtml(state, view) {
  const scene = view.desired?.scene ?? {};
  const choice = view.desired?.choice ?? {};
  const isOpen = open === view.name;
  const choiceName = choice.scene ? sceneName(state, choice.scene, view.type) : "None";
  let choiceCell = esc(choiceName);
  if (view.origin === "blob")
    choiceCell += `<span class="ovm">${icon("layers")} from the MQTT config overlay · not saved</span>`;
  else if ((scene.source === "overlay" || scene.source === "blob") && scene.scene !== choice.scene)
    choiceCell += `<span class="ovm">showing ${esc(sceneName(state, scene.scene, view.type))} from an MQTT overlay</span>`;
  let action;
  if (view.origin === "blob") {
    const busy = running.has(`adopt:${view.name}`);
    action = `<button class="link" type="button" data-act="adopt" data-device="${esc(view.name)}"${busy ? " disabled" : ""}>${busy ? `${icon("spinner")}Adding…` : "Add to config.json"}</button>`;
  } else
    action = `<button class="btn" type="button" data-act="edit" data-device="${esc(view.name)}" aria-expanded="${isOpen}">${icon("edit")}Edit</button>`;
  const row = `<div class="ct-row${isOpen ? " open" : ""}" role="row">
        <span role="cell" class="mono" style="font-size:12.5px">${esc(view.name)}</span>
        <span role="cell">${view.displayName ? esc(view.displayName) : `<span class="t3">—</span>`}</span>
        <span role="cell">${esc(typeName(view.type))}</span>
        <span role="cell" class="mono" style="font-size:12.5px">${esc(view.desired?.address?.value ?? "")}</span>
        <span role="cell">${choiceCell}</span>
        <span role="cell" class="act">${action}</span>
      </div>`;
  const outcome = outcomes.get(`adopt:${view.name}`);
  const adoptNote = outcome && view.origin === "blob"
    ? `<div class="slot" style="${outcome.bad ? "color:var(--bad)" : ""}">${esc(outcome.text)}</div>`
    : "";
  if (!isOpen) return row + adoptNote;
  return row + editHtml(view);
}

/** @param {any} view @returns {string} the open row: B-079's dialog as a row (pixd-config-edit) */
function editHtml(view) {
  const busy = running.has(`patch:${view.name}`);
  const outcome = outcomes.get(`patch:${view.name}`);
  const poll =
    view.type === "ulanzi"
      ? `<label>Preview poll (ms)<input class="input mono num" style="width:128px" type="number" name="pollMs" min="1000" max="10000" step="500" value="${esc(view.preview?.pollMs ?? 2000)}"><span class="hint">1000 – 10 000. How often the preview reads this display’s screen.</span></label>`
      : "";
  return `<div class="ct-edit" role="row"><div role="cell">
        <form class="ef" data-device="${esc(view.name)}">
          <label>Display name<input class="input" name="displayName" value="${esc(view.displayName ?? "")}"></label>
          <label>Comment<textarea class="input" name="comment" placeholder="Where it hangs, what it is for">${esc(view.comment ?? "")}</textarea></label>
          ${poll}
          <label>Preview grid<span class="check" style="font-weight:400;color:var(--text)"><input type="checkbox" name="showGrid"${view.preview?.showGrid ? " checked" : ""}>Show pixel separators in previews</span></label>
        </form>
        <div class="ef-f"><span class="slot"${outcome?.bad ? ' style="color:var(--bad)"' : ""}>${outcome ? esc(outcome.text) : `Name, type and IP address, and removing the device: in the <a class="link" style="font-size:12px" href="#/config/raw">raw config.json</a>.`}</span><button class="btn" type="button" data-act="cancel">Cancel</button><button class="btn primary" type="button" data-act="patch" data-device="${esc(view.name)}"${busy ? " disabled" : ""}>${busy ? `${icon("spinner")}Saving…` : `${icon("save")}Save`}</button></div>
      </div></div>`;
}

/**
 * @param {import("../store.js").ClientState} state
 */
function render(state) {
  if (!root) return;
  const q = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (root).querySelector(selector));
  setStatusLine(q(".head .sub"), state.loaded ? title(state) : { text: "Loading…" });
  if (!state.loaded) return;
  // An open row keeps what is typed in it: it is written again only when it opens or closes.
  const editing = root.querySelector(".ct-edit form");
  const typing = editing && editing.contains(document.activeElement);
  if (!typing)
    setHtml(q(".ct-body"), [...state.devices.values()].map((view) => rowHtml(state, view)).join(""));
  const scenes = state.scenes ?? [];
  setHtml(
    q(".st-body"),
    scenes
      .map(
        (/** @type {any} */ scene) =>
          `<div class="st-row" role="row"><span role="cell" class="mono" style="font-size:12.5px">${esc(scene.key)}</span><span role="cell">${esc(scene.pretty_name || scene.name || scene.key)}${scene.status === "broken" ? ` <span style="color:var(--bad);font-size:12px">· broken: ${esc(scene.error ?? "")}</span>` : ""}</span><span role="cell">${esc(scene.deviceType === "pixoo" ? "Pixoo64" : scene.deviceType === "ulanzi" ? "Ulanzi" : "any")}</span><span role="cell" class="mono t2" style="font-size:12px">${esc(scene.path)}${scene.pathSource && scene.pathSource !== "config" ? ` <span style="color:var(--ovr)">· from an MQTT overlay</span>` : ""}</span></div>`,
      )
      .join(""),
  );
  const theme = savedTheme();
  for (const button of root.querySelectorAll("#theme-seg button"))
    button.setAttribute("aria-pressed", String(button.getAttribute("value") === theme));
}

/** @param {string} name */
async function patch(name) {
  const form = /** @type {HTMLFormElement|null} */ (root?.querySelector(`.ct-edit form`) ?? null);
  if (!form || running.has(`patch:${name}`)) return;
  const data = new FormData(form);
  /** @type {Record<string, unknown>} */
  const preview = { showGrid: data.get("showGrid") === "on" };
  if (data.has("pollMs")) preview.pollMs = Number(data.get("pollMs"));
  running.add(`patch:${name}`);
  outcomes.delete(`patch:${name}`);
  render(getState());
  try {
    applyAnswer(
      await request("PATCH", `/api/v2/devices/${encodeURIComponent(name)}`, {
        resource: `device:${name}`,
        key: `patch:${name}`,
        body: { displayName: String(data.get("displayName") ?? ""), comment: String(data.get("comment") ?? ""), preview },
      }),
    );
    running.delete(`patch:${name}`);
    open = null;
  } catch (error) {
    running.delete(`patch:${name}`);
    outcomes.set(`patch:${name}`, {
      text: `Not saved: ${error instanceof ApiError ? error.message : "the request failed."}`,
      bad: true,
    });
  }
  /** @type {HTMLElement|null} */ (document.activeElement)?.blur?.();
  render(getState());
}

/** @param {string} name */
async function adopt(name) {
  if (running.has(`adopt:${name}`)) return;
  running.add(`adopt:${name}`);
  outcomes.delete(`adopt:${name}`);
  render(getState());
  try {
    applyAnswer(
      await request("POST", `/api/v2/devices/${encodeURIComponent(name)}/adopt`, {
        resource: `device:${name}`,
        key: `adopt:${name}`,
        body: {},
      }),
    );
  } catch (error) {
    outcomes.set(`adopt:${name}`, {
      text: `Not added: ${error instanceof ApiError ? error.message : "the request failed."}`,
      bad: true,
    });
  }
  running.delete(`adopt:${name}`);
  render(getState());
}

/** @param {HTMLFormElement} form */
async function addDevice(form) {
  const data = new FormData(form);
  const slot = /** @type {HTMLElement} */ (root?.querySelector("#add .slot"));
  const button = /** @type {HTMLButtonElement} */ (form.querySelector("button"));
  if (running.has("add")) return;
  running.add("add");
  button.disabled = true;
  button.innerHTML = `${icon("spinner")}Adding…`;
  try {
    applyAnswer(
      await request("POST", "/api/v2/devices", {
        resource: `device:${data.get("name")}`,
        key: "add-device",
        body: { name: data.get("name"), type: data.get("type"), ip: data.get("ip") },
      }),
    );
    slot.textContent = `Added ${data.get("name")}. pixdcon saved it to config.json and starts it now. Choose its scene on the device page.`;
    form.reset();
  } catch (error) {
    slot.innerHTML = `<span style="color:var(--bad);display:inline-flex;align-items:center;gap:6px">${icon("alert")}${esc(error instanceof ApiError ? error.message : "The request failed.")}</span>`;
  }
  running.delete("add");
  button.innerHTML = `${icon("plus")}Add device`;
  button.disabled = !ready(form);
}

/** @param {HTMLFormElement} form @returns {boolean} */
function ready(form) {
  const data = new FormData(form);
  return String(data.get("name") ?? "").trim() !== "" && String(data.get("ip") ?? "").trim() !== "";
}

/** @param {Event} event */
function onClick(event) {
  const button = /** @type {HTMLElement} */ (event.target).closest?.("button");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  if (button.closest("#theme-seg")) {
    setTheme(/** @type {"system"|"light"|"dark"} */ (button.getAttribute("value") ?? "system"));
    render(getState());
    return;
  }
  switch (button.dataset.act) {
    case "edit":
      open = open === button.dataset.device ? null : String(button.dataset.device);
      outcomes.clear();
      render(getState());
      break;
    case "cancel":
      open = null;
      render(getState());
      break;
    case "patch":
      void patch(String(button.dataset.device));
      break;
    case "adopt":
      void adopt(String(button.dataset.device));
      break;
  }
}

/** @param {Event} event */
function onInput(event) {
  const form = /** @type {HTMLElement} */ (event.target).closest?.("form.addf");
  if (form instanceof HTMLFormElement)
    /** @type {HTMLButtonElement} */ (form.querySelector("button")).disabled = !ready(form);
}

/** @param {Event} event */
function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.classList.contains("addf") && ready(form)) void addDevice(form);
}

/** @type {import("../router.js").Page} */
export const page = {
  mount(target, params) {
    root = target;
    root.className = "p-config";
    open = params.open && params.open !== "add" ? params.open : null;
    running.clear();
    outcomes.clear();
    root.innerHTML = `
  <div class="head"><h1 tabindex="-1">Config</h1><span class="sub" role="status"></span><div class="right"><a class="btn" href="#/config/raw">${icon("file")}Raw config.json</a></div></div>
  <section class="sec" aria-labelledby="h-cd" style="margin-top:12px">
    <div class="sec-h"><h2 id="h-cd">Devices</h2><span class="t3">Saved in config.json; a change restarts only that device. To remove a device or change its IP or type, use the <a class="link" style="font-size:12px" href="#/config/raw">raw config.json</a>.</span></div>
    <div role="table" aria-labelledby="h-cd">
      <div class="ct-head" role="row"><span role="columnheader">Name</span><span role="columnheader">Display name</span><span role="columnheader">Type</span><span role="columnheader">IP address</span><span role="columnheader">Your scene choice</span><span role="columnheader"><span class="vh">Action</span></span></div>
      <div class="ct-body" role="rowgroup"></div>
    </div>
  </section>
  <section class="sec" id="add" aria-labelledby="h-add">
    <div class="sec-h"><h2 id="h-add">Add device</h2></div>
    <div style="padding-top:14px"><form class="addf" aria-label="Add device">
      <label>Name<input class="input mono" name="name" placeholder="ulanzi-58" autocomplete="off"></label>
      <label>Type<span class="select"><select name="type"><option value="ulanzi">Ulanzi / AWTRIX (32×8)</option><option value="pixoo">Pixoo64 (64×64)</option></select>${icon("down", "")}</span></label>
      <label>IP address<input class="input mono" name="ip" placeholder="192.168.1.xx" autocomplete="off" inputmode="decimal"></label>
      <button class="btn primary" type="submit" disabled>${icon("plus")}Add device</button>
    </form></div>
    <div class="slot" role="status" style="margin-top:10px">pixdcon saves the device to config.json and starts it right away. Choose its scene on the device page.</div>
  </section>
  <section class="sec" aria-labelledby="h-sc">
    <div class="sec-h"><h2 id="h-sc">Scenes</h2><span class="t3">Scene files registered in config.json. A changed file reloads by itself.</span></div>
    <div role="table" aria-labelledby="h-sc">
      <div class="st-head" role="row"><span role="columnheader">Key</span><span role="columnheader">Name</span><span role="columnheader">For</span><span role="columnheader">File</span></div>
      <div class="st-body" role="rowgroup"></div>
    </div>
  </section>
  <section class="sec" aria-labelledby="h-ui">
    <div class="sec-h"><h2 id="h-ui">This browser</h2></div>
    <div class="pref"><span>Theme</span><div class="seg" id="theme-seg" role="group" aria-label="Theme"><button type="button" value="system">System</button><button type="button" value="light">Light</button><button type="button" value="dark">Dark</button></div><span class="t3">Stored in this browser only.</span></div>
  </section>`;
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("submit", onSubmit);
    unsubscribe = subscribe((state) => state, render);
    if (params.open === "add") {
      root.querySelector("#add")?.scrollIntoView();
      /** @type {HTMLInputElement|null} */ (root.querySelector('#add input[name="name"]'))?.focus();
    }
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    if (root) {
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      root.removeEventListener("submit", onSubmit);
    }
    root = null;
  },
};

