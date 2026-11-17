/**
 * Test kind 2 of 3 (API and MQTT contract): HTTP API and live channel.
 *
 * What exists now keeps the route table honest: every documented route is
 * declared once and says 501 until it is built, and the error envelope holds.
 * Phase 3 replaces the todo entries. Tests talk to pixdcon 2 from the outside
 * only. Owner: API + live channel worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { HttpServer } from "../../src/api/http-server.js";
import { LiveChannel, wireLiveChannel } from "../../src/api/live-channel.js";
import { HttpError } from "../../src/core/errors.js";
import { manualClock } from "../../src/core/clock.js";
import { createLogger } from "../../src/core/logger.js";
import { registerV2Routes } from "../../src/api/routes-v2.js";
import { V1_ROUTES } from "../../src/api/routes-v1.js";
import { V2_ROUTES } from "../../src/api/routes-v2.js";
import { startStack } from "../helpers/harness.js";

test("HTTP: every documented route is declared exactly once", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  const declared = stack.app.server
    .routes()
    .map((route) => `${route.method} ${route.path}`);
  assert.equal(
    new Set(declared).size,
    declared.length,
    "no route is declared twice",
  );
  for (const route of [...V1_ROUTES, ...V2_ROUTES]) {
    assert.ok(
      declared.includes(`${route.method} ${route.path}`),
      `${route.method} ${route.path} is declared`,
    );
    assert.ok(route.summary, `${route.method} ${route.path} has a summary`);
  }
  assert.ok(declared.includes("GET /api/health"));
});

test("HTTP: every JSON answer says where it stands: X-Pixdcon-Position carries the epoch of the run and the seq of the live channel", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  for (const [path, status] of /** @type {const} */ ([
    ["/api/health", 200],
    ["/api/v2/devices", 501], // an error answer is an answer too
  ])) {
    const response = await fetch(`${stack.base}${path}`);
    assert.equal(response.status, status, path);
    const position = response.headers.get("x-pixdcon-position");
    assert.match(String(position), /^[0-9a-f]{8}-\d+$/, path);
    assert.ok(position?.startsWith(`${stack.app.epoch}-`));
  }
  // A static file is not state: it has no position.
  const page = await fetch(`${stack.base}/`);
  assert.equal(page.headers.get("x-pixdcon-position"), null);
});

test("HTTP: the error envelope, 404, 405, 415 and the skeleton's 501", async (t) => {
  const stack = await startStack(t, { mqtt: false });

  const health = await stack.api("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.instance, "pixdcon2-test");
  assert.match(health.body.version, /^\d{12}\.0\.0$/);
  assert.equal(health.body.version_scheme, "inspr-calver-3");

  const unknown = await stack.api("/api/nope");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body, "Not found");

  const wrongMethod = await stack.api("/api/v2/overlays", {
    method: "PUT",
    body: {},
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.code, "method_not_allowed");

  // Until phase 3 builds them, declared routes say so instead of pretending.
  for (const route of [...V1_ROUTES, ...V2_ROUTES]) {
    const path = route.path.replace(/:(\w+)/g, "x");
    const answer = await stack.api(path, {
      method: route.method,
      body: route.method === "GET" ? undefined : {},
    });
    assert.equal(answer.status, 501, `${route.method} ${route.path}`);
    assert.equal(answer.body.code, "not_implemented");
  }

  const page = await fetch(`${stack.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(
    (await fetch(`${stack.base}/../package.json`)).status,
    404,
    "nothing outside the web root is served",
  );
});

test("HTTP: a write without Content-Type: application/json is refused", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  stack.app.server.route("POST", "/api/_test/echo", async (ctx) => ({
    got: await ctx.body(),
  }));

  const form = await fetch(`${stack.base}/api/_test/echo`, {
    method: "POST",
    body: '{"a":1}',
  });
  assert.equal(
    form.status,
    415,
    "a cross-site form post cannot send JSON without a preflight",
  );

  const ok = await stack.api("/api/_test/echo", { body: { a: 1 } });
  assert.deepEqual(ok, { status: 200, body: { got: { a: 1 } } });

  const notObject = await fetch(`${stack.base}/api/_test/echo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "[1]",
  });
  assert.equal(notObject.status, 400);
  assert.equal(
    /** @type {any} */ (await notObject.json()).code,
    "json_object_required",
  );
});

