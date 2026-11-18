/* global document, HTMLButtonElement, HTMLInputElement, HTMLFormElement */
/**
 * Page: Device control.
 * Approved mockups: pixd-device-{default,overridden,previewing,stale,offline,offline-ulanzi,loading,error,empty,json-error} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Facts strip, display column (preview, mode, brightness), 'Showing now' block with its five fixed rows, scene option list, settings band and rows, 'Separate copy of this scene'. After a scene switch the settings form appears only once its values are loaded (build rule 1).
 *
 * States without a mockup, as Tick decided them (tick-states-0030.md):
 *  - a device in shadow (item 7): neutral filled dot "Shadow · not driving
 *    the display" with the reason; the preview keeps drawing, captioned
 *    "Would show · not on the display"; Source row "Shadow: changes here
 *    don't reach the display", no action; scene, mode and brightness stay
 *    usable
 *  - a device that exists only in the MQTT config overlay (item 8): the
 *    sentence in the title status line with the violet overlay icon, and
 *    "Add to config.json" beside it (POST …/adopt)
 * And the defaults of the interfaces entry, section 13, item 11, for an
 * overlay record that the broker has not delivered again since the last
 * reconnect (a held display, a switch-off, a waiting scene or setting
 * overlay).
 *
 * Owner: UI worker.
 */

import { request } from "../api.js";
import { createPixelPreview } from "../components/pixel-preview.js";
import { openRecoveryDialog } from "../components/recovery-dialog.js";
import { createSettingsForm, failedEnds, retryEnd } from "../components/settings-form.js";
import { dot, icon, setAttr, setClass, setHtml } from "../dom.js";
import { esc, percent, topicHtml } from "../format.js";
import { getSession } from "../session.js";
import { deviceSlot, forgetIdle, op, start } from "../ops.js";
import { applyAnswer, getState, subscribe } from "../store.js";
import {
  deviceCondition,
  deviceStatus,
  deviceTitle,
  facts,
  previewCaption,
  previewState,
  sceneChoices,
  sceneMeta,
  sceneName,
  showingNow,
  sizeOf,
  typeLabel,
  waitingSettingsLine,
} from "../view/model.js";

/** @type {HTMLElement|null} */
let root = null;
/** @type {string} */
let name = "";
/** @type {(() => void)|null} */
let unsubscribe = null;
/** @type {ReturnType<typeof createPixelPreview>|null} */
let preview = null;
/** @type {string} */
let previewKey = "";
/** @type {ReturnType<typeof createSettingsForm>|null} */
let form = null;
/** @type {{update: (device: any) => void, close: () => void}|null} */
let dialog = null;
let wantRecovery = false;
/**
 * The slots of this device's controls (ops.js), in the device's life:
 * `scene`, `mode`, `brightness`, `restore` (Return to your choice; the
 * Devices page's Restore is the same slot), `adopt` (shared with Config).
 * Copy is `copy:<scene>`. Busy labels, failures and notes are read from
 * the slots, so another device, another life of this one, or another page
 * never shows what belongs to a different operation.
 */
const SLOTS = { scene: "scene", mode: "mode", brightness: "brightness", return: "restore", adopt: "adopt" };
/** Brightness typed on the slider, until its own request was answered: the slot it belongs to and the level. @type {{key: string, level: number}|null} */
let sliding = null;
/** Why the settings form's last preview failed (B-175: said in the title status line and on the Display line); null when it worked. @type {string|null} */
let previewFailure = null;
/** A render runs; a change the settings form reports meanwhile draws once more after it. */
let rendering = false;
let renderAgain = false;

/**
 * The slot of one of this page's controls, in the life of the device shown.
 *
 * @param {keyof typeof SLOTS} control
 * @param {any} [view]
 * @returns {string|null} null: the device is not listed
 */
function slotOf(control, view = getState().devices.get(name)) {
  return view ? deviceSlot(SLOTS[control], view) : null;
}

/** @param {keyof typeof SLOTS} control @param {any} view */
const opOf = (control, view) => op(slotOf(control, view) ?? "");

/**
 * Start a control's operation (ops.js): ignored while its slot is busy,
 * from this page or another (B-176); its outcome is said only while it is
 * the slot's current operation.
 *
 * @param {keyof typeof SLOTS} control
 * @param {(key: string) => Promise<import("../api.js").Answer>} send the request, with the slot as its control key
 * @param {string} busyText
 */
