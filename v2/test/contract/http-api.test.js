/**
 * Test kind 2 of 3 (API and MQTT contract): HTTP API and live channel.
 *
 * Routes, SSE, position headers and v1 wire shapes exercised over loopback.
 * Recorded store views isolate W4's transport from W1/W3's unfinished stores.
 * Remaining integration todos name their blockers. Owner: API + live channel worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { HttpServer } from "../../src/api/http-server.js";
import { LiveChannel, wireLiveChannel } from "../../src/api/live-channel.js";
import { NotImplementedError } from "../../src/core/todo.js";
import { HttpError } from "../../src/core/errors.js";
import { manualClock } from "../../src/core/clock.js";
import { createLogger } from "../../src/core/logger.js";
import { registerV2Routes } from "../../src/api/routes-v2.js";
import { V1_ROUTES, registerV1Routes } from "../../src/api/routes-v1.js";
import { V2_ROUTES } from "../../src/api/routes-v2.js";
import { REPO_ROOT, startStack, waitFor } from "../helpers/harness.js";
import {
  createClientFence,
  decideSnapshot,
  decideView,
  openSource,
  parsePosition,
} from "../../web/js/ordering.js";

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
    ["/api/v2/devices", 200],
    ["/api/v2/devices/missing", 404], // an error answer is an answer too
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

  stack.app.server.route("GET", "/api/_test/skeleton", () => {
    throw new NotImplementedError("test");
  });
  const skeleton = await stack.api("/api/_test/skeleton");
  assert.equal(skeleton.status, 501);
  assert.equal(skeleton.body.code, "not_implemented");

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
test("v1 routes: request and answer shapes of all 18 routes match the matrix (A-126 to A-153)", async (t) => {
  const api = await recordedApi(t);
  const stack = await startStack(t, { mqtt: false });
  api.deps.versioningDir = resolve(REPO_ROOT, "vendor/inspr-versioning");
  api.deps.scenes.list = () => [
    {
      key: "clock",
      path: "clock.js",
      name: "clock",
      pretty_name: "Clock",
      description: "",
      deviceType: "pixoo",
      settingsSchema: {},
    },
  ];
  api.deps.settings.toV1 = () => ({
    "pixoo-189": {
      clock: { saved: { x: 2 }, overlay: {}, effective: { x: 2 } },
    },
  });
  api.deps.settings.state = () => ({
    values: { old: { saved: 1 } },
    schema: { x: {} },
  });
  api.deps.settings.save = async (
    /** @type {any} */ _device,
    /** @type {any} */ _scene,
    /** @type {any} */ change,
  ) => {
    assert.deepEqual(change.reset, ["old"]);
    return { state: { values: { x: { saved: 2 } } }, rejected: {} };
  };
  api.deps.previews.toV1 = () => ({
    "pixoo-189": {
      width: 1,
      height: 1,
      data: "AQID",
      source: "runtime",
      intervalMs: 1000,
      updatedAt: "2026-11-17T00:00:00.000Z",
    },
  });
  api.deps.config.addDevice = async () => {};
  api.deps.config.replaceRaw = async () => {};
  api.deps.config.updateDevice = async (
    /** @type {any} */ _name,
    /** @type {any} */ mutate,
  ) => {
    mutate({});
  };
  api.deps.scenes.check = () => null;
  api.deps.state.chooseScene = async () => ({
    view: api.device,
    persisted: true,
    notSavedReason: null,
  });
  api.deps.state.setMode =
    api.deps.state.setBrightness =
    api.deps.state.clearSceneOverlay =
      async () => api.device;
  api.deps.overlays.publishSceneOverlay = async () => ({ confirmed: true });
  api.deps.overlays.publishSettings = async () => ({
    applied: ["x"],
    rejected: [],
    failed: [],
  });
  api.deps.overlays.clearSettings = async () => ({
    cleared: ["x"],
    failed: [],
  });
  api.deps.overlays.settingValues = () => ({ x: 2 });
  const cases = [
    ["GET", "/api/config", undefined, api.deps.state.runningConfigV1()],
    ["GET", "/api/config/file", undefined, api.deps.config.get()],
    ["POST", "/api/config/file", { devices: [], scenes: {} }, { ok: true }],
    ["GET", "/api/scene-settings", undefined, api.deps.settings.toV1()],
    ["GET", "/api/previews", undefined, api.deps.previews.toV1()],
    [
      "POST",
      "/api/device",
      { name: "new", type: "pixoo", ip: "127.0.0.1" },
      { ok: true },
    ],
    [
      "POST",
      "/api/device/save",
      { deviceName: "pixoo-189", patch: { displayName: "TV" } },
      { ok: true, device: api.deps.config.get().devices[0] },
    ],
    [
      "POST",
      "/api/scene",
      { deviceName: "pixoo-189", scene: "clock" },
      { ok: true },
    ],
    [
      "POST",
      "/api/scene-settings/save",
      { deviceName: "pixoo-189", sceneName: "clock", values: { x: 2 } },
      { ok: true, saved: { x: 2 } },
    ],
    [
      "POST",
      "/api/scene-settings/overlay",
      { deviceName: "pixoo-189", sceneName: "clock", values: { x: 2 } },
      { ok: true, overlay: { x: 2 } },
    ],
    [
      "POST",
      "/api/scene-settings/overlay/clear",
      { deviceName: "pixoo-189", sceneName: "clock" },
      { ok: true, overlay: { x: 2 } },
    ],
    [
      "POST",
      "/api/overlay",
      { deviceName: "pixoo-189", scene: "clock" },
      { ok: true },
    ],
    ["POST", "/api/overlay/clear", { deviceName: "pixoo-189" }, { ok: true }],
    [
      "POST",
      "/api/mode",
      { deviceName: "pixoo-189", mode: "play" },
      { ok: true },
    ],
    [
      "POST",
      "/api/brightness",
      { deviceName: "pixoo-189", enabled: false },
      { ok: true },
    ],
  ];
  for (const [method, path, body, expected] of cases) {
    const result = await api.api(String(path), String(method), body);
    assert.equal(result.status, 200, String(path));
    assert.deepEqual(result.body, expected, String(path));
  }
  const scenes = await api.api("/api/scenes");
  assert.deepEqual(scenes.body, {
    clock: api.deps.scenes.list()[0],
    builtins: { ulanzi: [], pixoo: [] },
  });
  assert.equal((await api.api("/api/status")).status, 200);
  const asset = await fetch(`${api.base}/vendor/inspr-versioning/version.js`);
  assert.equal(asset.status, 200);
  assert.equal(
    await asset.text(),
    await readFile(resolve(api.deps.versioningDir, "version.js"), "utf8"),
  );
  assert.equal(
    (await fetch(`${api.base}/vendor/inspr-versioning/not-allowed`)).status,
    404,
  );
  // The nineteenth compatibility route copies and registers the file too.
  const source = resolve(stack.dataDir, "source.js");
  await writeFile(source, 'export default {name:"source",render(){}};');
  api.deps.config.baseDir = () => stack.dataDir;
  api.deps.scenes.get = (/** @type {any} */ key) =>
    key === "source"
      ? {
          key,
          resources: { assetDirs: [], stateFields: [] },
          name: key,
          pretty_name: key,
        }
      : undefined;
  api.deps.scenes.fileOf = () => source;
  api.deps.config.update = async (/** @type {any} */ mutate) => {
    mutate({ scenes: {} });
  };
  const clone = await api.api("/api/scene/clone", "POST", {
    sceneName: "source",
    targetSceneKey: "copy",
    targetPrettyName: "Copy",
  });
  assert.equal(clone.body.ok, true);
  assert.equal(clone.body.sceneKey, "copy");
  assert.match(clone.body.path, /\/copy-[\w-]+\.js$/);
  assert.equal(clone.status, 200);
  assert.equal(
    (await readdir(resolve(stack.dataDir, "generated-scenes/_backups"))).length,
    1,
    "v1 clones retain a source backup",
  );
  assert.equal(
    V1_ROUTES.length,
    19,
    "18 in skeleton, plus the omitted device/save compatibility route",
  );
});
test("v1 GET /api/status: fields the deploy check reads (mqttConnected, version, deviceHealth, deviceScenes)", async (t) => {
  const api = await recordedApi(t);
  const result = await api.api("/api/status");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    mqttConnected: false,
    version: "202611170357.0.0",
    version_scheme: "inspr-calver-3",
    deviceModes: { "pixoo-189": "play" },
    deviceBrightness: { "pixoo-189": { override: null, last: 25 } },
    deviceHealth: {
      "pixoo-189": {
        online: true,
        consecutiveErrors: 0,
        lastSuccessAgoMs: 250,
        ip: "127.0.0.1:189",
        type: "pixoo",
        apSsid: null,
      },
    },
    deviceScenes: { "pixoo-189": "funkeykid" },
  });
});
test("v2 writes answer with the applied DeviceView and a higher rev", async (t) => {
  const api = await recordedApi(t);
  api.deps.state.chooseScene = async (
    /** @type {any} */ name,
    /** @type {any} */ scene,
  ) => {
    assert.equal(name, "pixoo-189");
    assert.equal(scene, "clock");
    const view = {
      ...api.device,
      rev: 8,
      effective: { ...api.device.effective, scene },
    };
    api.deps.state.emit("device", view);
    return { view, persisted: false, notSavedReason: "config_invalid" };
  };
  const result = await api.api("/api/v2/devices/pixoo-189/scene", "PUT", {
    scene: "clock",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.device.rev, 8);
  assert.equal(result.body.device.effective.scene, "clock");
  assert.deepEqual(
    [result.body.persisted, result.body.notSavedReason],
    [false, "config_invalid"],
  );
  for (const [suffix, body, code] of [
    ["scene", {}, "invalid_field"],
    ["mode", { mode: "oops" }, "invalid_mode"],
    ["brightness", { override: 101 }, "invalid_brightness"],
  ]) {
    const bad = await api.api(
      `/api/v2/devices/pixoo-189/${suffix}`,
      "PUT",
      body,
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, code);
  }
  const patch = await api.api("/api/v2/devices/pixoo-189", "PATCH", {
    ip: "127.0.0.2",
  });
  assert.equal(patch.status, 400);
  assert.equal(patch.body.field, "ip");
});
test("v2 mode and brightness: applied at once, retained control published, 503 mqtt_offline while a configured broker is down", async (t) => {
  const api = await recordedApi(t);
  /** @type {unknown[]} */ const controls = [];
  api.deps.state.setMode = async (
    /** @type {any} */ name,
    /** @type {any} */ mode,
  ) => {
    controls.push({ name, mode });
    return { ...api.device, rev: 8 };
  };
  api.deps.state.setBrightness = async (
    /** @type {any} */ name,
    /** @type {any} */ percent,
  ) => {
    controls.push({ name, percent });
    return { ...api.device, rev: 9 };
  };
  assert.equal(
    (await api.api("/api/v2/devices/pixoo-189/mode", "PUT", { mode: "pause" }))
      .body.rev,
    8,
  );
  assert.equal(
    (
      await api.api("/api/v2/devices/pixoo-189/brightness", "PUT", {
        override: null,
      })
    ).body.rev,
    9,
  );
  assert.deepEqual(controls, [
    { name: "pixoo-189", mode: "pause" },
    { name: "pixoo-189", percent: null },
  ]);
  api.deps.state.setMode = api.deps.state.setBrightness = async () => {
    throw new HttpError(503, "mqtt_offline", "MQTT is offline");
  };
  for (const [suffix, body] of [
    ["mode", { mode: "play" }],
    ["brightness", { override: 50 }],
  ]) {
    const result = await api.api(
      `/api/v2/devices/pixoo-189/${suffix}`,
      "PUT",
      body,
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "mqtt_offline");
  }
  // Retained control transport belongs to W1; these routes use its command
  // result and never acknowledge an unpublished control themselves.
});
test("live channel: snapshot first, events in seq order, replay with since, ping, slow reader cut off", async (t) => {
  const api = await recordedApi(t, { ringSize: 2 });
  const first = await stream(t, `${api.base}/api/v2/events`);
  assert.deepEqual(await first.next(), {
    id: "abcd1234-0",
    type: "snapshot",
    data: await (await fetch(`${api.base}/api/v2/bootstrap`)).json(),
  });
  api.deps.state.emit("device", { ...api.device, rev: 8 });
  assert.equal((await first.next()).id, "abcd1234-1");
  api.live.publish("device-removed", { name: "other" });
  assert.equal((await first.next()).id, "abcd1234-2");
  const replay = await stream(t, `${api.base}/api/v2/events?since=abcd1234-0`);
  assert.deepEqual(
    [(await replay.next()).id, (await replay.next()).id],
    ["abcd1234-1", "abcd1234-2"],
  );
  await api.clock.advance(15000);
  assert.equal((await first.next()).type, "ping");
  const expired = await stream(t, `${api.base}/api/v2/events?since=abcd1234-0`);
  assert.equal((await expired.next()).type, "snapshot");
  const slow = bufferedResponse();
  api.live.handle(
    /** @type {any} */ ({
      res: slow,
      req: { headers: {} },
      query: new URLSearchParams(),
    }),
  );
  assert.equal(slow.destroyed, false, "one buffered write is allowed");
  api.live.publish("ping", { at: "now" });
  assert.equal(
    slow.destroyed,
    false,
    "backpressure alone is not a stuck reader",
  );
  await api.clock.advance(10000);
  assert.equal(slow.destroyed, true);
});

/** A writable with a small highWaterMark: false means buffered, not lost. */
function bufferedResponse() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    writableLength: 0,
    highWaterMark: 256,
    writes: /** @type {string[]} */ ([]),
    writeHead() {},
    flushHeaders() {},
    write(/** @type {string} */ wire) {
      this.writes.push(wire);
      this.writableLength += Buffer.byteLength(wire);
      return this.writableLength < this.highWaterMark;
    },
    drain() {
      this.writableLength = 0;
      emitter.emit("drain");
    },
    destroyed: false,
    destroy() {
      this.destroyed = true;
      emitter.emit("close");
    },
    end() {
      emitter.emit("close");
    },
  });
}

