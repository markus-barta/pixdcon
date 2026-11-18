/**
 * API helper: the only place in the UI that sends requests.
 *
 * Build rules it carries (Tick, PIXD-81 addendum):
 *  - one request at a time per control (rule 2): a `key` that is busy takes no
 *    second request; the control shows its busy label and ignores the click
 *  - every failure is said (rule 4): a failed request rejects with ApiError,
 *    whose `message` is one sentence to show beside the control that caused it
 *  - every request has a time bound (the operation rule, ops.js, rule 4):
 *    pixdcon has REQUEST_TIMEOUT_MS to answer, the body included. Then the
 *    request is aborted and fails with code "timeout", and its key is free
 *    again, so a request that hangs never blocks the next one
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

/** How long pixdcon has to answer one request, body included (ms). */
export const REQUEST_TIMEOUT_MS = 15000;

/** A control is owned by one request in one run; old cleanup cannot free its successor.
 * @type {Map<string, {epoch: string|null}>}
 */
const busy = new Map();
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

/** @param {string|undefined} key @param {{epoch: string|null}} control */
function release(key, control) {
  if (key === undefined || busy.get(key) === control) {
    if (key !== undefined) {
      busy.delete(key);
      announce(key, false);
    }
  }
}

/** A resource guard retired this control's operation. Its old finally still
 * holds the old object and cannot release a subsequently reused control.
 * @param {string} key
 */
export function retireControl(key) {
  const control = busy.get(key);
  if (control) release(key, control);
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

/** @returns {ApiError} */
const timeoutError = () =>
  new ApiError(`pixdcon did not answer within ${REQUEST_TIMEOUT_MS / 1000} s.`, {
    status: 0,
    code: "timeout",
  });

/**
 * The time bound of one request. After REQUEST_TIMEOUT_MS the fetch is
 * aborted and whatever the request still waits for (the answer, its body)
 * fails with a timeout, also where the network or a stand-in ignores the
 * abort. The caller ends the bound when the request is done.
 *
 * @param {AbortSignal} [outer] the caller's own signal
 */
function bound(outer) {
  const controller = new AbortController();
  let timedOut = false;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @type {Promise<never>} */
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError());
    }, REQUEST_TIMEOUT_MS);
  });
  return {
    signal: outer ? AbortSignal.any([outer, controller.signal]) : controller.signal,
    /**
     * @template T
     * @param {Promise<T>} work
     * @returns {Promise<T>}
     */
    race: (work) => Promise.race([work, late]),
    timedOut: () => timedOut,
    end: () => clearTimeout(timer),
  };
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
  if (key !== undefined && isBusy(key))
    throw new ApiError("Still working on the last request.", {
      status: 0,
      code: "busy",
    });
  const fence = storeFence();
  const control = { epoch: fence.epoch };
  // The generation is taken before the request leaves (ordering.js).
  const generation =
    resource === "bootstrap"
      ? openSource(fence, "bootstrap")
      : beginRequest(fence, resource);
  if (key !== undefined) {
    busy.set(key, control);
    announce(key, true);
  }
  const time = bound(signal);
  try {
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json" };
    if (method !== "GET" && method !== "HEAD") headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await time.race(
        fetch(path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
          signal: time.signal,
        }),
      );
    } catch {
      if (time.timedOut()) throw timeoutError();
      if (signal?.aborted)
        throw new ApiError("Cancelled.", { status: 0, code: "aborted" });
      throw new ApiError("No answer from pixdcon.", {
        status: 0,
        code: "unreachable",
      });
    }
    const position = parsePosition(response.headers.get("X-Pixdcon-Position"));
    let text;
    try {
      text = await time.race(response.text());
    } catch {
      if (time.timedOut()) throw timeoutError();
      throw new ApiError("No answer from pixdcon.", {
        status: 0,
        code: "unreachable",
      });
    }
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
    time.end();
    release(key, control);
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
  const time = bound(options.signal);
  try {
    let response;
    try {
      response = await time.race(
        fetch(`/api/v2/devices/${encodeURIComponent(device)}/preview`, {
          cache: "no-store",
          signal: time.signal,
        }),
      );
    } catch {
      if (time.timedOut()) throw timeoutError();
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
    let bytes;
    try {
      bytes = new Uint8Array(await time.race(response.arrayBuffer()));
    } catch {
      if (time.timedOut()) throw timeoutError();
      throw new ApiError("No answer from pixdcon.", {
        status: 0,
        code: "unreachable",
      });
    }
    return frameOf(generation, response, bytes);
  } finally {
    time.end();
  }
}

/**
 * @param {number} generation
 * @param {Response} response
 * @param {Uint8Array} bytes
 */
function frameOf(generation, response, bytes) {
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
  return busy.get(key)?.epoch === storeFence().epoch;
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
