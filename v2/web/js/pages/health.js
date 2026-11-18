/* global HTMLButtonElement, HTMLElement */
/**
 * Page: Health.
 * Approved mockups: pixd-health-{default,mqtt-offline} (PIXD-81, -v1-approved-2026-11-16).
 *
 * Version, MQTT, displays with last error, the recent log (last 200 lines, filter, Copy). The displays heading states the time rule (stale after 30 s, offline after 2 min), not v1's '5 failed renders'.
 *
 * As Tick decided (tick-states-0030.md):
 *  - item 9, restart required: the title status line says "The MQTT
 *    settings in config.json changed. Restart pixdcon to apply them." No
 *    restart button (v1 has none); the sentence says what to do
 *  - item 10, above the Displays table exactly "Stale after 30 s, offline
 *    after 2 min without a good frame"; "Errors in a row" stays, as a fact
 * And the default of section 13, item 12: one line under the MQTT block,
 * "Config overlay: written by pixdcon v1 during the switch-over", only
 * while that is so.
 *
 * Owner: UI worker.
 */

import { request } from "../api.js";
import { follow as followOp, observeResource, op } from "../ops.js";
import { dot, icon, setHtml, setStatusLine } from "../dom.js";
import { clock, duration, esc, prettyVersion } from "../format.js";
import { applyAnswer, getState, subscribe, tick } from "../store.js";
import { setVersionDisplay, versionDisplay } from "../theme.js";
import {
  HEALTH_RULE,
  blobWriterLine,
  healthRow,
  healthTitle,
  overlaysInEffect,
} from "../view/model.js";

/** @type {HTMLElement|null} */
let root = null;
/** @type {(() => void)|null} */
let unsubscribe = null;
/** "all" | "warn": the log filter. */
let filter = "all";
/** The log pane follows the newest line unless the user scrolled up. */
let follow = true;
let copied = "";
/** Outcomes of a load belong to its mounted opening; data goes to the fence. */
let openings = 0;

/**
 * @param {any} line LogLine
 * @returns {string}
 */
function logLine(line) {
  const at = new Date(line.at);
  const ms = String(at.getMilliseconds()).padStart(3, "0");
  const level = String(line.level ?? "INFO");
  const tag =
    level === "WARN"
      ? `<span class="w">WARN</span> `
      : level === "ERROR"
        ? `<span class="e">ERROR</span>`
        : `${esc(level.padEnd(5, " "))}`;
  return `<span class="ts">${esc(clock(line.at))}.${ms}</span>  ${tag} ${esc(line.message)}`;
}

/**
 * @param {import("../store.js").ClientState} state
 */
