/* global document */
/**
 * UI entry point.
 *
 * Phase 3 boot order: theme → GET /api/v2/bootstrap → store → router → live
 * channel. While the first answer is outstanding the page shows the loading
 * state (mockup pixd-devices-loading); when pixdcon does not answer, the
 * title line says so and the request is tried again (pixd-devices-disconnected).
 *
 * The skeleton only proves the wiring from browser to process: it asks
 * /api/health and writes the answer into the title line.
 *
 * Owner: UI worker.
 */

const status = document.getElementById("page-status");
const version = document.getElementById("version");

try {
  const response = await fetch("/api/health");
  const health = await response.json();
  if (status) {
    status.textContent = `${health.instance} ${health.version} is running · skeleton (PIXD-83): the UI is built in phase 3`;
  }
  if (version) {
    version.textContent = health.version;
    version.hidden = false;
  }
} catch {
  if (status) status.textContent = "No answer from pixdcon";
}
