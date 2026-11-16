/**
 * Typed errors. The render loop and the health model depend on telling a
 * display that does not answer from a scene that throws (matrix S-6, B-030):
 * only DeviceError counts towards the circuit breaker and the power cycle.
 */

/** A display did not accept a request: timeout, refused, HTTP error, firmware error code. */
export class DeviceError extends Error {
  /**
   * @param {string} message                 text as v1 logs it, e.g. "Pixoo HTTP timeout after 5000ms"
   * @param {{device?: string, op?: string, timeout?: boolean, cause?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "DeviceError";
    /** @type {"device"} */
    this.kind = "device";
    this.device = details.device ?? null;
    this.op = details.op ?? null;
    this.timeout = details.timeout === true;
  }
}

/** A scene failed: import error, missing render(), throwing init/render/destroy, invalid schema. */
export class SceneError extends Error {
  /**
   * @param {string} message
   * @param {{scene?: string, device?: string, phase?: "import"|"contract"|"init"|"render"|"destroy", cause?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "SceneError";
    /** @type {"scene"} */
    this.kind = "scene";
    this.scene = details.scene ?? null;
    this.device = details.device ?? null;
    this.phase = details.phase ?? null;
  }
}

/** config.json (or a posted config) is not usable. Carries the position for the raw editor. */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{line?: number, column?: number, path?: string, cause?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "ConfigError";
    /** @type {"config"} */
    this.kind = "config";
    this.line = details.line ?? null;
    this.column = details.column ?? null;
    this.path = details.path ?? null;
  }
}

/** An API request that is answered with a status code and the envelope `{error, code}`. */
export class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code      stable machine code, e.g. "mqtt_offline", "unknown_device", "config_invalid"
   * @param {string} message   one sentence a person can act on
   * @param {Record<string, unknown>} [extra] added to the response body
   */
  constructor(statusCode, code, message, extra = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Classify any thrown value for the health model and the UI.
 * `null` and `undefined` are valid inputs: a scene may reject with nothing (matrix S-36).
 *
 * @param {unknown} error
 * @returns {{kind: "device"|"scene"|"config"|"internal", message: string}}
 */
export function classifyError(error) {
  if (error instanceof DeviceError)
    return { kind: "device", message: error.message };
  if (error instanceof SceneError)
    return { kind: "scene", message: error.message };
  if (error instanceof ConfigError)
    return { kind: "config", message: error.message };
  if (error instanceof Error)
    return { kind: "internal", message: error.message };
  return {
    kind: "internal",
    message: `non-error value thrown: ${String(error)}`,
  };
}