test("live channel: replay above high-water mark recovers in one attempt and drains", async (t) => {
  const api = await recordedApi(t);
  for (let rev = 8; rev < 28; rev++)
    api.live.publish("device", {
      ...api.device,
      rev,
      comment: "x".repeat(8192),
    });
  const res = bufferedResponse();
  let staleDeadline = () => {};
  const every = api.clock.every;
  api.live.deps.clock = {
    ...api.clock,
    every(fn, ms) {
      if (ms === 10000) staleDeadline = fn;
      return every(fn, ms);
    },
  };
  api.live.handle(
    /** @type {any} */ ({
      res,
      req: { headers: {} },
      query: new URLSearchParams("since=abcd1234-0"),
    }),
  );
  assert.ok(res.writableLength > res.highWaterMark);
  assert.equal(res.destroyed, false);
  assert.equal(res.writes.length, 20);
  assert.match(res.writes[19], /id: abcd1234-20/);
  res.drain();
  staleDeadline();
  assert.equal(
    res.destroyed,
    false,
    "a canceled deadline cannot close a drained stream",
  );
  await api.clock.advance(10000);
  assert.equal(res.destroyed, false, "drain cancels the stuck-reader deadline");
});

test("live channel: replay byte budget falls back to snapshot; previews stay out of replay", async (t) => {
  const api = await recordedApi(t);
  for (let rev = 8; rev < 48; rev++)
    api.live.publish("device", {
      ...api.device,
      rev,
      comment: "x".repeat(65536),
    });
  const replay = await stream(t, `${api.base}/api/v2/events?since=abcd1234-0`);
  assert.equal((await replay.next()).type, "snapshot");
  const since = api.live.seq();
  for (let seq = 0; seq < 600; seq++)
    api.live.publish("preview", { frameSeq: seq });
  api.live.publish("device", { ...api.device, rev: 48 });
  const next = await stream(
    t,
    `${api.base}/api/v2/events?since=abcd1234-${since}`,
  );
  assert.equal(
    (await next.next()).type,
    "device",
    "preview bursts do not evict state or replay old frames",
  );
});

