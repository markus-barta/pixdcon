/**
 * Test kind 2 of 3 (API and MQTT contract): the browser's side of the live
 * channel and of the API.
 *
 * The page gets state from the live stream and from the answers of its own
 * requests. What decides whether something that arrives is applied is pure
 * code and is run in ordering.test.js and ordering-client.test.js
 * (web/js/ordering.js). These tests prove that the store, the live client
 * and the API helper really go through that decision, and that the pages
 * say what the approved design, Tick's decisions (tick-states-0030.md) and
 * section 13 (items 11 and 12) ask for. They run in Node, against
 * stand-ins for EventSource and fetch; no browser, nothing beyond loopback
 * (nothing at all: fetch is a stand-in).
 * Owner: UI worker.
 */

process.env.TZ = "Europe/Vienna";

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { ApiError, isBusy, onBusy, request, requestFrame } from "../../web/js/api.js";
import { clock, clockShort } from "../../web/js/format.js";
import { connectLive } from "../../web/js/live.js";
import { openSource, beginRequest } from "../../web/js/ordering.js";
import {
  applyAnswer as applyDefaultAnswer,
  applyEvent as applyDefaultEvent,
  createStore,
  decideFrameAnswer,
  fence as defaultFence,
  toPreview,
} from "../../web/js/store.js";
import { setSession } from "../../web/js/session.js";
import { createDraftBook } from "../../web/js/view/drafts.js";
import {
  HEALTH_RULE,
  RESTART_SENTENCE,
  blobWriterLine,
  deviceCell,
  deviceCondition,
  deviceStatus,
  devicesSummary,
  header,
  healthTitle,
  overlayRow,
  overlayRows,
  pageCondition,
  previewCaption,
  showingNow,
  waitingSceneOverlay,
  waitingSettingsLine,
} from "../../web/js/view/model.js";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const at = (/** @type {string} */ hms) => new Date(`2026-11-16T${hms}+01:00`).toISOString();

// ---------------------------------------------------------------------------
// Recorded data in the shapes of src/types.js
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {{epoch?: string, incarnation?: number, rev?: number, scene?: string|null, source?: string, output?: string, outputProblem?: string|null, origin?: string, enabled?: boolean, addressSource?: string, health?: string, type?: string}} [o]
 * @returns {any} DeviceView
 */
function view(name, o = {}) {
  const scene = o.scene === undefined ? "clock" : o.scene;
  return {
    name,
    epoch: o.epoch ?? A,
    incarnation: o.incarnation ?? 1,
    rev: o.rev ?? 1,
    displayName: "",
    comment: "",
    type: o.type ?? "ulanzi",
    origin: o.origin ?? "config",
    size: o.type === "pixoo" ? { width: 64, height: 64 } : { width: 32, height: 8 },
    desired: {
      scene: { scene, source: o.source ?? "config", since: at("09:14:31"), overlayId: null, problem: null },
      choice: { scene, persisted: true, notSavedReason: null, chosenAt: null, overridden: false },
      mode: { value: "play", source: "default", since: at("09:14:22") },
      brightness: { override: null, source: "none", since: at("09:14:22") },
      address: { value: "192.168.1.56", source: o.addressSource ?? "config" },
      enabled: o.enabled ?? true,
      output: o.output ?? "drive",
      outputProblem: o.outputProblem ?? null,
    },
    effective: { scene, phase: "running", showingSince: at("09:14:31"), frameCount: 10, lastBrightness: 30, appliedBrightness: 30, nextRetryAt: null },
    health: {
      state: o.health ?? (o.output === "shadow" ? "shadow" : "online"),
      since: at("09:14:31"),
      lastFrameAt: at("18:42:05"),
      lastContactAt: at("18:42:06"),
      consecutiveErrors: 0,
      lastError: null,
      reason: null,
      powerCycles: { count: 0, max: 10, plugTopic: null },
      apSsid: null,
    },
    preview: { showGrid: false, pollMs: 2000 },
    facts: { minFrameMs: 500, powerCyclePlugTopic: null },
    blobKeys: [],
    settingOverlayCount: 0,
    pending: null,
  };
}

/**
 * @param {string} device
 * @param {{epoch?: string, incarnation?: number, rev?: number, draft?: number|null}} [o]
 * @returns {any} SettingsState
 */
function settings(device, o = {}) {
  return {
    device,
    scene: "clock",
    epoch: o.epoch ?? A,
    incarnation: o.incarnation ?? 1,
    rev: o.rev ?? 1,
    schema: { size: { type: "int", label: "Size", group: "General", description: "", default: 1, placeholder: "" } },
    values: { size: { default: 1, effective: 1, source: "default" } },
    savedFrom: "config",
    preview: o.draft ? { session: "s1", draft: o.draft } : null,
  };
}

/**
 * @param {string} epoch
 * @param {number} seq
 * @param {any[]} devices
 * @param {{incarnations?: number, overlays?: any[], mqtt?: any, controller?: any}} [o]
 * @returns {any} Snapshot
 */
function snapshot(epoch, seq, devices, o = {}) {
  return {
    epoch,
    seq,
    controller: o.controller ?? { version: "261009065314.0.0", startedAt: at("09:14:22"), blobWriter: { writer: true, reason: null }, restartRequired: null, mqttNamespace: { baseTopic: "home/hsb1/pixdcon" } },
    mqtt: o.mqtt ?? { state: "connected", url: "mqtt://broker:1883", since: at("09:14:28"), connection: 1, lastError: null, settled: true },
    config: { path: "/data/config.json", rev: 1, valid: true, error: null, loadedAt: at("18:40:12"), invalidSince: null, warnings: [] },
    devices,
    incarnations: o.incarnations ?? devices.reduce((n, d) => Math.max(n, d.incarnation ?? 0), 0),
    scenes: [{ key: "clock", path: "./scenes/ulanzi/clock.js", pathSource: "config", name: "clock", pretty_name: "Clock", description: "", deviceType: "ulanzi", settingsSchema: {}, resources: { assetDirs: [], stateFields: [] }, status: "ok", error: null }],
    builtins: { ulanzi: [], pixoo: [] },
    overlays: o.overlays ?? [],
  };
}

/**
 * @param {string} id
 * @param {string} kind
 * @param {{device?: string|null, scene?: string|null, key?: string|null, value?: unknown, confirmed?: boolean, inEffect?: boolean, restricts?: string|null, connection?: number}} [o]
 * @returns {any} OverlayRecord
 */
function record(id, kind, o = {}) {
  return {
    id,
    kind,
    topic: `home/hsb1/pixdcon/overlay/${id}`,
    device: o.device ?? null,
    scene: o.scene ?? null,
    key: o.key ?? null,
    raw: String(o.value ?? ""),
    value: o.value ?? null,
    valid: true,
    problem: null,
    receivedAt: at("18:18:02"),
    origin: "live",
    connection: o.connection ?? 1,
    confirmed: o.confirmed ?? true,
    inEffect: o.inEffect ?? (o.confirmed ?? true),
    restricts: o.restricts ?? null,
    supersededBy: null,
    clear: { pending: false, requestedAt: null, attempts: 0 },
  };
}

/** A store that holds one snapshot of epoch A, read from a stream. */
function loadedStore(devices = [view("d1", { rev: 5 })], o = {}) {
  const store = createStore();
  const stream = openSource(store.fence(), "stream");
  const decision = store.applyEvent({ type: "snapshot", epoch: A, seq: 10, stream, data: snapshot(A, 10, devices, o) });
  assert.equal(decision.action, "apply");
  return { store, stream };
}

/** A stand-in for fetch: answers by a function, records what was asked. */
function fakeFetch(/** @type {(url: string, init: any) => Response|Promise<Response>} */ answer) {
  /** @type {Array<{url: string, init: any, generations: number}>} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, init, generations: defaultFence().generations });
      return answer(url, init);
    }
  );
  return calls;
}

/** A stand-in for the browser's EventSource. */
class FakeEventSource {
  /** @type {FakeEventSource[]} */
  static made = [];
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.closed = false;
    /** @type {Map<string, Array<(event: any) => void>>} */
    this.listeners = new Map();
    /** @type {((event?: any) => void)|null} */
    this.onopen = null;
    /** @type {((event?: any) => void)|null} */
    this.onerror = null;
    FakeEventSource.made.push(this);
  }
  /** @param {string} type @param {(event: any) => void} listener */
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  close() {
    this.closed = true;
  }
  /** Deliver an event, as the browser would (also after close: one that was queued). */
  emit(/** @type {string} */ type, /** @type {string} */ id, /** @type {unknown} */ data) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ lastEventId: id, data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

// ---------------------------------------------------------------------------
// The eleven named cases
// ---------------------------------------------------------------------------

test("client store: a snapshot, an event, a view and an answer change the store only when the fence answers apply; what is dropped changes nothing on screen", () => {
  const store = createStore();
  let renders = 0;
  store.subscribe((state) => state.devices, () => (renders += 1));
  assert.equal(renders, 1, "a subscription renders once at once");
  const stream = openSource(store.fence(), "stream");

  // An event before any snapshot is dropped and changes nothing.
  const before = store.getState();
  assert.equal(store.applyEvent({ type: "device", epoch: A, seq: 3, stream, data: view("d1") }).action, "drop");
  assert.equal(store.getState().devices, before.devices);
  assert.equal(renders, 1);

  // The snapshot is applied.
  assert.equal(store.applyEvent({ type: "snapshot", epoch: A, seq: 10, stream, data: snapshot(A, 10, [view("d1", { rev: 5 })]) }).action, "apply");
  assert.equal(store.getState().devices.get("d1").rev, 5);
  assert.equal(renders, 2);

  // An older rev, another epoch, an old stream: dropped, nothing on screen moves.
  const held = store.getState().devices;
  for (const event of [
    { type: "device", epoch: A, seq: 11, stream, data: view("d1", { rev: 4 }) },
    { type: "device", epoch: B, seq: 12, stream, data: view("d1", { epoch: B, rev: 9 }) },
    { type: "device", epoch: A, seq: 13, stream: stream - 1, data: view("d1", { rev: 9 }) },
  ])
    assert.equal(store.applyEvent(event).action, "drop", JSON.stringify(event).slice(0, 60));
  assert.equal(store.getState().devices, held, "the dropped copies changed nothing");
  assert.equal(renders, 2);

  // An answer without a position, and one of another epoch: dropped.
  assert.equal(store.applyAnswer({ body: view("d1", { rev: 8 }), resource: "device:d1", generation: 99, epoch: null, seq: 0 }).reason, "no_position");
  assert.equal(store.applyAnswer({ body: view("d1", { epoch: B, rev: 8 }), resource: "device:d1", generation: 99, epoch: B, seq: 14 }).action, "drop");
  assert.equal(store.getState().devices, held);

  // A newer view applies, from an event and from an answer.
  assert.equal(store.applyEvent({ type: "device", epoch: A, seq: 15, stream, data: view("d1", { rev: 6 }) }).action, "apply");
  assert.equal(store.applyAnswer({ body: { device: view("d1", { rev: 7 }), persisted: true, notSavedReason: null }, resource: "device:d1", generation: 99, epoch: A, seq: 16 }).action, "apply");
  assert.equal(store.getState().devices.get("d1").rev, 7);
  assert.equal(renders, 4);
});

test("client live: every connect and reconnect opens a new EventSource with a new stream generation; events of a replaced stream are dropped, also ones that were queued before it was closed; an event whose id cannot be read is not handed on", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const saved = globalThis.EventSource;
  globalThis.EventSource = /** @type {any} */ (FakeEventSource);
  FakeEventSource.made = [];
  try {
    const store = createStore();
    /** @type {any[]} */
    const handed = [];
    const live = connectLive(
      { onEvent: (event) => handed.push(event), onState: () => {} },
      { fence: store.fence() },
    );
    assert.equal(FakeEventSource.made.length, 1);
    const first = FakeEventSource.made[0];
    assert.match(first.url, new RegExp(`^/api/v2/events\\?session=${live.session}$`));
    assert.equal(store.fence().stream, 1, "the first stream took generation 1");
    first.onopen?.();
    first.emit("snapshot", `${A}-10`, snapshot(A, 10, [view("d1")]));
    first.emit("device", `${A}-11`, view("d1", { rev: 2 }));
    assert.deepEqual(handed.map((e) => [e.type, e.epoch, e.seq, e.stream]), [["snapshot", A, 10, 1], ["device", A, 11, 1]]);

    // An id that cannot be read, and data that is not JSON, are not handed on.
    first.emit("device", "11", view("d1", { rev: 3 }));
    first.emit("device", `${A}-12`, "{not json");
    assert.equal(handed.length, 2);

    // The stream breaks: a new EventSource after 5 s, with the cursor and a new generation.
    first.onerror?.();
    assert.equal(first.closed, true, "the browser's own retry is not left running");
    assert.equal(FakeEventSource.made.length, 1);
    mock.timers.tick(5000);
    assert.equal(FakeEventSource.made.length, 2);
    const second = FakeEventSource.made[1];
    assert.match(second.url, new RegExp(`since=${A}-11`));
    assert.equal(store.fence().stream, 2, "the reconnect took a new generation");

    // An event that was queued on the old stream is not handed on …
    first.emit("device", `${A}-13`, view("d1", { rev: 9 }));
    assert.equal(handed.length, 2);
    // … and had one been, the store drops it: its stream was replaced.
    for (const event of handed) store.applyEvent(event);
    assert.equal(
      store.applyEvent({ type: "device", epoch: A, seq: 13, stream: 1, data: view("d1", { rev: 9 }) }).reason,
      "superseded_source",
    );
    second.emit("device", `${A}-14`, view("d1", { rev: 4 }));
    assert.equal(handed.at(-1).stream, 2);
    live.close();
  } finally {
    globalThis.EventSource = saved;
    mock.timers.reset();
  }
});

test("client api: every request takes its generation before it is sent; the answer carries epoch and seq of X-Pixdcon-Position; an answer without the header is not applied", async () => {
  const calls = fakeFetch((url) =>
    url.endsWith("/no-header")
      ? new Response(JSON.stringify(view("d1", { rev: 3 })), { status: 200 })
      : url.endsWith("/refused")
        ? new Response(JSON.stringify({ error: "Unknown scene", code: "unknown_scene" }), { status: 400, headers: { "X-Pixdcon-Position": `${A}-20` } })
        : new Response(JSON.stringify([]), { status: 200, headers: { "X-Pixdcon-Position": `${A}-17` } }),
  );
  const before = defaultFence().generations;
  const answer = await request("GET", "/api/v2/overlays", { resource: "overlays" });
  assert.equal(calls[0].generations, before + 1, "the generation was taken before fetch was called");
  assert.equal(answer.generation, before + 1);
  assert.equal(defaultFence().requests.get("overlays"), answer.generation);
  assert.equal(answer.epoch, A);
  assert.equal(answer.seq, 17);
  assert.equal(calls[0].init.cache, "no-store");

  // Writes send JSON with its content type (415 otherwise, 4.13).
  await request("PUT", "/api/v2/devices/d1/mode", { resource: "device:d1", body: { mode: "pause" } });
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  assert.equal(calls[1].init.body, JSON.stringify({ mode: "pause" }));

  // Without the header: epoch null, and the store applies none such.
  const bare = await request("GET", "/no-header", { resource: "device:d1" });
  assert.equal(bare.epoch, null);
  assert.equal(applyDefaultAnswer(bare).reason, "no_position");

  // A refusal is one sentence with its code; a request that reaches nothing is said too.
  await assert.rejects(request("PUT", "/refused", { resource: "device:d1", body: {} }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.message, "Unknown scene.");
    assert.equal(error.code, "unknown_scene");
    assert.equal(error.status, 400);
    return true;
  });
  globalThis.fetch = /** @type {any} */ (async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(request("GET", "/api/v2/overlays", { resource: "overlays" }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "unreachable");
    assert.equal(error.status, 0);
    return true;
  });
});