// --- Phase 3 ---------------------------------------------------------------------------------------
test.todo(
  "v1 routes: request and answer shapes of all 18 routes match the matrix (A-126 to A-153)",
);
test.todo(
  "v1 GET /api/status: fields the deploy check reads (mqttConnected, version, deviceHealth, deviceScenes)",
);
test.todo("v2 writes answer with the applied DeviceView and a higher rev");
test.todo(
  "v2 mode and brightness: applied at once, retained control published, 503 mqtt_offline while a configured broker is down",
);
test("live channel: snapshot first, events in seq order, replay with since, ping, slow reader cut off", async (t) => {
  const api = await recordedApi(t, {ringSize: 2});
  const first = await stream(t, `${api.base}/api/v2/events`);
  assert.deepEqual(await first.next(), {id: "abcd1234-0", type: "snapshot", data: await (await fetch(`${api.base}/api/v2/bootstrap`)).json()});
  api.deps.state.emit("device", {...api.device, rev: 8});
  assert.equal((await first.next()).id, "abcd1234-1");
  api.live.publish("device-removed", {name: "other"});
  assert.equal((await first.next()).id, "abcd1234-2");
  const replay = await stream(t, `${api.base}/api/v2/events?since=abcd1234-0`);
  assert.deepEqual([(await replay.next()).id, (await replay.next()).id], ["abcd1234-1", "abcd1234-2"]);
  await api.clock.advance(15000);
  assert.equal((await first.next()).type, "ping");
  const expired = await stream(t, `${api.base}/api/v2/events?since=abcd1234-0`);
  assert.equal((await expired.next()).type, "snapshot");
  const slow = Object.assign(new EventEmitter(), {writeHead() {}, flushHeaders() {}, write: () => false, destroyed: false,
    destroy() { this.destroyed = true; }});
  api.live.handle(/** @type {any} */ ({res: slow, req: {headers:{}}, query: new URLSearchParams()}));
  assert.equal(slow.destroyed, true);

});
test("live channel: an event carries the device rev; an older answer never overwrites a newer state", async (t) => {
  const api = await recordedApi(t);
  const older = /** @type {any} */ (await (await fetch(`${api.base}/api/v2/devices/pixoo-189`)).json());
  const events = await stream(t, `${api.base}/api/v2/events`); await events.next();
  api.deps.state.emit("device", {...api.device, rev: 8});
  const event = await events.next();
  assert.equal(event.data.epoch, api.device.epoch);
  assert.equal(event.data.rev, 8);
  assert.ok(older.rev < event.data.rev, "wire carries revisions for the client's ordering fence");

});
test("boot epoch: every view, snapshot and event id carries the epoch; after a restart a cursor of the old epoch gets a snapshot, not a replay", async (t) => {
  const api = await recordedApi(t, {epoch: "new-epoch"});
  const bootstrap = /** @type {any} */ (await (await fetch(`${api.base}/api/v2/bootstrap`)).json());
  assert.equal(bootstrap.epoch, "new-epoch");
  assert.equal(bootstrap.devices[0].epoch, "new-epoch");
  assert.equal(bootstrap.overlays[0].confirmed, false);
  assert.deepEqual(await (await fetch(`${api.base}/api/v2/devices`)).json(), bootstrap.devices);
  assert.equal((await fetch(`${api.base}/api/v2/devices/missing`)).status, 404);
  api.live.publish("device", {...api.device, rev: 8});
  const events = await stream(t, `${api.base}/api/v2/events?since=old-epoch-1`);
  const first = await events.next();
  assert.equal(first.type, "snapshot"); assert.equal(first.id, "new-epoch-1");
  assert.equal(first.data.epoch, "new-epoch");

});
test("boot epoch: a bare number as cursor (no epoch) gets a snapshot", async (t) => {
  const api = await recordedApi(t);
  api.live.publish("device-removed", {name: "other"});
  const events = await stream(t, `${api.base}/api/v2/events?since=1`);
  assert.equal((await events.next()).type, "snapshot");

});
test.todo(
  "settings drafts over HTTP: preview needs session and draft; Save with draft n leaves a preview of draft n+1 in place and says so in the state",
);
test.todo(
  "adopt route: 409 not_overlay_only for a device of config.json; for a blob-only device the answer has origin config",
);
test.todo(
  "scene copy: the folders in the source's resources.assetDirs are linked beside the copy, and a copy of home3 loads",
);
test.todo(
  "GET /api/health: 200 with status degraded while a display is offline, 503 when the scheduler watchdog is overdue",
);
test.todo(
  "config: an invalid config.json keeps the last valid config running and the UI reachable, also at start",
);