function act(control, send, busyText) {
  const key = slotOf(control);
  if (!key) return;
  const settled = () => {
    if (sliding?.key === key) sliding = null;
  };
  start(key, async () => applyAnswer(await send(key)), {
    device: name,
    label: busyText,
    done: settled,
    failed: settled,
  });
  render(getState());
}

const path = (/** @type {string} */ tail) =>
  `/api/v2/devices/${encodeURIComponent(name)}${tail}`;

/** @param {string|null} scene */
function chooseScene(scene) {
  const state = getState();
  const view = state.devices.get(name);
  act(
    "scene",
    (key) =>
      request("PUT", path("/scene"), {
        resource: `device:${name}`,
        key,
        body: { scene },
      }),
    `Switching to ${sceneName(state, scene, view?.type)}…`,
  );
}

/** @param {string} mode */
function setMode(mode) {
  act(
    "mode",
    (key) =>
      request("PUT", path("/mode"), {
        resource: `device:${name}`,
        key,
        body: { mode },
      }),
    mode === "play" ? "Starting play…" : mode === "pause" ? "Pausing…" : "Stopping…",
  );
}

/** @param {number|null} override */
function setBrightness(override) {
  act(
    "brightness",
    (key) =>
      request("PUT", path("/brightness"), {
        resource: `device:${name}`,
        key,
        body: { override },
      }),
    override === null ? "Back to Auto…" : `Setting ${override} %…`,
  );
}

function returnToChoice() {
  act(
    "return",
    (key) =>
      request("DELETE", path("/scene-overlay"), {
        resource: `device:${name}`,
        key,
      }),
    "Clearing the overlay…",
  );
}

function adopt() {
  act(
    "adopt",
    (key) =>
      request("POST", path("/adopt"), {
        resource: `device:${name}`,
        key,
        body: {},
      }),
    "Adding…",
  );
}

/**
 * Create copy: an operation in the slot of the scene (`copy:<scene>`);
 * what it made, or why it failed, is said beside the button from the slot.
 *
 * @param {HTMLFormElement} copyForm
 */
function copyScene(copyForm) {
  const view = getState().devices.get(name);
  const key = view?.desired?.scene?.scene;
  if (!key) return;
  const data = new FormData(copyForm);
  const replace = data.get("replace") === "on";
  start(
    `copy:${key}`,
    () =>
      request("POST", `/api/v2/scenes/${encodeURIComponent(key)}/copy`, {
        resource: `scene-copy:${key}`,
        key: `copy:${key}`,
        body: {
          targetKey: String(data.get("targetKey") ?? "") || undefined,
          name: String(data.get("name") ?? "") || undefined,
          replace,
        },
      }),
    {
      owns: { scene: () => getState().devices.get(view.name)?.desired?.scene?.scene },
      effects: { start: ["epoch", "scene"], slot: ["epoch", "scene"] },
      label: "Creating…",
      done: (answer) =>
        replace
          ? `${key} now uses the copy; the original file was backed up${answer.body?.backup ? ` to ${answer.body.backup}` : ""}.`
          : `Created ${answer.body?.scene?.key ?? ""} at ${answer.body?.path ?? ""}.`,
    },
  );
  render(getState());
}

/**
 * @param {import("../store.js").ClientState} state
 */
function render(state) {
  if (!root) return;
  if (rendering) {
    renderAgain = true;
    return;
  }
  rendering = true;
  try {
    draw(state);
  } finally {
    rendering = false;
  }
  if (renderAgain) {
    renderAgain = false;
    render(getState());
  }
}

/**
 * @param {import("../store.js").ClientState} state
 */
