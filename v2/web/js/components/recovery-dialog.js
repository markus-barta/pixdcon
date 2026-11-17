/* global document, HTMLButtonElement */
/**
 * Component: recovery dialog ("Recovery steps").
 * Approved mockups: pixd-device-offline (Pixoo), pixd-device-offline-ulanzi.
 *
 * Top-anchored at 72 px, at most 600 px wide, focus kept inside, Esc closes
 * and returns focus to the opener. Header: device, address, type, failed
 * renders, last contact. Body: last error text, numbered steps for the device
 * type, commands in a copyable mono line. Footer: "Retry now"
 * (POST /api/v2/devices/<name>/retry) and Close.
 * The steps depend on why the display is not online (health.reason): hardware
 * steps for device_unreachable, the scene's error and "choose another scene"
 * for scene_error (matrix S-6, S-29).
 *
 * Owner: UI worker.
 */

import { request } from "../api.js";
import { deviceSlot, op, start } from "../ops.js";
import { icon, setHtml } from "../dom.js";
import { clock, esc } from "../format.js";
import { applyAnswer, getState } from "../store.js";
import { deviceTitle, typeLabel } from "../view/model.js";

/**
 * @param {any} view
 * @returns {string} the numbered steps, as the mockups write them
 */
function steps(view) {
  const health = view.health ?? {};
  const address = view.desired?.address?.value ?? "";
  const base = getState().controller?.mqttNamespace?.baseTopic ?? "home/hsb1/pixdcon";
  if (health.reason === "scene_error")
    return `<ol class="recov"><li><div><b>The display answers; the scene fails.</b> pixdcon does not power-cycle a display for a scene error. The error above comes from the scene.</div></li><li><div><b>Choose another scene</b> in the Scene section to bring the display back now, or fix the scene file and save it: pixdcon loads it again by itself.</div></li></ol>`;
  if (view.type === "ulanzi") {
    const ssid = health.apSsid ?? "awtrix_…";
    return `<ol class="recov"><li><div><b>Power and cable.</b> Check that the display is lit and the USB-C cable is seated. On the Ulanzi TC001 a failing power brick is the most common cause: try a known-good 5 V / 2.4 A brick.</div></li><li><div><b>Wi-Fi rescue (most common after a power dip).</b> If the display started but lost its Wi-Fi settings, it opens its own network. On your laptop, join <span class="mono">${esc(ssid)}</span> (open, no password), then run:<div class="cmd"><span>cd ~/Code/pixdcon &amp;&amp; ./scripts/awtrix-rescue.sh ${esc(address)}</span><button class="ibtn" type="button" style="width:28px;height:28px" aria-label="Copy command" data-copy="cd ~/Code/pixdcon &amp;&amp; ./scripts/awtrix-rescue.sh ${esc(address)}">${icon("copy")}</button></div>The script sends the home Wi-Fi settings to the display and waits until it is back on the network; pixdcon takes it back within about 30 s.</div></li><li><div><b>If it keeps losing its Wi-Fi.</b> Repeated loss of the Wi-Fi settings after a restart points to the display’s flash memory, not the power supply. Watch <span class="mono">${esc(base)}/${esc(view.name)}/telemetry</span> for early signs: uptime resets, a falling <span class="mono">bat_raw</span>, shrinking free RAM. The display may need replacing.</div></li></ol>`;
  }
  const plug = view.facts?.powerCyclePlugTopic;
  const cycles = health.powerCycles ?? { count: 0, max: 0 };
  const second = plug
    ? `<li><div><b>Wait for the automatic power cycle.</b> The Pixoo64’s HTTP stack can hang after a long uptime while ping still answers. pixdcon switches the plug <span class="mono">${esc(plug)}</span> off and on after ${esc(cycles.max)} failed renders in a row; ${esc(cycles.count)} of ${esc(cycles.max)} cycles are used. Wait about a minute.</div></li>`
    : "";
  return `<ol class="recov"><li><div><b>Power and cable.</b> Check that the display is lit and its power cable is seated.</div></li>${second}<li><div><b>Power-cycle by hand.</b> Unplug the display for about 10 s and plug it back in. The Pixoo64 has no access-point rescue; only a power cycle helps.</div></li><li><div><b>If it keeps happening.</b> The telemetry on <span class="mono">${esc(base)}/${esc(view.name)}/telemetry</span> records every failed poll as <span class="mono">reachable: false</span>, so it shows how often the display hangs.</div></li></ol>`;
}

