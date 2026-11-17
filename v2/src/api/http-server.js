/**
 * HTTP server: routing, JSON, static files, one error envelope.
 *
 * This file is a working minimum so that `npm run dev` and the smoke harness
 * run from day one: a route table with `:params`, JSON requests and answers,
 * static files for the UI, and the error mapping. Feature routes are declared
 * in routes-v1.js and routes-v2.js and answer 501 until they are built.
 *
 * Contract (matrix A-116 to A-123, A-191):
 *  - plain HTTP on WEB_PORT (default 8080), all interfaces, no login
 *  - routes match by method and normalised path; the query string never selects a route
 *  - JSON answers; errors are {"error": "<one sentence>", "code": "<stable_code>", …}
 *  - every JSON answer carries `X-Pixdcon-Position: <epoch>-<seq>`: the run
 *    of the process and the seq of the last live event published before the
 *    answer was built. The page orders an answer against the live stream
 *    with it (web/js/ordering.js); an answer without it is not applied
 *  - unknown path: 404 "Not found" as plain text (v1); known path, other method: 405
 *  - bodies: a JSON object of at most 1 MiB; 400 invalid_json, 400 json_object_required, 413 body_too_large
 *  - writes need Content-Type: application/json, else 415. A web page on
 *    another origin cannot send that without a preflight this server never
 *    answers, which closes v1's cross-site write hole (A-119, A-BUG-22)
 *  - a route that is not built yet: 501 {"code": "not_implemented"}
 *  - thrown HttpError: its status and code; ConfigError: 400 with line and
 *    column; anything else: 500 {"code": "internal"} without internals, logged
 *    at error. 4xx are logged at debug (A-121, A-BUG-23)
 *
 * To do in phase 3: retry a failed bind every 30 s (A-117), HEAD, ETag for
 * static files and previews, request ids in the log.
 *
 * Owner: API + live channel worker.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { ConfigError, HttpError } from "../core/errors.js";
import { NotImplementedError } from "../core/todo.js";

const MAX_BODY_BYTES = 1024 * 1024;

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Returned by a handler that wrote the response itself (live channel, binary previews). */
export const HANDLED = Symbol("handled");

/**
 * @typedef {object} RequestContext
 * @property {import("node:http").IncomingMessage} req
 * @property {import("node:http").ServerResponse} res
 * @property {Record<string, string>} params decoded `:name` parts of the path
 * @property {URLSearchParams} query
 * @property {() => Promise<Record<string, unknown>>} body parsed JSON object of the request
 */

/**
 * @callback RouteHandler
 * @param {RequestContext} ctx
 * @returns {unknown} a value to send as JSON with status 200, {status, body} for another status, or HANDLED
 */

/**
 * @typedef {object} RouteMeta
 * @property {string} summary
 * @property {string} [body] request body
 * @property {string} [ok] answer on success
 * @property {string} [errors]
 * @property {string} [rows] matrix row ids this route carries
 */

/**
 * @typedef {object} Route
 * @property {string} method
 * @property {string} path pattern with `:name` segments
 * @property {RouteHandler} handler
 * @property {RouteMeta} meta
 * @property {RegExp} regex
 * @property {string[]} keys
 */

export class HttpServer {
  /**
   * @param {object} options
   * @param {number} options.port 0 picks a free port (tests)
   * @param {string} [options.host] default "0.0.0.0"
   * @param {string} options.webRoot directory of the UI files
   * @param {import("../types.js").Logger} options.logger
   * @param {() => string} [options.position] "<epoch>-<seq>" for the X-Pixdcon-Position header of every JSON answer (main.js: the epoch and the live channel's seq)
   */
  constructor(options) {
    this.options = options;
    /** @type {Route[]} */
    this.table = [];
    /** @type {import("node:http").Server|null} */
    this.server = null;
    /** @type {Set<import("node:net").Socket>} */
    this.sockets = new Set();
  }