test("live channel: stuck and over-budget readers are cut off; next connection gets snapshot", async (t) => {
  const api = await recordedApi(t);
  const slow = bufferedResponse();
  api.live.handle(
    /** @type {any} */ ({
      res: slow,
      req: { headers: {} },
      query: new URLSearchParams("session=page"),
    }),
  );
  const cursor = api.live.seq();
  await api.clock.advance(10000);
  assert.equal(slow.destroyed, true, "even a quiet stuck stream times out");
  const next = await stream(
    t,
    `${api.base}/api/v2/events?session=page&since=abcd1234-${cursor}`,
  );
  assert.equal((await next.next()).type, "snapshot");
  const full = bufferedResponse();
  api.live.handle(
    /** @type {any} */ ({
      res: full,
      req: { headers: {} },
      query: new URLSearchParams(),
    }),
  );
  api.live.publish("device", {
    ...api.device,
    comment: "x".repeat(2 * 1024 * 1024),
  });
  assert.equal(
    full.destroyed,
    true,
    "byte budget closes a growing buffer before its deadline",
  );
  const recovered = await stream(
    t,
    `${api.base}/api/v2/events?since=abcd1234-${api.live.seq()}`,
  );
  assert.equal((await recovered.next()).type, "snapshot");
});
test("live channel: an event carries the device rev; an older answer never overwrites a newer state", async (t) => {
  const api = await recordedApi(t);
  const entered = deferred(),
    release = deferred();
  const oldView = structuredClone(api.device);
  const route = api.server.table.find((route) => route.path === "/api/v2/devices/:name");
  assert.ok(route);
  const handler = route.handler;
  route.handler = (ctx) => {
    const body = handler(ctx);
    entered.resolve();
    return release.promise.then(() => body);
  };
  const answer = api.api("/api/v2/devices/pixoo-189");
  await entered.promise;
  const events = await stream(t, `${api.base}/api/v2/events`);
  const snapshot = await events.next();
  const fence = createClientFence();
  const source = openSource(fence, "stream");
  decideSnapshot(fence, snapshot.data, { generation: source });
  let shown = oldView;
  api.deps.state.emit("device", { ...api.device, rev: 8, comment: "newer" });
  const event = await events.next();
  const key = `device:${api.device.name}`;
  const eventPosition = parsePosition(event.id);
  assert.ok(eventPosition);
  const applyEvent = decideView(fence, {
    ...event.data,
    key,
    seq: eventPosition.seq,
  });
  assert.equal(applyEvent.action, "apply");
  if (applyEvent.action === "apply") shown = event.data;
  release.resolve();
  const older = await answer;
  const answerPosition = parsePosition(older.headers.get("x-pixdcon-position"));
  assert.ok(answerPosition);
  const applyAnswer = decideView(fence, {
    ...older.body,
    key,
    seq: answerPosition.seq,
  });
  assert.deepEqual(applyAnswer, { action: "drop", reason: "not_newer" });
  if (applyAnswer.action === "apply") shown = older.body;
  assert.equal(shown.rev, 8);
  assert.equal(
    shown.comment,
    "newer",
    "late HTTP answer cannot replace the newer event already shown",
  );
});
test("boot epoch: every view, snapshot and event id carries the epoch; after a restart a cursor of the old epoch gets a snapshot, not a replay", async (t) => {
  const api = await recordedApi(t, { epoch: "new-epoch" });
  const bootstrap = /** @type {any} */ (
    await (await fetch(`${api.base}/api/v2/bootstrap`)).json()
  );
  assert.equal(bootstrap.epoch, "new-epoch");
  assert.equal(bootstrap.devices[0].epoch, "new-epoch");
  assert.equal(bootstrap.overlays[0].confirmed, false);
  assert.deepEqual(
    await (await fetch(`${api.base}/api/v2/devices`)).json(),
    bootstrap.devices,
  );
  assert.equal((await fetch(`${api.base}/api/v2/devices/missing`)).status, 404);
  api.live.publish("device", { ...api.device, rev: 8 });
  const events = await stream(t, `${api.base}/api/v2/events?since=old-epoch-1`);
  const first = await events.next();
  assert.equal(first.type, "snapshot");
  assert.equal(first.id, "new-epoch-1");
  assert.equal(first.data.epoch, "new-epoch");
});
test("boot epoch: a bare number as cursor (no epoch) gets a snapshot", async (t) => {
  const api = await recordedApi(t);
  api.live.publish("device-removed", { name: "other" });
  const events = await stream(t, `${api.base}/api/v2/events?since=1`);
  assert.equal((await events.next()).type, "snapshot");
});
test("settings drafts over HTTP: preview needs session and draft; Save with draft n leaves a preview of draft n+1 in place and says so in the state", async (t) => {
  const api = await recordedApi(t);
  const settings = {
    device: "pixoo-189",
    scene: "clock",
    epoch: "abcd1234",
    rev: 1,
    values: {},
    preview: { session: "page", draft: 2 },
  };
  /** @type {unknown[]} */ const seen = [];
  api.deps.settings.preview = (
    /** @type {any} */ device,
    /** @type {any} */ scene,
    /** @type {any} */ preview,
  ) => {
    seen.push({ device, scene, preview });
    return { state: settings, rejected: {}, applied: false };
  };
  api.deps.settings.save = async (
    /** @type {any} */ device,
    /** @type {any} */ scene,
    /** @type {any} */ change,
  ) => {
    seen.push({ device, scene, change });
    return { state: settings, rejected: {}, overlaysNotCleared: [] };
  };
  const path = "/api/v2/devices/pixoo-189/settings/clock";
  for (const body of [
    { values: {} },
    { session: "page", values: {} },
    { session: "page", draft: -1, values: {} },
  ])
    assert.equal((await api.api(path + "/preview", "PUT", body)).status, 400);
  const preview = await api.api(path + "/preview", "PUT", {
    session: "page",
    draft: 2,
    values: { brightness: 3 },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.applied, false);
  const saved = await api.api(path, "PUT", {
    session: "page",
    draft: 1,
    set: { brightness: 2 },
    reset: ["old"],
  });
  assert.deepEqual(saved.body.state.preview, { session: "page", draft: 2 });
  assert.deepEqual(seen, [
    {
      device: "pixoo-189",
      scene: "clock",
      preview: { session: "page", draft: 2, values: { brightness: 3 } },
    },
    {
      device: "pixoo-189",
      scene: "clock",
      change: {
        set: { brightness: 2 },
        reset: ["old"],
        session: "page",
        draft: 1,
      },
    },
  ]);
});
test("adopt route: 409 not_overlay_only for a device of config.json; for a blob-only device the answer has origin config", async (t) => {
  const api = await recordedApi(t);
  let blob = false;
  api.deps.state.adoptDevice = async (/** @type {any} */ name) => {
    assert.equal(name, "pixoo-189");
    if (!blob)
      throw new HttpError(409, "not_overlay_only", "Already in config.json");
    return { ...api.device, rev: 8, origin: "config" };
  };
  const refused = await api.api("/api/v2/devices/pixoo-189/adopt", "POST", {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "not_overlay_only");
  blob = true;
  const adopted = await api.api("/api/v2/devices/pixoo-189/adopt", "POST", {});
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.origin, "config");
});
test("scene copy: the folders in the source's resources.assetDirs are linked beside the copy, and a copy of home3 loads", async (t) => {
  const api = await recordedApi(t),
    stack = await startStack(t, { mqtt: false });
  const file = resolve(REPO_ROOT, "scenes/pixoo/home3.js");
  // createApp installs the shared links before loading scenes.
  assert.equal(
    await realpath(resolve(stack.dataDir, "lib")),
    resolve(REPO_ROOT, "lib"),
  );
  assert.equal(
    await realpath(resolve(stack.dataDir, "assets")),
    resolve(REPO_ROOT, "assets"),
  );
  api.deps.scenes.get = (/** @type {any} */ key) =>
    key === "home3"
      ? {
          key,
          name: "home3",
          pretty_name: "Home 3",
          resources: {
            assetDirs: ["home3-assets"],
            stateFields: ["_boilerStatePath"],
          },
        }
      : undefined;
  api.deps.scenes.fileOf = () => file;
  api.deps.config.baseDir = () => stack.dataDir;
  /** @type {Record<string, any>} */ const raw = { scenes: {} };
  api.deps.config.update = async (/** @type {any} */ mutate) => {
    mutate(raw);
  };
  const result = await api.api("/api/v2/scenes/home3/copy", "POST", {
    targetKey: "home3-copy",
    name: "My Home",
  });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body.linkedAssetDirs, ["home3-assets"]);
  const destination = resolve(stack.dataDir, result.body.path);
  assert.equal(
    await realpath(resolve(destination, "../home3-assets")),
    await realpath(resolve(file, "../home3-assets")),
  );
  const scene = (await import(pathToFileURL(destination).href)).default;
  assert.equal(scene.name, "home3-copy");
  assert.equal(scene.pretty_name, "My Home");
  assert.equal(typeof scene.render, "function");
  const content = await readFile(destination, "utf8");
  assert.match(
    content,
    /resolve\(__dirname, "\.state", "home3-boiler.json"\)/,
    "history remains beside the new copy, never linked",
  );
  assert.equal(raw.scenes["home3-copy"].path, result.body.path);
  assert.equal(typeof scene._boilerStatePath, "string");
  assert.match(scene._boilerStatePath, /\/\.state\/home3-copy-[\w-]+-0\.json$/);
  const another = await api.api("/api/v2/scenes/home3/copy", "POST", {
    targetKey: "another-copy",
  });
  assert.equal(another.status, 201);
  const otherPath = resolve(stack.dataDir, another.body.path);
  const otherScene = (await import(pathToFileURL(otherPath).href)).default;
  assert.notEqual(otherScene._boilerStatePath, scene._boilerStatePath);
  for (const copy of [scene, otherScene]) {
    copy._boilerSave = Promise.resolve();
    copy._boilerHistory = { copy: copy.name };
    copy._boilerRevision = 0;
    await copy._saveBoilerHistory(true);
    assert.deepEqual(
      JSON.parse(await readFile(copy._boilerStatePath, "utf8")),
      { copy: copy.name },
    );
  }
  assert.match(result.body.path, /\/home3-copy-[\w-]+\.js$/);
  const legacyPath = resolve(destination, "../home3-copy.js");
  await writeFile(legacyPath, "v1 clone with overwrite:true");
  assert.equal(
    await readFile(destination, "utf8"),
    content,
    "v1's ordinary clone filename cannot overwrite the stamped v2 copy",
  );
  assert.equal(
    (
      await api.api("/api/v2/scenes/home3/copy", "POST", {
        targetKey: "home3-copy",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api.api("/api/v2/scenes/home3/copy", "POST", {
        targetKey: "../bad",
      })
    ).status,
    400,
  );
  // A module that fails to import never becomes config, and is retryable.
  const broken = resolve(stack.dataDir, "broken.js");
  await writeFile(broken, "export default {render(}");
  api.deps.scenes.fileOf = () => broken;
  api.deps.scenes.get = (/** @type {string} */ key) =>
    key === "home3"
      ? {
          name: "broken",
          resources: { assetDirs: [], stateFields: [] },
        }
      : undefined;
  const bad = await api.api("/api/v2/scenes/home3/copy", "POST", {
    targetKey: "broken-copy",
  });
  assert.equal(bad.status, 400);
  assert.equal(raw.scenes["broken-copy"], undefined);
  await writeFile(broken, 'export default {name:"fixed",render(){}};');
  const fixed = await api.api("/api/v2/scenes/home3/copy", "POST", {
    targetKey: "broken-copy",
  });
  assert.equal(
    fixed.status,
    201,
    "a failed module cache entry does not poison a retry",
  );
  const sourceText = await readFile(broken, "utf8");
  const replacement = await api.api("/api/v2/scenes/home3/copy", "POST", {
    replace: true,
  });
  assert.equal(replacement.status, 201);
  assert.equal(replacement.body.scene.key, "home3");
  assert.equal(await readFile(replacement.body.backup, "utf8"), sourceText);
  assert.equal(
    await readFile(broken, "utf8"),
    sourceText,
    "replace repoints the key and keeps the original file",
  );
});
test("GET /api/health: 200 with status degraded while a display is offline, 503 when the scheduler watchdog is overdue", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, { mqtt: false, clock });
  const { scheduler, health } = stack.app.modules;
  // A live watchdog keeps updating its timestamp. Stop only its timer to
  // model supervision failing while the HTTP server remains responsive.
  health.register("offline", {
    shadow: false,
    powerCycleMax: 0,
    plugTopic: null,
  });
  await clock.advance(120000);
  scheduler.lastWatchdogAt = new Date(clock.now()).toISOString();
  const degraded = await stack.api("/api/health");
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.status, "degraded");
  assert.ok(degraded.body.reasons.includes("display_offline:offline"));
  scheduler.timer?.cancel();
  await clock.advance(scheduler.watchdogIntervalMs * 2 + 1);
  const failed = await stack.api("/api/health");
  assert.equal(failed.status, 503);
  assert.equal(failed.body.status, "failed");
  assert.ok(failed.body.reasons.includes("watchdog_overdue"));
});
test("config: an invalid config.json keeps the last valid config running and the UI reachable, also at start", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, { mqtt: false, clock });
  const before = stack.app.modules.runtime.get();
  await writeFile(stack.configPath, "{ broken");
  const reload = await stack.api("/api/v2/config/reload", { body: {} });
  assert.equal(reload.status, 200);
  assert.equal(reload.body.valid, false);
  assert.ok(reload.body.error.message);
  assert.equal(stack.app.modules.runtime.get(), before);
  assert.equal((await stack.api("/api/v2/devices")).body.length, 2);
  assert.equal((await stack.api("/api/health")).status, 200);
  const rejected = await stack.api("/api/v2/config/raw", {
    method: "PUT",
    body: { text: "{ broken" },
  });
  assert.equal(rejected.status, 400);
  assert.equal(await readFile(stack.configPath, "utf8"), "{ broken");
  const invalid = await startStack(t, {
    mqtt: false,
    clock,
    configText: "{ broken",
  });
  assert.equal(
    (await invalid.api("/api/v2/config/raw")).body.state.valid,
    false,
  );
  assert.deepEqual((await invalid.api("/api/v2/devices")).body, []);
  const repaired = await invalid.api("/api/v2/config/raw", {
    method: "PUT",
    body: { text: '{"devices":[],"scenes":{}}' },
  });
  assert.equal(repaired.status, 200);
  assert.equal(repaired.body.state.valid, true);
  assert.ok((await invalid.api("/api/health")).body.restartRequired);
});

