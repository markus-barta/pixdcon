/**
 * Client store: what the page knows, fed by the snapshot and the live events.
 *
 * One rule decides everything that arrives, whether as an answer to a request
 * or as a live event: a device view or settings state is applied only when its
 * `rev` is higher than the one on screen (build rule 3). A late answer can
 * therefore never put an older scene, mode or brightness back.
 *
 * Views subscribe to a slice and re-render only their reserved slots; nothing
 * inserts or removes rows while they are on screen (approved spec section 8).
 *
 * Owner: UI worker.
 */

import { todo } from "./todo.js";

/**
 * @typedef {object} ClientState
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

/** @param {any} snapshot Snapshot from GET /api/v2/bootstrap or the first live event */
export function applySnapshot(snapshot) {
  return todo("store.applySnapshot", snapshot);
}

/** @param {{type: string, seq: number, data: any}} event */
export function applyEvent(event) {
  return todo("store.applyEvent", event);
}

/**
 * Apply the answer of a write (DeviceView or SettingsState), subject to the rev rule.
 *
 * @param {any} view
 * @returns {boolean} false when it was older than what is shown and was dropped
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