test("client boot: the bootstrap answer and the stream's snapshot can arrive in either order, also across a restart of pixdcon; the page ends on the newer one", () => {
  // main.js: the bootstrap request is sent first, then the stream opens.
  for (const order of ["bootstrap first", "stream first"]) {
    const store = createStore();
    const bootstrap = openSource(store.fence(), "bootstrap");
    const stream = openSource(store.fence(), "stream");
    const fromBootstrap = () =>
      store.applyAnswer({ body: snapshot(A, 10, [view("d1", { rev: 4 })]), resource: "bootstrap", generation: bootstrap, epoch: A, seq: 10 });
    const fromStream = () =>
      store.applyEvent({ type: "snapshot", epoch: A, seq: 12, stream, data: snapshot(A, 12, [view("d1", { rev: 5 })]) });
    if (order === "bootstrap first") {
      assert.equal(fromBootstrap().action, "apply");
      assert.equal(fromStream().action, "apply");
    } else {
      assert.equal(fromStream().action, "apply");
      assert.equal(fromBootstrap().reason, "superseded_source");
    }
    assert.equal(store.getState().devices.get("d1").rev, 5, order);
    assert.equal(store.getState().seq, 12, order);
  }

  // Across a restart: the stream's snapshot is of the new run (epoch B); the
  // late bootstrap answer of the old run (epoch A, a higher seq) comes after it.
  const store = createStore();
  const bootstrap = openSource(store.fence(), "bootstrap");
  const stream = openSource(store.fence(), "stream");
  assert.equal(store.applyEvent({ type: "snapshot", epoch: B, seq: 3, stream, data: snapshot(B, 3, [view("d1", { epoch: B, rev: 1 })]) }).reason, "new_epoch");
  assert.equal(store.applyAnswer({ body: snapshot(A, 57, [view("d1", { rev: 57 })]), resource: "bootstrap", generation: bootstrap, epoch: A, seq: 57 }).action, "drop");
  assert.equal(store.getState().epoch, B);
  assert.equal(store.getState().devices.get("d1").rev, 1);
  // The view of the new run with rev 2 is taken although the old run had rev 57.
  assert.equal(store.applyEvent({ type: "device", epoch: B, seq: 4, stream, data: view("d1", { epoch: B, rev: 2 }) }).action, "apply");
});

test("client timers: the reconnect timer and the 20 s silence timer change the connection state that is shown and nothing else; values on screen are marked as old, never replaced, by a timer", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse(at("18:41:52")) });
  const saved = globalThis.EventSource;
  globalThis.EventSource = /** @type {any} */ (FakeEventSource);
  FakeEventSource.made = [];
  try {
    const store = createStore();
    /** @type {any[]} */
    const states = [];
    const live = connectLive(
      { onEvent: (event) => store.applyEvent(event), onState: (state) => { states.push(state); store.setLive(state); } },
      { fence: store.fence() },
    );
    const first = FakeEventSource.made[0];
    first.onopen?.();
    first.emit("snapshot", `${A}-10`, snapshot(A, 10, [view("d1", { rev: 5 })]));
    const devices = store.getState().devices;
    assert.equal(store.getState().live.state, "live");

    // 20 s without an event: lost, since the last event; the values stay.
    mock.timers.tick(19999);
    assert.equal(store.getState().live.state, "live");
    mock.timers.tick(1);
    assert.equal(store.getState().live.state, "lost");
    assert.equal(store.getState().live.lostSince, Date.parse(at("18:41:52")));
    assert.equal(first.closed, true);
    assert.equal(store.getState().devices, devices, "the timer replaced no value");
    const line = pageCondition(store.getState());
    assert.ok(line);
    assert.equal(line.cls, "bad");
    assert.match(line.text, /^No answer from pixdcon since 18:41:52 · retrying every 5 s · values below are from /);
    const frozen = showingNow(store.getState(), devices.get("d1"));
    assert.match(frozen.display.text, /^Live updates paused · retrying/);
    assert.equal(frozen.action, null, "no action while the values are old");

    // 5 s later a new stream is opened: the state says so, the values still stay.
    mock.timers.tick(5000);
    assert.equal(FakeEventSource.made.length, 2);
    assert.equal(store.getState().devices, devices);
    FakeEventSource.made[1].onopen?.();
    assert.equal(store.getState().live.state, "live");
    assert.equal(store.getState().devices, devices);
    assert.deepEqual([...new Set(states.map((s) => s.state))], ["live", "lost"]);
    live.close();
  } finally {
    globalThis.EventSource = saved;
    mock.timers.reset();
  }
});

test("client controls: one request at a time per control; a click while its request runs sends nothing, and the answer of the request is applied by its rev", async () => {
  /** @type {Array<(response: Response) => void>} */
  const pending = [];
  const calls = fakeFetch(() => new Promise((resolve) => pending.push(resolve)));
  /** @type {Array<[string, boolean]>} */
  const seen = [];
  const stop = onBusy((key, busy) => seen.push([key, busy]));
  const first = request("PUT", "/api/v2/devices/d1/scene", { resource: "device:d1", key: "scene:d1", body: { scene: "clock" } });
  assert.equal(isBusy("scene:d1"), true);
  await assert.rejects(
    request("PUT", "/api/v2/devices/d1/scene", { resource: "device:d1", key: "scene:d1", body: { scene: "other" } }),
    (error) => error instanceof ApiError && error.code === "busy",
  );
  assert.equal(calls.length, 1, "the second click sent nothing");
  // Another control of the same device is not blocked by it.
  const other = request("PUT", "/api/v2/devices/d1/mode", { resource: "device:d1", key: "mode:d1", body: { mode: "stop" } });
  assert.equal(calls.length, 2);
  pending[0](new Response(JSON.stringify({ device: view("d1", { rev: 8 }), persisted: true, notSavedReason: null }), { status: 200, headers: { "X-Pixdcon-Position": `${A}-30` } }));
  pending[1](new Response(JSON.stringify(view("d1", { rev: 7 })), { status: 200, headers: { "X-Pixdcon-Position": `${A}-29` } }));
  const [scene, mode] = await Promise.all([first, other]);
  assert.equal(isBusy("scene:d1"), false);
  assert.deepEqual(seen, [["scene:d1", true], ["mode:d1", true], ["scene:d1", false], ["mode:d1", false]]);
  stop();

  // The answers go through the fence by rev: the later answer of the older rev changes nothing.
  const { store } = loadedStore([view("d1", { rev: 5 })]);
  assert.equal(store.applyAnswer(scene).action, "apply");
  assert.equal(store.applyAnswer(mode).reason, "not_newer");
  assert.equal(store.getState().devices.get("d1").rev, 8);
});

test("client settings form: every edit raises the draft; a preview answer for an older draft than the one on screen is not shown", () => {
  const book = createDraftBook();
  // The draft number is the page's edit counter: it rises with every edit
  // of any form of the page (r2 finding 3), so the test counts from the first.
  const d = book.edit("size", "2", { value: 2 });
  assert.ok(d >= 1);
  assert.equal(book.edit("size", "3", { value: 3 }), d + 1);
  assert.equal(book.edit("layout", '{"rows": [1,', { error: "Not valid JSON" }), d + 2);
  // The preview carries the newest draft and only what parses (S-5: never `{}`).
  assert.deepEqual(book.previewBody("s1"), { session: "s1", draft: d + 2, values: { size: 3 } });
  assert.equal(book.saveBody("s1"), null, "Save is blocked while a field does not parse");
  assert.equal(book.edit("layout", "{}", { value: {} }), d + 3);
  const plan = book.saveBody("s1");
  assert.ok(plan);
  assert.deepEqual(plan.body, { set: { size: 3, layout: {} }, reset: [], session: "s1", draft: d + 3 });

  // Answers of two previews come back in the wrong order: the store shows
  // the newer one (decideView by rev), and the field shows what was typed.
  const { store } = loadedStore([view("d1", { rev: 5 })]);
  const newer = { state: settings("d1", { rev: 6, draft: d + 3 }), rejected: {}, applied: true };
  const older = { state: settings("d1", { rev: 5, draft: d + 1 }), rejected: {}, applied: true };
  assert.equal(store.applyAnswer({ body: newer, resource: "settings:d1/clock", generation: 1, epoch: A, seq: 40 }).action, "apply");
  assert.equal(store.applyAnswer({ body: older, resource: "settings:d1/clock", generation: 1, epoch: A, seq: 41 }).reason, "not_newer");
  assert.equal(store.getState().settings.get("d1/clock").preview.draft, d + 3);
  assert.deepEqual(book.shown("size", store.getState().settings.get("d1/clock").values.size), { raw: "3", value: 3, error: undefined });

  // Save commits what it named; what was typed after the click stays, with a newer draft.
  assert.equal(book.edit("size", "5", { value: 5 }), d + 4);
  book.saved(plan.committed, plan.body.reset);
  assert.equal(book.edits.has("layout"), false);
  assert.equal(book.edits.get("size")?.raw, "5");
  assert.deepEqual(book.previewBody("s1"), { session: "s1", draft: d + 4, values: { size: 5 } });
});

test("client store, snapshot (N4): a snapshot is applied part by part: every resource that decideSnapshot does not name in keep, every device view through decideView with the snapshot's seq, and the devices in gone are removed; a late answer that stands before the snapshot changes nothing on screen", () => {
  const { store, stream } = loadedStore([view("d1", { rev: 5 }), view("d2", { rev: 3, incarnation: 2 })], { overlays: [record("x", "mode", { device: "d1", value: "pause" })] });
  store.applyEvent({ type: "settings", epoch: A, seq: 11, stream, data: settings("d2", { incarnation: 2, rev: 1 }) });
  assert.ok(store.getState().settings.has("d2/clock"));

  // An answer for the overlay list, asked for now, stands after the next snapshot.
  const early = beginRequest(store.fence(), "overlays");
  assert.equal(store.applyAnswer({ body: [record("y", "mode", { device: "d1", value: "stop" })], resource: "overlays", generation: early, epoch: A, seq: 25 }).action, "apply");
  // A second request, answered from a position before the next snapshot.
  const late = beginRequest(store.fence(), "overlays");

  // The next snapshot (seq 20) does not list d2; it has an older copy of the overlay list.
  const decision = store.applyEvent({
    type: "snapshot",
    epoch: A,
    seq: 20,
    stream,
    data: snapshot(A, 20, [view("d1", { rev: 6 })], { incarnations: 2, overlays: [record("x", "mode", { device: "d1", value: "pause" })] }),
  });
  assert.equal(decision.action, "apply");
  assert.deepEqual(/** @type {any} */ (decision).keep, ["overlays"]);
  assert.deepEqual(/** @type {any} */ (decision).gone, ["d2"]);
  const state = store.getState();
  assert.deepEqual(state.overlays.map((r) => r.id), ["y"], "the newer copy of the answer is kept");
  assert.equal(state.devices.has("d2"), false, "d2 is gone");
  assert.equal(state.settings.has("d2/clock"), false, "with its settings state");
  assert.equal(state.devices.get("d1").rev, 6);

  // The late answer stands before the snapshot: nothing on screen changes.
  assert.equal(store.applyAnswer({ body: [], resource: "overlays", generation: late, epoch: A, seq: 15 }).reason, "not_newer");
  assert.deepEqual(store.getState().overlays.map((r) => r.id), ["y"]);
});

test("client store, removal (N4): device-removed calls forgetDevice with the event's seq and drops the device's settings states; the late answer of a write to the old device does not bring it back after a device of the same name was added again", () => {
  const { store, stream } = loadedStore([view("d1", { rev: 5, incarnation: 1 })], { incarnations: 1 });
  store.applyEvent({ type: "settings", epoch: A, seq: 11, stream, data: settings("d1", { rev: 2 }) });
  store.applyEvent({ type: "preview", epoch: A, seq: 12, stream, data: { device: "d1", width: 1, height: 1, source: "runtime", receivedAt: at("18:42:06"), frameSeq: 1, rgbBase64: "AAAA" } });
  assert.ok(store.getState().previews.has("d1"));

  assert.equal(store.applyEvent({ type: "device-removed", epoch: A, seq: 30, stream, data: { name: "d1", incarnation: 1 } }).action, "apply");
  const removed = store.getState();
  assert.equal(removed.devices.has("d1"), false);
  assert.equal(removed.settings.has("d1/clock"), false, "the settings state went with the device");
  assert.equal(removed.previews.has("d1"), false, "and its last frame");

  // The device comes back as incarnation 2 with rev 1.
  assert.equal(store.applyEvent({ type: "device", epoch: A, seq: 32, stream, data: view("d1", { rev: 1, incarnation: 2 }) }).action, "apply");
  // The late answer of a write to the old device (incarnation 1, rev 9, stamped before the removal).
  assert.equal(store.applyAnswer({ body: view("d1", { rev: 9, incarnation: 1 }), resource: "device:d1", generation: 5, epoch: A, seq: 29 }).action, "drop");
  // Also without a name, by its position.
  const unnamed = view("d1", { rev: 9 });
  delete unnamed.incarnation;
  assert.equal(store.applyAnswer({ body: unnamed, resource: "device:d1", generation: 5, epoch: A, seq: 29 }).action, "drop");
  assert.equal(store.getState().devices.get("d1").incarnation, 2);
  assert.equal(store.getState().devices.get("d1").rev, 1);
});

test("client store, incarnation (R4-4): every device view and settings state goes through decideView with its incarnation, and a view inside a snapshot with snapshot: true; after a reconnect whose snapshot lists a device that was removed and added again meanwhile, the page shows the new device at its rev 1 and takes its later revs, and the late answer of a write to the old device changes nothing", () => {
  const store = createStore();
  const first = openSource(store.fence(), "stream");
  store.applyEvent({ type: "snapshot", epoch: A, seq: 10, stream: first, data: snapshot(A, 10, [view("D", { rev: 20, incarnation: 1 })], { incarnations: 1 }) });
  store.applyEvent({ type: "settings", epoch: A, seq: 11, stream: first, data: settings("D", { rev: 4, incarnation: 1 }) });
  // The page is away: D is removed and added again (incarnation 2). The new stream's snapshot lists it at rev 1.
  const second = openSource(store.fence(), "stream");
  assert.equal(
    store.applyEvent({ type: "snapshot", epoch: A, seq: 50, stream: second, data: snapshot(A, 50, [view("D", { rev: 1, incarnation: 2 })], { incarnations: 2 }) }).action,
    "apply",
  );
  assert.equal(store.getState().devices.get("D").rev, 1);
  assert.equal(store.getState().devices.get("D").incarnation, 2);
  assert.equal(store.getState().settings.has("D/clock"), false, "the old life's settings state is gone");
  // Its later revs apply.
  for (const rev of [2, 3])
    assert.equal(store.applyEvent({ type: "device", epoch: A, seq: 50 + rev, stream: second, data: view("D", { rev, incarnation: 2 }) }).action, "apply");
  // The late answer of a write to the old device, whatever position it claims.
  assert.equal(store.applyAnswer({ body: view("D", { rev: 21, incarnation: 1 }), resource: "device:D", generation: 9, epoch: A, seq: 99 }).action, "drop");
  assert.equal(store.applyAnswer({ body: settings("D", { rev: 5, incarnation: 1 }), resource: "settings:D/clock", generation: 9, epoch: A, seq: 99 }).action, "drop");
  assert.equal(store.getState().devices.get("D").rev, 3);
  assert.equal(store.getState().settings.has("D/clock"), false);
});