// --- Ordering (knowledge entry, section 3.0) ---
test("position: the X-Pixdcon-Position of a write's answer is not lower than the seq of the live events the write caused, and never later than the last event published before its body was built", async (t) => {
  const api = await recordedApi(t);
  api.deps.state.retry = async () => {
    api.deps.state.emit("device", { ...api.device, rev: 8 });
    return { ...api.device, rev: 8 };
  };
  const events = await stream(t, `${api.base}/api/v2/events`);
  await events.next();
  const result = await api.api("/api/v2/devices/pixoo-189/retry", "POST", {});
  const event = await events.next();
  assert.equal(event.id, "abcd1234-1");
  assert.equal(result.headers.get("x-pixdcon-position"), event.id);
  assert.equal(result.body.rev, event.data.rev);
});
test("live channel sessions: a page that reconnects opens its new stream before the old one closes; the session is reported gone only when its last stream closed", async (t) => {
  const api = await recordedApi(t);
  const old = await stream(t, `${api.base}/api/v2/events?session=page`);
  await old.next();
  const newer = await stream(t, `${api.base}/api/v2/events?session=page`);
  await newer.next();
  assert.deepEqual(api.sessions, [["page", true]]);
  old.abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(api.sessions, [["page", true]]);
  assert.equal(api.live.status().sessions.length, 1);
  api.live.stop();
  assert.deepEqual(api.sessions, [
    ["page", true],
    ["page", false],
  ]);
  assert.deepEqual(api.live.status(), { clients: 0, sessions: [] });
  assert.equal(api.clock.pending(), 0);
});
test("requests in order: two writes for one device are applied in the order they arrived and each answers with its own applied view; writes for two devices do not wait for each other", async (t) => {
  const api = await recordedApi(t);
  const entered = deferred(),
    release = deferred();
  /** @type {string[]} */ const seen = [];
  api.deps.state.setMode = async (
    /** @type {any} */ name,
    /** @type {any} */ mode,
  ) => {
    seen.push(`${name}:${mode}`);
    if (mode === "pause") {
      entered.resolve();
      await release.promise;
    }
    return {
      ...api.device,
      name,
      rev: mode === "pause" ? 8 : 9,
      applied: mode,
    };
  };
  const first = api.api("/api/v2/devices/pixoo-189/mode", "PUT", {
    mode: "pause",
  });
  await entered.promise;
  const second = api.api("/api/v2/devices/pixoo-189/mode", "PUT", {
    mode: "play",
  });
  const other = await api.api("/api/v2/devices/other/mode", "PUT", {
    mode: "stop",
  });
  assert.equal(other.status, 200);
  assert.deepEqual(seen, ["pixoo-189:pause", "other:stop"]);
  release.resolve();
  assert.deepEqual(
    [(await first).body.applied, (await second).body.applied],
    ["pause", "play"],
  );
  assert.deepEqual(seen, ["pixoo-189:pause", "other:stop", "pixoo-189:play"]);
  // Failure does not poison the lane.
  api.deps.state.setMode = async () => {
    throw new HttpError(503, "mqtt_offline", "Offline");
  };
  assert.equal(
    (await api.api("/api/v2/devices/pixoo-189/mode", "PUT", { mode: "play" }))
      .status,
    503,
  );
  api.deps.state.setMode = async () => api.device;
  assert.equal(
    (await api.api("/api/v2/devices/pixoo-189/mode", "PUT", { mode: "play" }))
      .status,
    200,
  );
});

/** Recorded W1 views; API/SSE tests do not implement or modify the state store.
 * @param {import("node:test").TestContext} t
 * @param {{epoch?: string, ringSize?: number}} [options]
 */
