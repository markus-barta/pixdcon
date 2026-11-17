/**
 * Client store: what the page knows, fed by the snapshot and the live events.
 *
 * One rule decides everything that arrives, whether as a snapshot, a live
 * event or the answer to a request: the decision functions of ordering.js
 * (finished code). The store holds one fence (`createClientFence`) and asks
 * it before it changes anything; what is not answered with "apply" changes
 * nothing.
 *   - a device view or settings state is applied only when its `epoch` is
 *     the epoch of the snapshot the page holds and its `rev` is higher than
 *     the one on screen (build rule 3). A late answer can therefore never
 *     put an older scene, mode or brightness back.
 *   - the epoch is the identity of one run of pixdcon; `rev` and the live
 *     channel's `seq` start again with every run. A page that stayed open
 *     across a restart would otherwise hold rev 57 and drop every fresh
 *     view with rev 3 as "older" (B-177).
 *   - a snapshot with another epoch replaces everything the page holds,
 *     previews and settings included, but only when it comes from the
 *     newest stream or bootstrap request the page has started. The answer
 *     of a bootstrap request that was sent to the earlier run and arrives
 *     after the new run's snapshot is dropped.
 *   - a snapshot of the page's epoch with a lower seq than the page's is
 *     dropped; so is an event with a seq that is not higher than the last
 *     one, an event of a stream that was replaced, and an event or view of
 *     another epoch.
 *   - a device that was removed comes back only through something newer
 *     than its removal. The position of the removal is kept for the rest of
 *     the epoch (`forgetDevice`), so the late answer of a write to the old
 *     device is not taken for the device of the same name that came back,
 *     although that one counts its revs from 1 again.
 *   - every copy has a position. A snapshot is a copy of every resource at
 *     its seq: an answer that was asked for before it and stands before it
 *     changes nothing afterwards, and where the page already holds a newer
 *     copy (the answer of a request that stood after the snapshot), the
 *     page keeps it (`decideSnapshot` answers `keep` and `gone`). An event
 *     always moves the page's position, and brings its content only when
 *     the page does not hold a newer copy of that resource.
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

/** @returns {import("./ordering.js").ClientFence} the store's fence; live.js and api.js take their generations from it */
export function fence() {
  return todo("store.fence");
}

/**
 * Apply a snapshot: ask `decideSnapshot` with the snapshot's epoch, seq and
 * the names of its devices. On "apply": take every whole resource that is
 * not in `keep`, put every device view through `decideView` with the
 * snapshot's seq, and remove the devices in `gone`.
 *
 * @param {any} snapshot Snapshot from GET /api/v2/bootstrap or the first live event
 * @param {{generation: number}} source the stream or bootstrap request it came from (ordering.js openSource)
 * @returns {import("./ordering.js").Decision} decideSnapshot's answer; "apply" with reason "new_epoch" reset the store
 */
export function applySnapshot(snapshot, source) {
  return todo("store.applySnapshot", snapshot, source);
}

/**
 * Apply a live event. `decideEvent` first (it moves the page's position
 * also when it answers "drop" with reason "newer_copy"); an event that
 * carries a view then goes through `decideView` with the event's seq, and
 * "device-removed" calls `forgetDevice` with it.
 *
 * @param {import("./live.js").LiveEnvelope} event
 * @returns {import("./ordering.js").Decision} decideEvent's answer, and for an event that carries a view, decideView's
 */
export function applyEvent(event) {
  return todo("store.applyEvent", event);
}

/**
 * Apply the answer of a request. A DeviceView or SettingsState goes through
 * decideView with the answer's position; a whole resource (overlay list,
 * config state, scenes) through decideAnswer.
 *
 * @param {import("./api.js").Answer} answer
 * @returns {import("./ordering.js").Decision}
 */
export function applyAnswer(answer) {
  return todo("store.applyAnswer", answer);
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