// --- Ordering (knowledge entry, section 3.0) ---
test.todo(
  "position: the X-Pixdcon-Position of a write's answer is not lower than the seq of the live events the write caused",
);
test("live channel sessions: a page that reconnects opens its new stream before the old one closes; the session is reported gone only when its last stream closed", async (t) => {
  const api = await recordedApi(t);
  const old = await stream(t, `${api.base}/api/v2/events?session=page`); await old.next();
  const newer = await stream(t, `${api.base}/api/v2/events?session=page`); await newer.next();
  assert.deepEqual(api.sessions, [["page", true]]);
  old.abort.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(api.sessions, [["page", true]]);
  assert.equal(api.live.status().sessions.length, 1);
  api.live.stop();
  assert.deepEqual(api.sessions, [["page", true], ["page", false]]);
  assert.deepEqual(api.live.status(), {clients: 0, sessions: []});
  assert.equal(api.clock.pending(), 0);

});
test.todo(
  "requests in order: two writes for one device are applied in the order they arrived and each answers with its own applied view; writes for two devices do not wait for each other",
);


/** Recorded W1 views; API/SSE tests do not implement or modify the state store.
 * @param {import("node:test").TestContext} t
 * @param {{epoch?: string, ringSize?: number}} [options]
 */
async function recordedApi(t, options = {}) {
  const epoch = options.epoch ?? "abcd1234";
  const clock = manualClock();
  const logger = createLogger({ level: "error", sink: {out() {}, err() {}} });
  const device = { name: "pixoo-189", epoch, rev: 7, origin: "config", type: "pixoo",
    desired: { scene: {scene: "funkeykid", source: "config"} },
    effective: {scene: "funkeykid", frameCount: 100}, health: {state: "online"} };
  const overlay = { id: "device-scene:pixoo-189", confirmed: false, inEffect: false };
  /** @type {Array<[string, boolean]>} */
  const sessions = [];
  const snapshot = () => ({devices: [device], overlays: [overlay], scenes: [], builtins: {ulanzi: [], pixoo: []},
    controller: {epoch}, mqtt: {state: "disabled"}, config: {valid: true} });
  const live = new LiveChannel({epoch, clock, logger, ringSize: options.ringSize,
    snapshot: /** @type {any} */ (snapshot), onSession: (id, connected) => sessions.push([id, connected])});
  const state = Object.assign(new EventEmitter(), {views: () => [device], view: (/** @type {string} */ name) => {
    if(name !== device.name) throw new HttpError(404, "unknown_device", "Unknown device");
    return device;
  }});
  const deps = /** @type {any} */ ({epoch, clock, logger, live, state,
    overlays: Object.assign(new EventEmitter(), {list: () => [overlay]}),
    scenes: Object.assign(new EventEmitter(), {list: () => []}),
    config: Object.assign(new EventEmitter(), {file: () => ({valid: true})}),
    previews: new EventEmitter(), settings: new EventEmitter(), mqtt: null});
  const server = new HttpServer({port: 0, host: "127.0.0.1", webRoot: resolve("web"), logger,
    position: () => `${epoch}-${live.seq()}`});
  registerV2Routes(server, deps);
  const unwire = wireLiveChannel(live, deps);
  t.after(async () => { unwire(); live.stop(); await server.stop(); });
  const {port} = await server.start();
  const base = `http://127.0.0.1:${port}`;
  return {base, deps, live, device, sessions, clock, server};
}

/** @param {import("node:test").TestContext} t @param {string} url */
async function stream(t, url) {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(url, {signal: abort.signal});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  let buffer = "";
  return {abort, async next() {
    while (!buffer.includes("\n\n")) {
      const {value, done} = await reader.read();
      assert.equal(done, false, "stream has another event");
      buffer += Buffer.from(value ?? []).toString();
    }
    const end = buffer.indexOf("\n\n");
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    const fields = Object.fromEntries(raw.split("\n").map(line => {
      const colon = line.indexOf(":"); return [line.slice(0, colon), line.slice(colon + 2)];
    }));
    return {id: fields.id, type: fields.event, data: JSON.parse(fields.data)};
  }};
}