function render(state) {
  if (!root) return;
  const q = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (root).querySelector(selector));
  setStatusLine(q(".head .sub"), state.loaded ? healthTitle(state) : { text: "Loading…" });
  if (!state.loaded) return;
  const controller = state.controller ?? {};
  const mqtt = state.mqtt ?? {};
  const version = prettyVersion(controller.version);
  const display = versionDisplay();
  const shownVersion = version ? (display === "pretty" ? version.pretty : version.canonical) : (controller.version ?? "—");
  const config = state.config ?? {};
  const running = controller.startedAt
    ? `since ${clock(controller.startedAt)} · ${duration(state.now - Date.parse(controller.startedAt))}`
    : "—";
  setHtml(
    q(".kv-px"),
    `<dt>Version</dt><dd><span class="num">${esc(shownVersion)}</span><button class="link" type="button" data-act="copy-version" title="Copy ${esc(controller.version ?? "")}">${icon("copy")}${copied === "version" ? "Copied" : "Copy"}</button></dd>
        <dt>Version display</dt><dd><div class="seg" role="group" aria-label="Version display"><button type="button" data-act="version-display" data-value="pretty" aria-pressed="${display === "pretty"}">Pretty</button><button type="button" data-act="version-display" data-value="semver" aria-pressed="${display === "semver"}">SemVer</button></div></dd>
        <dt>Canonical</dt><dd class="mono">${esc(controller.version ?? "—")} · ${esc(controller.version_scheme ?? "")}</dd>
        <dt>Running</dt><dd class="num">${esc(running)}</dd>
        <dt>Config</dt><dd><span class="mono">${esc(config.path ?? "config.json")}</span><span class="t3 num">${config.valid === false ? `· <span style="color:var(--bad)">invalid on disk since ${esc(clock(config.invalidSince))}</span>` : `· reloaded at ${esc(clock(config.loadedAt))}`}</span></dd>`,
  );
  const offline = mqtt.state === "offline";
  const inEffect = overlaysInEffect(state.overlays);
  const base = controller.mqttNamespace?.baseTopic ?? "—";
  let broker;
  if (mqtt.state === "connected")
    broker = `${dot("ok")}<span class="mono">${esc(mqtt.url ?? "")}</span><span class="t3 num">· connected at ${esc(clock(mqtt.since))}</span>`;
  else if (offline)
    broker = `${dot("bad")}<span class="mono">${esc(mqtt.url ?? "")}</span><span class="num" style="color:var(--bad)">· offline since ${esc(clock(mqtt.since))} · retrying every 5 s</span>`;
  else if (mqtt.state === "disabled") broker = `${dot("idle")}<span class="t3">not configured</span>`;
  else broker = `${dot("idle")}<span class="mono">${esc(mqtt.url ?? "")}</span><span class="t3">· connecting</span>`;
  const lastError = mqtt.lastError
    ? `<span class="mono" style="color:var(--bad)">${esc(mqtt.lastError.message)}</span><span class="t3 num">· ${esc(clock(mqtt.lastError.at))}</span>`
    : `<span class="t3">none</span>`;
  const status = String(controller.status ?? "ok");
  const reasons = Array.isArray(controller.reasons) ? controller.reasons : [];
  setHtml(
    q(".kv-mq"),
    `<dt>Broker</dt><dd>${broker}</dd>
        <dt>Base topic</dt><dd class="mono">${esc(base)}</dd>
        <dt>Health</dt><dd>${offline ? `<span class="t3 num">not published while offline</span>` : `<span class="mono">${esc(status)}</span><span class="t3">${reasons.length ? `· ${esc(reasons.join(", "))} ` : ""}· published to …/health every 30 s</span>`}</dd>
        <dt>Last error</dt><dd>${lastError}</dd>
        ${offline ? `<dt>Waits for MQTT</dt><dd class="t2">Mode, brightness override, clearing overlays</dd>` : ""}
        <dt>Overlays</dt><dd><a class="link" style="font-size:13px" href="#/overlays">${inEffect > 0 ? `${inEffect} in effect` : "none in effect"}${offline ? ", as last received" : ""}</a></dd>`,
  );
  const writerLine = blobWriterLine(state);
  setHtml(q(".mq-note"), writerLine ? esc(writerLine) : "");
  // Displays
  const rows = [...state.devices.values()]
    .map((view) => {
      const row = healthRow(state, view);
      const stCls = row.status.kind === "shadow" ? "st shadow" : `st ${row.status.dot === "idle" ? "" : row.status.dot}`.trim();
      const label = row.status.kind === "shadow" ? "Shadow" : row.status.label;
      return `<div class="ht-row" role="row"><span role="cell"><a href="#/devices/${encodeURIComponent(row.name)}">${esc(row.title)}</a>${row.sub ? ` <span class="mono t3">${esc(row.sub)}</span>` : ""}</span><span role="cell"><span class="${stCls}">${dot(row.status.dot)}${esc(label)}</span></span><span role="cell" class="num${row.lastFrame === "none yet" || row.lastFrame === "not measured" ? " t3" : ""}">${esc(row.lastFrame)}</span><span role="cell" class="num"${row.errorsCls ? ` style="color:var(--${row.errorsCls})"` : ""}>${esc(row.errors)}</span><span role="cell" class="${row.lastError ? "mono" : "t3"}">${esc(row.lastError ?? "none")}</span><span role="cell" class="num${row.powerCyclesMuted ? " t3" : ""}">${esc(row.powerCycles)}</span><span role="cell" class="mono">${esc(row.mqttHealth)}</span></div>`;
    })
    .join("");
  setHtml(q(".ht-body"), rows);
  // Log
  const lines = state.log.filter(
    (line) => filter === "all" || line.level === "WARN" || line.level === "ERROR",
  );
  const pane = q(".log");
  const wasAtBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4;
  // The load of this opening failed and no line is there yet: say so.
  const failure = state.log.length === 0 ? op("log").failure : null;
  const text = failure
    ? esc(`The log could not be loaded: ${failure} New lines still arrive.`)
    : lines.map(logLine).join("\n");
  if (setHtml(pane, text) && (follow || wasAtBottom))
    pane.scrollTop = pane.scrollHeight;
  for (const button of /** @type {HTMLElement} */ (root).querySelectorAll('[data-act="filter"]'))
    button.setAttribute("aria-pressed", String(button.getAttribute("data-value") === filter));
  setHtml(q(".copy-log"), `${icon("copy")}${copied === "log" ? "Copied" : "Copy"}`);
}