/**
 * @param {any} device DeviceView
 * @param {HTMLElement} opener receives the focus again on close
 * @returns {{update: (device: any) => void, close: () => void}}
 */
export function openRecoveryDialog(device, opener) {
  let view = device;
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `
    <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-h">
      <div class="dlg-h"><div><h2 id="dlg-h"></h2><div class="meta"></div></div><button class="ibtn" type="button" data-act="close" aria-label="Close (Esc)">${icon("x", "")}</button></div>
      <div class="dlg-b"></div>
      <div class="dlg-f"><span class="t3 retry-note" style="margin-right:auto;font-size:12px;align-self:center">Retry wakes the render loop and re-initialises the display.</span><button class="btn" type="button" data-act="retry">${icon("reload")}Retry now</button><button class="btn primary" type="button" data-act="close">Close</button></div>
    </div>`;
  (opener.closest("main") ?? document.body).append(scrim);
  const q = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (scrim.querySelector(selector));

  function render() {
    const health = view.health ?? {};
    const errors = Number(health.consecutiveErrors ?? 0);
    q("#dlg-h").textContent = `${deviceTitle(view)} is ${health.state === "offline" ? "offline" : health.state === "stale" ? "stale" : "not online"}`;
    setHtml(
      q(".dlg-h .meta"),
      `<span class="mono">${esc(view.desired?.address?.value ?? "")}</span> · ${esc(typeLabel(view.type))} · ${errors} failed ${errors === 1 ? "render" : "renders"} in a row · last contact ${esc(clock(health.lastContactAt))}`,
    );
    const last = health.lastError;
    setHtml(
      q(".dlg-b"),
      `<div class="lasterr"><span class="t3">Last error</span><span class="mono">${last ? `${esc(last.message)} · ${esc(clock(last.at))}` : "none recorded"}</span></div>
      <p style="margin:12px 0 0;font-size:13px;line-height:20px;color:var(--text-2)">${health.reason === "scene_error" ? "The display answers, but the scene fails to render." : "Every render attempt fails. pixdcon retries with a growing pause of up to 30 s and checks the display every 10 s, so it takes the display back within about 30 s of it answering again. Try these in order:"}</p>
      ${steps(view)}`,
    );
    // Retry is an operation in the slot of the device's life (ops.js): a
    // dialog opened again while it runs shows it busy, and its outcome is
    // said in whichever dialog of that device is open.
    const retrying = op(deviceSlot("retry", view));
    const retry = /** @type {HTMLButtonElement} */ (q('[data-act="retry"]'));
    retry.disabled = retrying.busy;
    setHtml(retry, retrying.busy ? `${icon("spinner")}Retrying…` : `${icon("reload")}Retry now`);
    const note = q(".retry-note");
    if (retrying.failure) {
      note.style.color = "var(--bad)";
      note.textContent = `Not retried: ${retrying.failure}`;
    } else {
      note.style.color = "";
      note.textContent = "Retry wakes the render loop and re-initialises the display.";
    }
  }

  function retry() {
    const key = deviceSlot("retry", view);
    const name = view.name;
    start(
      key,
      async () =>
        applyAnswer(
          await request("POST", `/api/v2/devices/${encodeURIComponent(name)}/retry`, {
            resource: `device:${name}`,
            key,
            body: {},
          }),
        ),
      { done: () => (scrim.isConnected ? render() : undefined), failed: () => (scrim.isConnected ? render() : undefined) },
    );
    render();
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    scrim.remove();
    if (opener.isConnected) opener.focus();
  }

  /** @param {KeyboardEvent} event Esc closes; Tab stays inside (approved spec 5) */
  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      api.close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = /** @type {HTMLElement[]} */ ([
      ...scrim.querySelectorAll("button:not([disabled]), a[href]"),
    ]);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** @param {Event} event */
  function onClick(event) {
    if (event.target === scrim) {
      api.close();
      return;
    }
    const button = /** @type {HTMLElement} */ (event.target).closest?.("button");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    if (button.dataset.act === "close") api.close();
    else if (button.dataset.act === "retry") retry();
    else if (button.dataset.copy) void navigator.clipboard?.writeText(button.dataset.copy.replaceAll("&amp;", "&"));
  }

  document.addEventListener("keydown", onKey, true);
  scrim.addEventListener("click", onClick);
  render();
  /** @type {HTMLElement} */ (q('.dlg-f [data-act="close"]')).focus();

  const api = {
    /** @param {any} next */
    update(next) {
      view = next;
      render();
    },
    close,
  };
  return api;
}
