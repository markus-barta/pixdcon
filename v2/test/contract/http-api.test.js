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
    assert.equal(
      position,
      `${stack.app.epoch}-0`,
      "the run's epoch; seq 0 while the live channel has published nothing",
    );
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
test.todo(
  "live channel: snapshot first, events in seq order, replay with since, ping, slow reader cut off",
);
test.todo(
  "live channel: an event carries the device rev; an older answer never overwrites a newer state",
);
test.todo(
  "boot epoch: every view, snapshot and event id carries the epoch; after a restart a cursor of the old epoch gets a snapshot, not a replay",
);
test.todo("boot epoch: a bare number as cursor (no epoch) gets a snapshot");
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
test.todo(
  "live channel sessions: a page that reconnects opens its new stream before the old one closes; the session is reported gone only when its last stream closed",
);
test.todo(
  "requests in order: two writes for one device are applied in the order they arrived and each answers with its own applied view; writes for two devices do not wait for each other",
);