/** @param {Event} event */
function onClick(event) {
  const button = /** @type {HTMLElement} */ (event.target).closest?.("[data-act]");
  if (!(button instanceof HTMLButtonElement)) return;
  switch (button.dataset.act) {
    case "filter":
      filter = button.dataset.value === "warn" ? "warn" : "all";
      follow = true;
      break;
    case "version-display":
      setVersionDisplay(button.dataset.value === "semver" ? "semver" : "pretty");
      tick(Date.now()); // the top bar follows at once
      break;
    case "copy-version": {
      const title = button.getAttribute("title") ?? "";
      void navigator.clipboard?.writeText(title.replace(/^Copy /, ""));
      copied = "version";
      break;
    }
    case "copy-log": {
      const pane = root?.querySelector(".log");
      void navigator.clipboard?.writeText(pane?.textContent ?? "");
      copied = "log";
      break;
    }
    default:
      return;
  }
  render(getState());
}

/** @param {Event} event the user scrolled the log: follow the newest line only when at the bottom */
function onScroll(event) {
  const pane = /** @type {HTMLElement} */ (event.target);
  if (!(pane instanceof HTMLElement) || !pane.classList.contains("log")) return;
  follow = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4;
}

/**
 * The log of this opening, in the slot `log` (ops.js): the load of the
 * next opening makes this one obsolete, so its late failure says nothing
 * there. A failure of the current load is said in the pane while it is
 * empty; the lines of the live channel still arrive. The shared resource
 * observer replaces this read when a snapshot starts another pixdcon run.
 */
function loadLog() {
  followOp("log", async () => applyAnswer(await request("GET", "/api/v2/log", { resource: "log" })), {
    owns: { opening: () => openings },
    effects: { start: ["epoch", "opening"], done: ["epoch", "opening"], failed: ["epoch", "opening"] },
    failed: () => render(getState()),
  });
}

/** @type {import("../router.js").Page} */
export const page = {
  mount(target, _params) {
    openings += 1;
    root = target;
    root.className = "p-health";
    filter = "all";
    follow = true;
    copied = "";
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    root.innerHTML = `
  <div class="head"><h1 tabindex="-1">Health</h1><span class="sub num" role="status"></span></div>
  <div class="cols">
    <section class="sec" style="margin-top:8px" aria-labelledby="h-px">
      <div class="sec-h"><h2 id="h-px">pixdcon</h2></div>
      <dl class="kv kv-px"></dl>
    </section>
    <section class="sec" style="margin-top:8px" aria-labelledby="h-mq">
      <div class="sec-h"><h2 id="h-mq">MQTT</h2></div>
      <dl class="kv kv-mq"></dl>
      <p class="mq-note"></p>
    </section>
  </div>
  <section class="sec" aria-labelledby="h-dv">
    <div class="sec-h"><h2 id="h-dv">Displays</h2><span class="t3">${esc(HEALTH_RULE)}</span></div>
    <div role="table" aria-labelledby="h-dv">
      <div class="ht-head" role="row"><span role="columnheader">Display</span><span role="columnheader">Status</span><span role="columnheader">Last frame</span><span role="columnheader">Errors in a row</span><span role="columnheader">Last error</span><span role="columnheader">Power cycles</span><span role="columnheader">MQTT health</span></div>
      <div class="ht-body" role="rowgroup"></div>
    </div>
  </section>
  <section class="sec" aria-labelledby="h-log">
    <div class="sec-h"><h2 id="h-log">Recent log</h2><span class="t3">Last 200 lines of this process · newest at the bottom</span></div>
    <div class="logbar"><div class="seg" role="group" aria-label="Log level"><button type="button" data-act="filter" data-value="all" aria-pressed="true">All</button><button type="button" data-act="filter" data-value="warn" aria-pressed="false">Warnings and errors</button></div><button class="btn copy-log" type="button" data-act="copy-log">${icon("copy")}Copy</button><span class="t3">Times are local (${esc(zone)})</span></div>
    <pre class="log" tabindex="0" aria-label="Recent log lines"></pre>
  </section>`;
    root.addEventListener("click", onClick);
    root.addEventListener("scroll", onScroll, true);
    const unobserve = observeResource(null, loadLog);
    const unrender = subscribe((state) => state, render);
    unsubscribe = () => { unobserve(); unrender(); };
    loadLog();
  },
  unmount() {
    openings += 1;
    unsubscribe?.();
    unsubscribe = null;
    if (root) {
      root.removeEventListener("click", onClick);
      root.removeEventListener("scroll", onScroll, true);
    }
    root = null;
  },
};