function draw(state) {
  if (!root) return;
  const view = state.devices.get(name);
  const q = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (root).querySelector(selector));
  const head = q(".dev-head");
  const grid = q(".dev-grid");
  const missing = q(".missing");
  if (!view) {
    head.hidden = true;
    grid.hidden = true;
    q(".facts").hidden = true;
    missing.hidden = false;
    setHtml(
      missing,
      state.loaded
        ? `<div class="head"><h1 tabindex="-1">${esc(name)}</h1><span class="sub">pixdcon has no device of this name</span></div>`
        : `<div class="head"><h1 tabindex="-1">${esc(name)}</h1><span class="sub">${icon("spinner")}Loading…</span></div>`,
    );
    return;
  }
  head.hidden = false;
  grid.hidden = false;
  q(".facts").hidden = false;
  missing.hidden = true;
  const frozen = state.live.state === "lost";
  const shadow = view.desired?.output === "shadow";
  const mqttOk = state.mqtt?.state === "connected" || state.mqtt?.state === "disabled";
  const controlsNeedMqtt = !shadow && state.mqtt?.state !== "disabled";
  const mqttBlocked = controlsNeedMqtt && !mqttOk;
  const title = deviceTitle(view);
  const size = sizeOf(view);

  // Head
  const h1 = q(".dev-head h1");
  if (h1.textContent !== title) h1.textContent = title;
  const metaParts = [];
  if (view.displayName && view.displayName !== view.name) metaParts.push(`<span class="mono">${esc(view.name)}</span>`);
  metaParts.push(esc(typeLabel(view.type)), `${size.width}×${size.height}`);
  if (view.desired?.address?.value) metaParts.push(`<span class="mono">${esc(view.desired.address.value)}</span>`);
  if (view.comment) metaParts.push(esc(view.comment));
  metaParts.push(`<a class="link" style="font-size:13px" href="#/config/${encodeURIComponent(view.name)}">Device settings</a>`);
  setHtml(q(".dev-head .meta"), metaParts.join(" · "));
  const status = deviceStatus(view, state);
  const stCls = status.kind === "shadow" ? "st shadow" : `st ${status.dot === "idle" ? "" : status.dot}`.trim();
  setHtml(q(".dev-head .st-slot"), `<span class="${stCls}">${dot(status.dot)}${esc(status.label)}</span>`);

  // Title status line, on its own line under the title row (Tick L1): an
  // end of a settings preview that failed comes first, with Retry (the
  // operation rule, 3 and 4); then the page conditions (Tick, item 8;
  // section 13, item 11).
  const ended = failedEnds(view)[0];
  const sub = q(".dev-head .sub");
  if (ended) {
    const text = `Settings preview of ${sceneName(state, ended.scene, view.type)} not ended: ${ended.failure}`;
    setClass(sub, "sub warn");
    setHtml(
      sub,
      `${icon("alert")}<span class="sub-text">${esc(text)}</span> <button class="btn" type="button" data-act="end-retry" data-scene="${esc(ended.scene)}"${ended.busy ? " disabled" : ""}>${ended.busy ? `${icon("spinner")}Retrying…` : `${icon("reload")}Retry`}</button>`,
    );
    setAttr(sub, "title", text);
  } else {
    const condition = deviceCondition(state, view, { previewFailure });
    if (!condition) {
      setClass(sub, "sub");
      setHtml(sub, "");
      setAttr(sub, "title", null);
    } else {
      setClass(sub, `sub${condition.cls ? ` ${condition.cls}` : ""}`);
      const lead = condition.dot ? dot(condition.dot) : condition.icon ? icon(condition.icon) : "";
      let actionHtml = "";
      if (condition.action) {
        const adopting = opOf("adopt", view);
        actionHtml = ` <button class="btn" type="button" data-act="adopt"${adopting.busy || frozen ? " disabled" : ""}>${adopting.busy ? `${icon("spinner")}${esc(adopting.label)}` : esc(condition.action.label)}</button>${adopting.failure ? ` <span class="fail">${esc(adopting.failure)}</span>` : ""}`;
      }
      setHtml(sub, `${lead}<span class="sub-text">${esc(condition.text)}</span>${actionHtml}`);
      setAttr(sub, "title", condition.title ?? condition.text);
    }
  }

  // Facts
  setHtml(
    q(".facts"),
    facts(state, view)
      .map(
        (fact) =>
          `<div class="fact"><dt>${esc(fact.label)}</dt><dd><span class="${fact.mono ? "mono" : fact.muted ? "t3" : "num"}"${fact.cls ? ` style="color:var(--${fact.cls})"` : ""}>${esc(fact.value)}</span></dd></div>`,
      )
      .join(""),
  );

  // Display column
  const key = `${view.name}/${view.incarnation}/${view.type}`;
  if (!preview || previewKey !== key) {
    preview?.destroy();
    previewKey = key;
    preview = createPixelPreview(q(".pv-host"), {
      scale: view.type === "pixoo" ? 5 : 10,
      grid: Boolean(view.preview?.showGrid),
      veil: 0.6,
      size,
      label: `Live preview of ${title}`,
    });
  }
  preview.setGrid(Boolean(view.preview?.showGrid));
  const pv = previewState(state, view);
  preview.draw(pv.frame, { veil: pv.veil, reason: pv.reason, spinner: pv.spinner });
  setHtml(q(".cap-text"), esc(previewCaption(state, view)));
  setAttr(q(".cap a"), "href", `#/devices/${encodeURIComponent(view.name)}/enlarged`);

  // Mode
  const mode = view.desired?.mode ?? {};
  const moding = opOf("mode", view);
  const modeDisabled = frozen || mqttBlocked || moding.busy;
  for (const button of root.querySelectorAll('[data-act="mode"]')) {
    const value = button.getAttribute("data-mode");
    setAttr(button, "aria-pressed", String(mode.value === value));
    /** @type {HTMLButtonElement} */ (button).disabled = modeDisabled;
    setAttr(button, "title", mqttBlocked ? "Mode needs MQTT; it waits for the broker" : value === "play" ? "Pressing Play while playing re-initialises the display" : null);
  }
  const modeHint = q(".mode-hint");
  if (moding.busy) {
    setClass(modeHint, "hint mode-hint");
    setHtml(modeHint, `${icon("spinner")} ${esc(moding.label)}`);
  } else if (moding.failure) {
    setClass(modeHint, "hint mode-hint");
    setHtml(modeHint, `<span style="color:var(--bad)">Not changed: ${esc(moding.failure)}</span>`);
  } else if (mode.source === "mqtt") {
    setClass(modeHint, "hint mode-hint ovr");
    setHtml(modeHint, `Set by an MQTT overlay since ${esc(new Date(mode.since).toTimeString().slice(0, 8))}. Pause holds the current frame; Stop blanks the display.`);
  } else {
    setClass(modeHint, "hint mode-hint");
    setHtml(modeHint, "Pause holds the current frame. Stop blanks the display and switches it off.");
  }

  // Brightness
  const brightness = view.desired?.brightness ?? {};
  const override = brightness.override ?? null;
  const last = view.effective?.lastBrightness ?? null;
  const briOp = opOf("brightness", view);
  const briDisabled = frozen || mqttBlocked || briOp.busy;
  for (const button of root.querySelectorAll('[data-act="bri-mode"]')) {
    const value = button.getAttribute("data-value");
    setAttr(button, "aria-pressed", String(value === (override === null ? "auto" : "override")));
    /** @type {HTMLButtonElement} */ (button).disabled = briDisabled;
    setAttr(button, "title", mqttBlocked ? "Brightness needs MQTT; it waits for the broker" : null);
  }
  const range = /** @type {HTMLInputElement} */ (q('input[type="range"]'));
  range.disabled = override === null || briDisabled;
  const slid = sliding && sliding.key === slotOf("brightness", view) ? sliding.level : null;
  const shownLevel = slid ?? override ?? last ?? 50;
  if (document.activeElement !== range && range.value !== String(shownLevel)) range.value = String(shownLevel);
  const val = q(".range .val");
  setClass(val, `val num${override === null ? " off" : ""}`);
  setHtml(val, esc(slid !== null ? percent(slid) : override !== null ? percent(override) : percent(last)));
  const briHint = q(".bri-hint");
  if (briOp.busy) {
    setClass(briHint, "hint bri-hint");
    setHtml(briHint, `${icon("spinner")} ${esc(briOp.label)}`);
  } else if (briOp.failure) {
    setClass(briHint, "hint bri-hint");
    setHtml(briHint, `<span style="color:var(--bad)">Not changed: ${esc(briOp.failure)}</span>`);
  } else if (override !== null) {
    setClass(briHint, "hint bri-hint ovr");
    setHtml(
      briHint,
      brightness.source === "mqtt"
        ? `Override from an MQTT overlay: the display stays at ${esc(percent(override))} whatever the scene asks for.`
        : `Override: the display stays at ${esc(percent(override))} whatever the scene asks for.`,
    );
  } else {
    setClass(briHint, "hint bri-hint");
    const showing = view.desired?.scene?.scene;
    setHtml(
      briHint,
      !showing
        ? "Auto: the scene sets brightness once one runs."
        : last !== null
          ? `Auto: the scene sets brightness. Last set: ${esc(percent(last))}.`
          : view.health?.state === "starting"
            ? "Auto: the scene sets brightness once it runs."
            : "Auto: this scene does not set brightness, so the display keeps its current level.",
    );
  }

  // Showing now
  const now = showingNow(state, view, { previewFailure });
  setClass(q(".why"), `why${now.tint ? ` ${now.tint}` : ""}`);
  setHtml(q(".why .k-now"), esc(now.label));
  setHtml(
    q(".why .v-now"),
    `<b>${esc(now.showing.name)}</b>${now.showing.key ? `<span class="mono t3">${esc(now.showing.key)}</span>` : ""}`,
  );
  const src = /** @type {any} */ (now.source);
  setClass(q(".why .v-src"), `v v-src${src.cls ? ` ${src.cls}` : ""}`);
  const srcText = src.topic
    ? `${esc(src.text)}<code>${topicHtml(src.topic)}</code>`
    : esc(src.text);
  const srcSub = src.sub
    ? `<span class="wsub">${esc(src.sub.replace(/ · Overlays$/, ""))} · <a class="link" href="#/overlays">Overlays</a></span>`
    : "";
  setHtml(q(".why .v-src"), `${src.icon ? icon(src.icon) : ""}<span>${srcText}${srcSub}</span>`);
  const disp = /** @type {any} */ (now.display);
  setClass(q(".why .v-disp"), `v v-disp${disp.cls ? ` ${disp.cls}` : ""}`);
  setAttr(q(".why .v-disp"), "title", disp.title ?? null);
  setHtml(
    q(".why .v-disp"),
    `${disp.dot ? dot(disp.dot) : disp.icon ? icon(disp.icon) : ""}<span class="num">${esc(disp.text)}${disp.sub ? `<span class="wsub">${esc(disp.sub)}</span>` : ""}</span>`,
  );
  setClass(q(".why .v-choice"), `v v-choice ${now.choice.cls}`);
  setHtml(
    q(".why .v-choice"),
    `<span>${esc(now.choice.text)}</span>${now.choice.note ? `<span class="t3"${now.choice.noteTitle ? ` title="${esc(now.choice.noteTitle)}"` : ""}>${esc(now.choice.note)}</span>` : ""}`,
  );
  let actions = "";
  if (now.action) {
    const actionIcon = now.action.kind === "return" ? "undo" : now.action.kind === "recovery" ? "info" : "file";
    const cls = now.action.kind === "return" ? "btn primary" : "btn";
    const returning = opOf("return", view);
    const busy = now.action.kind === "return" && returning.busy;
    if (now.action.kind === "fixconfig")
      actions = `<a class="btn" href="#/config/raw">${icon("file")}Fix config.json</a>`;
    else
      actions = `<button class="${cls}" type="button" data-act="${now.action.kind}"${now.action.disabled || busy ? " disabled" : ""}${now.action.title ? ` title="${esc(now.action.title)}"` : ""}>${busy ? `${icon("spinner")}${esc(returning.label || "Clearing the overlay…")}` : `${icon(actionIcon)}${esc(now.action.label)}`}</button>`;
    if (now.action.kind === "return" && returning.failure && !busy)
      actions += `<span style="color:var(--bad);font-size:12px">${esc(returning.failure)}</span>`;
  }
  setHtml(q(".why .acts"), actions);

  // Scene section
  const scene = view.desired?.scene ?? {};
  const choice = view.desired?.choice ?? {};
  const overlaid = scene.source === "overlay" || scene.source === "blob";
  const overlayOnly = view.origin === "blob";
  setHtml(
    q(".scene-note"),
    overlayOnly
      ? shadow
        ? "Choosing a scene changes the preview; it is not saved until the device is added to config.json."
        : "Choosing a scene switches the display now; it is not saved until the device is added to config.json."
      : shadow
      ? "Choosing a scene saves it as your choice; in shadow only the preview changes."
      : view.health?.state === "offline"
        ? "Choosing a scene saves it as your choice; the display shows it once it is back."
        : overlaid
          ? "Choosing a scene switches the display now, saves it as your choice and clears the overlay."
          : "Choosing a scene switches the display now and saves it as your choice.",
  );
  setAttr(q(".opts"), "aria-label", `Scene for ${title}`);
  const choices = sceneChoices(state, view);
  const showing = scene.scene ?? "";
  const switching = opOf("scene", view);
  const pendingTarget = switching.busy ? null : view.pending?.op === "scene" ? view.pending.target : null;
  const optionHtml = (/** @type {{value: string, label: string}} */ option) => {
    const checked = option.value === showing;
    let tag = "";
    let tagCls = "tag";
    if (pendingTarget !== null && option.value === (pendingTarget ?? "")) tag = `${icon("spinner")}switching`;
    else if (checked && view.health?.state === "starting" && !shadow) tag = `${icon("spinner")}starting`;
    else if (checked && overlaid && !shadow) {
      tag = "overlay";
      tagCls = "tag ovr";
    } else if (!checked && overlaid && option.value === (choice.scene ?? "") && option.value !== "") {
      tag = "your choice";
      tagCls = "tag mine";
    }
    return `<button class="opt${checked && overlaid && !shadow ? " ovr" : ""}" type="button" role="radio" aria-checked="${checked}" data-act="scene" data-scene="${esc(option.value)}"${frozen || switching.busy ? " disabled" : ""}><span class="rd" aria-hidden="true"></span><span class="on" title="${esc(option.label)}">${esc(option.label)}</span><span class="${tagCls}">${tag}</span></button>`;
  };
  const [scenesGroup, builtinGroup, noneGroup] = choices.groups;
  setHtml(
    q(".opts"),
    `<div><div class="og-h" aria-hidden="true">Scenes</div>${scenesGroup.options.map(optionHtml).join("")}<div class="opt-sep"></div>${noneGroup.options.map(optionHtml).join("")}</div>` +
      `<div><div class="og-h" aria-hidden="true">Built-in modes</div>${builtinGroup.options.map(optionHtml).join("")}</div>`,
  );
  const meta = sceneMeta(state, showing);
  let below = "";
  if (switching.busy) below = `${icon("spinner")}${esc(switching.label)}`;
  else if (switching.failure)
    below = `<span style="color:var(--bad);display:flex;align-items:center;gap:6px">${icon("alert")}Not switched: ${esc(switching.failure)}</span>`;
  else if (scene.source === "ui" && choice.persisted === false && choice.notSavedReason === "config_invalid")
    below = `<span style="color:var(--warn);display:flex;align-items:center;gap:6px">${icon("alert")}Not saved: ${esc(state.config?.error?.message ?? "config.json is not valid JSON")}. The display switched anyway.</span>`;
  else if (!showing) below = "Choose a scene to start drawing on this display.";
  else if (meta)
    below = `${meta.description ? `${esc(meta.description)} · ` : ""}<span class="mono">${esc(meta.path)}</span>${meta.status === "broken" ? ` · <span style="color:var(--bad)">${esc(meta.error ?? "broken")}</span>` : ""}`;
  else if (showing.startsWith("builtin:")) below = "Drawn by the display itself.";
  setHtml(q(".below.scene-below"), below);

  // Settings (build rule 1: the form of the scene that is showing)
  if (form) {
    // The form's scope is the scene in this life of the device: another
    // epoch or incarnation drops what it shows and loads again.
    form.setScene(showing || null, showing ? sceneName(state, showing, view.type) : undefined, {
      epoch: view.epoch ?? null,
      incarnation: Number(view.incarnation ?? 0),
    });
    form.update(state.settings.get(`${view.name}/${showing}`), {
      frozen,
      mqttConnected: state.mqtt?.state === "connected",
      shadow,
      configInvalid: state.config?.valid === false,
      overlayOnly: view.origin === "blob",
      waiting: showing ? waitingSettingsLine(state, view.name, showing) : null,
    });
  }

  // Separate copy of this scene (B-091, B-182)
  const adv = q(".adv");
  const copyable = Boolean(meta) && !showing.startsWith("builtin:");
  adv.hidden = !copyable;
  if (copyable && meta) {
    setHtml(
      q(".adv .copy-of"),
      `Creates a new scene file and key, so one device can diverge from ${esc(sceneName(state, showing, view.type))}.`,
    );
    setHtml(q(".adv .replace-label"), `Replace ${esc(showing)} with the copy (the original file is backed up on disk first)`);
    const copying = op(`copy:${showing}`);
    const copyButton = /** @type {HTMLButtonElement} */ (q(".adv [data-act='copy']"));
    copyButton.disabled = frozen || copying.busy;
    setHtml(copyButton, copying.busy ? `${icon("spinner")}Creating…` : `${icon("copy")}Create copy`);
    const slot = q(".adv .slot");
    setHtml(
      slot,
      copying.failure
        ? `<span style="color:var(--bad)">Not copied: ${esc(copying.failure)}</span>`
        : esc(copying.note ?? ""),
    );
  }

  // Recovery dialog
  if (dialog) dialog.update(view);
  else if (wantRecovery && status.kind === "bad") {
    wantRecovery = false;
    openRecovery();
  }
}