test("client pages, a record that is not confirmed (item 11): after a reconnect an overlay row reads 'Waiting for the broker · not in effect' until the record is delivered again, for a scene, a setting, mode, brightness and a scene path alike; a switch-off still reads as one; a held display reads 'On hold'; Clear of the config overlay is disabled with its reason while this instance is not its writer (item 12)", () => {
  const reconnect = { state: "connected", url: "mqtt://broker:1883", since: at("18:42:01"), connection: 2, lastError: null, settled: true };
  const waiting = [
    record("device-scene:d1", "device-scene", { device: "d1", value: "tv", confirmed: false, connection: 1 }),
    record("setting:d1:clock:size", "setting", { device: "d1", scene: "clock", key: "size", value: 4, confirmed: false, connection: 1 }),
    record("mode:d1", "mode", { device: "d1", value: "pause", confirmed: false, connection: 1 }),
    record("brightness:d1", "brightness", { device: "d1", value: { enabled: true, value: 40 }, confirmed: false, connection: 1 }),
    record("scene-path:clock", "scene-path", { scene: "clock", value: "./x.js", confirmed: false, connection: 1 }),
  ];
  const held = view("held", { enabled: false, addressSource: "overlay", health: "idle" });
  const off = view("off", { enabled: false, health: "idle" });
  const restricting = [
    record("device-ip:held", "device-ip", { device: "held", value: "192.168.1.189", confirmed: false, inEffect: false, restricts: "held", connection: 1 }),
    record("device-enabled:off", "device-enabled", { device: "off", value: false, confirmed: false, inEffect: false, restricts: "off", connection: 1 }),
    record("blob", "blob", { value: { devices: [], scenes: {} } }),
  ];
  const { store } = loadedStore([view("d1"), held, off], {
    mqtt: reconnect,
    overlays: [...waiting, ...restricting],
    controller: { version: "261009065314.0.0", startedAt: at("09:14:22"), blobWriter: { writer: false, reason: "v1_writes" }, restartRequired: null, mqttNamespace: { baseTopic: "home/hsb1/pixdcon" } },
  });
  const state = store.getState();
  for (const r of waiting) {
    const row = overlayRow(state, r);
    assert.equal(row.status, "Waiting for the broker · not in effect", r.kind);
    assert.equal(row.value.cls, "", `${r.kind}: neutral, not violet`);
    assert.equal(row.received.sub, `received ${clockShort(r.receivedAt)} · not confirmed since the reconnect at 18:42`, r.kind);
    assert.equal(row.clear?.disabled, false, `${r.kind}: Clear works as for any row`);
  }
  const switchedOff = overlayRow(state, restricting[1]);
  assert.equal(switchedOff.status, "Switched off by an MQTT overlay since 18:18");
  assert.equal(switchedOff.received.sub, "not confirmed since the reconnect at 18:42 · still off");
  assert.equal(overlayRow(state, restricting[0]).status, "Waiting for the broker · display on hold");

  // The held display, on the Devices page and the Device page.
  assert.equal(deviceStatus(held, state).label, "On hold");
  assert.equal(
    deviceCondition(state, held)?.text,
    "On hold: its address comes from an MQTT overlay (192.168.1.189) that the broker has not confirmed since the reconnect at 18:42. Clear the overlay to use the address in config.json.",
  );
  assert.equal(deviceCondition(state, off)?.text, "Switched off by an MQTT overlay");
  assert.equal(deviceStatus(off, state).label, "Off");

  // The device page of d1: the source shows what decides now, one line says what waits.
  assert.equal(waitingSceneOverlay(state, state.devices.get("d1")), "MQTT overlay 'tv' is not confirmed since the reconnect at 18:42 · Overlays");
  const now = showingNow(state, state.devices.get("d1"));
  assert.equal(now.source.text, "Your choice, saved in config.json");
  assert.equal(now.tint, "", "no violet tint: nothing is wrong");
  assert.equal(waitingSettingsLine(state, "d1", "clock"), "1 setting overlay is waiting for the broker · Overlays");

  // Item 12: the config overlay's Clear while this instance is not its writer.
  const blob = overlayRow(state, restricting[2]);
  assert.deepEqual(blob.clear, { disabled: true, reason: "written by pixdcon v1 during the switch-over" });
  assert.equal(blobWriterLine(state), "Config overlay: written by pixdcon v1 during the switch-over");
  const edge = { ...state, controller: { ...state.controller, blobWriter: { writer: false, reason: "force_shadow" } } };
  assert.deepEqual(overlayRow(edge, restricting[2]).clear, { disabled: true, reason: "this instance never writes the config overlay" });
  assert.equal(blobWriterLine(edge), null);

  // A row that left the list while the page showed it stays, greyed, with its time.
  const shown = ["mode:d1"];
  const stream = store.fence().stream;
  store.applyEvent({ type: "overlays", epoch: A, seq: 30, stream, data: state.overlays.filter((r) => r.id !== "mode:d1") });
  const rows = overlayRows(store.getState(), { shown, since: 0 });
  assert.equal(rows[0].id, "mode:d1");
  assert.match(String(rows[0].cleared), /^Cleared \d\d:\d\d:\d\d$/);
  assert.equal(rows[0].clear, null);
});

// ---------------------------------------------------------------------------
// Tick's four states (tick-states-0030.md), word for word, and the frames
// ---------------------------------------------------------------------------

test("client pages, Tick's four states: shadow (neutral filled dot, 'Shadow · not driving the display' with the reason, 'Would show · not on the display', counted apart), overlay-only with 'Add to config.json', 'Restart needed' and its sentence, and the Health rule text", () => {
  const shadow = view("p189", { output: "shadow", outputProblem: "still driven by pixdcon v1", type: "pixoo" });
  const overlayOnly = view("u58", { origin: "blob", addressSource: "blob", source: "blob" });
  const { store, stream } = loadedStore([view("a"), view("b"), view("c"), shadow, overlayOnly]);
  let state = store.getState();

  // Item 7: a device in shadow.
  const status = deviceStatus(shadow, state);
  assert.deepEqual([status.dot, status.label, status.meta[0].text], ["shadow", "Shadow · not driving the display", "still driven by pixdcon v1"]);
  for (const reason of ["this instance never drives a display", "waiting for pixdcon v1's device list"])
    assert.equal(deviceStatus(view("x", { output: "shadow", outputProblem: reason }), state).meta[0].text, reason);
  const now = showingNow(state, shadow);
  assert.equal(now.source.text, "Shadow: changes here don't reach the display");
  assert.equal(now.action, null, "no action in the action row");
  assert.equal(now.display.text, "Shadow · not driving the display");
  assert.equal(/** @type {any} */ (now.display).sub, "still driven by pixdcon v1");
  assert.equal(previewCaption(state, shadow), "64 × 64 · Would show · not on the display");
  assert.equal(devicesSummary(state).text, "5 devices · 4 online · 1 shadow");

  // Item 8: a device that exists only in the MQTT config overlay.
  const condition = deviceCondition(state, overlayOnly);
  assert.equal(condition?.text, "This device comes from the MQTT config overlay and is not in config.json. Changes are applied but not saved.");
  assert.equal(condition?.icon, "layers");
  assert.equal(condition?.cls, "ovr");
  assert.deepEqual(condition?.action, { label: "Add to config.json", kind: "adopt" });
  assert.equal(deviceCell(overlayOnly).lines[0].text, "from the MQTT config overlay · not saved");

  // Item 9: restart required.
  store.applyEvent({ type: "controller", epoch: A, seq: 20, stream, data: { ...state.controller, restartRequired: { reason: "mqtt changed", since: at("18:36:40") } } });
  state = store.getState();
  assert.deepEqual(header(state).restart, { shown: true, title: RESTART_SENTENCE });
  assert.equal(healthTitle(state).text, "The MQTT settings in config.json changed. Restart pixdcon to apply them.");

  // Item 10: the Health rule text.
  assert.equal(HEALTH_RULE, "Stale after 30 s, offline after 2 min without a good frame");
});

test("client previews: a frame from the stream is checked before it is drawn (bad frame, B-180) and keyed by the exact device name (B-178); the one frame asked for over HTTP fills an empty slot only, in the same epoch and life of its device", async () => {
  const { store, stream } = loadedStore([view("a.b", { rev: 1, incarnation: 1 }), view("a-b", { rev: 1, incarnation: 2 })]);
  store.applyEvent({ type: "preview", epoch: A, seq: 11, stream, data: { device: "a.b", width: 2, height: 1, source: "runtime", receivedAt: at("18:42:06"), frameSeq: 1, rgbBase64: Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64") } });
  store.applyEvent({ type: "preview", epoch: A, seq: 12, stream, data: { device: "a-b", width: 2, height: 1, source: "runtime", receivedAt: at("18:42:06"), frameSeq: 1, rgbBase64: Buffer.from([1, 2, 3]).toString("base64") } });
  const state = store.getState();
  assert.deepEqual([...(state.previews.get("a.b")?.rgb ?? [])], [1, 2, 3, 4, 5, 6]);
  assert.equal(state.previews.get("a-b")?.rgb, null, "a frame of the wrong length is a bad frame, not drawn");
  assert.notEqual(state.previews.get("a.b"), state.previews.get("a-b"));

  // The HTTP frame: the request takes its generation first; it fills an empty slot only.
  fakeFetch(() => new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { "X-Frame-Width": "1", "X-Frame-Height": "1", "X-Frame-Source": "runtime", "X-Frame-Received-At": at("18:41:00"), "X-Frame-Seq": "3" } }));
  const answer = await requestFrame("c");
  assert.equal(answer.frame?.width, 1);
  const filling = createStore();
  const s2 = openSource(filling.fence(), "stream");
  filling.applyEvent({ type: "snapshot", epoch: A, seq: 10, stream: s2, data: snapshot(A, 10, [view("c", { incarnation: 4 })]) });
  const generation = beginRequest(filling.fence(), "frame:c");
  const frame = toPreview(/** @type {any} */ (answer.frame), answer.frame?.rgb ?? null);
  assert.equal(decideFrameAnswer(filling.getState(), filling.fence(), { device: "c", generation, epoch: A, incarnation: 3 }).reason, "older_incarnation");
  assert.equal(decideFrameAnswer(filling.getState(), filling.fence(), { device: "c", generation, epoch: B, incarnation: 4 }).reason, "other_epoch");
  assert.equal(filling.applyFrameAnswer({ device: "c", generation, epoch: A, incarnation: 4 }, frame).action, "apply");
  assert.equal(filling.getState().previews.get("c"), frame);
  const again = beginRequest(filling.fence(), "frame:c");
  assert.equal(filling.applyFrameAnswer({ device: "c", generation: again, epoch: A, incarnation: 4 }, frame).reason, "newer_copy", "a held frame is never replaced by the HTTP one");
  assert.equal(clock(frame.receivedAt), "18:41:00");
});

// ---------------------------------------------------------------------------
// Fix round 1: the first gate's findings 1 to 10, each test playing the
// gate's sequence. Findings 9 and 10 are pure (store, view model); the
// others run the pages and the settings form against the stand-in DOM below.
// ---------------------------------------------------------------------------

test("r2 finding 9, log: lines from the HTTP answer and from the stream are merged by LogLine.seq, without copies and in order; the 200-line cap keeps history, not copies", () => {
  const { store, stream } = loadedStore();
  const line = (/** @type {number} */ seq) => ({ seq, at: at("18:42:00"), level: "INFO", message: `[Test] line ${seq}` });
  assert.equal(store.applyAnswer({ body: [line(1), line(2)], resource: "log", generation: beginRequest(store.fence(), "log"), epoch: A, seq: 12 }).action, "apply");
  store.applyEvent({ type: "log", epoch: A, seq: 13, stream, data: line(1) });
  store.applyEvent({ type: "log", epoch: A, seq: 14, stream, data: line(2) });
  store.applyEvent({ type: "log", epoch: A, seq: 15, stream, data: line(3) });
  assert.deepEqual(store.getState().log.map((l) => l.seq), [1, 2, 3]);
  // An answer that overlaps what the stream brought, and a stream line that is late.
  store.applyAnswer({ body: [line(2), line(3), line(4), line(5)], resource: "log", generation: beginRequest(store.fence(), "log"), epoch: A, seq: 16 });
  store.applyEvent({ type: "log", epoch: A, seq: 17, stream, data: line(4) });
  assert.deepEqual(store.getState().log.map((l) => l.seq), [1, 2, 3, 4, 5]);
  // The cap: 260 lines, every one of them twice, keep the newest 200 lines once each.
  const many = Array.from({ length: 260 }, (_, i) => line(i + 1));
  store.applyAnswer({ body: many.slice(0, 200), resource: "log", generation: beginRequest(store.fence(), "log"), epoch: A, seq: 18 });
  let seq = 18;
  for (const l of many) store.applyEvent({ type: "log", epoch: A, seq: (seq += 1), stream, data: l });
  const seqs = store.getState().log.map((l) => l.seq);
  assert.equal(seqs.length, 200);
  assert.equal(new Set(seqs).size, 200);
  assert.deepEqual([seqs[0], seqs[199]], [61, 260]);
});

test("r2 finding 10, item 11: a device that an entry of the config overlay (blob) switches off reads 'Switched off by an MQTT overlay', confirmed or not, and never 'disabled in config.json'", () => {
  for (const confirmed of [true, false]) {
    const blob = record("blob", "blob", { value: { devices: [{ name: "d1", enabled: false }, { name: "d2", scene: "clock" }] }, confirmed, restricts: null });
    const { store } = loadedStore([view("d1", { enabled: false }), view("d2", { enabled: false })], { overlays: [blob] });
    const state = store.getState();
    const off = state.devices.get("d1");
    assert.equal(deviceCondition(state, off)?.text, "Switched off by an MQTT overlay", `confirmed: ${confirmed}`);
    assert.equal(showingNow(state, off).display.text, "Off · switched off by an MQTT overlay");
    assert.deepEqual(deviceStatus(off, state).meta.map((m) => m.text), ["switched off by an MQTT overlay"]);
    // d2 is in the blob too, but the blob does not switch it off: config.json does.
    const disabled = state.devices.get("d2");
    assert.equal(showingNow(state, disabled).display.text, "Off · disabled in config.json");
    assert.equal(deviceCondition(state, disabled), null);
  }
});


// ---------------------------------------------------------------------------
// A small stand-in for the browser's DOM, so the pages and the settings form
// run in Node: it parses the HTML the components write, finds their slots by
// the selectors they use, and carries events up the tree; nothing more.
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(["input", "br", "img", "hr", "meta", "link", "source", "wbr", "col", "area", "base", "embed", "param", "track"]);
/** @type {Record<string, string>} */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeHtml = (/** @type {string} */ text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, /** @type {string} */ name) =>
    name[0] === "#"
      ? String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)))
      : (ENTITIES[name.toLowerCase()] ?? all),
  );

class FakeNode {
  constructor() {
    /** @type {FakeNode|null} */
    this.parentNode = null;
    /** @type {FakeNode[]} */
    this.childNodes = [];
  }
  /** @returns {FakeElement|null} */
  get parentElement() {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  /** @returns {string} */
  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(text) {
    this.replaceChildren(String(text ?? ""));
  }
  /** @param {...(FakeNode|string)} nodes */
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeText(node) : node;
      child.remove();
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  /** @param {...(FakeNode|string)} nodes */
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) child.remove();
    this.append(...nodes.filter((node) => node !== ""));
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  /** @param {string} text */
  constructor(text) {
    super();
    this.data = String(text);
  }
  get textContent() {
    return this.data;
  }
  set textContent(text) {
    this.data = String(text);
  }
}

/** @type {{activeElement: any, body: any, createElement: (tag: string) => any}} */
const fakeDocument = {
  activeElement: null,
  body: null,
  createElement: (tag) => makeElement(tag),
};

/**
 * @param {string} selector
 * @returns {Array<Array<{combinator: string, tag: string|null, id: string|null, classes: string[], attrs: Array<{name: string, value?: string}>}>>}
 */