  /**
   * Declare a route.
   *
   * @param {string} method
   * @param {string} path e.g. "/api/v2/devices/:name/scene"
   * @param {RouteHandler} handler
   * @param {RouteMeta} [meta]
   */
  route(method, path, handler, meta = { summary: "" }) {
    /** @type {string[]} */
    const keys = [];
    const source = path
      .split("/")
      .map((part) => {
        if (part.startsWith(":")) {
          keys.push(part.slice(1));
          return "([^/]+)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.table.push({
      method: method.toUpperCase(),
      path,
      handler,
      meta,
      regex: new RegExp(`^${source}$`),
      keys,
    });
  }

  /** @returns {Array<{method: string, path: string, meta: RouteMeta}>} the declared routes */
  routes() {
    return this.table.map(({ method, path, meta }) => ({ method, path, meta }));
  }

  /** @returns {Promise<{port: number}>} */
  async start() {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.options.logger.error(
          "[WebServer] request failed after the response started",
          error,
        );
        res.destroy();
      });
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server = server;
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(this.options.port, this.options.host ?? "0.0.0.0", () => {
        server.off("error", rejectListen);
        resolveListen(undefined);
      });
    });
    const address = server.address();
    const port =
      typeof address === "object" && address ? address.port : this.options.port;
    this.options.logger.info(`[WebServer] Listening on port ${port}`);
    return { port };
  }

  /** Stop accepting, end open connections (the live channel keeps them open). */
  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise((resolveClose) => {
      server.close(() => resolveClose(undefined));
      for (const socket of this.sockets) socket.destroy();
    });
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  async #handle(req, res) {
    const url = new URL(req.url ?? "/", "http://pixdcon.invalid");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    try {
      const candidates = this.table.filter((route) => route.regex.test(path));
      const route = candidates.find((candidate) => candidate.method === method);
      if (!route) {
        if (candidates.length > 0) {
          throw new HttpError(
            405,
            "method_not_allowed",
            `${method} is not available for ${path}`,
          );
        }
        if (method === "GET" && (await this.#static(path, res))) return;
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method))
        requireJsonType(req);
      const match = /** @type {RegExpExecArray} */ (route.regex.exec(path));
      /** @type {Record<string, string>} */
      const params = Object.create(null);
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1]);
      });
      const result = await route.handler({
        req,
        res,
        params,
        query: url.searchParams,
        body: () => readJsonBody(req),
      });
      if (result === HANDLED) return;
      // Read after the handler ran: the answer includes every change the
      // handler made, so it stands at or after the events of those changes.
      const position = this.options.position?.();
      const shaped =
        result &&
        typeof result === "object" &&
        "status" in result &&
        "body" in result
          ? /** @type {{status: number, body: unknown}} */ (result)
          : { status: 200, body: result };
      sendJson(res, shaped.status, shaped.body ?? {}, position);
    } catch (error) {
      if (res.headersSent) throw error;
      const { status, body } = this.#errorBody(error, `${method} ${path}`);
      sendJson(res, status, body, this.options.position?.());
    }
  }

  /**
   * @param {unknown} error
   * @param {string} what
   * @returns {{status: number, body: Record<string, unknown>}}
   */
  #errorBody(error, what) {
    const { logger } = this.options;
    if (error instanceof HttpError) {
      logger.debug(`[WebServer] ${what} → ${error.statusCode} ${error.code}`);
      return {
        status: error.statusCode,
        body: { error: error.message, code: error.code, ...error.extra },
      };
    }
    if (error instanceof NotImplementedError) {
      return {
        status: 501,
        body: { error: error.message, code: "not_implemented" },
      };
    }
    if (error instanceof ConfigError) {
      return {
        status: 400,
        body: {
          error: error.message,
          code: "invalid_config",
          line: error.line,
          column: error.column,
        },
      };
    }
    logger.error(`[WebServer] ${what} failed`, error);
    return { status: 500, body: { error: "Internal error", code: "internal" } };
  }

  /**
   * Serve a UI file. Only files below the web root, only known types.
   *
   * @param {string} path
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<boolean>} true when a file was sent
   */
  async #static(path, res) {
    const root = resolve(this.options.webRoot);
    let relative;
    try {
      relative =
        path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
    } catch {
      return false;
    }
    const file = resolve(root, relative);
    const type = CONTENT_TYPES[extname(file)];
    if (!type || !file.startsWith(root + sep)) return false;
    try {
      const content = await readFile(file);
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {string} [position] "<epoch>-<seq>", sent as X-Pixdcon-Position
 */
export function sendJson(res, status, body, position) {
  // Serialise before the header is written: a value that cannot be serialised
  // must become a 500, not a half-sent response (matrix A-BUG-11).
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(position ? { "X-Pixdcon-Position": position } : {}),
  });
  res.end(text);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(req) {
  requireJsonType(req);
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(
        413,
        "body_too_large",
        "The request body is larger than 1 MiB",
      );
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "json_object_required", "JSON object required");
  }
  return value;
}

/** @param {import("node:http").IncomingMessage} req */
function requireJsonType(req) {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^application\/json(?:\s*;|$)/i.test(type)) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Send the request with Content-Type: application/json",
    );
  }
}