function openRecovery() {
  const view = getState().devices.get(name);
  if (!view || dialog || !root) return;
  const opener = /** @type {HTMLElement} */ (root.querySelector('[data-act="recovery"]') ?? root);
  dialog = openRecoveryDialog(view, opener);
  const closing = dialog;
  const close = closing.close;
  closing.close = () => {
    close();
    if (dialog === closing) dialog = null;
  };
}

/** @param {Event} event */
function onClick(event) {
  const button = /** @type {HTMLElement} */ (event.target).closest?.("[data-act]");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  switch (button.dataset.act) {
    case "scene":
      chooseScene(button.dataset.scene === "" ? null : String(button.dataset.scene));
      break;
    case "mode":
      setMode(String(button.dataset.mode));
      break;
    case "bri-mode": {
      const view = getState().devices.get(name);
      if (button.dataset.value === "auto") setBrightness(null);
      else setBrightness(Math.round(view?.effective?.lastBrightness ?? 50));
      break;
    }
    case "return":
      returnToChoice();
      break;
    case "recovery":
      openRecovery();
      break;
    case "adopt":
      adopt();
      break;
    case "end-retry": {
      const view = getState().devices.get(name);
      if (view) retryEnd(view, String(button.dataset.scene), getSession());
      render(getState());
      break;
    }
  }
}