async function recordedApi(t, options = {}) {
  const epoch = options.epoch ?? "abcd1234";
  const clock = manualClock();
  const logger = createLogger({ level: "error", sink: { out() {}, err() {} } });
  const device = {
    name: "pixoo-189",
    epoch,
    incarnation: 1,
    rev: 7,
    origin: "config",
    type: "pixoo",
    comment: "",
    desired: {
      scene: { scene: "funkeykid", source: "config" },
      mode: { value: "play" },
      brightness: { override: null },
    },
    effective: { scene: "funkeykid", frameCount: 100, lastBrightness: 25 },
    health: {
      state: "online",
      lastFrameAt: new Date(clock.now() - 250).toISOString(),
      consecutiveErrors: 0,
      apSsid: null,
    },
    runtime: { address: "127.0.0.1:189" },
  };
  const overlay = {
    id: "device-scene:pixoo-189",
    confirmed: false,
    inEffect: false,
  };
  /** @type {Array<[string, boolean]>} */
  const sessions = [];
  const snapshot = () => ({
    devices: [device],
    overlays: [overlay],
    scenes: [],
    builtins: { ulanzi: [], pixoo: [] },
    controller: { epoch },
    mqtt: { state: "disabled" },
    config: { valid: true },
  });
  const live = new LiveChannel({
    epoch,
    clock,
    logger,
    ringSize: options.ringSize,
    snapshot: /** @type {any} */ (snapshot),
    onSession: (id, connected) => sessions.push([id, connected]),
  });
  const state = Object.assign(new EventEmitter(), {
    views: () => [device],
    view: (/** @type {string} */ name) => {
      if (name !== device.name)
        throw new HttpError(404, "unknown_device", "Unknown device");
      return structuredClone(device);
    },
    get: () => device,
    list: () => [device],
    runningConfigV1: () => ({
      devices: [
        {
          name: device.name,
          type: "pixoo",
          ip: "127.0.0.1",
          scene: "funkeykid",
        },
      ],
      scenes: {},
    }),
  });
  const deps = /** @type {any} */ ({
    epoch,
    clock,
    logger,
    live,
    state,
    controller: () => ({
      epoch,
      status: "ok",
      version: "202611170357.0.0",
      version_scheme: "inspr-calver-3",
    }),
    builtinModes: { ulanzi: [], pixoo: [] },
    ownership: { status: () => ({ known: true, devices: [] }) },
    scheduler: { status: () => ({ loopsAlive: 1 }) },
    overlays: Object.assign(new EventEmitter(), { list: () => [overlay] }),
    scenes: Object.assign(new EventEmitter(), { list: () => [] }),
    config: Object.assign(new EventEmitter(), {
      file: () => ({ valid: true }),
      get: () => state.runningConfigV1(),
      readRaw: async () => ({ text: "{}", state: { valid: true } }),
    }),
    previews: new EventEmitter(),
    settings: new EventEmitter(),
    mqtt: null,
  });
  const server = new HttpServer({
    port: 0,
    host: "127.0.0.1",
    webRoot: resolve("web"),
    logger,
    position: () => `${epoch}-${live.seq()}`,
  });
  registerV1Routes(server, deps);
  registerV2Routes(server, deps);
  const unwire = wireLiveChannel(live, deps);
  t.after(async () => {
    unwire();
    live.stop();
    await server.stop();
  });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  /** @param {string} path @param {string} [method] @param {unknown} [body] */
  const api = async (path, method = "GET", body = undefined) => {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: data ? JSON.parse(data) : null,
    };
  };
  return { base, deps, live, device, sessions, clock, server, api };
}

/** @param {import("node:test").TestContext} t @param {string} url */
async function stream(t, url) {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(url, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream/,
  );
  const reader = /** @type {ReadableStream<Uint8Array>} */ (
    response.body
  ).getReader();
  let buffer = "";
  return {
    abort,
    async next() {
      while (!buffer.includes("\n\n")) {
        const { value, done } = await reader.read();
        assert.equal(done, false, "stream has another event");
        buffer += Buffer.from(value ?? []).toString();
      }
      const end = buffer.indexOf("\n\n");
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const fields = Object.fromEntries(
        raw.split("\n").map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon), line.slice(colon + 2)];
        }),
      );
      return {
        id: fields.id,
        type: fields.event,
        data: JSON.parse(fields.data),
      };
    },
  };
}

