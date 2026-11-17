/**
 * API helper: the only place in the UI that sends requests.
 *
 * Build rules it carries (Tick, PIXD-81 addendum):
 *  - one request at a time per control (rule 2): a `key` that is busy takes no
 *    second request; the control shows its busy label and ignores the click
 *  - every failure is said (rule 4): a failed request rejects with ApiError,
 *    whose `message` is one sentence to show beside the control that caused it
 *  - answers in order (rule 3): the caller gets the answer with its stamp;
 *    whether it is applied is decided in store.js (ordering.js). The stamp is
 *    where the answer stands: the epoch and seq of the response header
 *    `X-Pixdcon-Position: <epoch>-<seq>` that every JSON answer of pixdcon
 *    carries, and the generation this module took for the request
 *    (`beginRequest(fence, resource)`, or `openSource(fence, "bootstrap")`
 *    for GET /api/v2/bootstrap) before it was sent
 *
 * Owner: UI worker.
 */

import { todo } from "./todo.js";

/** Thrown for every answer that is not 2xx and for a request that did not reach pixdcon. */
export class ApiError extends Error {
  /**
   * @param {string} message one sentence for a person
   * @param {{status: number, code: string, extra?: Record<string, unknown>}} details status 0 = pixdcon did not answer
   */
  constructor(message, details) {
    super(message);
    this.name = "ApiError";
    this.status = details.status;
    this.code = details.code;
    this.extra = details.extra ?? {};
  }
}

/**
 * An answer with where it stands.
 *
 * @typedef {object} Answer
 * @property {any} body the parsed answer
 * @property {string} resource what the answer is about: "bootstrap", "device:<name>", "settings:<device>/<scene>", "overlays", "config", "scenes", …
 * @property {number} generation generation of the request (ordering.js)
 * @property {string|null} epoch from X-Pixdcon-Position; null when the header is missing or unreadable: such an answer is not applied
 * @property {number} seq from X-Pixdcon-Position
 */

/**
 * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"} method
 * @param {string} path e.g. "/api/v2/devices/pixoo-159/scene"
 * @param {object} options
 * @param {string} options.resource what the answer is about (see Answer)
 * @param {unknown} [options.body] sent as JSON
 * @param {string} [options.key] control key, e.g. "scene:pixoo-159"; a busy key rejects with code "busy"
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Answer>}
 * @throws {ApiError}
 */
export async function request(method, path, options) {
  return todo("api.request", method, path, options);
}

/**
 * @param {string} key
 * @returns {boolean} true while a request with this key is running
 */
export function isBusy(key) {
  return todo("api.isBusy", key);
}

/**
 * Follow the busy state of control keys, to show and clear busy labels.
 *
 * @param {(key: string, busy: boolean) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onBusy(listener) {
  return todo("api.onBusy", listener);
}
