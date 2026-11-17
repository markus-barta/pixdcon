/** Serialized, cancellable transport shared by the two HTTP drivers. */
import { DeviceError } from "../core/errors.js";

/** @param {import('./driver.js').DriverOptions} options @param {string} label */
export function createTransport(options, label) {
  let closed = false;
  let ready = false;
  let tail = Promise.resolve();
  const lifetime = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5000;

  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  function queue(task) {
    const result = tail.then(async () => {
      try {
        if (closed) throw new DeviceError(`${label} driver closed`);
        return await task();
      } catch (cause) {
        ready = false;
        if (cause instanceof DeviceError) throw cause;
        throw new DeviceError(`${label} HTTP: ${cause instanceof Error ? cause.message : String(cause)}`, {
          device: options.name, cause,
        });
      }
    });
    tail = result.then(() => {}, () => {});
    return result;
  }

  /** @param {string} path @param {unknown} [body] @param {AbortSignal} [signal] @returns {Promise<unknown>} */
  async function request(path, body, signal) {
    const deadline = new AbortController();
    const abort = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, abort.signal, ...(signal ? [signal] : [])]);
    const expired = options.clock.sleep(timeoutMs, deadline.signal).then((elapsed) => {
      if (!elapsed) return new Promise(() => {});
      abort.abort();
      throw new DeviceError(`${label} HTTP timeout after ${timeoutMs}ms`, {
        device: options.name, op: path, timeout: true,
      });
    });
    try {
      // The race covers the body as well as the headers. A late answer has no side effects.
      return await Promise.race([expired, (async () => {
        const response = await fetch(`http://${options.address}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
          signal: combined,
        });
        const text = await response.text();
        if (!response.ok) throw new DeviceError(`${label} HTTP ${response.status}`, { device: options.name, op: path });
        try { return JSON.parse(text); } catch { return null; }
      })()]);
    } finally {
      deadline.abort();
    }
  }
  return {
    queue, request,
    get ready() { return ready; },
    set ready(value) { ready = value && !closed; },
    async close() { closed = true; ready = false; lifetime.abort(); },
  };
}

/** @param {import('../types.js').Frame} frame @param {number} width @param {number} height */
export function copyFrame(frame, width, height) {
  if (frame.width !== width || frame.height !== height || !(frame.rgb instanceof Uint8Array) || frame.rgb.length !== width * height * 3)
    throw new DeviceError(`Frame must contain ${width}x${height} RGB bytes`);
  return { width, height, rgb: frame.rgb.slice() };
}

/** @param {number} value @param {number} min @param {number} max */
export function brightness(value, min, max) {
  if (!Number.isFinite(value)) throw new DeviceError("Brightness must be finite");
  return Math.round(Math.max(min, Math.min(max, value)));
}
