/* global document, window */
/**
 * UI entry point.
 *
 * Boot order: theme → GET /api/v2/bootstrap → store → router → live
 * channel. The bootstrap request is sent first and the router mounts the
 * page at once, so the page shows the loading state (mockup
 * pixd-devices-loading) while the first answer is outstanding. When pixdcon
 * does not answer, the title line says so; the live channel tries again
 * every 5 s and its first event is a snapshot, which loads the page
 * (pixd-devices-disconnected).
 *
 * Everything that arrives goes through the store, and the store asks the
 * client fence (ordering.js) first: the bootstrap answer and the stream's
 * snapshot can arrive in either order, also across a restart of pixdcon,
 * and the page ends on the newer one.
 *
 * Also here: the top bar (version, overlay count, MQTT state, "Restart
 * needed"), the one 1 s clock the ages on screen are computed against, the
 * first frame of every display, and the end of this page's settings
 * previews when the page is left.
 *
 * Owner: UI worker.
 */

import { ApiError, request, requestFrame } from "./api.js";
import { connectLive } from "./live.js";
import { startRouter } from "./router.js";
import {
  applyAnswer,
  applyEvent,
  applyFrameAnswer,
  fence,
  getState,
  setLive,
  setLoadError,
  subscribe,
  tick,
  toPreview,
} from "./store.js";
import { applyTheme, versionDisplay } from "./theme.js";
import { prettyVersion } from "./format.js";
import { header } from "./view/model.js";
import { setSession } from "./session.js";

applyTheme();

const app = /** @type {HTMLElement} */ (document.getElementById("app"));

// 1. The bootstrap request leaves first; its generation is taken now.
const bootstrap = request("GET", "/api/v2/bootstrap", { resource: "bootstrap" });

// 2. The page mounts and shows the loading state.
startRouter(app);

// 3. The top bar follows the store.
const versionButton = /** @type {HTMLButtonElement} */ (document.getElementById("version"));
const overlayCount = /** @type {HTMLElement} */ (document.getElementById("overlay-count"));
const restartLink = /** @type {HTMLElement} */ (document.getElementById("restart"));
const mqttDot = /** @type {HTMLElement} */ (document.getElementById("mqtt-dot"));
const mqttText = /** @type {HTMLElement} */ (document.getElementById("mqtt-text"));

subscribe(
  (state) => state,
  (state) => {
    const top = header(state);
    const version = prettyVersion(state.controller?.version);
    if (version) {
      versionButton.hidden = false;
      versionButton.textContent =
        versionDisplay() === "semver" ? version.canonical : version.pretty;
      versionButton.title = `${version.canonical} · ${version.utc} · click to copy`;
      versionButton.setAttribute("aria-label", `Version ${version.canonical}, click to copy`);
      versionButton.dataset.canonical = version.canonical;
    } else if (state.controller?.version) {
      versionButton.hidden = false;
      versionButton.textContent = state.controller.version;
      versionButton.dataset.canonical = state.controller.version;
    }
    overlayCount.hidden = top.overlayCount === 0;
    overlayCount.textContent = top.overlayCount ? String(top.overlayCount) : "";
    overlayCount.setAttribute("aria-label", `${top.overlayCount} active`);
    restartLink.hidden = !top.restart.shown;
    restartLink.title = top.restart.title;
    mqttDot.className = `dot ${top.mqtt.dot}`;
    mqttText.textContent = top.mqtt.text;
    mqttText.style.color = top.mqtt.cls ? `var(--${top.mqtt.cls})` : "";
  },
);

versionButton.addEventListener("click", () => {
  const canonical = versionButton.dataset.canonical;
  if (canonical) void navigator.clipboard?.writeText(canonical);
});

// 4. The live channel opens with its own generation, which is newer than the
// bootstrap request's: whichever of the two snapshots arrives last, the page
// ends on the stream's (ordering.js decideSnapshot drops the older source).
const live = connectLive(
  { onEvent: applyEvent, onState: setLive },
  { fence: fence(), log: true },
);
setSession(live.session);

// 5. The bootstrap answer goes through the same fence.
try {
  applyAnswer(await bootstrap);
} catch (error) {
  if (!getState().loaded)
    setLoadError({
      message: error instanceof ApiError ? error.message : "No answer from pixdcon.",
      at: Date.now(),
    });
}

// The ages on screen ("frame 2 s ago") follow one clock; it changes nothing else.
setInterval(() => {
  tick(Date.now());
}, 1000);

// The first frame of every display: a display that sends no new frames
// (offline, paused) still shows its last one. One request per device life.
/** @type {Set<string>} */
const asked = new Set();
subscribe(
  (state) => state.devices,
  (devices) => {
    const state = getState();
    for (const view of devices.values()) {
      const key = `${state.epoch}/${view.name}/${view.incarnation}`;
      if (asked.has(key) || state.previews.has(view.name)) continue;
      asked.add(key);
      void loadFrame(view.name, Number(view.incarnation ?? 0), state.epoch);
    }
  },
);

/**
 * @param {string} device
 * @param {number} incarnation
 * @param {string|null} epoch
 */
async function loadFrame(device, incarnation, epoch) {
  try {
    const { generation, frame } = await requestFrame(device);
    applyFrameAnswer(
      { device, generation, epoch, incarnation },
      frame ? toPreview(frame, frame.rgb) : null,
    );
  } catch {
    // The stream brings the next frame; a failure here changes nothing on screen.
  }
}

// Leaving the page ends its settings previews (preview rule 2); the server
// also ends them 5 s after the page's last stream closed.
window.addEventListener("pagehide", () => {
  const body = new Blob(["{}"], { type: "application/json" });
  navigator.sendBeacon?.(
    `/api/v2/preview-sessions/${encodeURIComponent(live.session)}/end`,
    body,
  );
});