/** @param {Event} event */
function onInput(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type === "range") {
    const key = slotOf("brightness");
    if (key) sliding = { key, level: Number(target.value) };
    render(getState());
  }
}

/** @param {Event} event */
function onChange(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type === "range")
    setBrightness(Number(target.value));
}

/** @param {Event} event */
function onSubmit(event) {
  const target = event.target;
  if (!(target instanceof HTMLFormElement) || !target.classList.contains("copyf")) return;
  event.preventDefault();
  copyScene(target);
}

/** @param {KeyboardEvent} event the scene radio group: arrows move and apply (approved spec 8) */
function onKey(event) {
  const target = /** @type {HTMLElement} */ (event.target);
  if (!target.matches?.('.opt[role="radio"]')) return;
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const all = /** @type {HTMLButtonElement[]} */ ([...(root?.querySelectorAll('.opt[role="radio"]') ?? [])]);
  const at = all.indexOf(/** @type {HTMLButtonElement} */ (target));
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
  const next = all[(at + step + all.length) % all.length];
  if (!next) return;
  event.preventDefault();
  next.focus();
  chooseScene(next.dataset.scene === "" ? null : String(next.dataset.scene));
}

/** @type {import("../router.js").Page} */
export const page = {
  mount(target, params) {
    root = target;
    name = params.name;
    wantRecovery = params.recovery === "1";
    // A fresh opening: what this device's idle controls said before is gone;
    // an operation that runs keeps its slot, and its outcome is said when it
    // comes. A failed end of a preview stays until it is retried or replaced.
    forgetIdle((key) => /^(scene|mode|brightness|restore|adopt):/.test(key) && key.slice(key.indexOf(":") + 1).startsWith(`${name}@`));
    sliding = null;
    previewFailure = null;
    root.className = "p-device";
    root.innerHTML = `
      <a class="crumb" href="#/devices">${icon("left")}Devices</a>
      <div class="missing" hidden></div>
      <div class="dev-head">
        <div class="dh"><div class="dh-line"><h1 tabindex="-1"></h1></div><div class="sub" role="status"></div><div class="meta"></div></div>
        <span class="st-slot"></span>
      </div>
      <dl class="facts"></dl>
      <div class="dev-grid">
        <aside class="side" aria-label="Display">
          <div>
            <div class="pv-host"></div>
            <div class="cap"><span class="num cap-text"></span><a class="link">${icon("expand")}Enlarge</a></div>
          </div>
          <div class="blk"><h3 id="h-mode">Mode</h3>
            <div class="seg" role="group" aria-labelledby="h-mode"><button type="button" data-act="mode" data-mode="play">${icon("play")}Play</button><button type="button" data-act="mode" data-mode="pause">${icon("pause")}Pause</button><button type="button" data-act="mode" data-mode="stop">${icon("stop")}Stop</button></div>
            <div class="hint mode-hint"></div>
          </div>
          <div class="blk"><h3 id="h-bri">Brightness</h3>
            <div class="seg" role="group" aria-labelledby="h-bri"><button type="button" data-act="bri-mode" data-value="auto">Auto</button><button type="button" data-act="bri-mode" data-value="override">Override</button></div>
            <div class="range" style="margin-top:12px"><input type="range" min="1" max="100" value="50" aria-label="Brightness override in percent"><span class="val num off"></span></div>
            <div class="hint bri-hint"></div>
          </div>
        </aside>
        <div class="content">
          <div class="why" role="group" aria-label="What is showing and why">
            <div class="k k-now" style="grid-row:1">Showing now</div><div class="v now v-now" style="grid-row:1"></div>
            <div class="k" style="grid-row:2">Source</div><div class="v v-src" style="grid-row:2"></div>
            <div class="k" style="grid-row:3">Display</div><div class="v v-disp" style="grid-row:3"></div>
            <div class="k" style="grid-row:4">Your choice</div><div class="v v-choice" style="grid-row:4"></div>
            <div class="acts"></div>
          </div>
          <section class="sec" aria-labelledby="h-scene">
            <div class="sec-h"><h2 id="h-scene">Scene</h2><span class="t3 scene-note"></span></div>
            <div class="opts" role="radiogroup"></div>
            <div class="below scene-below" role="status"></div>
          </section>
          <section class="sec settings-host" aria-labelledby="h-settings"></section>
          <details class="adv" hidden>
            <summary>${icon("right")}Separate copy of this scene<span class="t3 copy-of"></span></summary>
            <form class="copyf" style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;max-width:640px;padding:4px 0 16px">
              <label style="font-size:13px">New scene key<input class="input mono" style="margin-top:6px" name="targetKey" autocomplete="off"></label>
              <label style="font-size:13px">Name<input class="input" style="margin-top:6px" name="name" autocomplete="off"></label>
              <label class="check" style="grid-column:1/-1;font-size:13px"><input type="checkbox" name="replace"><span class="replace-label"></span></label>
              <div style="display:flex;align-items:center;gap:12px;grid-column:1/-1"><button class="btn" type="submit" data-act="copy">${icon("copy")}Create copy</button><span class="slot"></span></div>
            </form>
          </details>
        </div>
      </div>`;
    form = createSettingsForm(
      /** @type {HTMLElement} */ (root.querySelector(".settings-host")),
      {
        device: name,
        session: getSession,
        onPreviewFailure(message) {
          previewFailure = message;
          render(getState());
        },
      },
    );
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("keydown", onKey);
    unsubscribe = subscribe((state) => state, render);
  },
  unmount() {
    unsubscribe?.();
    unsubscribe = null;
    dialog?.close();
    dialog = null;
    if (form) {
      // Leaving the page reverts what it previewed (approved spec 8): the
      // scenes it switched away from ended when it switched; this ends the
      // one it shows.
      void form.end();
      form.destroy();
      form = null;
    }
    previewFailure = null;
    preview?.destroy();
    preview = null;
    previewKey = "";
    if (root) {
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      root.removeEventListener("change", onChange);
      root.removeEventListener("submit", onSubmit);
      root.removeEventListener("keydown", onKey);
    }
    root = null;
  },
};