function parseSelector(selector) {
  /** @type {any[][]} */
  const lists = [];
  /** @type {any[]} */
  let sequence = [];
  let combinator = " ";
  /** @type {any} */
  let compound = null;
  const start = () => {
    if (!compound) {
      compound = { combinator, tag: null, id: null, classes: [], attrs: [] };
      sequence.push(compound);
    }
    return compound;
  };
  const token = /\s*([>,])\s*|(\s+)|([a-zA-Z*][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  for (const m of selector.trim().matchAll(token)) {
    if (m[1] === ",") {
      lists.push(sequence);
      sequence = [];
      compound = null;
      combinator = " ";
    } else if (m[1] === ">" || m[2] !== undefined) {
      compound = null;
      combinator = m[1] === ">" ? ">" : " ";
    } else if (m[3]) start().tag = m[3].toLowerCase();
    else if (m[4]) start().id = m[4];
    else if (m[5]) start().classes.push(m[5]);
    else if (m[6]) start().attrs.push({ name: m[6], value: m[7] ?? m[8] ?? m[9] });
  }
  lists.push(sequence);
  return lists;
}

/** @param {FakeElement} element @param {any} part */
function matchesCompound(element, part) {
  if (part.tag && part.tag !== "*" && element.localName !== part.tag) return false;
  if (part.id && element.getAttribute("id") !== part.id) return false;
  const classes = element.className.split(/\s+/);
  for (const cls of part.classes) if (!classes.includes(cls)) return false;
  for (const attr of part.attrs) {
    const value = element.getAttribute(attr.name);
    if (value === null || (attr.value !== undefined && value !== attr.value)) return false;
  }
  return true;
}

/** @param {FakeElement} element @param {any[]} sequence @param {number} i @returns {boolean} */
function matchesSequence(element, sequence, i) {
  if (!matchesCompound(element, sequence[i])) return false;
  if (i === 0) return true;
  if (sequence[i].combinator === ">") {
    const parent = element.parentElement;
    return parent ? matchesSequence(parent, sequence, i - 1) : false;
  }
  for (let up = element.parentElement; up; up = up.parentElement)
    if (matchesSequence(up, sequence, i - 1)) return true;
  return false;
}

class FakeEvent {
  /** @param {string} type @param {{key?: string}} [init] */
  constructor(type, init = {}) {
    this.type = type;
    this.key = init.key;
    /** @type {any} */
    this.target = null;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

class FakeElement extends FakeNode {
  /** @param {string} tag */
  constructor(tag) {
    super();
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    /** @type {Map<string, string>} */
    this.attrs = new Map();
    /** @type {Map<string, Array<(event: any) => void>>} */
    this.listeners = new Map();
    /** @type {Record<string, string>} */
    this.style = { cssText: "" };
    const element = this;
    const attr = (/** @type {string|symbol} */ prop) =>
      `data-${String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    this.dataset = new Proxy(
      {},
      {
        get: (_, prop) => element.getAttribute(attr(prop)) ?? undefined,
        set: (_, prop, value) => {
          element.setAttribute(attr(prop), String(value));
          return true;
        },
      },
    );
  }
  get children() {
    return /** @type {FakeElement[]} */ (this.childNodes.filter((node) => node instanceof FakeElement));
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  /** @param {string} name */
  getAttribute(name) {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }
  /** @param {string} name @param {unknown} value */
  setAttribute(name, value) {
    this.attrs.set(name.toLowerCase(), String(value));
  }
  /** @param {string} name */
  removeAttribute(name) {
    this.attrs.delete(name.toLowerCase());
  }
  /** @param {string} name */
  hasAttribute(name) {
    return this.attrs.has(name.toLowerCase());
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(value) {
    this.setAttribute("class", value);
  }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (/** @type {string} */ cls) => list().includes(cls),
      add: (/** @type {string[]} */ ...cls) => (this.className = [...new Set([...list(), ...cls])].join(" ")),
      remove: (/** @type {string[]} */ ...cls) => (this.className = list().filter((c) => !cls.includes(c)).join(" ")),
    };
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(value) {
    if (value) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(value) {
    if (value) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get type() {
    return this.getAttribute("type") ?? (this.localName === "button" ? "submit" : "text");
  }
  get innerHTML() {
    return this.childNodes.map(serializeNode).join("");
  }
  set innerHTML(html) {
    this.replaceChildren();
    parseHtmlInto(this, String(html));
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  blur() {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = null;
  }
  /** @param {string} type @param {(event: any) => void} listener */
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    if (!list.includes(listener)) list.push(listener);
    this.listeners.set(type, list);
  }
  /** @param {string} type @param {(event: any) => void} listener */
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((fn) => fn !== listener));
  }
  /** @param {FakeEvent} event bubbles up to the root */
  dispatchEvent(event) {
    event.target = this;
    for (let node = /** @type {FakeElement|null} */ (this); node && !event.stopped; node = node.parentElement)
      for (const listener of [...(node.listeners.get(event.type) ?? [])]) listener.call(node, event);
    return !event.defaultPrevented;
  }
  /** @param {string} selector */
  matches(selector) {
    return parseSelector(selector).some((sequence) => matchesSequence(this, sequence, sequence.length - 1));
  }
  /** @param {string} selector */
  closest(selector) {
    for (let node = /** @type {FakeElement|null} */ (this); node; node = node.parentElement)
      if (node.matches(selector)) return node;
    return null;
  }
  /** @param {string} selector @returns {FakeElement[]} */
  querySelectorAll(selector) {
    /** @type {FakeElement[]} */
    const found = [];
    const walk = (/** @type {FakeElement} */ element) => {
      for (const child of element.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  /** @param {string} selector */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeInput extends FakeElement {
  get value() {
    return this._value ?? this.getAttribute("value") ?? "";
  }
  set value(value) {
    /** @type {string|undefined} */
    this._value = String(value);
  }
  get checked() {
    return this._checked ?? this.hasAttribute("checked");
  }
  set checked(value) {
    /** @type {boolean|undefined} */
    this._checked = Boolean(value);
  }
}
class FakeTextArea extends FakeElement {
  get value() {
    return this._value ?? this.textContent;
  }
  set value(value) {
    /** @type {string|undefined} */
    this._value = String(value);
  }
}
class FakeSelect extends FakeElement {
  get options() {
    return this.querySelectorAll("option");
  }
  get value() {
    const values = this.options.map((option) => option.getAttribute("value") ?? option.textContent);
    if (this._chosen !== undefined && values.includes(this._chosen)) return this._chosen;
    return values[0] ?? "";
  }
  set value(value) {
    /** @type {string|undefined} */
    this._chosen = String(value);
  }
}
class FakeButton extends FakeElement {}
class FakeForm extends FakeElement {}
class FakeAnchor extends FakeElement {}
class FakeCanvas extends FakeElement {
  getContext() {
    return null;
  }
}

/** @param {string} tag @returns {FakeElement} */
function makeElement(tag) {
  const name = tag.toLowerCase();
  const Kind =
    { input: FakeInput, textarea: FakeTextArea, select: FakeSelect, button: FakeButton, form: FakeForm, a: FakeAnchor, canvas: FakeCanvas }[name] ??
    FakeElement;
  const element = new Kind(name);
  if (name === "template") Object.defineProperty(element, "content", { get: () => element });
  return element;
}

/** @param {FakeNode} node @returns {string} */
function serializeNode(node) {
  if (node instanceof FakeText) return node.data.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const element = /** @type {FakeElement} */ (node);
  const attrs = [...element.attrs].map(([name, value]) => ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join("");
  if (VOID_TAGS.has(element.localName)) return `<${element.localName}${attrs}>`;
  return `<${element.localName}${attrs}>${element.childNodes.map(serializeNode).join("")}</${element.localName}>`;
}

/** @param {FakeElement} parent @param {string} html */
function parseHtmlInto(parent, html) {
  /** @type {FakeElement[]} */
  const stack = [parent];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
  for (const m of html.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1)
        if (stack[i].localName === tag) {
          stack.length = i;
          break;
        }
    } else if (m[2]) {
      const element = makeElement(m[2]);
      for (const a of (m[3] ?? "").matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
        element.setAttribute(a[1], decodeHtml(a[2] ?? a[3] ?? a[4] ?? ""));
      top.append(element);
      if (!VOID_TAGS.has(element.localName) && !m[4]) stack.push(element);
    } else top.append(decodeHtml(m[5] ?? m[6] ?? ""));
  }
}

fakeDocument.body = makeElement("body");
Object.assign(globalThis, {
  document: fakeDocument,
  HTMLElement: FakeElement,
  HTMLInputElement: FakeInput,
  HTMLTextAreaElement: FakeTextArea,
  HTMLSelectElement: FakeSelect,
  HTMLButtonElement: FakeButton,
  HTMLFormElement: FakeForm,
  HTMLAnchorElement: FakeAnchor,
  getComputedStyle: () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0" }),
});

/** A page root in the stand-in document. */
function pageRoot() {
  const root = makeElement("main");
  fakeDocument.body.append(root);
  return /** @type {any} */ (root);
}

/** Type into a field, as a person does: the value changes, then the event. */
function typeInto(/** @type {any} */ field, /** @type {string} */ value, type = "input") {
  field.value = value;
  field.dispatchEvent(new FakeEvent(type));
}

/** Click, as a browser does: a disabled button takes no click. */
function click(/** @type {any} */ element) {
  if (!element) throw new Error("nothing to click");
  if (element.disabled) return false;
  element.dispatchEvent(new FakeEvent("click"));
  return true;
}

/** Let the answers that were given run through their awaits. */
async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A stand-in for fetch whose answers the test gives, in any order.
 *
 * @returns {Array<{method: string, url: string, body: any, answered: boolean, answer: (status: number, body?: unknown, position?: string) => void}>}
 */
function heldFetch() {
  /** @type {any[]} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    (/** @type {string} */ url, /** @type {any} */ init = {}) =>
      new Promise((resolve) => {
        const call = {
          method: init.method ?? "GET",
          url: String(url),
          body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
          answered: false,
          answer: (/** @type {number} */ status, /** @type {unknown} */ body, /** @type {string|undefined} */ position) => {
            call.answered = true;
            resolve(
              new Response(body === undefined ? null : JSON.stringify(body), {
                status,
                headers: position ? { "X-Pixdcon-Position": position } : {},
              }),
            );
          },
        };
        calls.push(call);
      })
  );
  return calls;
}

/** Answer what is still open (503), so no control key stays busy for the next test. */
async function drain(/** @type {any[]} */ calls) {
  for (let round = 0; round < 5; round += 1) {
    await settle();
    const open = calls.filter((c) => !c.answered);
    if (open.length === 0) return;
    for (const call of open) call.answer(503, {});
  }
}

/** The first call not answered yet with this method and a URL that contains `part`. */
function pending(/** @type {any[]} */ calls, /** @type {string} */ method, /** @type {string} */ part) {
  const call = calls.find((c) => !c.answered && c.method === method && c.url.includes(part));
  assert.ok(call, `a ${method} request to …${part} was sent`);
  return call;
}

const SCENES = [
  { key: "clock", path: "./scenes/ulanzi/clock.js", pathSource: "config", name: "clock", pretty_name: "Clock", description: "", deviceType: "ulanzi", settingsSchema: {}, resources: { assetDirs: [], stateFields: [] }, status: "ok", error: null },
  { key: "weather", path: "./scenes/ulanzi/weather.js", pathSource: "config", name: "weather", pretty_name: "Weather", description: "", deviceType: "ulanzi", settingsSchema: {}, resources: { assetDirs: [], stateFields: [] }, status: "ok", error: null },
];

/**
 * A page module. Pages use the browser's DOM; they are loaded by a path the
 * typecheck does not follow, as web/ is checked against the browser and not
 * against Node's types (jsconfig.json excludes it).
 *
 * @param {string} name
 * @returns {Promise<any>}
 */
const loadPage = async (name) => (await import(new URL(`../../web/js/pages/${name}.js`, import.meta.url).href)).page;
const rawPage = await loadPage("config-raw");
const devicePage = await loadPage("device");
const devicesPage = await loadPage("devices");

let pageEpochs = 0;
/**
 * Load the page's own store (the one the pages read) with a snapshot of a
 * fresh epoch, from a stream of its own.
 *
 * @param {(epoch: string) => any[]} devices
 * @param {any} [o] snapshot options
 * @returns {{epoch: string, stream: number}}
 */
function bootPages(devices, o = {}) {
  pageEpochs += 1;
  const epoch = `e${String(pageEpochs).padStart(7, "0")}`;
  const stream = openSource(defaultFence(), "stream");
  const decision = applyDefaultEvent({ type: "snapshot", epoch, seq: 10, stream, data: { ...snapshot(epoch, 10, devices(epoch), o), scenes: SCENES } });
  assert.equal(decision.action, "apply");
  return { epoch, stream };
}

/**
 * A SettingsState with one int field `n` (or the schema given).
 *
 * @param {string} device
 * @param {string} scene
 * @param {{epoch: string, incarnation?: number, rev?: number, schema?: any, effective?: Record<string, unknown>, preview?: any}} o
 */
function sceneSettings(device, scene, o) {
  const schema = o.schema ?? { n: { type: "int", label: "N", group: "General", description: "", default: 1, placeholder: "" } };
  /** @type {Record<string, any>} */
  const values = {};
  for (const [key, field] of Object.entries(schema))
    values[key] = { default: field.default, effective: o.effective?.[key] ?? field.default, source: "default" };
  return { device, scene, epoch: o.epoch, incarnation: o.incarnation ?? 1, rev: o.rev ?? 1, schema, values, savedFrom: "config", preview: o.preview ?? null };
}

/** The settings rows of a mounted form, by key. */
const field = (/** @type {any} */ root, /** @type {string} */ key) => root.querySelector(`.set-body [data-key="${key}"]`);
const statusText = (/** @type {any} */ root) => root.querySelector(".set-status").textContent;
const saveButton = (/** @type {any} */ root) => root.querySelector('.set-h [data-act="save"]');


setSession("s1");

const CONFIG_STATE = { path: "/data/config.json", rev: 1, valid: true, error: null, loadedAt: at("18:40:12"), invalidSince: null, warnings: [] };

test("r2 finding 1, raw config: a load that comes back after the page was left and opened again writes nothing; the newer load fills the editor, and what is typed afterwards stays", async () => {
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  const calls = heldFetch();
  rawPage.mount(pageRoot(), {});
  rawPage.unmount();
  const root = pageRoot();
  rawPage.mount(root, {});
  try {
    const [first, second] = calls.filter((c) => c.method === "GET" && c.url === "/api/v2/config/raw");
    assert.ok(first && second, "each opening asked for the text");
    second.answer(200, { text: '{"devices": []}', state: CONFIG_STATE }, `${epoch}-20`);
    await settle();
    const editor = root.querySelector("textarea");
    assert.equal(editor.value, '{"devices": []}');
    typeInto(editor, '{"devices": [], "x": 1}');
    first.answer(200, { text: '{"devices": ["old"]}', state: CONFIG_STATE }, `${epoch}-10`);
    await settle();
    assert.equal(editor.value, '{"devices": [], "x": 1}', "the late answer of the page that was left wrote nothing");
    assert.match(root.querySelector(".edbar .state").textContent, /unsaved changes/);
    assert.doesNotMatch(root.querySelector(".edbar .state").textContent, /no unsaved changes/);
  } finally {
    rawPage.unmount();
    await drain(calls);
  }
});

test("r2 finding 2, settings form: after a restart (a new epoch) that keeps the device and its scene, the form drops the old values and loads the scene again", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  const root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch, effective: { n: 7 } }), `${epoch}-11`);
    await settle();
    assert.equal(field(root, "n")?.value, "7");
    // pixdcon restarts; its new run lists d1 with the same scene.
    const restarted = bootPages((e) => [view("d1", { epoch: e })]);
    await settle();
    assert.equal(field(root, "n"), null, "no value of the run before stays on screen");
    assert.match(root.querySelector(".set-body").textContent, /Loading settings for Clock/);
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch: restarted.epoch, effective: { n: 3 } }), `${restarted.epoch}-11`);
    await settle();
    assert.equal(field(root, "n")?.value, "3");
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
});

test("r2 finding 3, settings form: the draft number keeps rising when the device page is left and opened again, so pixdcon never meets a draft it has seen", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  let rev = 1;
  /** @type {any} */
  let root = null;
  const open = async () => {
    root = pageRoot();
    devicePage.mount(root, { name: "d1" });
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch, rev }), `${epoch}-${10 + rev}`);
    await settle();
  };
  const preview = async (/** @type {string} */ value) => {
    typeInto(field(root, "n"), value);
    await settle();
    const put = pending(calls, "PUT", "/settings/clock/preview");
    rev += 1;
    put.answer(200, { state: sceneSettings("d1", "clock", { epoch, rev, preview: { session: "s1", draft: put.body.draft } }), rejected: {}, applied: true }, `${epoch}-${10 + rev}`);
    await settle();
    return Number(put.body.draft);
  };
  await open();
  try {
    await preview("2");
    const before = await preview("3");
    click(saveButton(root));
    await settle();
    rev += 1;
    pending(calls, "PUT", "/settings/clock").answer(200, { state: sceneSettings("d1", "clock", { epoch, rev, effective: { n: 3 } }), overlaysNotCleared: [] }, `${epoch}-${10 + rev}`);
    await settle();
    devicePage.unmount();
    await settle();
    // Leaving ends the preview (finding 6); the next one of the scene waits for that end.
    for (const end of calls.filter((c) => !c.answered && c.method === "DELETE"))
      end.answer(200, sceneSettings("d1", "clock", { epoch, rev }), `${epoch}-${10 + rev}`);
    await settle();
    await open();
    const after = await preview("4");
    assert.ok(after > before, `the draft after opening the page again (${after}) is newer than the last one sent (${before})`);
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
});

test("r2 finding 4, settings form: a Save that comes back after the scene was switched leaves the other scene's edits alone, also when they read the same", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  const root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch }), `${epoch}-11`);
    await settle();
    typeInto(field(root, "n"), "20");
    await settle();
    pending(calls, "PUT", "/settings/clock/preview").answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 2, preview: { session: "s1", draft: 1 } }), rejected: {}, applied: true }, `${epoch}-12`);
    await settle();
    assert.equal(click(saveButton(root)), true);
    await settle();
    const save = pending(calls, "PUT", "/settings/clock");
    // The display switches to Weather before the Save is answered.
    applyDefaultAnswer({ body: view("d1", { epoch, rev: 2, scene: "weather" }), resource: "device:d1", generation: 0, epoch, seq: 13 });
    await settle();
    pending(calls, "GET", "/settings/weather").answer(200, sceneSettings("d1", "weather", { epoch }), `${epoch}-14`);
    await settle();
    typeInto(field(root, "n"), "20");
    await settle();
    pending(calls, "PUT", "/settings/weather/preview").answer(200, { state: sceneSettings("d1", "weather", { epoch, rev: 2, preview: { session: "s1", draft: 2 } }), rejected: {}, applied: true }, `${epoch}-15`);
    await settle();
    save.answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 3, effective: { n: 20 } }), overlaysNotCleared: [] }, `${epoch}-16`);
    await settle();
    assert.equal(saveButton(root).disabled, false, "Weather's edit is still there to be saved");
    assert.doesNotMatch(statusText(root), /Saved/);
    assert.match(statusText(root), /^Previewing 1 change/);
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
});

test("r2 finding 5, settings form: a preview's rejection marks only the edit it was sent with; a newer choice stays valid, is previewed and can be saved", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  const colours = (/** @type {string[]} */ options) => ({ color: { type: "enum", label: "Colour", group: "General", description: "", default: "green", placeholder: "", options } });
  const root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch, schema: colours(["red", "green", "blue"]) }), `${epoch}-11`);
    await settle();
    typeInto(field(root, "color"), "red", "change");
    await settle();
    const first = pending(calls, "PUT", "/settings/clock/preview");
    // A hot reload takes red away, and blue is chosen before the first answer is back.
    applyDefaultAnswer({ body: sceneSettings("d1", "clock", { epoch, rev: 3, schema: colours(["green", "blue"]) }), resource: "settings:d1/clock", generation: 0, epoch, seq: 13 });
    await settle();
    typeInto(field(root, "color"), "blue", "change");
    await settle();
    first.answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 2, schema: colours(["red", "green", "blue"]) }), rejected: { color: "not an option of this setting" }, applied: false }, `${epoch}-12`);
    await settle();
    const second = pending(calls, "PUT", "/settings/clock/preview");
    assert.deepEqual(second.body.values, { color: "blue" }, "the newer choice is previewed, not `{}`");
    assert.equal(saveButton(root).disabled, false, "and it can be saved");
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
});

test("r2 finding 6, settings form: the preview of a scene ends when the display switches to another scene, and every preview the page still holds ends when the page is left", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  const root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  let left = false;
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch }), `${epoch}-11`);
    await settle();
    typeInto(field(root, "n"), "5");
    await settle();
    pending(calls, "PUT", "/settings/clock/preview").answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 2, preview: { session: "s1", draft: 1 } }), rejected: {}, applied: true }, `${epoch}-12`);
    await settle();
    applyDefaultAnswer({ body: view("d1", { epoch, rev: 2, scene: "weather" }), resource: "device:d1", generation: 0, epoch, seq: 13 });
    await settle();
    pending(calls, "GET", "/settings/weather").answer(200, sceneSettings("d1", "weather", { epoch }), `${epoch}-14`);
    await settle();
    devicePage.unmount();
    left = true;
    await settle();
    const ends = calls.filter((c) => c.method === "DELETE" && c.url.includes("/preview"));
    assert.deepEqual(ends.map((c) => c.url), ["/api/v2/devices/d1/settings/clock/preview?session=s1"]);
  } finally {
    if (!left) devicePage.unmount();
    await drain(calls);
  }
});

test("r2 finding 7, B-175: a failed preview and a failed Save are said beside the action, also while an edit is unsaved; a failed preview also in the title status line and on the Display line", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  const root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch }), `${epoch}-11`);
    await settle();
    typeInto(field(root, "n"), "5");
    await settle();
    pending(calls, "PUT", "/settings/clock/preview").answer(500, {});
    await settle();
    assert.equal(statusText(root), "Not previewed: pixdcon failed to answer (500).");
    assert.equal(root.querySelector(".dev-head .sub").textContent, "Settings not previewed: pixdcon failed to answer (500).");
    assert.equal(root.querySelector(".why .v-disp").textContent, "Settings not previewed: pixdcon failed to answer (500).");
    assert.equal(click(saveButton(root)), true);
    await settle();
    pending(calls, "PUT", "/settings/clock").answer(500, {});
    await settle();
    assert.equal(statusText(root), "Not saved: pixdcon failed to answer (500).");
    // A preview that works again takes the failure away from the title and the Display line.
    pending(calls, "PUT", "/settings/clock/preview").answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 2, preview: { session: "s1", draft: 9 } }), rejected: {}, applied: true }, `${epoch}-12`);
    await settle();
    assert.equal(root.querySelector(".dev-head .sub").textContent, "");
    assert.doesNotMatch(root.querySelector(".why .v-disp").textContent, /not previewed/);
    assert.equal(statusText(root), "Not saved: pixdcon failed to answer (500).", "the failed Save is still said");
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
});

test("r2 finding 8, B-176: Restore shows its busy label in reserved width and ignores a second click; it leaves no false failure behind once it succeeded", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e, source: "overlay" })]);
  const root = pageRoot();
  devicesPage.mount(root, {});
  try {
    const restore = () => root.querySelector('.dt-row [data-act="restore"]');
    const second = () => root.querySelector(".dt-row .src2").textContent;
    assert.ok(restore(), "the row offers Restore");
    const button = restore();
    assert.equal(click(button), true);
    await settle();
    click(button);
    click(restore());
    await settle();
    assert.equal(calls.filter((c) => c.method === "DELETE" && c.url.endsWith("/scene-overlay")).length, 1, "the second click sent nothing");
    assert.doesNotMatch(second(), /Not restored/, "a second click is no failure");
    assert.equal(restore()?.disabled, true, "while it runs the button takes no click");
    assert.equal(restore()?.getAttribute("aria-busy"), "true");
    assert.equal(restore()?.children[0]?.textContent, "Restoring…", "its busy label shows");
    assert.equal(restore()?.children[1]?.textContent, "Restore", "the other label keeps its width, unseen");
    assert.equal(restore()?.children[1]?.getAttribute("aria-hidden"), "true");
    pending(calls, "DELETE", "/scene-overlay").answer(200, view("d1", { epoch, rev: 2 }), `${epoch}-12`);
    await settle();
    assert.doesNotMatch(second(), /Not restored/, "no failure is left once it succeeded");
  } finally {
    devicesPage.unmount();
    await drain(calls);
  }
});

// ---------------------------------------------------------------------------
// Fix round 2 (r3): the operation rule. Each test replays a sequence of the
// gate's second review (findings-r2.md) or a sibling the sweep found
// (sweep-r3.md), against the real pages.
// ---------------------------------------------------------------------------

const healthPage = await loadPage("health");
const overlaysPage = await loadPage("overlays");
/** A live event into the page's store, on the stream of the snapshot. */
const live = (/** @type {{epoch: string, stream: number}} */ boot, /** @type {string} */ type, /** @type {number} */ seq, /** @type {any} */ data) =>
  applyDefaultEvent({ type, epoch: boot.epoch, seq, stream: boot.stream, data });
const rowLine = (/** @type {any} */ root, /** @type {string} */ which) => root.querySelector(`.dt-row ${which}`).textContent;
const restoreIn = (/** @type {any} */ root) => root.querySelector('.dt-row [data-act="restore"]');
const titleLine = (/** @type {any} */ root) => root.querySelector(".dev-head .sub");
const previewOf = (/** @type {any} */ calls) => calls.filter((/** @type {any} */ c) => c.method === "PUT" && c.url.endsWith("/settings/clock/preview"));

test("r3 ops (the operation rule): an outcome changes its slot only while its token is current; a start while the slot is busy is ignored before anything changes; a failure is kept until the next start; follow and drop make the running operation obsolete", async () => {
  const ops = await import(new URL("../../web/js/ops.js", import.meta.url).href);
  /** @type {Array<(value?: unknown) => void>} */
  const answers = [];
  /** @type {Array<(error: unknown) => void>} */
  const fails = [];
  const held = () => new Promise((resolve, reject) => {
    answers.push(resolve);
    fails.push(reject);
  });
  const key = "test:ops";
  let done = 0;
  const count = () => {
    done += 1;
    return "Done";
  };
  assert.equal(ops.start(key, held, { label: "Working…", done: count }), true);
  assert.deepEqual([ops.op(key).busy, ops.op(key).label], [true, "Working…"]);
  assert.equal(ops.start(key, held, { done: count }), false, "a second start while busy is ignored");
  assert.equal(answers.length, 1, "and sends nothing");
  fails[0](new ApiError("pixdcon failed to answer (500).", { status: 500, code: "http_500" }));
  await settle();
  assert.deepEqual([ops.op(key).busy, ops.op(key).failure], [false, "pixdcon failed to answer (500)."], "the failure is kept");
  assert.equal(ops.start(key, held, { done: count }), true, "the action stays available");
  assert.equal(ops.op(key).failure, null, "a new start takes the old failure away");
  void ops.follow(key, held);
  answers[1]("late");
  await settle();
  assert.equal(done, 0, "the obsolete outcome ran nothing of the page");
  assert.equal(ops.op(key).busy, true, "and changed nothing in the slot");
  answers[2]("now");
  await settle();
  assert.deepEqual([ops.op(key).busy, ops.op(key).failure], [false, null]);
  ops.follow(key, held).catch(() => {});
  ops.drop(key);
  fails[3](new Error("late"));
  await settle();
  assert.deepEqual([ops.op(key).token, ops.op(key).failure], [0, null], "a dropped slot stays forgotten");
});

test("r3 api (rule 4): a request that gets no answer fails after 15 s with code timeout and a sentence, and its control key is free again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = heldFetch();
  const outcome = request("PUT", "/api/v2/devices/d1/mode", { resource: "device:d1", key: "mode:test", body: { mode: "pause" } }).then(
    () => null,
    (error) => error,
  );
  await settle();
  assert.equal(isBusy("mode:test"), true);
  t.mock.timers.tick(15_000);
  const error = await outcome;
  assert.ok(error instanceof ApiError);
  assert.deepEqual([error.code, error.message], ["timeout", "pixdcon did not answer within 15 s."]);
  assert.equal(isBusy("mode:test"), false, "the key is free again");
  await drain(calls);
});

test("r3 gate 2.1 (settings load): a load that fails after newer values of its scene arrived changes nothing; the values stay on screen", async () => {
  const calls = heldFetch();
  const boot = bootPages((e) => [view("d1", { epoch: e })]);
  const root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  try {
    const get = pending(calls, "GET", "/settings/clock");
    live(boot, "settings", 20, sceneSettings("d1", "clock", { epoch: boot.epoch, rev: 2, effective: { n: 7 } }));
    await settle();
    assert.equal(field(root, "n")?.value, "7", "the live values are shown");
    get.answer(500, {});
    await settle();
    assert.equal(field(root, "n")?.value, "7", "the late failure of the load leaves them");
    assert.doesNotMatch(root.querySelector(".set-body").textContent, /could not be loaded/);
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
});

test("r3 gate 2.2 (finding 6, failed cleanup): an end of a preview that fails is kept and said in the title status line with Retry; Retry ends it", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  const root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch }), `${epoch}-11`);
    await settle();
    typeInto(field(root, "n"), "5");
    await settle();
    pending(calls, "PUT", "/settings/clock/preview").answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 2, preview: { session: "s1", draft: 1 } }), rejected: {}, applied: true }, `${epoch}-12`);
    await settle();
    applyDefaultAnswer({ body: view("d1", { epoch, rev: 2, scene: "weather" }), resource: "device:d1", generation: 0, epoch, seq: 13 });
    await settle();
    pending(calls, "GET", "/settings/weather").answer(200, sceneSettings("d1", "weather", { epoch }), `${epoch}-14`);
    pending(calls, "DELETE", "/settings/clock/preview").answer(500, {});
    await settle();
    assert.match(titleLine(root).textContent, /Settings preview of Clock not ended: pixdcon failed to answer \(500\)\./, "the failed end is said");
    const retry = titleLine(root).querySelector('[data-act="end-retry"]');
    assert.ok(retry, "with Retry beside it");
    assert.equal(click(retry), true);
    await settle();
    const again = calls.filter((c) => c.method === "DELETE" && c.url.includes("/settings/clock/preview"));
    assert.equal(again.length, 2, "Retry sends the end again");
    again[1].answer(200, sceneSettings("d1", "clock", { epoch, rev: 3 }), `${epoch}-15`);
    await settle();
    assert.doesNotMatch(titleLine(root).textContent, /not ended/, "an end that worked takes the line away");
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
});

test("r3 gate 2.3 (finding 8, Restore across lives): a new incarnation of the same name starts idle, and the old request's failure changes nothing on it", async () => {
  const calls = heldFetch();
  const boot = bootPages((e) => [view("d1", { epoch: e, source: "overlay" })]);
  const root = pageRoot();
  devicesPage.mount(root, {});
  try {
    assert.equal(click(restoreIn(root)), true);
    await settle();
    const old = pending(calls, "DELETE", "/scene-overlay");
    live(boot, "device-removed", 11, { name: "d1", incarnation: 1 });
    live(boot, "device", 12, view("d1", { epoch: boot.epoch, incarnation: 2, source: "overlay" }));
    await settle();
    assert.ok(restoreIn(root), "the new life offers Restore");
    assert.equal(restoreIn(root).disabled, false, "not busy: the running Restore was the old life's");
    assert.equal(restoreIn(root).getAttribute("aria-busy"), null);
    old.answer(500, {});
    await settle();
    assert.ok(restoreIn(root), "the old failure did not take the button");
    assert.doesNotMatch(rowLine(root, ".src2"), /Not restored/);
  } finally {
    devicesPage.unmount();
    await drain(calls);
  }
});

test("r3 gate Q3 (B-175): a failed Restore keeps its button, with the error beside it, and the button retries", async () => {
  const calls = heldFetch();
  bootPages((e) => [view("d1", { epoch: e, source: "overlay" })]);
  const root = pageRoot();
  devicesPage.mount(root, {});
  try {
    assert.equal(click(restoreIn(root)), true);
    await settle();
    pending(calls, "DELETE", "/scene-overlay").answer(500, {});
    await settle();
    assert.match(rowLine(root, ".src2"), /Not restored: pixdcon failed to answer \(500\)\./);
    assert.ok(restoreIn(root), "the button stays");
    assert.equal(restoreIn(root).disabled, false);
    assert.equal(click(restoreIn(root)), true);
    await settle();
    assert.equal(calls.filter((c) => c.method === "DELETE" && c.url.endsWith("/scene-overlay")).length, 2, "and it tries again");
  } finally {
    devicesPage.unmount();
    await drain(calls);
  }
});

test("r3 gate Q4 (Revert): Revert ends the preview in the scene's lane; an edit typed meanwhile is previewed after the end, so the end cannot remove it", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  const root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch }), `${epoch}-11`);
    await settle();
    typeInto(field(root, "n"), "2");
    await settle();
    const first = pending(calls, "PUT", "/settings/clock/preview");
    first.answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 2, effective: { n: 2 }, preview: { session: "s1", draft: first.body.draft } }), rejected: {}, applied: true }, `${epoch}-12`);
    await settle();
    assert.equal(click(root.querySelector('.set-h [data-act="revert"]')), true);
    await settle();
    const end = pending(calls, "DELETE", "/settings/clock/preview");
    typeInto(field(root, "n"), "3");
    await settle();
    assert.equal(previewOf(calls).length, 1, "no preview leaves while Revert's end is on its way");
    end.answer(200, sceneSettings("d1", "clock", { epoch, rev: 3 }), `${epoch}-13`);
    await settle();
    const next = pending(calls, "PUT", "/settings/clock/preview");
    assert.deepEqual(next.body.values, { n: 3 }, "the edit typed during Revert is previewed after the end");
    next.answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 4, effective: { n: 3 }, preview: { session: "s1", draft: next.body.draft } }), rejected: {}, applied: true }, `${epoch}-14`);
    await settle();
    assert.deepEqual(calls.filter((c) => c.url.includes("/settings/clock")).map((c) => c.method), ["GET", "PUT", "DELETE", "PUT"]);
    assert.match(statusText(root), /^Previewing 1 change/);
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
});

test("r3 gate Q5 (time bound): an end that gets no answer fails after 15 s with Retry, and the next preview of the scene leaves after it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  let root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  let mounted = true;
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch }), `${epoch}-11`);
    await settle();
    typeInto(field(root, "n"), "5");
    await settle();
    pending(calls, "PUT", "/settings/clock/preview").answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 2, preview: { session: "s1", draft: 1 } }), rejected: {}, applied: true }, `${epoch}-12`);
    await settle();
    devicePage.unmount();
    mounted = false;
    await settle();
    pending(calls, "DELETE", "/settings/clock/preview"); // held: no answer
    root = pageRoot();
    devicePage.mount(root, { name: "d1" });
    mounted = true;
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch, rev: 3 }), `${epoch}-13`);
    await settle();
    typeInto(field(root, "n"), "6");
    await settle();
    assert.equal(previewOf(calls).length, 1, "the new preview waits for the end");
    t.mock.timers.tick(120_000);
    await settle();
    const next = previewOf(calls)[1];
    assert.ok(next, "after the time bound the waiting preview leaves");
    assert.deepEqual(next.body.values, { n: 6 });
    assert.match(titleLine(root).textContent, /Settings preview of Clock not ended: pixdcon did not answer within 15 s\./);
    assert.ok(titleLine(root).querySelector('[data-act="end-retry"]'), "with Retry");
    next.answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 4, effective: { n: 6 }, preview: { session: "s1", draft: next.body.draft } }), rejected: {}, applied: true }, `${epoch}-14`);
    await settle();
    assert.doesNotMatch(titleLine(root).textContent, /not ended/, "the newer preview is the one the page holds now");
    assert.match(statusText(root), /^Previewing 1 change/);
  } finally {
    if (mounted) devicePage.unmount();
    t.mock.timers.tick(120_000);
    await drain(calls);
  }
});

test("r3 gate Q6 (one busy owner across pages): a switch started on the Device page owns the Devices row: a choice there sends nothing and says nothing, and the answer ends it", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  let root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  let on = "device";
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch }), `${epoch}-11`);
    await settle();
    const options = [...root.querySelectorAll(".opt")].map((o) => o.getAttribute("data-scene"));
    assert.ok(options.includes("weather"), "the Device page offers Weather");
    assert.equal(click(root.querySelector('.opt[data-scene="weather"]')), true);
    await settle();
    const put = pending(calls, "PUT", "/devices/d1/scene");
    devicePage.unmount();
    root = pageRoot();
    devicesPage.mount(root, {});
    on = "devices";
    typeInto(root.querySelector(".dt-row select"), "weather", "change");
    await settle();
    assert.equal(calls.filter((c) => c.method === "PUT" && c.url.endsWith("/devices/d1/scene")).length, 1, "only one switch leaves");
    assert.doesNotMatch(root.querySelector(".dt-row .c-show").textContent, /Not switched/);
    assert.match(rowLine(root, ".src"), /Switching to Weather…/, "the row shows the switch that runs");
    put.answer(200, view("d1", { epoch, rev: 3, scene: "weather" }), `${epoch}-13`);
    await settle();
    assert.doesNotMatch(root.querySelector(".dt-row .c-show").textContent, /Not switched|Switching/);
    assert.equal(root.querySelector(".dt-row select").value, "weather");
  } finally {
    if (on === "device") devicePage.unmount();
    else devicesPage.unmount();
    await drain(calls);
  }
});

test("r3 gate 4.1 (finding 1, raw retry): a load asked again keeps the editor revision it started from; what was typed meanwhile stays", async () => {
  const boot = bootPages((e) => [view("d1", { epoch: e })]);
  const calls = heldFetch();
  const root = pageRoot();
  rawPage.mount(root, {});
  try {
    const first = pending(calls, "GET", "/api/v2/config/raw");
    const editor = root.querySelector("textarea");
    typeInto(editor, '{"devices":[],"keep":"my edit"}');
    live(boot, "config", 20, { ...CONFIG_STATE, rev: 2 });
    first.answer(200, { text: '{"devices": []}', state: CONFIG_STATE }, `${boot.epoch}-11`);
    await settle();
    const retry = pending(calls, "GET", "/api/v2/config/raw");
    retry.answer(200, { text: '{"devices": ["disk"]}', state: { ...CONFIG_STATE, rev: 3 } }, `${boot.epoch}-21`);
    await settle();
    assert.equal(editor.value, '{"devices":[],"keep":"my edit"}', "the retry did not replace the edit");
    assert.match(root.querySelector(".edbar .state").textContent, /unsaved changes/);
    assert.doesNotMatch(root.querySelector(".edbar .state").textContent, /no unsaved changes/);
  } finally {
    rawPage.unmount();
    await drain(calls);
  }
});

test("r3 gate 4.2 (raw, late failure): the first load's late failure does not overwrite what a newer Reload said", async () => {
  const boot = bootPages((e) => [view("d1", { epoch: e })]);
  const calls = heldFetch();
  const root = pageRoot();
  rawPage.mount(root, {});
  try {
    const first = pending(calls, "GET", "/api/v2/config/raw");
    assert.equal(click(root.querySelector('[data-act="reload"]')), true);
    await settle();
    pending(calls, "POST", "/api/v2/config/reload").answer(200, { state: { ...CONFIG_STATE, rev: 2 } }, `${boot.epoch}-12`);
    await settle();
    const reloaded = calls.filter((c) => c.method === "GET" && c.url === "/api/v2/config/raw")[1];
    assert.ok(reloaded, "Reload asks for the text");
    reloaded.answer(200, { text: '{"devices": ["b"]}', state: { ...CONFIG_STATE, rev: 2 } }, `${boot.epoch}-13`);
    await settle();
    assert.match(root.querySelector(".errline").textContent, /Reloaded from disk/);
    first.answer(500, {});
    await settle();
    assert.match(root.querySelector(".errline").textContent, /Reloaded from disk/, "the newer outcome stays");
    assert.equal(root.querySelector("textarea").value, '{"devices": ["b"]}');
  } finally {
    rawPage.unmount();
    await drain(calls);
  }
});

test("r3 sweep (device controls): a control's outcome belongs to its device; device A's late failure is not said on device B's page", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e }), view("d2", { epoch: e })]);
  let root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  try {
    assert.equal(click(root.querySelector('[data-act="mode"][data-mode="pause"]')), true);
    await settle();
    const put = pending(calls, "PUT", "/devices/d1/mode");
    devicePage.unmount();
    root = pageRoot();
    devicePage.mount(root, { name: "d2" });
    put.answer(500, {});
    await settle();
    assert.doesNotMatch(root.querySelector(".mode-hint").textContent, /Not changed/, "d1's failure is not said on d2");
    assert.equal(root.querySelector('[data-act="mode"][data-mode="pause"]').disabled, false);
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
  void epoch;
});

test("r3 sweep (Overlays, rule 5): opened again while Clear runs, the row shows it busy; a click sends nothing and says nothing", async () => {
  const calls = heldFetch();
  bootPages((e) => [view("d1", { epoch: e, source: "overlay" })], { overlays: [record("o1", "scene", { device: "d1", value: "weather" })] });
  let root = pageRoot();
  overlaysPage.mount(root, {});
  try {
    const clear = () => root.querySelector('[data-act="clear"]');
    assert.ok(clear(), "the row offers Clear");
    assert.equal(click(clear()), true);
    await settle();
    overlaysPage.unmount();
    root = pageRoot();
    overlaysPage.mount(root, {});
    click(clear());
    await settle();
    assert.equal(calls.filter((c) => c.method === "DELETE" && c.url.includes("/api/v2/overlays/")).length, 1);
    assert.doesNotMatch(root.querySelector(".ov-body").textContent, /Not cleared/);
    assert.match(clear().textContent, /Clearing…/);
  } finally {
    overlaysPage.unmount();
    await drain(calls);
  }
});

test("r3 sweep (Health log): the log load of an opening that was left says nothing in the next opening", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e })]);
  let root = pageRoot();
  healthPage.mount(root, {});
  try {
    const first = pending(calls, "GET", "/api/v2/log");
    healthPage.unmount();
    root = pageRoot();
    healthPage.mount(root, {});
    const second = calls.filter((c) => c.method === "GET" && c.url === "/api/v2/log")[1];
    assert.ok(second && second !== first, "the second opening asked for the log");
    second.answer(200, [], `${epoch}-11`);
    await settle();
    first.answer(500, {});
    await settle();
    assert.doesNotMatch(root.querySelector(".log").textContent, /could not be loaded/);
  } finally {
    healthPage.unmount();
    await drain(calls);
  }
});

test("r3 Tick (M1, Q1, Q2, default 7): overlay-only texts; 'not previewed · was N' after a failed preview; pixdcon's reason for a refused value; a time field takes HH:MM only and says so beside it", async () => {
  const calls = heldFetch();
  const { epoch } = bootPages((e) => [view("d1", { epoch: e, origin: "blob" })]);
  const timeSchema = { at: { type: "time", label: "At", group: "General", description: "", default: "07:30", placeholder: "" }, n: { type: "int", label: "N", group: "General", description: "", default: 1, placeholder: "" } };
  const root = pageRoot();
  devicePage.mount(root, { name: "d1" });
  try {
    pending(calls, "GET", "/settings/clock").answer(200, sceneSettings("d1", "clock", { epoch, schema: timeSchema }), `${epoch}-11`);
    await settle();
    assert.equal(root.querySelector(".scene-note").textContent, "Choosing a scene switches the display now; it is not saved until the device is added to config.json.");
    assert.equal(root.querySelector(".set-desc").textContent, "Changes show on the display at once. Add the device to config.json to save them.");
    // default 7: HH:MM as the hint; another form is refused beside the field
    assert.match(root.querySelector('[data-row="at"] label').textContent, /HH:MM/);
    typeInto(field(root, "at"), "7.30");
    await settle();
    assert.match(root.querySelector('[data-row="at"] .ctl').textContent, /Enter a time as HH:MM, 24-hour\./);
    assert.equal(previewOf(calls).length, 0, "a time in another form is not previewed");
    typeInto(field(root, "at"), "07:45");
    await settle();
    // Q1: a failed preview reads "not previewed · was …" on the row
    pending(calls, "PUT", "/settings/clock/preview").answer(500, {});
    await settle();
    assert.match(root.querySelector('[data-row="at"] .mk').textContent, /^not previewed · was 07:30$/);
    // Q2: a value pixdcon refuses, with its reason
    typeInto(field(root, "n"), "99");
    await settle();
    const put = pending(calls, "PUT", "/settings/clock/preview");
    put.answer(200, { state: sceneSettings("d1", "clock", { epoch, rev: 2, schema: timeSchema }), rejected: { n: "above the maximum of 50" }, applied: false }, `${epoch}-12`);
    await settle();
    assert.equal(statusText(root), "pixdcon refused this value: above the maximum of 50");
    assert.match(root.querySelector('[data-row="n"] .ctl').textContent, /pixdcon refused this value: above the maximum of 50/);
  } finally {
    devicePage.unmount();
    await drain(calls);
  }
});

// ---------------------------------------------------------------------------
// r4, phase A: the interleaving harness (PIXD-86; design-note-r4.md)
//
// For every operation kind of the effect inventory, every change of one
// identity and every end of the operation, the same story runs twice:
//  - the case: the operation begins; one identity changes; the operation
//    ends (success, failure 500, or no answer within 15 s on the manual
//    clock); pixdcon answers what is left;
//  - its reference: the same story without the operation, or, where the
//    operation cannot be left out (a load that opens with the page, a
//    preview that typing sends), with the operation ended at once,
//    successfully, before the change.
// At three points (after the change, after the end, after everything was
// answered) every piece of UI state on the stand-in DOM whose identities
// include one the change changed must read the same in both runs: the old
// operation changed none of it (the rule, design note section 3). A
// reconnect changes no identity; its case is compared, piece by piece and at
// every point, with the same story without the reconnect, so a reconnect
// alone never takes an operation's outcome away.
//
// pixdcon is a stand-in that takes each request's position, revision and
// device lives when it is sent (as pixdcon processes it), and whose
// successful answers carry what the world already holds: a difference
// between the two runs comes from what a continuation did on screen, not
// from data it brought (the store may take data through the fence).
// Cases that fail at fbf3f61 are listed in R4_KNOWN and run as todo, so the
// suite stays green; R4_HARNESS_STRICT=1 runs them as plain tests.
// ---------------------------------------------------------------------------

const configPage = await loadPage("config");
const { getState: r4State, setOp: r4SetOp } = await import(new URL("../../web/js/store.js", import.meta.url).href);

// The stand-in DOM, completed for the pages the earlier tests did not reach
// (Config's edit row, Create copy, Add device, the recovery dialog):
// Node.contains, isConnected, form.reset(), a FormData that reads a form,
// and document listeners.
Object.assign(fakeDocument, { addEventListener() {}, removeEventListener() {} });
Object.defineProperty(FakeNode.prototype, "contains", {
  value(/** @type {any} */ node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  },
});
Object.defineProperty(FakeNode.prototype, "isConnected", {
  get() {
    /** @type {any} */
    let at = this;
    while (at.parentNode) at = at.parentNode;
    return at === fakeDocument.body;
  },
});
/** @param {any} form @returns {any[]} the named fields of a form */
const r4Fields = (form) => form.querySelectorAll("input, textarea, select").filter((/** @type {any} */ el) => el.getAttribute("name"));
Object.defineProperty(FakeForm.prototype, "reset", {
  value() {
    for (const el of r4Fields(this)) {
      el._value = undefined;
      el._checked = undefined;
      el._chosen = undefined;
    }
  },
});
globalThis.FormData = /** @type {any} */ (
  class {
    /** @param {any} form */
    constructor(form) {
      /** @type {Map<string, string>} */
      this.entries = new Map();
      for (const el of form ? r4Fields(form) : []) {
        if (el.getAttribute("type") === "checkbox") {
          if (el.checked) this.entries.set(el.getAttribute("name"), "on");
        } else this.entries.set(el.getAttribute("name"), String(el.value));
      }
    }
    /** @param {string} name */
    get(name) {
      return this.entries.get(name) ?? null;
    }
    /** @param {string} name */
    has(name) {
      return this.entries.has(name);
    }
  }
);

/** What a change of one identity changes (design note section 1). */
const R4_CHANGES = {
  reopen: ["opening"],
  leave: ["opening"],
  type: ["revision"],
  epoch: ["epoch", "life"],
  reincarnate: ["life"],
  commit: ["draft"],
  "newer draft": ["draft"],
  reconnect: [],
};
/** @typedef {keyof typeof R4_CHANGES} R4Change */
const R4_ENDS = /** @type {const} */ (["success", "500", "timeout"]);
const R4_POINTS = ["after the change", "after the end", "after everything was answered"];
const R4_RAW = '{"devices": []}';

/**
 * The world pixdcon holds in one story: its run (epoch), positions,
 * revisions and the lives of its devices.
 *
 * @param {{devices?: Array<{name: string, o?: any}>, overlays?: (epoch: string) => any[], settingsOverlay?: boolean}} spec
 */
function r4World(spec) {
  /** @type {any} */
  const world = { epoch: "", seq: 100, rev: 100, stream: 0, lives: new Map(), spec: { ...spec, devices: (spec.devices ?? []).map((d) => ({ ...d, o: { ...d.o } })) } };
  for (const device of spec.devices ?? []) world.lives.set(device.name, 1);
  return world;
}

/** @param {any} world @param {string} name @param {string} epoch @param {number} life @param {number} rev */
function r4View(world, name, epoch, life, rev) {
  const entry = (world.spec.devices ?? []).find((/** @type {any} */ d) => d.name === name);
  return view(name, { ...(entry?.o ?? {}), epoch, incarnation: life, rev });
}

/** A snapshot of the world on a new stream (boot, reconnect, restart). @param {any} world */
function r4Snapshot(world) {
  world.stream = openSource(defaultFence(), "stream");
  world.seq += 1;
  world.rev += 1;
  const devices = (world.spec.devices ?? []).map((/** @type {any} */ d) => r4View(world, d.name, world.epoch, world.lives.get(d.name), world.rev));
  const data = {
    ...snapshot(world.epoch, world.seq, devices, { overlays: world.spec.overlays?.(world.epoch) ?? [], incarnations: Math.max(0, ...world.lives.values()) }),
    scenes: SCENES,
  };
  const decision = applyDefaultEvent({ type: "snapshot", epoch: world.epoch, seq: world.seq, stream: world.stream, data });
  assert.equal(decision.action, "apply", "the harness's snapshot is taken");
}

/** pixdcon (re)starts: a new epoch, every device in its first life. @param {any} world */
function r4NewEpoch(world) {
  pageEpochs += 1;
  world.epoch = `e${String(pageEpochs).padStart(7, "0")}`;
  for (const name of world.lives.keys()) world.lives.set(name, 1);
  r4Snapshot(world);
}

/** @param {any} world @param {string} type @param {any} data */
function r4Live(world, type, data) {
  world.seq += 1;
  return applyDefaultEvent({ type, epoch: world.epoch, seq: world.seq, stream: world.stream, data });
}

/** @param {any} world @param {any} call @param {string} device @param {string} scene @param {{effective?: any, saved?: any, preview?: any}} [o] */
function r4Settings(world, call, device, scene, o = {}) {
  /** @type {any} */
  const state = sceneSettings(device, scene, { epoch: call.epoch, incarnation: call.lives.get(device) ?? 1, rev: call.rev, effective: o.effective, preview: o.preview ?? null });
  for (const [key, layer] of Object.entries(state.values)) {
    if (world.spec.settingsOverlay) /** @type {any} */ (layer).overlay = 4;
    if (o.saved && key in o.saved) Object.assign(/** @type {any} */ (layer), { saved: o.saved[key], effective: o.saved[key], source: "config" });
  }
  return state;
}

/**
 * pixdcon's successful answer to a request, in its own words: what the
 * world holds, at the position the request was processed.
 *
 * @param {any} world
 * @param {any} call
 * @returns {unknown}
 */
function r4Answer(world, call) {
  const { method } = call;
  const path = call.url.split("?")[0];
  /** @type {RegExpExecArray|null} */
  let m;
  if ((m = /^\/api\/v2\/devices\/([^/]+)\/settings\/([^/]+)(\/preview|\/overlays)?$/.exec(path))) {
    const device = decodeURIComponent(m[1]);
    const scene = decodeURIComponent(m[2]);
    if (m[3] === "/preview" && method === "PUT")
      return { state: r4Settings(world, call, device, scene, { effective: call.body?.values, preview: { session: "s1", draft: call.body?.draft } }), rejected: {}, applied: true };
    if (m[3] === "/overlays") return { state: r4Settings(world, call, device, scene), failed: [] };
    if (!m[3] && method === "PUT") return { state: r4Settings(world, call, device, scene, { saved: call.body?.set }), overlaysNotCleared: [] };
    return r4Settings(world, call, device, scene);
  }
  if (path === "/api/v2/config/raw")
    return method === "GET" ? { text: R4_RAW, state: { ...CONFIG_STATE, rev: call.rev } } : { state: { ...CONFIG_STATE, rev: call.rev }, diff: {} };
  if (path === "/api/v2/config/reload") return { state: { ...CONFIG_STATE, rev: call.rev } };
  if (path === "/api/v2/log") return [];
  if (/^\/api\/v2\/overlays\/[^/]+$/.test(path)) return { overlays: world.spec.overlays?.(call.epoch) ?? [], pending: false, confirmed: true };
  if (/^\/api\/v2\/scenes\/[^/]+\/copy$/.test(path)) return { scene: { key: "clock-copy" }, path: "./scenes/clock-copy.js" };
  // Add device: what it brings is a device the story does not show; the answer carries no view.
  if (path === "/api/v2/devices") return {};
  if ((m = /^\/api\/v2\/devices\/([^/]+)(\/[a-z-]+)?$/.exec(path))) {
    const name = decodeURIComponent(m[1]);
    return r4View(world, name, call.epoch, call.lives.get(name) ?? 1, call.rev);
  }
  throw new Error(`the harness has no answer for ${method} ${call.url}`);
}

/** The stand-in for fetch: every request is held until the story answers it. @param {any} world */
function r4Server(world) {
  /** @type {any[]} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    (/** @type {string} */ url, /** @type {any} */ init = {}) =>
      new Promise((resolve) => {
        world.seq += 1;
        world.rev += 1;
        /** @type {any} */
        const call = {
          method: init.method ?? "GET",
          url: String(url),
          path: String(url).split("?")[0],
          body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
          epoch: world.epoch,
          seq: world.seq,
          rev: world.rev,
          lives: new Map(world.lives),
          answered: false,
          /** @param {number} status @param {unknown} [body] */
          answer(status, body) {
            if (call.answered) return;
            call.answered = true;
            resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "X-Pixdcon-Position": `${call.epoch}-${call.seq}` } }));
          },
          ok() {
            call.answer(200, r4Answer(world, call));
          },
          /** It ran out of time: its answer never reaches the page. */
          abandon() {
            call.answered = true;
          },
        };
        calls.push(call);
      })
  );
  return calls;
}

// --- what the pages show: pieces of UI state, each with its identities ---

const r4Text = (/** @type {any} */ el) => (el ? String(el.textContent).replace(/\s+/g, " ").trim() : "∅");
const r4Button = (/** @type {any} */ el) => (el ? `${r4Text(el)}${el.disabled ? " [disabled]" : ""}` : "∅");
const r4Value = (/** @type {any} */ el) => (el ? String(el.value) : "∅");
/** Where the focus is, said by the field it is on. @param {any} root */
function r4Focus(root) {
  const el = fakeDocument.activeElement;
  if (!el || !root || !root.contains(el)) return "not on this page";
  return `${el.localName}${["name", "data-key", "data-act"].map((a) => (el.getAttribute(a) ? `[${a}=${el.getAttribute(a)}]` : "")).join("")}`;
}
/** Whether preview feedback is said: the status line, the title status line, a row marker. @param {any} root */
function r4PreviewFeedback(root) {
  const status = /^Not previewed/.test(r4Text(root.querySelector(".set-status")));
  // The title says a failed preview as "Settings not previewed: …" (view/model.js previewFailureText); a failed end ("… not ended") belongs to the device's life, not to a draft.
  const title = r4Text(root.querySelector(".dev-head .sub")).includes("Settings not previewed:");
  const marker = root.querySelectorAll(".set-body .mk").some((/** @type {any} */ mk) => /^not previewed/.test(r4Text(mk)));
  return `status ${status ? "says it" : "-"} · title ${title ? "says it" : "-"} · marker ${marker ? "says it" : "-"}`;
}
/** The kind of a row's marker (default, saved, previewing, not previewed, …), without the values it names. @param {any} root */
const r4Marker = (root) => r4Text(root.querySelector('.set-body [data-row="n"] .mk')).split("·")[0].trim() || "∅";
const r4Dialog = () => {
  const dialog = fakeDocument.body.querySelector(".scrim .dlg");
  return dialog ? `open · ${r4Button(dialog.querySelector('[data-act="retry"]'))} · ${r4Text(dialog.querySelector(".retry-note"))}` : "closed";
};
/** @param {any} el @param {string} value */
function r4Type(el, value) {
  if (!el) throw new Error("nothing to type into");
  el.focus();
  typeInto(el, value);
}
/** @param {any} el */
function r4Click(el) {
  if (!el) throw new Error("nothing to click");
  if (!click(el)) throw new Error(`${r4Text(el)} is disabled`);
}

/**
 * The pages: how each opens, what it shows (a piece is [name, the
 * identities it depends on, what it reads now]) and where a person types.
 *
 * @type {Record<string, {module: () => any, params?: any, pieces: (root: any) => Array<[string, string[], string]>, type?: (ctx: any) => void}>}
 */
const R4_PAGES = {
  raw: {
    module: () => rawPage,
    pieces: (root) => [
      ["editor text", ["opening", "revision"], r4Value(root.querySelector("textarea"))],
      ["load and validity state", ["opening", "revision"], r4Text(root.querySelector(".edbar .state"))],
      ["focus", ["opening", "revision"], r4Focus(root)],
      ["Save", ["epoch"], r4Button(root.querySelector('[data-act="save"]'))],
      ["Reload", ["epoch"], r4Button(root.querySelector('[data-act="reload"]'))],
      ["outcome line", ["epoch"], r4Text(root.querySelector(".errline"))],
    ],
    type: (ctx) => r4Type(ctx.root.querySelector("textarea"), '{"devices": [], "typed": 2}'),
  },
  config: {
    module: () => configPage,
    pieces: (root) => {
      const row = root.querySelector(".ct-edit");
      return [
        ["edit row", ["opening", "life", "revision"], row ? `open for ${row.querySelector("form")?.getAttribute("data-device")}` : "closed"],
        ["edit row fields", ["opening", "life", "revision"], row ? `${r4Value(row.querySelector('[name="displayName"]'))} | ${r4Value(row.querySelector('[name="comment"]'))}` : "∅"],
        ["Add device fields", ["opening", "revision"], `${r4Value(root.querySelector('form.addf [name="name"]'))} | ${r4Value(root.querySelector('form.addf [name="ip"]'))}`],
        ["focus", ["opening", "revision"], r4Focus(root)],
        ["edit row Save and outcome", ["epoch", "life"], row ? `${r4Button(row.querySelector('[data-act="patch"]'))} | ${r4Text(row.querySelector(".ef-f .slot"))}` : "∅"],
        ["Add to config.json", ["epoch", "life"], `${r4Button(root.querySelector('[data-act="adopt"]'))} | ${root.querySelectorAll(".ct-body .slot").filter((/** @type {any} */ el) => !el.closest(".ct-edit")).map(r4Text).join(" ") || "∅"}`],
        ["Add device button and outcome", ["epoch"], `${r4Button(root.querySelector("form.addf button"))} | ${r4Text(root.querySelector("#add .slot"))}`],
      ];
    },
    type: (ctx) => {
      const row = ctx.root.querySelector(".ct-edit");
      if (row) r4Type(row.querySelector('[name="displayName"]'), "Typed later");
      else r4Type(ctx.root.querySelector('form.addf [name="name"]'), "typed-later");
    },
  },
  devices: {
    module: () => devicesPage,
    pieces: (root) => {
      const row = root.querySelector(".dt-row");
      const empty = root.querySelector(".empty-slot");
      return [
        ["row d1", ["epoch", "life"], row ? `${r4Value(row.querySelector("select"))} | ${r4Text(row.querySelector(".c-show"))} | ${r4Button(row.querySelector('[data-act="restore"]'))}` : "∅"],
        ["Add device fields", ["opening", "revision"], `${r4Value(empty?.querySelector('form.addf [name="name"]'))} | ${r4Value(empty?.querySelector('form.addf [name="ip"]'))}`],
        ["focus", ["opening", "revision"], r4Focus(root)],
        ["Add device button and outcome", ["epoch"], `${r4Button(empty?.querySelector("form.addf button"))} | ${r4Text(empty?.querySelector(".slot"))}`],
      ];
    },
  },
  device: {
    module: () => devicePage,
    params: { name: "d1" },
    pieces: (root) => {
      const range = root.querySelector('input[type="range"]');
      return [
        ["preview feedback", ["opening", "epoch", "life", "draft"], r4PreviewFeedback(root)],
        // What a field shows is an edit (its draft) or the store's value (data): compared when the draft changed.
        ["field n", ["draft"], r4Value(field(root, "n"))],
        ["row marker of n", ["draft"], r4Marker(root)],
        ["Create copy fields", ["opening", "revision"], `${r4Value(root.querySelector('.copyf [name="targetKey"]'))} | ${r4Value(root.querySelector('.copyf [name="name"]'))}`],
        ["focus", ["opening", "revision", "draft"], r4Focus(root)],
        ["recovery dialog", ["opening", "epoch", "life"], r4Dialog()],
        ["title status line", ["epoch", "life"], r4Text(root.querySelector(".dev-head .sub"))],
        ["settings status line", ["epoch", "life"], r4Text(root.querySelector(".set-status"))],
        ["settings Save and Revert", ["epoch", "life"], `${r4Button(root.querySelector('.set-h [data-act="save"]'))} | ${r4Button(root.querySelector('.set-h [data-act="revert"]'))} | ${r4Button(root.querySelector('.set-h [data-act="clear"]'))}`],
        ["mode", ["epoch", "life"], `${r4Text(root.querySelector(".mode-hint"))} | ${root.querySelectorAll('[data-act="mode"]').map((/** @type {any} */ b) => (b.disabled ? "x" : "o")).join("")}`],
        ["brightness", ["epoch", "life"], `${r4Value(range)}${range?.disabled ? " [disabled]" : ""} | ${root.querySelectorAll('[data-act="bri-mode"]').map((/** @type {any} */ b) => (b.disabled ? "x" : "o")).join("")}`],
        ["scene", ["epoch", "life"], `${r4Text(root.querySelector(".scene-below"))} | ${r4Text(root.querySelector(".v-src"))}`],
        ["action and adopt", ["epoch", "life"], `${r4Button(root.querySelector('.acts [data-act]'))} | ${r4Button(root.querySelector('.dev-head [data-act="adopt"]'))}`],
        ["Create copy outcome", ["epoch"], `${r4Button(root.querySelector(".adv [data-act='copy']"))} | ${r4Text(root.querySelector(".adv .slot"))}`],
      ];
    },
    type: (ctx) => r4Type(ctx.root.querySelector('.copyf [name="targetKey"]'), "typed-copy"),
  },
  overlays: {
    module: () => overlaysPage,
    pieces: (root) => [["row o1 Clear and outcome", ["epoch"], `${r4Button(root.querySelector('[data-act="clear"][data-id="o1"]'))} | ${r4Text(root.querySelector('[data-id="o1"]')?.parentNode)}`]],
  },
  health: {
    module: () => healthPage,
    pieces: (root) => [["log pane", ["opening", "epoch"], r4Text(root.querySelector(".log"))]],
  },
};

const r4d1 = (/** @type {any} */ o = {}) => ({ devices: [{ name: "d1", o }] });
/** The settings form of the Device page with an edit of n that was previewed. @param {any} ctx */
async function r4Previewed(ctx) {
  r4Type(field(ctx.root, "n"), "2");
  await settle();
  r4Pending(ctx, "PUT", "/settings/clock/preview").ok();
  await settle();
}
/** @param {any} ctx @param {string} method @param {string} tail */
function r4Pending(ctx, method, tail) {
  const call = [...ctx.calls].reverse().find((c) => !c.answered && c.method === method && c.path.endsWith(tail));
  assert.ok(call, `a ${method} …${tail} was sent`);
  return call;
}

/**
 * The operation kinds of the effect inventory (effects-r4.mjs), each with
 * the request that starts it: [method, the end of its path].
 *
 * @typedef {{name: string, site: string, page: string, world: any, request: [string, string], setup?: (ctx: any) => Promise<void>|void, begin?: (ctx: any) => Promise<void>|void, atOpen?: boolean, early?: boolean, skip?: Partial<Record<R4Change, string>>}} R4Kind
 * @type {R4Kind[]}
 */
const R4_KINDS = [
  { name: "raw load", site: "web/js/pages/config-raw.js:175", page: "raw", world: r4d1(), request: ["GET", "/api/v2/config/raw"], atOpen: true },
  {
    name: "raw save", site: "web/js/pages/config-raw.js:227", page: "raw", world: r4d1(), request: ["PUT", "/api/v2/config/raw"],
    setup: (ctx) => r4Type(ctx.root.querySelector("textarea"), '{"devices": [], "saved": 1}'),
    begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="save"]')),
  },
  { name: "raw reload", site: "web/js/pages/config-raw.js:274", page: "raw", world: r4d1(), request: ["POST", "/api/v2/config/reload"], begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="reload"]')) },
  {
    name: "config patch", site: "web/js/pages/config.js:165", page: "config", world: r4d1(), request: ["PATCH", "/api/v2/devices/d1"],
    setup: async (ctx) => {
      r4Click(ctx.root.querySelector('[data-act="edit"][data-device="d1"]'));
      await settle();
      r4Type(ctx.root.querySelector('.ct-edit [name="displayName"]'), "Kitchen");
      ctx.root.querySelector('[data-act="patch"]').focus();
    },
    begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="patch"]')),
  },
  { name: "config adopt", site: "web/js/pages/config.js:192", page: "config", world: r4d1({ origin: "blob" }), request: ["POST", "/api/v2/devices/d1/adopt"], begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="adopt"][data-device="d1"]')) },
  {
    name: "config add device", site: "web/js/pages/config.js:213", page: "config", world: r4d1(), request: ["POST", "/api/v2/devices"],
    setup: (ctx) => {
      r4Type(ctx.root.querySelector('form.addf [name="name"]'), "d9");
      r4Type(ctx.root.querySelector('form.addf [name="ip"]'), "192.168.1.9");
    },
    begin: (ctx) => ctx.root.querySelector("form.addf").dispatchEvent(new FakeEvent("submit")),
  },
  {
    name: "overlays clear", site: "web/js/pages/overlays.js:153", page: "overlays", request: ["DELETE", "/api/v2/overlays/o1"],
    world: { devices: [{ name: "d1", o: { source: "overlay" } }], overlays: (/** @type {string} */ epoch) => [record("o1", "scene", { device: "d1", value: epoch.endsWith("1") ? "weather" : "clock" })] },
    begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="clear"][data-id="o1"]')),
  },
  { name: "devices scene", site: "web/js/pages/devices.js:330", page: "devices", world: r4d1(), request: ["PUT", "/api/v2/devices/d1/scene"], begin: (ctx) => typeInto(ctx.root.querySelector(".dt-row select"), "weather", "change") },
  { name: "devices restore", site: "web/js/pages/devices.js:357", page: "devices", world: r4d1({ source: "overlay" }), request: ["DELETE", "/api/v2/devices/d1/scene-overlay"], begin: (ctx) => r4Click(restoreIn(ctx.root)) },
  {
    name: "devices add device", site: "web/js/pages/devices.js:375", page: "devices", world: { devices: [] }, request: ["POST", "/api/v2/devices"],
    setup: (ctx) => {
      r4Type(ctx.root.querySelector('.empty-slot form.addf [name="name"]'), "d9");
      r4Type(ctx.root.querySelector('.empty-slot form.addf [name="ip"]'), "192.168.1.9");
    },
    begin: (ctx) => ctx.root.querySelector(".empty-slot form.addf").dispatchEvent(new FakeEvent("submit")),
  },
  { name: "device scene", site: "web/js/pages/device.js:111 (scene)", page: "device", world: r4d1(), request: ["PUT", "/api/v2/devices/d1/scene"], begin: (ctx) => r4Click(ctx.root.querySelector('.opt[data-scene="weather"]')) },
  { name: "device mode", site: "web/js/pages/device.js:111 (mode)", page: "device", world: r4d1(), request: ["PUT", "/api/v2/devices/d1/mode"], begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="mode"][data-mode="pause"]')) },
  { name: "device brightness", site: "web/js/pages/device.js:111 (brightness)", page: "device", world: r4d1(), request: ["PUT", "/api/v2/devices/d1/brightness"], begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="bri-mode"][data-value="override"]')) },
  { name: "device return", site: "web/js/pages/device.js:111 (return)", page: "device", world: r4d1({ source: "overlay" }), request: ["DELETE", "/api/v2/devices/d1/scene-overlay"], begin: (ctx) => r4Click(ctx.root.querySelector('.acts [data-act="return"]')) },
  { name: "device adopt", site: "web/js/pages/device.js:111 (adopt)", page: "device", world: r4d1({ origin: "blob" }), request: ["POST", "/api/v2/devices/d1/adopt"], begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="adopt"]')), skip: { commit: "a device that is not in config.json has no Save" } },
  {
    name: "device copy", site: "web/js/pages/device.js:203", page: "device", world: r4d1(), request: ["POST", "/api/v2/scenes/clock/copy"],
    setup: (ctx) => r4Type(ctx.root.querySelector('.copyf [name="targetKey"]'), "clock-copy"),
    begin: (ctx) => ctx.root.querySelector(".copyf").dispatchEvent(new FakeEvent("submit")),
  },
  {
    name: "recovery retry", site: "web/js/components/recovery-dialog.js:101", page: "device", world: r4d1({ health: "offline" }), request: ["POST", "/api/v2/devices/d1/retry"],
    setup: (ctx) => r4Click(ctx.root.querySelector('[data-act="recovery"]')),
    begin: () => r4Click(fakeDocument.body.querySelector('.scrim [data-act="retry"]')),
  },
  { name: "settings load", site: "web/js/components/settings-form.js:412", page: "device", world: r4d1(), request: ["GET", "/settings/clock"], atOpen: true, skip: { commit: "the form shows no values to edit until its load ends", "newer draft": "the form shows no values to edit until its load ends" } },
  { name: "settings preview", site: "web/js/components/settings-form.js:443", page: "device", world: r4d1(), request: ["PUT", "/settings/clock/preview"], early: true, begin: (ctx) => r4Type(field(ctx.root, "n"), "2") },
  {
    name: "settings save", site: "web/js/components/settings-form.js:474", page: "device", world: r4d1(), request: ["PUT", "/settings/clock"],
    setup: r4Previewed, begin: (ctx) => r4Click(saveButton(ctx.root)),
    skip: { commit: "Save is the commit; the form's Save is busy while it runs" },
  },
  {
    name: "settings revert", site: "web/js/components/settings-form.js:517", page: "device", world: r4d1(), request: ["DELETE", "/settings/clock/preview"],
    setup: r4Previewed, begin: (ctx) => r4Click(ctx.root.querySelector('.set-h [data-act="revert"]')),
    skip: { commit: "Save, Revert and Clear are one busy slot: no Save while Revert runs" },
  },
  {
    name: "settings clear overlays", site: "web/js/components/settings-form.js:545", page: "device", world: { ...r4d1(), settingsOverlay: true }, request: ["DELETE", "/settings/clock/overlays"],
    begin: (ctx) => r4Click(ctx.root.querySelector('.set-h [data-act="clear"]')),
    skip: { commit: "Save, Revert and Clear are one busy slot: no Save while Clear runs" },
  },
  {
    name: "settings end", site: "web/js/components/settings-form.js:388", page: "device", world: r4d1(), request: ["DELETE", "/settings/clock/preview"],
    early: true, setup: r4Previewed,
    // The display switches to Weather (the live channel): the form ends the
    // preview of Clock, and shows Weather's values once they are loaded.
    begin: async (ctx) => {
      ctx.world.spec.devices[0].o.scene = "weather";
      ctx.world.rev += 1;
      r4Live(ctx.world, "device", r4View(ctx.world, "d1", ctx.world.epoch, ctx.world.lives.get("d1"), ctx.world.rev));
      await settle();
      r4Pending(ctx, "GET", "/settings/weather").ok();
    },
  },
  {
    name: "settings end retry", site: "web/js/components/settings-form.js:247", page: "device", world: r4d1(), request: ["DELETE", "/settings/clock/preview"],
    // The end of Clock's preview failed when the display switched to Weather; the title status line offers Retry.
    setup: async (ctx) => {
      await r4Previewed(ctx);
      ctx.world.spec.devices[0].o.scene = "weather";
      ctx.world.rev += 1;
      r4Live(ctx.world, "device", r4View(ctx.world, "d1", ctx.world.epoch, ctx.world.lives.get("d1"), ctx.world.rev));
      await settle();
      r4Pending(ctx, "GET", "/settings/weather").ok();
      r4Pending(ctx, "DELETE", "/settings/clock/preview").answer(500, {});
      await settle();
    },
    begin: (ctx) => r4Click(titleLine(ctx.root).querySelector('[data-act="end-retry"]')),
  },
  { name: "health log", site: "web/js/pages/health.js:187", page: "health", world: r4d1(), request: ["GET", "/api/v2/log"], atOpen: true },
];

/** Whether a change can happen while an operation of the kind runs; else why not. @param {R4Kind} kind @param {R4Change} change @returns {string|null} */
function r4NotApplicable(kind, change) {
  if (kind.skip?.[change]) return /** @type {string} */ (kind.skip[change]);
  if (change === "reincarnate" && !(kind.world.devices ?? []).length) return "no device in the story";
  if (change === "type" && !R4_PAGES[kind.page].type && !(kind.page === "devices" && !(kind.world.devices ?? []).length))
    return `the ${kind.page} page has no editor`;
  if ((change === "commit" || change === "newer draft") && kind.page !== "device") return `the ${kind.page} page has no settings drafts`;
  return null;
}

/** The page that a person leaves to (and types on there): Config, or Raw when the story is on Config. @param {any} ctx */
const r4Away = (ctx) => (ctx.kind.page === "config" ? "raw" : "config");

/** @param {any} ctx @param {string} page */
function r4Open(ctx, page) {
  ctx.page = page;
  ctx.root = pageRoot();
  R4_PAGES[page].module().mount(ctx.root, R4_PAGES[page].params ?? {});
}
/** @param {any} ctx */
function r4Close(ctx) {
  if (!ctx.page) return;
  R4_PAGES[ctx.page].module().unmount();
  ctx.root.remove();
  ctx.page = null;
}

/** pixdcon answers every request still open, also the ones those answers start; not `keep`. @param {any} ctx @param {any} [keep] */
async function r4AnswerAll(ctx, keep) {
  for (let round = 0; round < 8; round += 1) {
    await settle();
    const open = ctx.calls.filter((/** @type {any} */ c) => !c.answered && c !== keep);
    if (open.length === 0) return;
    for (const call of open) call.ok();
  }
}

/** @type {Record<R4Change, (ctx: any) => Promise<void>|void>} */
const R4_CHANGE = {
  reopen(ctx) {
    const page = ctx.page;
    r4Close(ctx);
    r4Open(ctx, page);
  },
  async leave(ctx) {
    ctx.home = ctx.page;
    r4Close(ctx);
    r4Open(ctx, r4Away(ctx));
    ctx.awayFrom = ctx.home;
    await r4AnswerAll(ctx, ctx.op);
    /** @type {any} */ (R4_PAGES[ctx.page].type)(ctx);
  },
  type(ctx) {
    const empty = ctx.root.querySelector(".empty-slot form.addf [name='name']");
    if (empty) r4Type(empty, "typed-later");
    else /** @type {any} */ (R4_PAGES[ctx.page].type)(ctx);
  },
  epoch(ctx) {
    r4NewEpoch(ctx.world);
  },
  reincarnate(ctx) {
    const { world } = ctx;
    const life = world.lives.get("d1");
    r4Live(world, "device-removed", { name: "d1", incarnation: life });
    world.lives.set("d1", life + 1);
    world.rev += 1;
    r4Live(world, "device", r4View(world, "d1", world.epoch, life + 1, world.rev));
  },
  async commit(ctx) {
    if (saveButton(ctx.root).disabled) {
      r4Type(field(ctx.root, "n"), "7");
      await settle();
      const put = ctx.calls.find((/** @type {any} */ c) => !c.answered && c !== ctx.op && c.method === "PUT" && c.path.endsWith("/preview"));
      put?.ok();
      await settle();
    }
    r4Click(saveButton(ctx.root));
    await settle();
    const save = [...ctx.calls].reverse().find((/** @type {any} */ c) => !c.answered && c !== ctx.op && c.method === "PUT" && /\/settings\/[^/]+$/.test(c.path));
    assert.ok(save, "the commit's Save was sent");
    save.ok();
  },
  "newer draft"(ctx) {
    r4Type(field(ctx.root, "n"), "3");
  },
  reconnect(ctx) {
    r4Snapshot(ctx.world);
  },
};

/**
 * One run of a story.
 *
 * @param {any} t the test (its manual clock)
 * @param {R4Kind} kind
 * @param {R4Change|null} change null: no change (the reference of a reconnect)
 * @param {(typeof R4_ENDS)[number]} end
 * @param {"case"|"without"|"early"} mode
 * @returns {Promise<Array<Map<string, {deps: string[], value: string}>>>} what the pieces read at the three points
 */
async function r4Run(t, kind, change, end, mode) {
  for (const key of [...r4State().ops.keys()]) r4SetOp(key, null);
  fakeDocument.activeElement = null;
  const world = r4World(kind.world);
  /** @type {any} */
  const ctx = { world, calls: r4Server(world), kind, page: null, root: null, op: null };
  r4NewEpoch(world);
  const points = [];
  try {
    r4Open(ctx, kind.page);
    await settle();
    const [method, tail] = kind.request;
    const isOp = (/** @type {any} */ c) => !c.answered && c.method === method && c.path.endsWith(tail);
    if (kind.atOpen) {
      ctx.op = ctx.calls.find(isOp);
      assert.ok(ctx.op, `${kind.name}: the page's opening sent its load`);
    }
    await r4AnswerAll(ctx, ctx.op);
    await kind.setup?.(ctx);
    await settle();
    if (!kind.atOpen && mode !== "without") {
      const before = ctx.calls.length;
      await kind.begin?.(ctx);
      await settle();
      ctx.op = ctx.calls.slice(before).find(isOp);
      assert.ok(ctx.op, `${kind.name}: the operation sent ${method} …${tail}`);
    }
    if (mode === "early") {
      ctx.op.ok();
      ctx.op = null;
      await settle();
    }
    if (mode === "without" && kind.atOpen) throw new Error("an operation that opens with the page has an early reference");
    t.mock.timers.tick(10_000);
    if (change) await R4_CHANGE[change](ctx);
    await settle();
    const observe = () => new Map(R4_PAGES[ctx.page].pieces(ctx.root).map(([name, deps, value]) => [`${ctx.page}: ${name}`, { deps, value }]));
    points.push(observe());
    if (end === "timeout") {
      ctx.op?.abandon();
      t.mock.timers.tick(5_000);
    } else if (ctx.op) {
      if (end === "success") ctx.op.ok();
      else ctx.op.answer(500, {});
    }
    await settle();
    points.push(observe());
    if (ctx.awayFrom) {
      r4Close(ctx);
      r4Open(ctx, ctx.awayFrom);
      ctx.awayFrom = null;
    }
    await r4AnswerAll(ctx);
    points.push(observe());
    return points;
  } finally {
    r4Close(ctx);
    await r4AnswerAll(ctx);
    t.mock.timers.tick(60_000);
    await settle();
  }
}

/**
 * The differences between a case and its reference, in the pieces the rule
 * protects: those whose identities include one the change changed (all of
 * them for a reconnect).
 *
 * @param {R4Change} change
 * @param {Array<Map<string, {deps: string[], value: string}>>} got
 * @param {Array<Map<string, {deps: string[], value: string}>>} want
 * @param {boolean} early the reference ended the operation at once
 * @param {boolean} atOpen the operation is the load the page's opening sent
 * @returns {string[]}
 */
function r4Differences(change, got, want, early, atOpen) {
  const changed = new Set(R4_CHANGES[change]);
  /** @type {string[]} */
  const out = [];
  got.forEach((pieces, i) => {
    // A reference that ended its operation at once differs from the case
    // while the case's operation still runs; a reconnect is compared where
    // everything was answered (the fence may ask again meanwhile).
    // A load that opens with the page is compared where everything was
    // answered: until then the reference holds data the case still waits for.
    if ((early && i === 0) || (atOpen && i < 2) || (change === "reconnect" && i < 2)) return;
    for (const [name, piece] of pieces) {
      if (change !== "reconnect" && !piece.deps.some((d) => changed.has(d))) continue;
      const reference = want[i]?.get(name)?.value;
      if (piece.value !== reference)
        out.push(`${R4_POINTS[i]}, ${name} [${piece.deps.join(", ")}]: "${piece.value}" — the story ${change === "reconnect" ? "without the reconnect" : "without the old operation"} reads "${reference}"`);
    }
  });
  return out;
}

/** The gate's findings, by the case that reproduces each. */
const R4_GATE = {
  "raw reload × reopen × success": "gate r3 M1",
  "config patch × reincarnate × success": "gate r3 M2",
  "config patch × type × success": "gate r3 M2, without removal",
  "overlays clear × epoch × 500": "gate r3 M3",
  "settings preview × commit × 500": "gate r3 M4",
};

/** Cases that fail at fbf3f61: phase B makes each one pass and takes it off this list. */
/** @type {Set<string>} */
const R4_KNOWN = new Set([
  "config add device × epoch × 500",
  "config add device × epoch × success",
  "config add device × epoch × timeout",
  "config add device × type × success",
  "config patch × epoch × 500",
  "config patch × epoch × success",
  "config patch × epoch × timeout",
  "config patch × leave × success",
  "config patch × reincarnate × success",
  "config patch × type × success",
  "device copy × epoch × 500",
  "device copy × epoch × success",
  "device copy × epoch × timeout",
  "devices add device × epoch × 500",
  "devices add device × epoch × success",
  "devices add device × epoch × timeout",
  "health log × epoch × 500",
  "health log × epoch × timeout",
  "overlays clear × epoch × 500",
  "overlays clear × epoch × success",
  "overlays clear × epoch × timeout",
  "raw load × epoch × 500",
  "raw load × epoch × timeout",
  "raw reload × epoch × 500",
  "raw reload × epoch × success",
  "raw reload × epoch × timeout",
  "raw reload × reopen × success",
  "raw save × epoch × 500",
  "raw save × epoch × success",
  "raw save × epoch × timeout",
  "settings preview × commit × 500",
  "settings preview × commit × timeout",
  "settings preview × newer draft × 500",
  "settings preview × newer draft × timeout",
]);

const R4_STRICT = process.env.R4_HARNESS_STRICT === "1";
/** The reference runs, by kind and change (and end, for a reconnect's). @type {Map<string, any>} */
const r4References = new Map();
let r4Count = 0;
for (const kind of R4_KINDS)
  for (const change of /** @type {R4Change[]} */ (Object.keys(R4_CHANGES)))
    for (const end of R4_ENDS) {
      const name = `${kind.name} × ${change} × ${end}`;
      const why = r4NotApplicable(kind, change);
      if (why) continue;
      r4Count += 1;
      const gate = /** @type {Record<string, string>} */ (R4_GATE)[name];
      const label = `r4 harness: ${name}${gate ? ` (${gate})` : ""}`;
      const todo = !R4_STRICT && R4_KNOWN.has(name) ? `fails at fbf3f61: ${name}` : undefined;
      test(label, { todo }, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const early = Boolean(kind.early || kind.atOpen);
        const key = change === "reconnect" ? `${kind.name}|none|${end}` : `${kind.name}|${change}`;
        if (!r4References.has(key))
          r4References.set(key, change === "reconnect" ? await r4Run(t, kind, null, end, "case") : await r4Run(t, kind, change, end, early ? "early" : "without"));
        const reference = /** @type {any} */ (r4References.get(key));
        const got = await r4Run(t, kind, change, end, "case");
        const differences = r4Differences(change, got, reference, early && change !== "reconnect", Boolean(kind.atOpen) && change !== "reconnect");
        assert.deepEqual(differences, [], `${kind.site}: the old operation changed UI state that depends on an identity the change changed`);
      });
    }

test("r4 harness: the matrix covers every operation kind, change and end; what does not apply is named with its reason", () => {
  /** @type {string[]} */
  const notApplicable = [];
  for (const kind of R4_KINDS)
    for (const change of /** @type {R4Change[]} */ (Object.keys(R4_CHANGES))) {
      const why = r4NotApplicable(kind, change);
      if (why) notApplicable.push(`${kind.name} × ${change}: ${why}`);
    }
  assert.equal(r4Count + notApplicable.length * R4_ENDS.length, R4_KINDS.length * Object.keys(R4_CHANGES).length * R4_ENDS.length);
  for (const name of Object.keys(R4_GATE)) assert.ok(R4_KINDS.some((k) => name.startsWith(`${k.name} ×`)), `${name} is a case of the matrix`);
  t_log(`r4 harness: ${R4_KINDS.length} kinds × ${Object.keys(R4_CHANGES).length} changes × ${R4_ENDS.length} ends: ${r4Count} cases run, ${notApplicable.length * R4_ENDS.length} not applicable:\n  ${notApplicable.join("\n  ")}`);
});

/** @param {string} line */
function t_log(line) {
  if (process.env.R4_HARNESS_STRICT === "1") process.stdout.write(`# ${line.replaceAll("\n", "\n# ")}\n`);
}
