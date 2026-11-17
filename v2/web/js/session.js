/**
 * The page's session id: the one the live channel names the page with
 * (live.js connectLive). Settings previews carry it, so the server ends
 * them when the page is gone (preview rule 2).
 *
 * Owner: UI worker.
 */

/** @type {string|null} */
let session = null;

/** @param {string} id */
export function setSession(id) {
  session = id;
}

/** @returns {string|null} null until the live channel was opened */
export function getSession() {
  return session;
}