function deferred() {
  /** @type {() => void} */ let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

test("v2 routes: overlays preserve confirmed; raw config, settings and preview bytes keep their shapes", async (t) => {
  const api = await recordedApi(t);
  api.deps.settings.state = () => ({ epoch: "abcd1234", rev: 3, values: {} });
  api.deps.settings.endPreview = () => [api.deps.settings.state()];
  api.deps.overlays.clearSettings = async () => ({
    cleared: ["x"],
    failed: [],
  });
  api.deps.overlays.clear = async () => ({ confirmed: false, pending: true });
  api.deps.config.replaceRaw = async (/** @type {any} */ text) => {
    assert.equal(text, "{}");
    return { diff: { devicesChanged: {} } };
  };
  api.deps.config.reload = async () => ({ valid: true });
  api.deps.config.addDevice = async () => {};
  api.deps.config.updateDevice = async (
    /** @type {any} */ _name,
    /** @type {any} */ mutate,
  ) => {
    const raw = { preview: { pollMs: 2000 } };
    mutate(raw);
    assert.deepEqual(raw, {
      preview: { pollMs: 2000, showGrid: true },
      comment: "TV",
    });
  };
  for (const path of [
    "/api/v2/scenes",
    "/api/v2/status",
    "/api/v2/config/raw",
    "/api/v2/devices/pixoo-189/settings/clock",
    "/api/v2/log?level=warn",
  ])
    assert.equal((await api.api(path)).status, 200, path);
  assert.equal((await api.api("/api/v2/overlays")).body[0].confirmed, false);
  assert.deepEqual((await api.api("/api/v2/overlays/id", "DELETE")).body, {
    confirmed: false,
    pending: true,
    overlays: api.deps.overlays.list(),
  });
  assert.deepEqual(
    (await api.api("/api/v2/config/raw", "PUT", { text: "{}" })).body,
    { state: { valid: true }, diff: { devicesChanged: {} } },
  );
  assert.equal(
    (await api.api("/api/v2/config/reload", "POST", {})).status,
    200,
  );
  assert.equal(
    (
      await api.api("/api/v2/devices", "POST", {
        name: "new",
        type: "ulanzi",
        ip: "127.0.0.1",
      })
    ).status,
    404,
    "view after add is authoritative; a missing applied view is never invented",
  );
  assert.equal(
    (
      await api.api("/api/v2/devices/pixoo-189", "PATCH", {
        comment: "TV",
        preview: { showGrid: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api.api(
        "/api/v2/devices/pixoo-189/settings/clock/preview?session=page",
        "DELETE",
      )
    ).body.rev,
    3,
  );
  assert.equal(
    (await api.api("/api/v2/preview-sessions/page/end", "POST", {})).body.ended,
    1,
  );
  assert.deepEqual(
    (
      await api.api(
        "/api/v2/devices/pixoo-189/settings/clock/overlays",
        "DELETE",
      )
    ).body,
    {
      state: { epoch: "abcd1234", rev: 3, values: {} },
      cleared: ["x"],
      failed: [],
    },
  );
  api.deps.previews.get = () => undefined;
  assert.equal(
    (await fetch(`${api.base}/api/v2/devices/pixoo-189/preview`)).status,
    204,
  );
  api.deps.previews.get = () => ({
    width: 1,
    height: 1,
    rgb: Uint8Array.of(1, 2, 3),
    source: "runtime",
    receivedAt: "now",
    seq: 2,
  });
  const response = await fetch(`${api.base}/api/v2/devices/pixoo-189/preview`);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.from([1, 2, 3]),
  );
  assert.equal(response.headers.get("x-frame-width"), "1");
  assert.equal(
    (
      await fetch(`${api.base}/api/v2/devices/pixoo-189/preview`, {
        headers: { "If-None-Match": String(response.headers.get("etag")) },
      })
    ).status,
    304,
  );
});

test("HTTP boundaries: HEAD, static ETag, malformed paths, invalid JSON, oversized bodies and JSON errors", async (t) => {
  const api = await recordedApi(t);
  api.server.route("POST", "/api/_echo", async (ctx) => await ctx.body());
  api.server.route("GET", "/api/_circular", () => {
    const value = { self: /** @type {any} */ (null) };
    value.self = value;
    return value;
  });
  const head = await fetch(`${api.base}/api/v2/devices`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("x-pixdcon-position"), "abcd1234-0");
  const staticGet = await fetch(api.base + "/");
  const etag = staticGet.headers.get("etag");
  assert.ok(etag);
  await staticGet.text();
  const staticHead = await fetch(api.base + "/", { method: "HEAD" });
  assert.equal(staticHead.status, 200);
  assert.equal(staticHead.headers.get("etag"), etag);
  assert.equal(await staticHead.text(), "");
  assert.equal(
    (await fetch(api.base + "/", { headers: { "If-None-Match": `W/${etag}` } }))
      .status,
    304,
  );
  assert.equal(
    (await fetch(api.base + "/api/v2/events?session=head", { method: "HEAD" }))
      .status,
    200,
  );
  assert.deepEqual(api.live.status(), { clients: 0, sessions: [] });
  assert.equal((await fetch(api.base + "/api/v2/devices/%ZZ")).status, 400);
  for (const [body, expected] of [
    ["{", 400],
    ["[]", 400],
    [`{"x":"${"a".repeat(1024 * 1024)}"}`, 413],
  ]) {
    const response = await fetch(api.base + "/api/_echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: String(body),
    });
    assert.equal(response.status, expected);
    assert.match(String(response.headers.get("x-request-id")), /^\d+$/);
  }
  const wrong = await fetch(api.base + "/api/v2/overlays/id", {
    method: "DELETE",
  });
  assert.equal(wrong.status, 415);
  const wrongType = await fetch(api.base + "/api/_echo", {
    method: "POST",
    headers: { "Content-Type": "application/json-patch" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  const circular = await api.api("/api/_circular");
  assert.equal(circular.status, 500);
  assert.equal(circular.body.code, "internal");
});

test("HTTP bind retry: port conflicts retry after 30 s; stop cancels the wait and removes its timer", async (t) => {
  const clock = manualClock();
  const logger = createLogger({ level: "error", sink: { out() {}, err() {} } });
  const first = new HttpServer({
    port: 0,
    host: "127.0.0.1",
    clock,
    logger,
    webRoot: resolve("web"),
  });
  const { port } = await first.start();
  const retry = new HttpServer({
    port,
    host: "127.0.0.1",
    clock,
    logger,
    webRoot: resolve("web"),
  });
  t.after(async () => {
    await first.stop();
    await retry.stop();
  });
  const starting = retry.start();
  for (let i = 0; i < 50 && !clock.pending(); i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.pending(), 1);
  await first.stop();
  await clock.advance(29999);
  assert.equal(retry.server?.listening, false);
  await clock.advance(1);
  assert.equal((await starting).port, port);
  const cancelled = new HttpServer({
    port,
    host: "127.0.0.1",
    clock,
    logger,
    webRoot: resolve("web"),
  });
  const cancelledStart = assert.rejects(
    cancelled.start(),
    (error) => error instanceof HttpError && error.code === "shutting_down",
  );
  for (let i = 0; i < 50 && !clock.pending(); i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.pending(), 1);
  await cancelled.stop();
  await cancelledStart;
  assert.equal(clock.pending(), 0);
});

test("live channel: a large snapshot drains before the next event; previews throttle per device and logs are opt-in", async (t) => {
  const api = await recordedApi(t);
  api.device.comment = "x".repeat(128 * 1024);
  const normal = await stream(t, `${api.base}/api/v2/events`);
  assert.equal(
    (await normal.next()).data.devices[0].comment.length,
    128 * 1024,
  );
  const logs = await stream(t, `${api.base}/api/v2/events?log=1`);
  await logs.next();
  api.deps.logger.error("one log line");
  assert.equal((await logs.next()).type, "log");
  const frame = {
    device: "pixoo-189",
    width: 1,
    height: 1,
    rgb: Uint8Array.of(1, 2, 3),
    seq: 1,
    source: "runtime",
    receivedAt: "first",
  };
  api.deps.previews.emit("frame", frame);
  api.deps.previews.emit("frame", { ...frame, seq: 2 });
  assert.equal((await normal.next()).data.frameSeq, 1);
  assert.equal((await logs.next()).type, "preview");
  assert.equal(
    api.live.seq(),
    2,
    "one log and one frame; second frame waits for the throttle",
  );
  api.deps.previews.emit("frame", { ...frame, seq: 3, receivedAt: "trailing" });
  await api.clock.advance(1000);
  assert.equal(
    api.live.seq(),
    3,
    "the trailing preview is published when its deadline expires",
  );
  const trailing = await normal.next();
  assert.equal(trailing.data.frameSeq, 3);
  assert.equal(trailing.data.receivedAt, "trailing");
  await api.clock.advance(1000);
  assert.equal(
    api.live.seq(),
    3,
    "a quiet burst sends its last frame exactly once",
  );
});

test("v1 compatibility edges: missing scene clears; settings replace valid schema keys; mode arrays are refused", async (t) => {
  const api = await recordedApi(t);
  /** @type {unknown[]} */ const scenes = [];
  api.deps.state.chooseScene = async (
    /** @type {string} */ _name,
    /** @type {string|null} */ scene,
  ) => {
    scenes.push(scene);
    return { view: api.device, persisted: true, notSavedReason: null };
  };
  assert.deepEqual(
    (await api.api("/api/scene", "POST", { deviceName: "pixoo-189" })).body,
    { ok: true },
  );
  assert.deepEqual(scenes, [null]);
  api.deps.settings.state = () => ({
    schema: { good: {}, bad: {}, old: {} },
    values: { old: { saved: 1 }, bad: { saved: 7 } },
  });
  /** @type {any[]} */ const saves = [];
  api.deps.settings.save = async (
    /** @type {string} */ _device,
    /** @type {string} */ _scene,
    /** @type {any} */ change,
  ) => {
    saves.push(change);
    return saves.length === 1
      ? { state: { values: {} }, rejected: { bad: "invalid" } }
      : { state: { values: { good: { saved: 3 } } }, rejected: {} };
  };
  const result = await api.api("/api/scene-settings/save", "POST", {
    deviceName: "pixoo-189",
    sceneName: "clock",
    values: { good: 2, bad: "invalid", unknown: 9 },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, saved: { good: 3 } });
  assert.deepEqual(saves, [
    { set: { good: 2, bad: "invalid" }, reset: ["old"] },
    { set: { good: 2 }, reset: ["old", "bad"] },
  ]);
  for (const [path, body] of [
    ["/api/mode", { deviceName: "pixoo-189", mode: ["play"] }],
    ["/api/v2/devices/pixoo-189/mode", { mode: ["play"] }],
  ]) {
    const response = await api.api(
      String(path),
      path === "/api/mode" ? "POST" : "PUT",
      body,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "invalid_mode");
  }
});

test("v1 clone: unsafe source keys are rejected before registry or filesystem access", async (t) => {
  const api = await recordedApi(t);
  let accesses = 0;
  api.deps.scenes.get = api.deps.scenes.fileOf = () => {
    accesses++;
    throw new Error("source access before validation");
  };
  for (const sceneName of [
    "../escape",
    "folder/../../escape",
    "..",
    "__proto__",
    "constructor",
  ]) {
    const result = await api.api("/api/scene/clone", "POST", {
      sceneName,
      targetSceneKey: "copy",
    });
    assert.equal(result.status, 400, sceneName);
    assert.equal(result.body.code, "invalid_field");
  }
  assert.equal(accesses, 0);
});

test("settings overlay routes: shadow devices return 409 before publishing or clearing", async (t) => {
  const api = await recordedApi(t);
  Object.assign(api.device.desired, { output: "shadow" });
  api.deps.settings.state = () => ({});
  let calls = 0;
  api.deps.overlays.publishSettings = api.deps.overlays.clearSettings = () => {
    calls++;
    return { failed: [], rejected: [] };
  };
  for (const [method, path, body] of [
    ["DELETE", "/api/v2/devices/pixoo-189/settings/clock/overlays", undefined],
    [
      "POST",
      "/api/scene-settings/overlay/clear",
      { deviceName: "pixoo-189", sceneName: "clock" },
    ],
    [
      "POST",
      "/api/scene-settings/overlay",
      { deviceName: "pixoo-189", sceneName: "clock", values: {} },
    ],
  ]) {
    const result = await api.api(String(path), String(method), body);
    assert.equal(result.status, 409, String(path));
    assert.equal(result.body.code, "shadow_output");
  }
  assert.equal(calls, 0);
});

test("v1 overlay: omitted scene publishes the empty retained overlay via the clear command", async (t) => {
  const api = await recordedApi(t);
  const calls = /** @type {unknown[]} */ ([]);
  api.deps.overlays.publishSceneOverlay = async (
    /** @type {string} */ name,
    /** @type {string|null} */ scene,
  ) => {
    calls.push([name, scene]);
    return { confirmed: true };
  };
  for (const scene of [undefined, null, ""]) {
    const result = await api.api("/api/overlay", "POST", {
      deviceName: "pixoo-189",
      ...(scene === undefined ? {} : { scene }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
  }
  assert.deepEqual(
    calls,
    Array.from({ length: 3 }, () => ["pixoo-189", null]),
  );
  assert.equal(
    (
      await api.api("/api/overlay", "POST", {
        deviceName: "pixoo-189",
        scene: 42,
      })
    ).status,
    400,
  );
});

test("v1 device save: scene and editable fields commit in one atomic store write", async (t) => {
  const api = await recordedApi(t);
  let saved = {
    name: "pixoo-189",
    ip: "127.0.0.1",
    enabled: true,
    scene: "clock",
    preview: { pollMs: 1000, showGrid: true },
  };
  let writes = 0;
  const sceneCommands = /** @type {unknown[]} */ ([]);
  api.deps.config.get = () => ({ devices: [saved] });
  api.deps.config.updateDevice = async (
    /** @type {string} */ name,
    /** @type {(device: any) => void} */ mutate,
  ) => {
    assert.equal(name, saved.name);
    const next = structuredClone(saved);
    mutate(next);
    writes++;
    saved = next;
  };
  api.deps.scenes.check = () => null;
  api.deps.state.chooseScene = async (
    /** @type {string} */ _name,
    /** @type {string} */ scene,
  ) => {
    sceneCommands.push(scene);
  };
  const patch = {
    ip: "127.0.0.2",
    enabled: false,
    scene: "radio",
    preview: { pollMs: 2000 },
  };
  const result = await api.api("/api/device/save", "POST", {
    deviceName: saved.name,
    patch,
  });
  assert.equal(result.status, 200);
  assert.equal(writes, 1);
  assert.deepEqual(
    sceneCommands,
    [],
    "the route must not make a second scene persistence write",
  );
  assert.equal(saved.scene, "radio");
  assert.deepEqual(result.body, {
    ok: true,
    device: { ...saved, ...patch, preview: { pollMs: 2000, showGrid: true } },
  });
  api.deps.scenes.check = () => "unknown scene";
  const rejected = await api.api("/api/device/save", "POST", {
    deviceName: saved.name,
    patch: { scene: "missing" },
  });
  assert.equal(rejected.status, 400);
  assert.equal(
    writes,
    1,
    "validation failure changes no part of the saved device",
  );
});

test("blob not writer: DELETE /api/v2/overlays/blob preserves 409 and controller writer reasons without publishing", async (t) => {
  const api = await recordedApi(t);
  let published = 0;
  api.deps.mqtt = { publish() { published++; }, status: () => ({ state: "connected" }) };
  for (const reason of ["v1_writes", "force_shadow"]) {
    const writer = { writer: false, reason };
    api.deps.controller = () => ({ blobWriter: writer });
    api.deps.ownership.status = () => ({ transition: true, known: true, connection: 3, devices: [] });
    // The overlay service owns the policy; the route must preserve its error.
    api.deps.overlays.clear = async () => { throw new HttpError(409, "blob_not_writer", "This instance does not write the config overlay"); };
    const result = await api.api("/api/v2/overlays/blob", "DELETE");
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "blob_not_writer");
    const status = (await api.api("/api/v2/status")).body;
    assert.deepEqual(status.controller.blobWriter, writer);
    assert.equal(status.v1.connection, 3);
  }
  assert.equal(published, 0);
});

test("incarnation: recorded DeviceView and SettingsState lives pass through snapshots, removal, events and answers unchanged", async (t) => {
  const api = await recordedApi(t);
  Object.assign(api.device, { incarnation: 4, rev: 20 });
  const settings = () => ({ epoch: api.device.epoch, incarnation: api.device.incarnation, rev: api.device.rev, device: api.device.name, scene: "clock", values: {} });
  api.deps.settings.state = settings;
  const snapshot = api.live.deps.snapshot;
  api.live.deps.snapshot = () => ({ ...snapshot(), incarnations: api.device.incarnation });
  const events = await stream(t, `${api.base}/api/v2/events`);
  const first = await events.next();
  assert.equal(first.data.incarnations, 4);
  assert.equal(first.data.devices[0].incarnation, 4);
  for (const incarnation of [4, 5]) {
    if (incarnation === 5) {
      api.deps.state.emit("device-removed", { name: api.device.name, incarnation: 4 });
      const removed = await events.next();
      assert.deepEqual(removed.data, { name: api.device.name, incarnation: 4 });
      // W1 supplies lifecycle numbers; this transport must not reinterpret them.
      Object.assign(api.device, { incarnation, rev: 1 });
      api.deps.state.emit("device-added", structuredClone(api.device));
      const added = await events.next();
      assert.equal(added.data.incarnation, 5);
      assert.equal(added.data.rev, 1);
    }
    assert.equal((await api.api(`/api/v2/devices/${api.device.name}`)).body.incarnation, incarnation);
    const answer = (await api.api(`/api/v2/devices/${api.device.name}/settings/clock`)).body;
    assert.equal(answer.incarnation, incarnation);
    api.deps.settings.emit("settings", settings());
    assert.deepEqual((await events.next()).data, answer);
    const boot = (await api.api("/api/v2/bootstrap")).body;
    assert.equal(boot.incarnations, incarnation);
    assert.equal(boot.devices[0].incarnation, incarnation);
  }
});

test("overlay records after a reconnect: confirmed, inEffect and restricts pass through list, snapshot and events for every kind", async (t) => {
  const api = await recordedApi(t);
  const records = ["blob", "device-scene", "scene-path", "device-ip", "device-enabled", "setting", "mode", "brightness"].map((kind) => ({ id: kind, kind, confirmed: false, inEffect: false, restricts: kind === "device-ip" ? "held" : kind === "device-enabled" ? "off" : null }));
  api.deps.overlays.list = () => structuredClone(records);
  const snapshot = api.live.deps.snapshot;
  api.live.deps.snapshot = () => ({ ...snapshot(), overlays: api.deps.overlays.list() });
  const events = await stream(t, `${api.base}/api/v2/events`);
  assert.deepEqual((await events.next()).data.overlays, records);
  assert.deepEqual((await api.api("/api/v2/overlays")).body, records);
  records[0].confirmed = records[0].inEffect = true;
  api.deps.overlays.emit("changed", { keys: ["blob"] });
  assert.deepEqual((await events.next()).data, records);
  assert.equal((await api.api("/api/v2/bootstrap")).body.overlays[1].confirmed, false);
});

test("integrated device lives: raw config removal and return reach HTTP, snapshots, device events and settings with a fresh incarnation at rev 1", async (t) => {
  const stack = await startStack(t, {
    mqtt: false,
    clock: manualClock(),
    config: (raw) =>
      raw.devices.forEach((/** @type {any} */ device) => {
        device.enabled = false;
      }),
  });
  const name = "ulanzi-t";
  const events = await stream(t, `${stack.base}/api/v2/events`);
  const initial = await events.next();
  assert.equal(initial.type, "snapshot");
  const old = initial.data.devices.find(
    (/** @type {any} */ device) => device.name === name,
  );
  assert.equal(old.rev, 1);
  const oldSettings = (
    await stack.api(`/api/v2/devices/${name}/settings/clock`)
  ).body;
  assert.equal(oldSettings.incarnation, old.incarnation);
  const raw = JSON.parse(await readFile(stack.configPath, "utf8"));
  const original = raw.devices;
  raw.devices = original.filter(
    (/** @type {any} */ device) => device.name !== name,
  );
  assert.equal(
    (
      await stack.api("/api/v2/config/raw", {
        method: "PUT",
        body: { text: JSON.stringify(raw) },
      })
    ).status,
    200,
  );
  let event = await events.next();
  while (event.type !== "device-removed") event = await events.next();
  assert.deepEqual(event.data, { name, incarnation: old.incarnation });
  assert.equal((await stack.api(`/api/v2/devices/${name}`)).status, 404);
  assert.equal(
    (await stack.api(`/api/v2/devices/${name}/settings/clock`)).status,
    404,
  );
  raw.devices = original;
  assert.equal(
    (
      await stack.api("/api/v2/config/raw", {
        method: "PUT",
        body: { text: JSON.stringify(raw) },
      })
    ).status,
    200,
  );
  do {
    event = await events.next();
  } while (event.type !== "device" || event.data.name !== name);
  const fresh = (await stack.api(`/api/v2/devices/${name}`)).body;
  assert.ok(fresh.incarnation > old.incarnation);
  assert.equal(fresh.rev, 1);
  assert.equal(event.data.incarnation, fresh.incarnation);
  assert.equal(event.data.rev, 1);
  const boot = (await stack.api("/api/v2/bootstrap")).body;
  assert.equal(boot.incarnations, fresh.incarnation);
  assert.deepEqual(
    boot.devices.find((/** @type {any} */ device) => device.name === name),
    fresh,
  );
  const freshSettings = (
    await stack.api(`/api/v2/devices/${name}/settings/clock`)
  ).body;
  assert.equal(freshSettings.incarnation, fresh.incarnation);
  assert.equal(freshSettings.rev, 1);
  const answer = await stack.api(`/api/v2/devices/${name}/mode`, {
    method: "PUT",
    body: { mode: "pause" },
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.incarnation, fresh.incarnation);
  assert.ok(answer.body.rev > fresh.rev);
  const preview = await stack.api(
    `/api/v2/devices/${name}/settings/clock/preview`,
    {
      method: "PUT",
      body: { session: "life-test", draft: 1, values: { refresh_ms: 2000 } },
    },
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.state.incarnation, fresh.incarnation);
  do {
    event = await events.next();
  } while (
    event.type !== "settings" ||
    event.data.rev !== preview.body.state.rev
  );
  assert.equal(event.data.incarnation, fresh.incarnation);
  assert.equal(event.data.values.refresh_ms.effective, 2000);
});

test("integrated writer policy: HTTP rejects blob clears with the actual v1_writes and force_shadow decisions and publishes nothing", async (t) => {
  for (const reason of ["v1_writes", "force_shadow"]) {
    const clock = manualClock();
    const stack = await startStack(t, {
      clock,
      env: { PIXDCON2_FORCE_SHADOW: reason === "force_shadow" ? "1" : "0" },
      config: (raw) => {
        if (reason === "v1_writes")
          raw.mqtt = { statusBaseTopic: "separate/status" };
      },
    });
    await stack.broker.inject(stack.app.topics.overlayBlob, '{"devices":[]}', {
      retain: true,
    });
    await waitFor(() => stack.app.modules.overlays.get("blob")?.confirmed);
    await clock.advance(300);
    assert.deepEqual(
      (await stack.api("/api/v2/status")).body.controller.blobWriter,
      { writer: false, reason },
    );
    const before = stack.broker
      .published()
      .filter((entry) => entry.topic === stack.app.topics.overlayBlob).length;
    const answer = await stack.api("/api/v2/overlays/blob", {
      method: "DELETE",
      body: {},
    });
    assert.equal(answer.status, 409);
    assert.equal(answer.body.code, "blob_not_writer");
    assert.equal(
      stack.broker
        .published()
        .filter((entry) => entry.topic === stack.app.topics.overlayBlob).length,
      before,
    );
  }
});

test("integrated broker reconfirmation: HTTP and SSE expose the same standing for every real overlay kind before and after held replay", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, {
    clock,
    config: (raw) => {
      raw.devices = [{ ...raw.devices[1], enabled: false }];
    },
  });
  const { mqtt, overlays, state, settings } = stack.app.modules;
  assert.ok(mqtt);
  const topics = stack.app.topics,
    name = "ulanzi-t";
  const sceneFile = stack.app.modules.scenes.fileOf("clock");
  assert.ok(sceneFile);
  for (const [topic, value] of [
    [topics.overlayBlob, '{"devices":[]}'],
    [topics.overlayDeviceScene(name), "test-pattern"],
    [topics.overlayScenePath("clock"), sceneFile],
    [topics.overlayDeviceIp(name), stack.awtrix.address],
    [topics.overlayDeviceEnabled(name), "false"],
    [topics.setting(name, "clock", "refresh_ms"), "2444"],
    [topics.mode(name), "pause"],
    [topics.brightnessOverride(name), "35"],
  ])
    await stack.broker.inject(topic, value, { retain: true });
  await waitFor(() => overlays.list().length === 8);
  await clock.advance(300);
  await stack.app.modules.registryLane.drain();
  assert.ok(
    (await stack.api("/api/v2/overlays")).body.every(
      (/** @type {any} */ record) => record.confirmed,
    ),
  );
  const release = stack.broker.holdRetained();
  stack.cleanup.add("HTTP held replay", release);
  await stack.broker.dropClients();
  await waitFor(() => mqtt.status().state === "offline");
  await clock.advance(5000);
  await waitFor(() => mqtt.status().connection === 2);
  await mqtt.settle();
  await clock.advance(300);
  const waiting = (await stack.api("/api/v2/overlays")).body;
  assert.equal(waiting.length, 8);
  assert.ok(
    waiting.every(
      (/** @type {any} */ record) =>
        record.confirmed === false && record.inEffect === false,
    ),
  );
  assert.equal(
    waiting.find((/** @type {any} */ record) => record.kind === "device-ip")
      .restricts,
    "held",
  );
  assert.equal(
    waiting.find(
      (/** @type {any} */ record) => record.kind === "device-enabled",
    ).restricts,
    "off",
  );
  const events = await stream(t, `${stack.base}/api/v2/events`);
  assert.deepEqual((await events.next()).data.overlays, waiting);
  release();
  await waitFor(() => overlays.list().every((record) => record.confirmed));
  await clock.advance(300);
  const confirmed = (await stack.api("/api/v2/overlays")).body;
  assert.ok(
    confirmed.every(
      (/** @type {any} */ record) =>
        record.confirmed && record.connection === 2,
    ),
  );
  let event = await events.next();
  while (event.type !== "overlays") event = await events.next();
  assert.deepEqual(event.data, confirmed);
  assert.deepEqual(
    (await stack.api("/api/v2/bootstrap")).body.overlays,
    confirmed,
  );
  assert.equal(state.view(name).desired.mode.value, "pause");
  assert.equal(state.view(name).desired.brightness.override, 35);
  assert.equal(settings.state(name, "clock").values.refresh_ms.effective, 2444);
});

test("position: config raw and reload capture their body's position inside the saved-state lane", async (t) => {
  const stack = await startStack(t, { mqtt: false, clock: manualClock() });
  const { config, live } = stack.app.modules;
  for (const path of ["/api/v2/config/raw", "/api/v2/config/reload"]) {
    let captured = "";
    const original = config.enqueue.bind(config);
    const read = config.read.bind(config);
    const afterBody = (/** @type {any} */ answer) => {
      captured = `${stack.app.epoch}-${live.seq()}`;
      // New state reaches the channel after the body exists, before the
      // config method and HTTP handler return. It cannot date the old body.
      live.publish("config", config.file());
      return answer;
    };
    const mock = path.endsWith("raw")
      ? t.mock.method(
          config,
          "enqueue",
          async (/** @type {() => Promise<any>} */ work) =>
            afterBody(await original(work)),
        )
      : t.mock.method(
          config,
          "read",
          async (
            /** @type {"file"|"startup"} */ origin,
            /** @type {any} */ capture,
          ) => afterBody(await read(origin, capture)),
        );
    const response = await fetch(
      `${stack.base}${path}`,
      path.endsWith("reload")
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }
        : {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-pixdcon-position"), captured);
    const body = /** @type {any} */ (await response.json());
    assert.equal(path.endsWith("raw") ? body.state.valid : body.valid, true);
    assert.notEqual(captured, `${stack.app.epoch}-${live.seq()}`);
    mock.mock.restore();
  }
});

test("position: controller health is stamped where its body is built", async (t) => {
  const stack = await startStack(t, { mqtt: false, clock: manualClock() });
  const { live } = stack.app.modules;
  const route = stack.app.server.table.find(
    (route) => route.path === "/api/health",
  );
  assert.ok(route);
  const original = route.handler;
  let captured = "";
  route.handler = async (ctx) => {
    const answer = await original(ctx);
    captured = `${stack.app.epoch}-${live.seq()}`;
    live.publish("config", stack.app.modules.config.file());
    return answer;
  };
  const response = await fetch(`${stack.base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-pixdcon-position"), captured);
  assert.equal(/** @type {any} */ (await response.json()).measured, true);
});

test("position: a delayed handler's explicit body position wins over newer events, including position zero", async (t) => {
  const api = await recordedApi(t);
  const gate = deferred(), built = deferred();
  api.server.route("GET", "/api/_position", async () => {
    const answer = api.server.answer({ value: "old" });
    built.resolve();
    await gate.promise;
    return answer;
  });
  const pending = api.api("/api/_position");
  await built.promise;
  api.live.publish("scenes", []);
  gate.resolve();
  assert.equal((await pending).headers.get("x-pixdcon-position"), "abcd1234-0");
  // Exercise the actual whole-resource route at the microtask boundary too.
  const route = api.server.table.find((route) => route.path === "/api/v2/overlays");
  assert.ok(route);
  const handler = route.handler;
  route.handler = async (ctx) => {
    const answer = handler(ctx);
    api.live.publish("overlays", [{ id: "new" }]);
    await Promise.resolve();
    return answer;
  };
  assert.equal((await api.api("/api/v2/overlays")).headers.get("x-pixdcon-position"), "abcd1234-1");
  api.server.route("GET", "/api/_fallback", () => ({ value: "current" }));
  assert.equal((await api.api("/api/_fallback")).headers.get("x-pixdcon-position"), "abcd1234-2");
});
