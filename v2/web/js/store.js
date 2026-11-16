/**
 * Client store: what the page knows, fed by the snapshot and the live events.
 *
 * One rule decides everything that arrives, whether as an answer to a request
 * or as a live event: a device view or settings state is applied only when
 *   1. its `epoch` is the epoch of the snapshot the page holds, and
 *   2. its `rev` is higher than the one on screen (build rule 3).
 * A late answer can therefore never put an older scene, mode or brightness
 * back. The epoch is the identity of one run of pixdcon; `rev` and the live
 * channel's `seq` start again with every run. Without rule 1, a page that
 * stayed open across a restart would hold rev 57 and drop every fresh view
 * with rev 3 as "older" (B-177). So:
 *   - a snapshot with another epoch replaces everything the page holds,
 *     previews and settings included, and its epoch becomes the page's
 *   - a view or event with another epoch than the page's is dropped; the
 *     snapshot of that epoch is on its way (live.js asks for it)
 *
 * Views subscribe to a slice and re-render only their reserved slots; nothing
 * inserts or removes rows while they are on screen (approved spec section 8).
 *
 * Owner: UI worker.
 */

import { todo } from "./todo.js";

/**
 * @typedef {object} ClientState
 * @property {string|null} epoch epoch of the snapshot the page holds; null before the first one
 * @property {number} seq
 * @property {any} controller ControllerStatus
 * @property {any} mqtt MqttStatus
 * @property {any} config ConfigFileState with the last reload result
 * @property {Map<string, any>} devices name → DeviceView, in config order
 * @property {Map<string, {width: number, height: number, source: string, receivedAt: string, rgb: Uint8Array}>} previews
 * @property {any[]} scenes SceneMeta[]
 * @property {{ulanzi: any[], pixoo: any[]}} builtins
 * @property {any[]} overlays OverlayRecord[]; cleared rows stay, greyed, until the page is left
 * @property {Map<string, any>} settings "<device>/<scene>" → SettingsState
 * @property {import("./live.js").LiveState} live
 */

/** @returns {ClientState} */
export function getState() {
  return todo("store.getState");
}

/** @param {any} snapshot Snapshot from GET /api/v2/bootstrap or the first live event; another epoch than the held one resets the store */
export function applySnapshot(snapshot) {
  return todo("store.applySnapshot", snapshot);
}

/** @param {{type: string, seq: number, data: any}} event */
export function applyEvent(event) {
  return todo("store.applyEvent", event);
}

/**
 * Apply the answer of a write (DeviceView or SettingsState), subject to the
 * epoch and rev rule.
 *
 * @param {any} view
 * @returns {boolean} false when it was dropped: another epoch, or not newer than what is shown
 */
export function applyAnswer(view) {
  return todo("store.applyAnswer", view);
}

/**
 * @template T
 * @param {(state: ClientState) => T} select
 * @param {(value: T) => void} render called when the selected value changed
 * @returns {() => void} unsubscribe
 */
export function subscribe(select, render) {
  return todo("store.subscribe", select, render);
}
