/* global document, HTMLButtonElement, window */
/**
 * Component: enlarged preview.
 * Approved mockup: pixd-device-preview-enlarged.
 *
 * Full window on the page background. Header: display name, device name,
 * scene and source; "3 of 4"; Previous, Next, Close with keycaps. Stage: the
 * largest whole-number scale. Footer: state, resolution, scale, "last frame
 * 18:42:06" with its age, pixel grid (the mockup says "updated"; the build
 * says "last frame", build rule 5). Esc, Close, a click outside the image or
 * a double click on it close the view; the arrow keys step through displays.
 *
 * Owner: UI worker.
 */

import { dot, icon, setHtml } from "../dom.js";
import { ago, clock, esc } from "../format.js";
import { getState, subscribe } from "../store.js";
import { deviceStatus, deviceTitle, previewState, sceneName, sizeOf } from "../view/model.js";
import { createPixelPreview } from "./pixel-preview.js";

/**
 * @param {string} device name of the display to start with
 * @param {HTMLElement} opener receives the focus again on close
 * @param {{onClose?: () => void, onStep?: (name: string) => void}} [options] onClose: the view closed; onStep: Previous or Next chose another display
 * @returns {{close: () => void}}
 */
export function openEnlargedPreview(device, opener, options = {}) {
  let name = device;
  const zoom = document.createElement("div");
  zoom.className = "zoom";
  zoom.setAttribute("role", "dialog");
  zoom.setAttribute("aria-modal", "true");
  zoom.setAttribute("aria-labelledby", "zoom-h");
  zoom.innerHTML = `
    <div class="zoom-h">
      <div><h2 id="zoom-h"></h2><div class="meta"></div></div>
      <span class="pos num"></span>
      <button class="btn" type="button" data-act="prev" title="Previous display (Left arrow)">${icon("left")}Previous <kbd aria-hidden="true" title="Left arrow">${icon("arrowl", "key")}</kbd></button>
      <button class="btn" type="button" data-act="next" title="Next display (Right arrow)">Next ${icon("right")} <kbd aria-hidden="true" title="Right arrow">${icon("arrowr", "key")}</kbd></button>
      <button class="btn" type="button" data-act="close" title="Close (Esc)">${icon("x")}Close <kbd aria-hidden="true" title="Escape">Esc</kbd></button>
    </div>
    <div class="zoom-stage"></div>
    <div class="zoom-f num"></div>`;
  document.body.append(zoom);
  const stage = /** @type {HTMLElement} */ (zoom.querySelector(".zoom-stage"));
  /** @type {ReturnType<typeof createPixelPreview>|null} */
  let preview = null;
  let previewFor = "";
  let closed = false;

  /** @param {import("../store.js").ClientState} state */
  function render(state) {
    const names = [...state.devices.keys()];
    const view = state.devices.get(name);
    const title = /** @type {HTMLElement} */ (zoom.querySelector("#zoom-h"));
    if (!view) {
      title.textContent = name;
      setHtml(/** @type {HTMLElement} */ (zoom.querySelector(".zoom-f")), "pixdcon has no device of this name");
      return;
    }
    title.textContent = deviceTitle(view);
    const scene = view.desired?.scene ?? {};
    const source =
      scene.source === "overlay"
        ? "MQTT overlay"
        : scene.source === "blob"
          ? "config overlay"
          : scene.source === "fallback"
            ? "nothing chosen"
            : "your choice";
    setHtml(
      /** @type {HTMLElement} */ (zoom.querySelector(".zoom-h .meta")),
      `${view.displayName && view.displayName !== view.name ? `<span class="mono">${esc(view.name)}</span> · ` : ""}${esc(scene.scene ? sceneName(state, scene.scene, view.type) : "Nothing")} · ${esc(source)}`,
    );
    const at = names.indexOf(name) + 1;
    setHtml(/** @type {HTMLElement} */ (zoom.querySelector(".pos")), `${at} of ${names.length}`);
    /** @type {HTMLElement} */ (zoom.querySelector(".pos")).setAttribute("aria-label", `Display ${at} of ${names.length}`);
    const size = sizeOf(view);
    const key = `${view.name}/${view.incarnation}`;
    if (!preview || previewFor !== key) {
      preview?.destroy();
      previewFor = key;
      preview = createPixelPreview(stage, {
        scale: "fit",
        grid: Boolean(view.preview?.showGrid),
        veil: 0.6,
        size,
        label: `${deviceTitle(view)}, enlarged`,
      });
    }
    const pv = previewState(state, view);
    preview.draw(pv.frame, { veil: pv.veil, reason: pv.reason, spinner: pv.spinner });
    const scale = preview.scale();
    const status = deviceStatus(view, state);
    const frame = state.previews.get(view.name);
    const received = frame?.receivedAt
      ? `last frame ${clock(frame.receivedAt)}, ${ago(frame.receivedAt, state.now)}`
      : "no frame yet";
    setHtml(
      /** @type {HTMLElement} */ (zoom.querySelector(".zoom-f")),
      `${dot(status.dot)}${esc(status.label)} · ${size.width} × ${size.height} shown at ${scale}× · ${esc(received)} · pixel grid ${view.preview?.showGrid ? "on" : "off"}`,
    );
  }

  /** @param {number} step */
  function stepBy(step) {
    const names = [...getState().devices.keys()];
    if (names.length === 0) return;
    const at = names.indexOf(name);
    name = names[(at + step + names.length) % names.length];
    options.onStep?.(name);
    render(getState());
  }

  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    preview?.destroy();
    zoom.remove();
    if (opener.isConnected) opener.focus();
    options.onClose?.();
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepBy(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepBy(1);
    }
  }

  /** @param {Event} event */
  function onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === stage) {
      close();
      return;
    }
    const button = target.closest?.("button");
    if (!(button instanceof HTMLButtonElement)) return;
    if (button.dataset.act === "close") close();
    else if (button.dataset.act === "prev") stepBy(-1);
    else if (button.dataset.act === "next") stepBy(1);
  }

  /** @param {Event} event */
  function onDouble(event) {
    if (/** @type {HTMLElement} */ (event.target).closest?.(".zoom-stage")) close();
  }

  function onResize() {
    preview?.resize();
    render(getState());
  }

  document.addEventListener("keydown", onKey, true);
  zoom.addEventListener("click", onClick);
  zoom.addEventListener("dblclick", onDouble);
  window.addEventListener("resize", onResize);
  const unsubscribe = subscribe((state) => state, render);
  /** @type {HTMLElement} */ (zoom.querySelector('[data-act="close"]')).focus();
  return { close };
}
