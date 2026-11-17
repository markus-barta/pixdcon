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
 *    for GET /api/v2/bootstrap) before it was sent. An answer without a
 *    readable header has `epoch: null`, and the store applies none such.
 *
 * Owner: UI worker.
 */

import { beginRequest, openSource, parsePosition } from "./ordering.js";
import { fence as storeFence } from "./store.js";

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

/** @type {Set<string>} */
const busy = new Set();
/** @type {Set<(key: string, busy: boolean) => void>} */
const listeners = new Set();

/** @param {string} key @param {boolean} state */
function announce(key, state) {
  for (const listener of [...listeners]) {
    try {
      listener(key, state);
    } catch {}
  }
}

/**
 * The sentence for an error answer: pixdcon's own `error` sentence when it
 * sent one, else one that names the status.
 *
 * @param {number} status
 * @param {any} payload
 * @returns {string}
 */
function sentence(status, payload) {
  const text = typeof payload?.error === "string" ? payload.error.trim() : "";
  if (text) return /[.!?]$/.test(text) ? text : `${text}.`;
  if (status === 501) return "pixdcon cannot do this yet.";
  if (status >= 500) return `pixdcon failed to answer (${status}).`;
  return `pixdcon refused the request (${status}).`;
}

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
  const { resource, body, key, signal } = options;
  if (key !== undefined && busy.has(key))
    throw new ApiError("Still working on the last request.", {
      status: 0,
      code: "busy",
    });
  const fence = storeFence();
  // The generation is taken before the request leaves (ordering.js).
  const generation =
    resource === "bootstrap"
      ? openSource(fence, "bootstrap")
      : beginRequest(fence, resource);
  if (key !== undefined) {
    busy.add(key);
    announce(key, true);
  }
  try {
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal,
      });
    } catch {
      if (signal?.aborted)
        throw new ApiError("Cancelled.", { status: 0, code: "aborted" });
      throw new ApiError("No answer from pixdcon.", {
        status: 0,
        code: "unreachable",
      });
    }
    const position = parsePosition(response.headers.get("X-Pixdcon-Position"));
    const text = await response.text();
    /** @type {any} */
    let payload = null;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const { code, ...extra } =
        payload && typeof payload === "object" ? payload : {};
      delete extra.error;
      throw new ApiError(sentence(response.status, payload), {
        status: response.status,
        code: typeof code === "string" ? code : `http_${response.status}`,
        extra,
      });
    }
    if (text !== "" && payload === null)
      throw new ApiError("pixdcon sent an answer that is not JSON.", {
        status: response.status,
        code: "invalid_answer",
      });
    return {
      body: payload,
      resource,
      generation,
      epoch: position?.epoch ?? null,
      seq: position?.seq ?? 0,
    };
  } finally {
    if (key !== undefined) {
      busy.delete(key);
      announce(key, false);
    }
  }
}

/**
 * The last frame of a display as bytes (GET /api/v2/devices/<name>/preview):
 * RGB888, row-major, with its size, source and receipt time in headers.
 * The page asks for it once when it opens, so a display that sends no new
 * frames (offline, paused) still shows its last one; after that the frames
 * come with the live channel. The store decides whether it may fill the
 * slot (store.js decideFrameAnswer); the generation is taken here, before
 * the request is sent.
 *
 * @param {string} device
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{generation: number, frame: {width: number, height: number, source: string, receivedAt: string|null, frameSeq: number, rgb: Uint8Array}|null}>} frame null: pixdcon has no frame yet (204)
 * @throws {ApiError}
 */
export async function requestFrame(device, options = {}) {
  const generation = beginRequest(storeFence(), `frame:${device}`);
  let response;
  try {
    response = await fetch(
      `/api/v2/devices/${encodeURIComponent(device)}/preview`,
      { cache: "no-store", signal: options.signal },
    );
  } catch {
    throw new ApiError("No answer from pixdcon.", {
      status: 0,
      code: "unreachable",
    });
  }
  if (response.status === 204) return { generation, frame: null };
  if (!response.ok)
    throw new ApiError(sentence(response.status, null), {
      status: response.status,
      code: `http_${response.status}`,
    });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    generation,
    frame: {
      width: Number(response.headers.get("X-Frame-Width")),
      height: Number(response.headers.get("X-Frame-Height")),
      source: response.headers.get("X-Frame-Source") ?? "runtime",
      receivedAt: response.headers.get("X-Frame-Received-At"),
      frameSeq: Number(response.headers.get("X-Frame-Seq") ?? 0),
      rgb: bytes,
    },
  };
}

/**
 * @param {string} key
 * @returns {boolean} true while a request with this key is running
 */
export function isBusy(key) {
  return busy.has(key);
}

/**
 * Follow the busy state of control keys, to show and clear busy labels.
 *
 * @param {(key: string, busy: boolean) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onBusy(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
