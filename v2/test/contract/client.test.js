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
import { AsyncLocalStorage } from "node:async_hooks";
import test, { mock } from "node:test";
import { functions as r8Functions, requestSites as r8RequestSites, sourceAnchor as r8SourceAnchor, structure as r8Structure, syntax as r8Syntax, walk as r8Walk } from "./harness-r8.js";
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

let fakeDomRevision = 0;
/** @type {WeakMap<FakeElement, {revision: number, one: Map<string, FakeElement|null>, all: Map<string, FakeElement[]>}>} */
const fakeQueryResults = new WeakMap();
/** Cache only until the next tree/attribute change. @param {FakeElement} element */
function fakeQueryCache(element) {
  let cache = fakeQueryResults.get(element);
  if (!cache || cache.revision !== fakeDomRevision) {
    cache = { revision: fakeDomRevision, one: new Map(), all: new Map() };
    fakeQueryResults.set(element, cache);
  }
  return cache;
}

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
  /** Whether focus can return to this browser node after a dialog closes. @returns {boolean} */
  get isConnected() {
    return this === fakeDocument.body || Boolean(this.parentNode?.isConnected);
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
      fakeDomRevision += 1;
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
    fakeDomRevision += 1;
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
 * Parsed selectors, by their text. A selector is parsed once: the parse is
 * read and never changed, and the pages ask for the same few selectors on
 * every element of every render (r4: half of the harness's time went here).
 *
 * @type {Map<string, Array<Array<{combinator: string, tag: string|null, id: string|null, classes: string[], attrs: Array<{name: string, value?: string}>}>>>}
 */
const parsedSelectors = new Map();
/** Read-only class-token sets, shared by equal class attributes. @type {Map<string, Set<string>>} */
const fakeClassTokens = new Map();

/**
 * @param {string} selector
 * @returns {Array<Array<{combinator: string, tag: string|null, id: string|null, classes: string[], attrs: Array<{name: string, value?: string}>}>>}
 */
function parseSelector(selector) {
  let parsed = parsedSelectors.get(selector);
  if (!parsed) {
    parsed = parseSelectorText(selector);
    parsedSelectors.set(selector, parsed);
  }
  return parsed;
}

/**
 * @param {string} selector
 * @returns {Array<Array<{combinator: string, tag: string|null, id: string|null, classes: string[], attrs: Array<{name: string, value?: string}>}>>}
 */
function parseSelectorText(selector) {
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
  if (part.classes.length) {
    const text = element.className;
    let classes = fakeClassTokens.get(text);
    if (!classes) { classes = new Set(text.split(/\s+/)); fakeClassTokens.set(text, classes); }
    for (const cls of part.classes) if (!classes.has(cls)) return false;
  }
  for (const attr of part.attrs) {
    const value = element.getAttribute(attr.name);
    if (value === null || (attr.value !== undefined && value !== attr.value)) return false;
  }
  return true;
}

/** Compile once per query instead of reparsing the selector for every node.
 * Matching still reads each node's current attributes and ancestors.
 * @param {string} selector @returns {(element: FakeElement) => boolean} */
function r7SelectorTest(selector) {
  const sequences = parseSelector(selector);
  const match = selector.includes(":not(")
    ? (/** @type {FakeElement} */ element) => element.matches(selector)
    : (/** @type {FakeElement} */ element) => sequences.some((sequence) => matchesSequence(element, sequence, sequence.length - 1));
  if (process.env.R7_MATCH_COMPARE !== "1") return match;
  return (element) => {
    const found = match(element);
    assert.equal(found, element.matches(selector), `compiled selector preserves ${selector}`);
    r7MatchesCompared += 1;
    return found;
  };
}
let r7MatchesCompared = 0;
process.once("exit", () => {
  if (process.env.R7_MATCH_COMPARE === "1") process.stdout.write(`# r7 selector comparisons: ${r7MatchesCompared}\n`);
});

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
  /** @param {string} type @param {{key?: string, shiftKey?: boolean}} [init] */
  constructor(type, init = {}) {
    this.type = type;
    this.key = init.key;
    this.shiftKey = Boolean(init.shiftKey);
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
    this.clientWidth = 320;
    this.clientHeight = 160;
    this.scrollTop = 0;
    this.scrollHeight = 160;
    /** @type {Record<string, any>|null} */
    this._dataset = null;
  }
  /** The browser's dataset object is needed only when accessed. @returns {Record<string, any>} */
  get dataset() {
    if (this._dataset) return this._dataset;
    const element = this;
    const attr = (/** @type {string|symbol} */ prop) =>
      `data-${String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    this._dataset = new Proxy(
      {},
      {
        get: (_, prop) => element.getAttribute(attr(prop)) ?? undefined,
        set: (_, prop, value) => {
          element.setAttribute(attr(prop), String(value));
          return true;
        },
      },
    );
    return this._dataset;
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
    const key = name.toLowerCase(); const next = String(value);
    if (this.attrs.get(key) !== next) fakeDomRevision += 1;
    this.attrs.set(key, next);
  }
  /** @param {string} name */
  removeAttribute(name) {
    if (this.attrs.delete(name.toLowerCase())) fakeDomRevision += 1;
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
  /** @param {string} selector @returns {boolean} */
  matches(selector) {
    if (selector.includes(":not(")) return selector.split(",").some((part) => {
      const omitted = [...part.matchAll(/:not\(([^)]+)\)/g)].map((m) => m[1]);
      return this.matches(part.replace(/:not\([^)]+\)/g, "")) && !omitted.some((not) => this.matches(not));
    });
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
    const cache = fakeQueryCache(this);
    const previous = cache.all.get(selector);
    if (previous) return previous.slice();
    /** @type {FakeElement[]} */
    const found = [];
    const match = r7SelectorTest(selector);
    const walk = (/** @type {FakeElement} */ element) => {
      for (const child of element.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (match(child)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    cache.all.set(selector, found);
    cache.one.set(selector, found[0] ?? null);
    return found.slice();
  }
  /** @param {string} selector @returns {FakeElement|null} */
  querySelector(selector) {
    const cache = fakeQueryCache(this);
    if (cache.one.has(selector)) return cache.one.get(selector) ?? null;
    const match = r7SelectorTest(selector);
    /** Native querySelector stops at the first tree-order match. @param {FakeElement} element @returns {FakeElement|null} */
    const first = (element) => {
      for (const child of element.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (match(child)) return child;
        const found = first(child);
        if (found) return found;
      }
      return null;
    };
    const found = first(this);
    cache.one.set(selector, found);
    return found;
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
//
// Revision r2 (gate r4 on the note, design-note-r4.md "r2 changes"):
//  - three more identities, each a change: the scene definition (schema),
//    the edit-row visit (revisit), config membership; "other field" is a
//    newer draft of another field;
//  - a piece's identities may follow what it says (a slot outcome is not
//    draft feedback); a kind names the changes outside its projection
//    (`commutes`): there the case must end where the story ends when the
//    change comes after the end;
//  - absolute checks beside the comparison: no request for a scope pixdcon
//    no longer holds starts after the change (captured values are
//    inherited); a page whose load belongs to a run loads again in the new
//    one; a kind's invariant (the brightness range) holds while it runs;
//  - per-run data (raw text, display names) and a next render, so a stale
//    write or a late gutter mark shows;
//  - every exclusion is a probe that runs; self-tests run mutated pages
//    (in memory) the harness must catch; the effect inventory is re-run by
//    the suite (section "r4, phase A revision: the effect inventory").
//
// Revision r3 (gate on harness r2, design-note-r4.md "r3 changes"):
//  - a commuted story ("after") is compared in every piece it shows at the
//    end, not only in the pieces of the changed identity: an effect the
//    independence claim promises to keep cannot go missing unseen (M1).
//    Typing into another form of the Device page is compared both ways:
//    by the rule, and as a commuted story, so no outcome is lost to it;
//  - field rejection has its own projection (the scene definition and the
//    edit that was submitted), apart from Save's acknowledgement. pixdcon
//    judges each value by the definition it holds when it processes the
//    request, so answers carry `rejected` maps that are not empty: a preview
//    (200) and a Save (400 invalid_field), each a kind. The definition of
//    Clock changes both ways: it narrows in the first world and widens in
//    the second. After a change of definition, what the form says about each
//    edit that remains is what the current definition says (revalidation),
//    checked whatever the reference shows (M2);
//  - every run of pixdcon has its own log lines: the Health pane holds the
//    current run's lines and none of an earlier run (M3);
//  - `config adopt × revisit` is unreachable as one change only: the story
//    of two changes (membership, then revisit) runs (LOW);
//  - every mutant a gate used is a self-test that must fail.
//
// Revision r4 (gate on harness r3, findings-r5a; design-note-r4.md "r4 changes"):
//  - the scene is an identity with a change of its own: the display shows
//    the other scene, a settings form loads that scene's values, and its n
//    is edited. Every scene has its own definitions, defaults and saved
//    values (kept per device and scene); every run and life of a device has
//    its own name and levels (A);
//  - the story keeps the edits a person typed: each survives with its
//    value, and the body of the next Save carries exactly the ones still to
//    be saved. The pending bookkeeping is compared across a change of
//    definition (B);
//  - the old operation's end alone changes no piece of a changed identity:
//    read in the one run, at the end and at the next render, while what
//    replaced the operation is still out (C);
//  - stories of two changes: a rejected preview, a newer edit pixdcon
//    takes, a commit, then the old rejection (D); a slider that another
//    life or run of the device owns while the first request ends (E);
//  - from the guard-removal sweep (build/w2/guard-sweep-r5b.mjs: every guard
//    of every continuation removed, one at a time): the same stories with
//    the old operation ending last, after the change's own requests were
//    answered and the person carried on in what the page became; an
//    operation whose scope ended starts no request; a request that ran out
//    of time gets its answer after all;
//  - an audit: every identity of the model has data of its own in the
//    stand-in, and is a change of the matrix or a step of a story that runs.
//
// Revision r5 (phase A5, guard-removal closure):
//  - named boundary stories for preview lanes, inherited callbacks, Raw's
//    overlapping loads, live generations, bootstrap and operation ownership;
//  - each story has an in-memory removal that must fail beside its control;
//  - separately named invariant probes justify equivalent/unreachable guards;
//    the sweep reruns them, never counting a source-anchor failure as a kill.
// ---------------------------------------------------------------------------

/** Instrumented requests retain their exact source function for the r7 inventory join. @type {any} */
let r7RequestSource = null;
/** The native registry captures a slot before async work starts. Preserve
 * that owner through awaits/lanes; never guess from the busiest slot.
 * @type {AsyncLocalStorage<any>} */
const r8OperationContext = new AsyncLocalStorage();

/** @type {any} active only during the generated audit histories */
let r7Coverage = null;
// Node may start a name-selected test while later top-level imports are
// still evaluating. Generated runs require the complete extractor inventory.
let r8HarnessLoaded = false;
/** @type {() => void} */ let r8ResolveHarness = () => { throw new Error("harness readiness resolver was not installed"); };
const r8HarnessReady = new Promise((resolve) => { r8ResolveHarness = () => resolve(undefined); });
/** @type {Promise<Record<string, any>>|null} */ let r8MeasuredModules = null;
/** Actual story transitions; independent of the foreign-outcome probes. @type {any[]} */
const r8Stories = [];
/** @type {any} */ let r8ActiveStory = null;
let r8EditIdentity = 0;


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

/**
 * What a change of one identity changes (design note r2, section 1). A
 * change may record more as it runs (`ctx.changed`): a Save on a device that
 * was blob-only adopts it first (membership).
 */
const R4_CHANGES = {
  reopen: ["opening"],
  leave: ["opening"],
  type: ["revision"],
  epoch: ["epoch", "life"],
  reincarnate: ["life"],
  // The display shows another scene (r4, gate r5a A): the form's scope is the scene, in one life of the device.
  scene: ["scene"],
  commit: ["draft"],
  "newer draft": ["draft"],
  "other field": ["draft"],
  schema: ["schema"],
  revisit: ["visit"],
  membership: ["membership"],
  reconnect: [],
};
/** @typedef {keyof typeof R4_CHANGES} R4Change */
/**
 * Single changes that only a story of two changes makes (R4_COMPOSITES): a
 * step that needs the change before it, so it is no change of the matrix.
 *  - "a newer draft pixdcon takes": an edit of n the definition takes (0),
 *    where the matrix's newer draft (3) is one the widening world refuses;
 *  - "the new owner slides": the range of the device's new life, or of the
 *    new run, takes a level (60) and sends it: another owner of the slider.
 *
 * @type {Record<string, string[]>}
 */
const R4_STEPS = {
  "a newer draft pixdcon takes": ["draft"],
  "the new owner slides": ["owner"],
  "equal value retyped": ["draft"],
  "value changed away and back": ["draft"],
  "reset replaced by an edit": ["draft"],
  "reset replaced by equal default": ["draft"],
  "another field reset": ["draft"],
  "newer config in the same epoch": ["resource"],
  "replacement overlay id": ["overlay"],
  "superseded by Reload": ["token"],
  "same stream epoch": ["epoch"],
  "leave without editing": ["opening"],
  "equal editor value": ["revision"],
  "replace current operation": ["token"],
  "same value slider input": ["owner"],
  "newer config position": ["resource"],
};
const R4_ENDS = /** @type {const} */ (["success", "500", "timeout"]);
/** @typedef {(typeof R4_ENDS)[number] | "refused"} R4End */
/**
 * Where a story is observed. The third point is r4's: the next render after
 * the old operation ended, while whatever the change started in its place is
 * still out. What the old end left in the page's own state without drawing
 * it (a failure's cleanup runs after the slot was written) shows there.
 */
const R4_POINTS = ["after the change", "after the end", "after the end, at the next render", "after everything was answered"];
const R4_LAST = R4_POINTS.length - 1;
/** config.json as pixdcon gives it: distinguishable per run, so a text of another run shows. @param {string} epoch */
const R4_RAW = (epoch, version = 1) => version === 1 ? `{"devices": [], "run": "${epoch}"}` : `{"devices": [], "run": "${epoch}", "version": ${version}}`;
/**
 * The scene definition of Clock: two fields, so a Save of one with an edit
 * of the other typed meanwhile is a story. n has a range: pixdcon judges a
 * value of n by the definition it holds when it processes the request.
 */
const R4_SCHEMA = {
  n: { type: "int", label: "N", group: "General", description: "", default: 1, min: 0, max: 50, placeholder: "" },
  m: { type: "int", label: "M", group: "General", description: "", default: 1, placeholder: "" },
};
/**
 * The definition after pixdcon took a changed scene file (same run, life,
 * scene and draft): n relabelled and its range narrowed, a field more. An
 * edit of n the first definition took (2, 3, 7) is one this one refuses.
 */
const R4_SCHEMA_2 = {
  ...R4_SCHEMA,
  n: { ...R4_SCHEMA.n, label: "N (new)", max: 1 },
  k: { type: "int", label: "K", group: "General", description: "", default: 5, placeholder: "" },
};
/**
 * The other way round (gate note2 M2): a first definition that refuses the
 * edit n = 2, and the one pixdcon takes after it, which takes n = 2.
 */
const R4_CLOCK_WIDENING = [
  { ...R4_SCHEMA, n: { ...R4_SCHEMA.n, max: 1 } },
  { ...R4_SCHEMA_2, n: { ...R4_SCHEMA_2.n, max: 50 } },
];
/**
 * Weather's own definition (r4, gate r5a A): the same keys as Clock's, so
 * the same rows are read, with its own labels, defaults and ranges, so what
 * a form shows of one scene is told apart from the other's. 9 is an edit of
 * n that only Weather's first definition takes in every world: Clock's
 * refuses it in the widening world, and Weather's second one refuses it.
 */
const R4_WEATHER = {
  n: { type: "int", label: "N of Weather", group: "General", description: "", default: 4, min: 0, max: 99, placeholder: "" },
  m: { type: "int", label: "M of Weather", group: "General", description: "", default: 6, placeholder: "" },
};
const R4_WEATHER_2 = {
  ...R4_WEATHER,
  n: { ...R4_WEATHER.n, label: "N of Weather (new)", max: 5 },
  k: { type: "int", label: "K of Weather", group: "General", description: "", default: 8, placeholder: "" },
};
/**
 * The definitions of a world, per scene: the first, and the one the change
 * `schema` brings for the scene the display shows.
 *
 * @type {Record<string, any[]>}
 */
const R4_DEFINITIONS = { clock: [R4_SCHEMA, R4_SCHEMA_2], weather: [R4_WEATHER, R4_WEATHER_2] };
/** @type {Record<string, any[]>} */
const R4_DEFINITIONS_WIDENING = { clock: R4_CLOCK_WIDENING, weather: [R4_WEATHER, R4_WEATHER_2] };
/** What config.json holds of each scene's settings when a story begins, for every device: Weather has a saved value, Clock none. @type {Record<string, Record<string, unknown>>} */
const R4_SAVED = { clock: {}, weather: { m: 8 } };
/** The scenes of the stories, and the one the display switches to from each. @type {Record<string, string>} */
const R4_OTHER_SCENE = { clock: "weather", weather: "clock" };
/**
 * Why pixdcon refuses a value, by the field of the scene definition it
 * holds; null: it takes the value. The reason names the bound, so a reason
 * of another definition is told apart on screen.
 *
 * @param {any} field @param {unknown} value
 * @returns {string|null}
 */
function r4Verdict(field, value) {
  if (!field || typeof value !== "number") return null;
  if (field.max !== undefined && value > field.max) return `above the maximum of ${field.max}`;
  if (field.min !== undefined && value < field.min) return `below the minimum of ${field.min}`;
  return null;
}
/** The values a definition refuses: key → reason (the `rejected` map of pixdcon's answers). @param {any} schema @param {Record<string, unknown>|undefined} values @returns {Record<string, string>} */
function r4Refused(schema, values) {
  /** @type {Record<string, string>} */
  const refused = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const reason = r4Verdict(schema?.[key], value);
    if (reason) refused[key] = reason;
  }
  return refused;
}
/** The log of one run of pixdcon: its own lines, numbered from 1 in every run, so a line of another run shows (gate note2 M3). @param {string} epoch */
const R4_LOG = (epoch) => [1, 2].map((seq) => ({ seq, at: at("18:42:00"), level: "INFO", message: `[pixdcon] line ${seq} of ${epoch}` }));
/**
 * Why a Save that pixdcon refuses is no commit of a draft. Narrowed (gate
 * r5a D): it holds while the refused edit is the only one. With a newer
 * edit of n that the definition takes, Save commits: that story of two
 * changes runs as a case.
 */
const R4_NO_COMMIT =
  "pixdcon refuses the Save of a value its scene definition does not take (400 invalid_field): no draft is committed, unreachable as one change (with a newer edit the definition takes, Save commits: the story of two changes runs as a case)";
/** Why no other owner can slide while a brightness request runs (gate r5a E): unreachable as one change; in a new life or run of the device the range is another slot's, and that story runs as a case. */
const R4_NO_OWNER = "the brightness range is disabled while its request runs: unreachable as one change (in a new life or a new run of the device the range is free: the story of two changes runs as a case)";
/** Why a blob-only device's row cannot be revisited as one change (gate note2, LOW): after a membership change it can, and that story of two changes runs. */
const R4_NO_ROW = "a device that is not in config.json has no edit row: unreachable as one change (once its membership changed the row is there: the story of two changes runs as a case)";

/** A change that cannot happen in the story: the stand-in DOM offers no way to do it. */
class R4Unreachable extends Error {}

/**
 * The world pixdcon holds in one story: its run (epoch), positions,
 * revisions, the lives and config membership of its devices, per scene the
 * scene definition (`schemas`: the first of the scene's two; the change
 * `schema` brings the second), per device and scene the saved settings
 * (`saved`, by "<device>/<scene>"), the previews it was sent, and per run,
 * life and scene the preview it holds (`layers`: the draft and the values
 * it took) and the highest draft it has seen (`drafts`).
 *
 * @param {{devices?: Array<{name: string, o?: any}>, overlays?: (epoch: string) => any[], settingsOverlay?: boolean, definitions?: Record<string, any[]>}} spec
 */
function r4World(spec) {
  const definitions = spec.definitions ?? R4_DEFINITIONS;
  /** @type {any} */
  const world = {
    epoch: "",
    seq: 100,
    rev: 100,
    stream: 0,
    epochs: [],
    lives: new Map(),
    definitions,
    schemas: new Map(Object.entries(definitions).map(([scene, list]) => [scene, list[0]])),
    saved: new Map(),
    previews: new Set(),
    layers: new Map(),
    drafts: new Map(),
    configVersion: 1,
    spec: { ...spec, devices: (spec.devices ?? []).map((d) => ({ ...d, o: { ...d.o } })) },
  };
  for (const device of spec.devices ?? []) world.lives.set(device.name, 1);
  return world;
}
/** The saved settings of one scene on one device, as pixdcon holds them: what config.json held when the story began, until a Save changes them. @param {any} world @param {string} device @param {string} scene @returns {Record<string, unknown>} */
const r4Saved = (world, device, scene) => world.saved.get(`${device}/${scene}`) ?? R4_SAVED[scene] ?? {};
/** The scene the display of the story's device shows. @param {any} world @returns {string} */
const r4Showing = (world) => world.spec.devices[0]?.o?.scene ?? "clock";

/** What pixdcon holds now, as a request it processes now would see it. @param {any} world */
const r4Now = (world) => ({
  epoch: world.epoch,
  rev: world.rev,
  lives: new Map(world.lives),
  epochs: [...world.epochs],
  schemas: new Map(world.schemas),
  saved: new Map([...world.saved].map(([key, values]) => [key, { ...values }])),
  devices: world.spec.devices.map((/** @type {any} */ d) => ({ ...d, o: { ...d.o } })),
  configVersion: world.configVersion,
  overlays: world.spec.overlays?.(world.epoch, world.epochs.indexOf(world.epoch)) ?? [],
});

/** A scene in one life of a device in the run pixdcon is in: what a preview it holds, and its memory of the page's drafts, belongs to. @param {any} world @param {string} device @param {string} scene */
const r4Scope = (world, device, scene) => `${world.epoch}/${device}@${world.lives.get(device) ?? 1}/${scene}`;

/**
 * The brightness a device holds, in one run and one life: 30 in the first
 * life of the first run, 2 more per run and 5 more per life after it, so the
 * level of another run or life shows (gate r5a: a re-added device began at
 * the same 30). An override of the story follows it by the same step.
 *
 * @param {any} world @param {string} epoch @param {number} life
 */
const r4Level = (world, epoch, life) => 30 + 2 * Math.max(0, world.epochs.indexOf(epoch)) + 5 * (Math.max(1, life) - 1);

/** @param {any} world @param {string} name @param {string} epoch @param {number} life @param {number} rev @param {any[]} [devices] the devices as pixdcon held them */
function r4View(world, name, epoch, life, rev, devices = world.spec.devices ?? []) {
  const entry = devices.find((/** @type {any} */ d) => d.name === name);
  const v = view(name, { ...(entry?.o ?? {}), epoch, incarnation: life, rev });
  // Distinguishable per run and per life: what an answer of another run, or of an earlier life of the device, brings shows.
  v.displayName = life > 1 ? `${name} of ${epoch}, life ${life}` : `${name} of ${epoch}`;
  const level = r4Level(world, epoch, life);
  v.effective.lastBrightness = level;
  v.effective.appliedBrightness = level;
  if (entry?.o?.override !== undefined) v.desired.brightness = { override: entry.o.override + level - 30, source: "web", since: v.desired.brightness.since };
  return v;
}

/** A snapshot of the world on a new stream (boot, reconnect, restart). @param {any} world */
function r4Snapshot(world, sameStream = false) {
  if (!sameStream) world.stream = openSource(defaultFence(), "stream");
  world.seq += 1;
  world.rev += 1;
  const devices = (world.spec.devices ?? []).map((/** @type {any} */ d) => r4View(world, d.name, world.epoch, world.lives.get(d.name), world.rev));
  const data = {
    ...snapshot(world.epoch, world.seq, devices, { overlays: world.spec.overlays?.(world.epoch, world.epochs.indexOf(world.epoch)) ?? [], incarnations: Math.max(0, ...world.lives.values()) }),
    scenes: SCENES,
  };
  const decision = applyDefaultEvent({ type: "snapshot", epoch: world.epoch, seq: world.seq, stream: world.stream, data });
  assert.equal(decision.action, "apply", "the harness's snapshot is taken");
}

/** pixdcon (re)starts: a new epoch, every device in its first life. @param {any} world */
function r4NewEpoch(world, sameStream = false) {
  pageEpochs += 1;
  world.epoch = `e${String(pageEpochs).padStart(7, "0")}`;
  world.epochs.push(world.epoch);
  for (const name of world.lives.keys()) world.lives.set(name, 1);
  r4Snapshot(world, sameStream);
}

/** A value as the story reads it: each run of pixdcon by its place in the story (run 1, run 2), not by its id. @param {any} world @param {string} value */
const r4InStory = (world, value) => world.epochs.reduce((/** @type {string} */ text, /** @type {string} */ epoch, /** @type {number} */ i) => text.replaceAll(epoch, `run ${i + 1}`), value);

/** @param {any} world @param {string} type @param {any} data */
function r4Live(world, type, data) {
  world.seq += 1;
  return applyDefaultEvent({ type, epoch: world.epoch, seq: world.seq, stream: world.stream, data });
}

/**
 * A SettingsState as pixdcon held it when it processed `at` (a request, or
 * r4Now for a live event): its scene definition and saved values.
 *
 * @param {any} world @param {any} at @param {string} device @param {string} scene @param {{effective?: any, preview?: any}} [o]
 */
function r4Settings(world, at, device, scene, o = {}) {
  /** @type {any} */
  const state = sceneSettings(device, scene, { epoch: at.epoch, incarnation: at.lives.get(device) ?? 1, rev: at.rev, effective: o.effective, preview: o.preview ?? null, schema: at.schemas?.get(scene) ?? world.schemas.get(scene) });
  // Saved values are kept per device and scene (r4, gate r5a A): what a Save of Clock wrote is not Weather's.
  const saved = at.saved?.get(`${device}/${scene}`) ?? R4_SAVED[scene] ?? {};
  for (const [key, layer] of Object.entries(state.values)) {
    if (world.spec.settingsOverlay) /** @type {any} */ (layer).overlay = 4;
    if (key in saved) Object.assign(/** @type {any} */ (layer), { saved: saved[key], effective: o.effective?.[key] ?? saved[key], source: "config" });
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
    // The preview as pixdcon held it once it had processed the request: the values it took (a refused one is not among them), and what it refused.
    if (m[3] === "/preview" && method === "PUT")
      return {
        state: r4Settings(world, call, device, scene, { effective: call.layer?.values, preview: call.layer ? { session: "s1", draft: call.layer.draft } : null }),
        rejected: call.rejected,
        applied: call.applied,
      };
    if (m[3] === "/overlays") return { state: r4Settings(world, call, device, scene), failed: [] };
    if (!m[3] && method === "PUT") return { state: r4Settings(world, call, device, scene), rejected: {}, overlaysNotCleared: [] };
    return r4Settings(world, call, device, scene);
  }
  if (path === "/api/v2/config/raw")
    return method === "GET" ? { text: R4_RAW(call.epoch, call.configVersion), state: { ...CONFIG_STATE, rev: call.rev } } : { state: { ...CONFIG_STATE, rev: call.rev }, diff: {} };
  if (path === "/api/v2/config/reload") return { state: { ...CONFIG_STATE, rev: call.rev } };
  if (path === "/api/v2/log") return R4_LOG(call.epoch);
  if (/^\/api\/v2\/overlays\/[^/]+$/.test(path)) return { overlays: call.overlays, pending: false, confirmed: true };
  if (/^\/api\/v2\/scenes\/[^/]+\/copy$/.test(path)) return { scene: { key: "clock-copy" }, path: "./scenes/clock-copy.js" };
  // Add device: what it brings is a device the story does not show; the answer carries no view.
  if (path === "/api/v2/devices") return {};
  if ((m = /^\/api\/v2\/devices\/([^/]+)(\/[a-z-]+)?$/.exec(path))) {
    const name = decodeURIComponent(m[1]);
    return r4View(world, name, call.epoch, call.lives.get(name) ?? 1, call.rev, call.devices);
  }
  throw new Error(`the harness has no answer for ${method} ${call.url}`);
}

/**
 * The stand-in for fetch: every request is held until the story answers it.
 * pixdcon processes a request when it is sent: a Save changes the saved
 * values then, and a preview end that names a preview pixdcon was never
 * sent in this run and life of the device is marked (old-scope work: the
 * cleanup of an earlier run or life, started after it ended).
 *
 * It judges values by the scene definition it holds when it processes the
 * request (r3, gate note2 M2), as the API says (src/api/routes-v2.js):
 *  - a preview (PUT …/preview) takes the values the definition takes and
 *    names the others in `rejected` (200). One whose draft is not higher
 *    than the highest pixdcon has seen for the page, device and scene
 *    changes nothing: `applied: false`, and the answer shows the preview
 *    as it is, with nothing judged;
 *  - a Save that holds a refused value saves nothing and commits no draft:
 *    400 `invalid_field` with `rejected` (`call.refusal`). A Save that
 *    works commits its draft: the preview ends unless a newer one is held;
 *  - the end of a preview (DELETE) ends it.
 *
 * @param {any} world
 */
function r4Server(world) {
  /** @type {any[]} */
  const calls = [];
  globalThis.fetch = /** @type {any} */ (
    (/** @type {string} */ url, /** @type {any} */ init = {}) =>
      new Promise((resolve) => {
        world.seq += 1;
        world.rev += 1;
        const method = init.method ?? "GET";
        const path = String(url).split("?")[0];
        const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        const settings = /^\/api\/v2\/devices\/([^/]+)\/settings\/([^/]+)(\/preview)?$/.exec(path);
        /** @type {string|null} */
        let stray = null;
        /** What a preview's answer names as not taken. @type {Record<string, string>} */
        let rejected = {};
        let applied = false;
        /** A Save pixdcon refuses: key → reason. @type {Record<string, string>|null} */
        let refusal = null;
        /** The preview pixdcon holds once this request is processed. @type {{draft: number, values: Record<string, unknown>}|null} */
        let layer = null;
        if (settings) {
          const device = decodeURIComponent(settings[1]);
          const scene = decodeURIComponent(settings[2]);
          const life = world.lives.get(device) ?? 1;
          const held = r4Scope(world, device, scene);
          const seen = world.drafts.get(held) ?? 0;
          if (settings[3] && method === "PUT") {
            world.previews.add(held);
            const draft = Number(body?.draft);
            if (draft > seen) {
              rejected = r4Refused(world.schemas.get(scene), body?.values);
              applied = true;
              world.drafts.set(held, draft);
              world.layers.set(held, { draft, values: Object.fromEntries(Object.entries(body?.values ?? {}).filter(([key]) => !(key in rejected))) });
            }
          }
          if (settings[3] && method === "DELETE") {
            if (!world.previews.has(held)) stray = `DELETE …/settings/${scene}/preview in run ${world.epoch}, life ${life} of ${device}: pixdcon was sent no preview of it in this run and life`;
            world.layers.delete(held);
          }
          if (!settings[3] && method === "PUT") {
            const refused = r4Refused(world.schemas.get(scene), body?.set);
            if (Object.keys(refused).length) refusal = refused;
            else {
              const values = { ...r4Saved(world, device, scene), ...(body?.set ?? {}) };
              for (const key of body?.reset ?? []) delete values[key];
              world.saved.set(`${device}/${scene}`, values);
              if (body?.draft !== undefined) {
                world.drafts.set(held, Math.max(seen, Number(body.draft)));
                if ((world.layers.get(held)?.draft ?? Infinity) <= Number(body.draft)) world.layers.delete(held);
              }
            }
          }
          const now = world.layers.get(held);
          layer = now ? { draft: now.draft, values: { ...now.values } } : null;
        }
        /** @type {any} */
        const call = {
          origin: r7RequestSource,
          method,
          url: String(url),
          path,
          body,
          ...r4Now(world),
          seq: world.seq,
          stray,
          rejected,
          applied,
          refusal,
          layer,
          answered: false,
          /** The status pixdcon answered with; 0: no answer reached the page. */
          status: 0,
          // The story's edit objects, captured at submission: values alone
          // cannot acknowledge an equal-valued replacement (gate F).
          submitted: new Map(world.story?.edits ?? []),
          formScope: world.story?.page === "device" ? r4FormScope(world.story) : null,
          opening: world.story?.opening,
          storyTime: world.story?.clock ?? 0,
          /** @param {number} status @param {unknown} [answer] */
          answer(status, answer) {
            if (call.answered) return;
            call.answered = true;
            call.status = status;
            resolve(new Response(answer === undefined ? null : JSON.stringify(answer), { status, headers: { "X-Pixdcon-Position": `${call.epoch}-${call.seq}` } }));
          },
          /** pixdcon answers in its own words what it did with the request: a Save it refused is a 400. */
          ok() {
            if (call.refusal) call.answer(400, { code: "invalid_field", error: "A value was refused: nothing is saved", rejected: call.refusal });
            else call.answer(200, r4Answer(world, call));
          },
          /** It ran out of time: its answer does not reach the page within the time bound. */
          abandon() {
            call.answered = true;
          },
          /** pixdcon's answer to a request that ran out of time comes after all (r4): the time bound ended the request, the network delivers late. */
          late() {
            if (call.status !== 0) return;
            resolve(new Response(call.refusal ? JSON.stringify({ code: "invalid_field", error: "A value was refused: nothing is saved", rejected: call.refusal }) : JSON.stringify(r4Answer(world, call)), { status: call.refusal ? 400 : 200, headers: { "X-Pixdcon-Position": `${call.epoch}-${call.seq}` } }));
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
/**
 * Whether preview feedback is said: the title status line, a row marker.
 * The settings status line is its own piece: it says the action slot's
 * failure before a failed preview (B-175), so whether it says "Not
 * previewed" also follows the slot, which outlives the opening (r4).
 *
 * @param {any} root
 */
function r4PreviewFeedback(root) {
  // The title says a failed preview as "Settings not previewed: …" (view/model.js previewFailureText); a failed end ("… not ended") belongs to the device's life, not to a draft.
  const title = r4Text(root.querySelector(".dev-head .sub")).includes("Settings not previewed:");
  const marker = root.querySelectorAll(".set-body .mk").some((/** @type {any} */ mk) => /^not previewed/.test(r4Text(mk)));
  return `title ${title ? "says it" : "-"} · marker ${marker ? "says it" : "-"}`;
}
/** The kind of a row's marker (default, saved, previewing, not previewed, …), without the values it names. @param {any} root @param {string} key */
const r4Marker = (root, key) => r4Text(root.querySelector(`.set-body [data-row="${key}"] .mk`)).split("·")[0].trim() || "∅";
/** The edits the next Save sends: the rows whose marker says an edit (previewing, not previewed). @param {any} root */
const r4Unsaved = (root) =>
  root.querySelectorAll(".set-body [data-row]").filter((/** @type {any} */ row) => /^(previewing|not previewed)/.test(r4Text(row.querySelector(".mk")))).map((/** @type {any} */ row) => row.getAttribute("data-row")).join(" ") || "none";
/**
 * The projection of field rejection (gate note2 M2; design note §3): what
 * pixdcon said about a value belongs to the scene definition it judged it
 * by and to the edit that was submitted (that key's own draft, in its
 * opening and scope). It is not Save's acknowledgement: config membership
 * is no part of it, and another field's newer draft does not make it
 * obsolete (the rejection kinds name that change as commuting).
 */
const R4_REJECTION = ["opening", "epoch", "life", "scene", "schema", "draft"];
/**
 * The projection of the pending bookkeeping (what a field holds, a row's
 * marker, the edits the next Save sends): each edit's draft and config
 * membership, in the scene the form shows (r4, gate r5a A) and under the
 * scene definition the edits were made against (gate r5a B: compared across
 * a change of definition too, so an edit that vanishes there shows).
 */
const R4_BOOKKEEPING = ["draft", "membership", "schema", "scene"];
/** Preview feedback: its draft (newest, above the committed one) in its opening, scope (scene, run, life) and scene definition. */
const R4_FEEDBACK = ["opening", "epoch", "life", "scene", "draft", "schema"];
/**
 * Which scene, and which definition of it, the form shows: the heading and
 * each row's label with its range. Its own piece (r4): what an answer of
 * another scene or of an earlier definition puts into the form shows here,
 * whatever the fields hold.
 *
 * @param {any} root
 */
const r4Definition = (root) =>
  `${r4Text(root.querySelector("#h-settings"))} | ${root.querySelectorAll(".set-body [data-row]").map((/** @type {any} */ row) => `${row.getAttribute("data-row")}: ${r4Text(row.querySelector("label"))}`).join("; ") || "no rows"}`;
/** Why pixdcon refused the edit of a field, as its row says it; "none" when the row says no reason. @param {any} root @param {string} key */
const r4Refusal = (root, key) => String(root.querySelector(`.set-body [data-row="${key}"] .ferr`)?.textContent ?? "").replace(/\s+/g, " ").trim() || "none";
/**
 * What a row marker depends on, by what it says: "not previewed, not saved"
 * is field rejection (an edit that is not taken: its own projection); "not
 * previewed" is preview feedback (its draft, newest and above the committed
 * one, in its scope and scene definition); the rest (saved, previewing,
 * default) is Save bookkeeping (each submitted edit, and config membership).
 *
 * @param {string} said
 */
const r4MarkerDeps = (said) => (/^not previewed, not saved/.test(said) ? R4_REJECTION : /^not previewed/.test(said) ? R4_FEEDBACK : R4_BOOKKEEPING);
/**
 * What the settings status line depends on, by what it says: an outcome of
 * the action slot (Save, Revert, Clear) depends on the slot identities, and
 * a Save outcome also on config membership (gate r4 §1); preview feedback on
 * its draft, scope and scene definition; pixdcon's reason for a refused
 * value on the definition and the submitted edit (field rejection); the
 * count of unsaved edits on the drafts and membership.
 *
 * @param {string} said
 */
function r4StatusDeps(said) {
  if (/^(Not saved|Saved)/.test(said)) return ["epoch", "life", "scene", "membership", "token"];
  if (/^(Not reverted|Not cleared|\d+ could not be cleared)/.test(said)) return ["epoch", "life", "scene", "token"];
  if (/^Not previewed/.test(said)) return R4_FEEDBACK;
  if (/^pixdcon refused this value/.test(said)) return R4_REJECTION;
  if (/^(Previewing|No unsaved|Changes are applied)/.test(said)) return [...R4_BOOKKEEPING, "epoch", "life"];
  return ["draft", "schema", "scene", "epoch", "life", "opening"];
}
/** Whether the recovery dialog is open: it belongs to the opening that opened it. */
const r4Dialog = () => (fakeDocument.body.querySelector(".scrim .dlg") ? "open" : "closed");
/** The dialog's Retry and what it said: the slot of the device's life, which outlives the opening (rule 5). A dialog opened again while Retry runs shows it busy, and its outcome when it comes (r4). */
const r4DialogRetry = () => {
  const dialog = fakeDocument.body.querySelector(".scrim .dlg");
  return dialog ? `${r4Button(dialog.querySelector('[data-act="retry"]'))} · ${r4Text(dialog.querySelector(".retry-note"))}` : "∅";
};
/** The fields a person can type into (not a slider, box or choice). @param {any} root */
const r4TextFields = (root) =>
  root.querySelectorAll("textarea, input").filter((/** @type {any} */ el) => !["range", "checkbox", "radio", "hidden", "color"].includes(el.getAttribute("type") ?? "") && !el.disabled);
/** @param {any} el @param {string} value */
function r4Type(el, value) {
  if (!el) throw new R4Unreachable("nothing to type into");
  if (el.disabled) throw new R4Unreachable("the field is disabled");
  el.focus();
  typeInto(el, value);
}
/** @param {any} el */
function r4Click(el) {
  if (!el) throw new Error("nothing to click");
  const visit = r8ActiveStory?.root?.contains(el) && el.getAttribute("data-act") === "edit";
  if (!click(el)) throw new Error(`${r4Text(el)} is disabled`);
  if (visit && r8ActiveStory.root.querySelector(".ct-edit form")) r8ActiveStory.visit = (r8ActiveStory.visit ?? 0) + 1;
}
/** The scope the settings form of the story shows, as the story counts it: the scene in one run and life, and which showing of it (a scene left and shown again is a new scope of the form). @param {any} ctx */
const r4FormScope = (ctx) => `${r4Scope(ctx.world, ctx.world.spec.devices[0].name, r4Showing(ctx.world))}#${ctx.shows}`;
/**
 * A person edits a field of the settings form. The story keeps what was
 * typed (gate r5a B): the key and the value, the scope and the opening of
 * the page it was typed in, and how many requests had been sent by then. So
 * what becomes of each edit is asserted from the story itself, not from
 * what the screen still claims.
 *
 * @param {any} ctx @param {string} key @param {string} value
 */
function r4Edit(ctx, key, value) {
  r4Type(field(ctx.root, key), value);
  ctx.edits.set(key, { value, intent: "set", scope: r4FormScope(ctx), opening: ctx.opening, at: ctx.calls.length, identity: ++r8EditIdentity });
}
/** Reset is an edit with its own identity and intent, even at an equal value. @param {any} ctx @param {string} key */
function r6Reset(ctx, key) {
  const value = String(ctx.world.schemas.get(r4Showing(ctx.world))[key].default);
  r4Click(ctx.root.querySelector(`[data-act="reset"][data-key="${key}"]`));
  ctx.edits.set(key, { value, intent: "reset", scope: r4FormScope(ctx), opening: ctx.opening, at: ctx.calls.length, identity: ++r8EditIdentity });
}
/** The display of the story's device shows the other scene (the live channel): another scope of the settings form. @param {any} ctx @returns {string} the scene it shows now */
function r4Switch(ctx) {
  const { world } = ctx;
  const name = r4StoryDevice(ctx);
  const entry = world.spec.devices.find((/** @type {any} */ d) => d.name === name);
  entry.o.scene = R4_OTHER_SCENE[entry.o.scene ?? "clock"];
  ctx.shows += 1;
  world.rev += 1;
  r4Live(world, "device", r4View(world, name, world.epoch, world.lives.get(name), world.rev));
  return entry.o.scene;
}

/**
 * The pages: how each opens, what it shows (a piece is [name, the
 * identities it depends on, what it reads now]) and where a person types.
 *
 * A piece's identities may follow what it says (a function of its text):
 * one line can say a slot outcome or preview feedback.
 *
 * @typedef {string[] | ((said: string) => string[])} R4Deps
 * @type {Record<string, {module: () => any, params?: any, pieces: (root: any) => Array<[string, R4Deps, string]>, type?: (ctx: any) => void}>}
 */
const R4_PAGES = {
  raw: {
    module: () => rawPage,
    pieces: (root) => [
      // What the editor holds and says belongs to a load of one run: compared across epochs too (gate r4 §4).
      ["editor text", ["opening", "revision", "epoch", "resource"], r4Value(root.querySelector("textarea"))],
      // While it says a load is out, the line is the load's (its opening, its run); once it says how the text reads, it is
      // the text's too (the editor's revision): a load that ends after a person typed ends "Loading", and no more (r4).
      ["load and validity state", (said) => (/^Loading config\.json/.test(said) ? ["opening", "epoch", "token", "resource"] : ["opening", "revision", "epoch", "token", "resource"]), r4Text(root.querySelector(".edbar .state"))],
      ["gutter marks", ["opening", "revision", "epoch"], root.querySelectorAll(".gut b.err").map(r4Text).join(" ") || "none"],
      ["focus", ["opening", "revision"], r4Focus(root)],
      ["Save", ["epoch", "token"], r4Button(root.querySelector('[data-act="save"]'))],
      ["Reload", ["epoch", "token"], r4Button(root.querySelector('[data-act="reload"]'))],
      ["outcome line", ["epoch", "token"], r4Text(root.querySelector(".errline"))],
    ],
    type: (ctx) => r4Type(ctx.root.querySelector("textarea"), '{"devices": [],\n "typed": 2}'),
  },
  config: {
    module: () => configPage,
    pieces: (root) => {
      const row = root.querySelector(".ct-edit");
      return [
        ["config load and pending", ["epoch"], r4Text(root.querySelector(".head .sub"))],
        ["edit row", ["opening", "visit", "life", "revision", "membership"], `${row ? `open for ${row.querySelector("form")?.getAttribute("data-device")}` : "closed"}${root.querySelector(".ct-row.open") ? " · row marked open" : ""}`],
        ["edit row fields", ["opening", "visit", "epoch", "life", "revision", "membership"], row ? `${r4Value(row.querySelector('[name="displayName"]'))} | ${r4Value(row.querySelector('[name="comment"]'))}` : "∅"],
        ["Add device fields", ["opening", "revision"], `${r4Value(root.querySelector('form.addf [name="name"]'))} | ${r4Value(root.querySelector('form.addf [name="ip"]'))} | ${r4Value(root.querySelector('form.addf [name="type"]'))}`],
        ["focus", ["opening", "visit", "revision"], r4Focus(root)],
        // A slot (busy label, outcome) outlives the visit and the opening (rule 5): it depends on the slot identities only.
        ["edit row Save and outcome", ["epoch", "life", "membership", "token"], row ? `${r4Button(row.querySelector('[data-act="patch"]'))} | ${r4Text(row.querySelector(".ef-f .slot"))}` : "∅"],
        ["Add to config.json", ["epoch", "life", "membership", "token"], `${r4Button(root.querySelector('[data-act="adopt"]'))} | ${root.querySelectorAll(".ct-body .slot").filter((/** @type {any} */ el) => !el.closest(".ct-edit")).map(r4Text).join(" ") || "∅"}`],
        ["Add device button and outcome", ["epoch", "token"], `${r4Button(root.querySelector("form.addf button"))} | ${r4Text(root.querySelector("#add .slot"))}`],
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
      // The Add device form of the empty page is on screen only while no device is listed (r4): hidden, it says nothing.
      const slot = root.querySelector(".empty-slot");
      const empty = slot && !slot.hidden ? slot : null;
      return [
        ["row d1", ["epoch", "life", "token"], row ? `${r4Value(row.querySelector("select"))}${row.querySelector("select")?.disabled ? " [disabled]" : ""} | ${r4Text(row.querySelector(".c-show"))} | ${r4Text(row.querySelector(".src2"))} | ${r4Button(row.querySelector('[data-act="restore"]'))}` : "∅"],
        ["Add device fields", ["opening", "revision"], `${r4Value(empty?.querySelector('form.addf [name="name"]'))} | ${r4Value(empty?.querySelector('form.addf [name="ip"]'))} | ${r4Value(empty?.querySelector('form.addf [name="type"]'))}`],
        ["focus", ["opening", "revision"], r4Focus(root)],
        ["Add device button and outcome", ["epoch", "token"], `${r4Button(empty?.querySelector("form.addf button"))} | ${r4Text(empty?.querySelector(".slot"))}`],
      ];
    },
  },
  device: {
    module: () => devicePage,
    params: { name: "d1" },
    pieces: (root) => {
      const range = root.querySelector('input[type="range"]');
      return [
        ["preview feedback", R4_FEEDBACK, r4PreviewFeedback(root)],
        ["Display line", ["scene", "epoch", "life", "owner"], r4Text(root.querySelector(".why .v-disp"))],
        // The scene the form shows and the definition of it: what belongs to another scene, run, life or definition shows here.
        ["scene definition shown", ["epoch", "life", "scene", "schema"], r4Definition(root)],
        ["settings context", ["epoch", "life", "scene", "membership"], r4Text(root.querySelector(".set-desc"))],
        ["settings load outcome", (said) => said === "∅ | ∅" ? ["epoch", "life", "scene", "token"] : ["opening", "epoch", "life", "scene", "token"], `${r4Text(root.querySelector(".set-body .below"))} | ${r4Button(root.querySelector('.set-body [data-act="retry"]'))}`],
        // What a field shows is an edit (its draft) or the store's value (data): compared when the draft, the membership,
        // the scene or the scene definition changed.
        ["field n", R4_BOOKKEEPING, r4Value(field(root, "n"))],
        ["field m", R4_BOOKKEEPING, r4Value(field(root, "m"))],
        ["row marker of n", r4MarkerDeps, r4Marker(root, "n")],
        ["row marker of m", r4MarkerDeps, r4Marker(root, "m")],
        // Why pixdcon refused an edit: field rejection, with its own projection (gate note2 M2).
        ["refusal of n", R4_REJECTION, r4Refusal(root, "n")],
        ["refusal of m", R4_REJECTION, r4Refusal(root, "m")],
        ["edits the next Save sends", R4_BOOKKEEPING, r4Unsaved(root)],
        ["Create copy fields", ["opening", "revision"], `${r4Value(root.querySelector('.copyf [name="targetKey"]'))} | ${r4Value(root.querySelector('.copyf [name="name"]'))}`],
        ["focus", ["opening", "revision", "draft", "scene"], r4Focus(root)],
        ["recovery dialog", ["opening", "epoch", "life"], r4Dialog()],
        ["recovery Retry and outcome", ["epoch", "life", "token"], r4DialogRetry()],
        // Slot labels and outcomes (busy, failure, note) depend on the slot identities; preview feedback is the piece above.
        ["title status line", (said) => said.includes("Settings not previewed:") ? [...R4_FEEDBACK, "owner", "token"] : ["epoch", "life", "token"], `${r4Text(root.querySelector(".dev-head .sub"))} | ${r4Button(root.querySelector('.dev-head [data-act="end-retry"]'))}`],
        ["settings status line", r4StatusDeps, r4Text(root.querySelector(".set-status"))],
        ["settings Save and Revert", ["epoch", "life", "scene", "token"], `${r4Button(root.querySelector('.set-h [data-act="save"]'))} | ${r4Button(root.querySelector('.set-h [data-act="revert"]'))} | ${r4Button(root.querySelector('.set-h [data-act="clear"]'))}`],
        ["mode", ["epoch", "life", "token"], `${r4Text(root.querySelector(".mode-hint"))} | ${root.querySelectorAll('[data-act="mode"]').map((/** @type {any} */ b) => (b.disabled ? "x" : "o")).join("")}`],
        // The slider shows the level of its owner: the brightness slot of the device's life whose own request typed it (gate r5a E).
        ["brightness", ["epoch", "life", "owner", "token"], `${r4Value(range)}${range?.disabled ? " [disabled]" : ""} | ${r4Text(root.querySelector(".range .val"))} | ${root.querySelectorAll('[data-act="bri-mode"]').map((/** @type {any} */ b) => (b.disabled ? "x" : "o")).join("")}`],
        ["brightness feedback", ["epoch", "life", "owner", "token"], r4Text(root.querySelector(".bri-hint"))],
        ["scene", ["epoch", "life", "token"], `${r4Text(root.querySelector(".scene-below"))} | ${r4Text(root.querySelector(".v-src"))} | ${root.querySelectorAll(".opt").map(r4Button).join(" | ")}`],
        ["action and adopt", ["epoch", "life", "token"], `${r4Text(root.querySelector(".why .acts"))} | ${r4Button(root.querySelector('.why .acts [data-act]'))} | ${r4Button(root.querySelector('.dev-head [data-act="adopt"]'))}`],
        // Create copy is an operation in the slot of the scene (`copy:<scene>`): its outcome is the scene's.
        ["Create copy outcome", ["epoch", "scene", "token"], `${r4Button(root.querySelector(".adv [data-act='copy']"))} | ${r4Text(root.querySelector(".adv .slot"))}`],
      ];
    },
    type: (ctx) => r4Type(ctx.root.querySelector('.copyf [name="targetKey"]'), "typed-copy"),
  },
  overlays: {
    module: () => overlaysPage,
    pieces: (root) => ["o1", "o2", "o3"].map((id) => [`row ${id} Clear and outcome`, ["epoch", "overlay", "token"], `${r4Button(root.querySelector(`[data-act="clear"][data-id="${id}"]`))} | ${r4Text(root.querySelector(`[data-id="${id}"]`)?.closest(".ot-row"))}`]),
  },
  health: {
    module: () => healthPage,
    // The pane holds the log of one run: every run has its own lines (gate note2 M3).
    pieces: (root) => [["log pane", ["opening", "epoch", "token"], r4Text(root.querySelector(".log"))]],
  },
};

const r4d1 = (/** @type {any} */ o = {}) => ({ devices: [{ name: "d1", o }] });
/** The settings form of the Device page with an edit of n that was previewed. @param {any} ctx */
async function r4Previewed(ctx) {
  r4Edit(ctx, "n", "2");
  await settle();
  r4Pending(ctx, "PUT", `/settings/${r4Showing(ctx.world)}/preview`).ok();
  await settle();
}
/**
 * The edit of n once more, as a person carries on after a change (`again`):
 * its preview is answered where it was sent. It may not be: behind a Revert
 * that is still out it waits in the scene's lane.
 *
 * @param {any} ctx
 */
async function r4EditedAgain(ctx) {
  r4Edit(ctx, "n", "2");
  await settle();
  ctx.calls.find((/** @type {any} */ c) => !c.answered && c !== ctx.op && c.method === "PUT" && c.path.endsWith(`/settings/${r4Showing(ctx.world)}/preview`))?.ok();
  await settle();
}
/** @param {any} ctx @param {string} method @param {string} tail */
function r4Pending(ctx, method, tail) {
  const call = [...ctx.calls].reverse().find((c) => !c.answered && c.method === method && c.path.endsWith(tail));
  assert.ok(call, `a ${method} …${tail} was sent`);
  return call;
}
/**
 * The settings form with an edit of n that pixdcon's verdict never reached:
 * the preview got no answer of pixdcon's own (500). The row says "not
 * previewed", no reason stands beside the field, and Save is still offered.
 *
 * @param {any} ctx
 */
async function r4Unverified(ctx) {
  r4Edit(ctx, "n", "2");
  await settle();
  r4Pending(ctx, "PUT", "/settings/clock/preview").answer(500, {});
  await settle();
  assert.equal(saveButton(ctx.root).disabled, false, "Save is offered while pixdcon's verdict on the edit is not known");
}
/** What the first definition of the widening world says about n = 2. */
const R4_REFUSED_N = { n: "above the maximum of 1" };
/** The range of the Device page is disabled while its brightness request runs (gate r4 §5): no slider revision can begin meanwhile. @param {any} ctx */
function r4RangeHeld(ctx) {
  const range = ctx.root.querySelector('input[type="range"]');
  return range && !range.disabled ? `the brightness range is enabled (${r4Value(range)}) while its brightness request runs` : null;
}

/**
 * The operation kinds of the effect inventory (effects-r4.mjs), each with
 * the request that starts it: [method, the end of its path].
 *  - `unreachable`: changes the stand-in DOM offers no way to make while
 *    the operation runs, with the reason the probe must meet (section 4.5);
 *  - `commutes`: changes outside the projection of the operation's effects
 *    (section 3): the case must end where the story ends when the change
 *    comes after the end, in every piece (r3);
 *  - `ends`: ends beyond success, 500 and timeout; `only`: the ends in
 *    their place, for a kind that is one answer of pixdcon's (a rejection);
 *  - `refuse`: how the end `refused` is given, where it is not Raw's 422;
 *  - `sent`: what the story claims about the request pixdcon processed,
 *    checked when it begins, so a kind cannot run without its rejection;
 *  - `invariant`: what must hold while the request runs;
 *  - `again`: how a person carries on after a change took the page's state
 *    away (r4, the stories where the old operation ends last): by default
 *    the kind's `setup` once more; null: there is nothing to do again.
 *
 * @typedef {{name: string, site: string, page: string, world: any, request: [string, string], isolation?: boolean, completeBeforeChange?: boolean, setup?: (ctx: any) => Promise<void>|void, begin?: (ctx: any) => Promise<void>|void, again?: null|((ctx: any) => Promise<void>|void), atOpen?: boolean, early?: boolean, commutes?: R4Change[], ends?: R4End[], only?: R4End[], refuse?: (op: any) => void, sent?: (op: any) => void, invariant?: (ctx: any) => string|null}} R4Kind
 * @type {R4Kind[]}
 */
const R4_KINDS = [
  { name: "raw load", site: "web/js/pages/config-raw.js:175", page: "raw", world: r4d1(), request: ["GET", "/api/v2/config/raw"], atOpen: true },
  {
    name: "raw save", site: "web/js/pages/config-raw.js:227", page: "raw", world: r4d1(), request: ["PUT", "/api/v2/config/raw"],
    // Two lines: a refusal of line 2 has a line to mark, in whatever opening or run its answer comes (r4, from the sweep).
    setup: (ctx) => r4Type(ctx.root.querySelector("textarea"), '{"devices": [],\n "saved": 1}'),
    begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="save"]')),
    ends: ["refused"],
  },
  { name: "raw reload", site: "web/js/pages/config-raw.js:274", page: "raw", world: r4d1(), request: ["POST", "/api/v2/config/reload"], begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="reload"]')) },
  // B1a's captured continuation can no longer send this GET after the
  // source prepass unmounts Raw. Execute the second request explicitly.
  {
    name: "raw reload load", site: "web/js/pages/config-raw.js:reloadFromDisk", page: "raw", world: r4d1(), request: ["GET", "/api/v2/config/raw"], early: true,
    begin: async (ctx) => {
      r4Click(ctx.root.querySelector('[data-act="reload"]'));
      r4Pending(ctx, "POST", "/config/reload").ok();
      await settle();
    },
  },
  {
    name: "config patch", site: "web/js/pages/config.js:165", page: "config", world: r4d1(), request: ["PATCH", "/api/v2/devices/d1"],
    setup: async (ctx) => {
      r4Click(ctx.root.querySelector('[data-act="edit"][data-device="d1"]'));
      await settle();
      r4Type(ctx.root.querySelector('.ct-edit [name="displayName"]'), "Kitchen");
      ctx.root.querySelector('[data-act="patch"]').focus();
    },
    // The row again: Edit opens it where it is closed (Edit on an open row would close it), and the name is typed once more.
    again: async (ctx) => {
      if (!ctx.root.querySelector(".ct-edit")) r4Click(ctx.root.querySelector('[data-act="edit"][data-device="d1"]'));
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
    world: { devices: [{ name: "d1", o: { source: "overlay" } }], overlays: (/** @type {string} */ epoch, run = epoch.endsWith("1") ? 0 : 1) => [record("o1", "scene", { device: "d1", value: run === 0 ? "weather" : "clock" })] },
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
  { name: "device brightness", site: "web/js/pages/device.js:111 (brightness)", page: "device", world: r4d1(), request: ["PUT", "/api/v2/devices/d1/brightness"], begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="bri-mode"][data-value="override"]')), invariant: r4RangeHeld },
  {
    name: "device brightness range", site: "web/js/pages/device.js:645 (setBrightness, the range)", page: "device", world: r4d1({ override: 30 }), request: ["PUT", "/api/v2/devices/d1/brightness"],
    begin: (ctx) => {
      const range = ctx.root.querySelector('input[type="range"]');
      assert.equal(range.disabled, false, "the range takes a level while no brightness request runs");
      typeInto(range, "40", "input");
      typeInto(range, "40", "change");
    },
    invariant: r4RangeHeld,
  },
  { name: "device return", site: "web/js/pages/device.js:111 (return)", page: "device", world: r4d1({ source: "overlay" }), request: ["DELETE", "/api/v2/devices/d1/scene-overlay"], begin: (ctx) => r4Click(ctx.root.querySelector('.acts [data-act="return"]')) },
  { name: "device adopt", site: "web/js/pages/device.js:111 (adopt)", page: "device", world: r4d1({ origin: "blob" }), request: ["POST", "/api/v2/devices/d1/adopt"], begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="adopt"]')) },
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
  // The load's projection is its scope (opening, scene, epoch, life): a change of membership or scene definition does not make its outcome another scope's.
  { name: "settings load", site: "web/js/components/settings-form.js:412", page: "device", world: r4d1(), request: ["GET", "/settings/clock"], atOpen: true, commutes: ["membership", "schema"] },
  // Preview feedback does not depend on config membership: a blob-only device previews too.
  { name: "settings preview", site: "web/js/components/settings-form.js:443", page: "device", world: r4d1(), request: ["PUT", "/settings/clock/preview"], early: true, begin: (ctx) => r4Edit(ctx, "n", "2"), commutes: ["membership"] },
  {
    name: "settings save", site: "web/js/components/settings-form.js:474", page: "device", world: r4d1(), request: ["PUT", "/settings/clock"],
    setup: r4Previewed, again: r4EditedAgain, begin: (ctx) => r4Click(saveButton(ctx.root)),
    // Save's bookkeeping acknowledges each submitted edit: a newer draft, of n or of another field, is outside its projection.
    // Pixdcon wrote what was submitted: a changed scene definition does not take that back (remaining edits are revalidated).
    commutes: ["newer draft", "other field", "schema"],
  },
  // Field rejection (gate note2 M2): the answers that carry a `rejected` map that is not empty. In this world the first
  // definition refuses n = 2 ("above the maximum of 1") and the second, which the change `schema` brings, takes it.
  {
    name: "settings preview rejected", site: "web/js/components/settings-form.js:449 (book.rejected)", page: "device",
    world: { ...r4d1(), definitions: R4_DEFINITIONS_WIDENING }, request: ["PUT", "/settings/clock/preview"],
    early: true, begin: (ctx) => r4Edit(ctx, "n", "2"),
    // pixdcon answers 200 and names n as not taken.
    sent: (op) => assert.deepEqual([op.applied, op.rejected], [true, R4_REFUSED_N], "pixdcon took the preview and refused n"),
    // The kind is that answer. Without an answer of pixdcon's own (500, timeout) no rejection reaches the page: those ends
    // are `settings preview`'s. Here they could not be compared: a preview's reference is the story where it ended at once,
    // successfully, and in this world that success leaves pixdcon's verdict on n, which a case without an answer never has
    // (with an edit of another field typed meanwhile the two differ in the row of n, whatever the page does).
    only: ["success"],
    // What pixdcon said about n belongs to the definition and to the edit of n that was sent: config membership and an edit
    // of another field are outside it.
    commutes: ["membership", "other field"],
  },
  {
    name: "settings save rejected", site: "web/js/components/settings-form.js:493 (Save, 400 invalid_field)", page: "device",
    world: { ...r4d1(), definitions: R4_DEFINITIONS_WIDENING }, request: ["PUT", "/settings/clock"],
    setup: r4Unverified, begin: (ctx) => r4Click(saveButton(ctx.root)),
    // The edit again, its preview again without an answer of pixdcon's own; Save may still be busy with the first one.
    again: async (ctx) => {
      r4Edit(ctx, "n", "2");
      await settle();
      ctx.calls.find((/** @type {any} */ c) => !c.answered && c !== ctx.op && c.method === "PUT" && c.path.endsWith("/settings/clock/preview"))?.answer(500, {});
      await settle();
    },
    // pixdcon saves nothing and answers 400 invalid_field with `rejected`: this Save has no success. Its reference is the
    // story without the Save, so the ends without an answer of pixdcon's own run here too (the verdict is lost twice).
    only: ["refused", "500", "timeout"],
    sent: (op) => assert.deepEqual(op.refusal, R4_REFUSED_N, "pixdcon refuses the Save of n"),
    refuse: (op) => op.ok(),
    // The Save's outcome (the slot's line) is outside a newer draft and the scene definition; the edits that remain are revalidated.
    commutes: ["newer draft", "other field", "schema"],
  },
  {
    name: "settings revert", site: "web/js/components/settings-form.js:517", page: "device", world: r4d1(), request: ["DELETE", "/settings/clock/preview"],
    // The click clears the edits (before any answer): its reference clicks too, and ends the Revert at once.
    early: true, setup: r4Previewed, again: r4EditedAgain,
    begin: (ctx) => {
      r4Click(ctx.root.querySelector('.set-h [data-act="revert"]'));
      // Revert: nothing typed is kept. The story's edits go with the click.
      ctx.edits.clear();
    },
    // Its outcome (the end of the preview, the slot's line) is outside a newer draft, membership and the scene definition: a failed Revert keeps the store's values.
    commutes: ["newer draft", "other field", "membership", "schema"],
  },
  {
    name: "settings clear overlays", site: "web/js/components/settings-form.js:545", page: "device", world: { ...r4d1(), settingsOverlay: true }, request: ["DELETE", "/settings/clock/overlays"],
    begin: (ctx) => r4Click(ctx.root.querySelector('.set-h [data-act="clear"]')),
  },
  {
    name: "settings end", site: "web/js/components/settings-form.js:388", page: "device", world: r4d1(), request: ["DELETE", "/settings/clock/preview"],
    early: true, setup: r4Previewed, again: r4EditedAgain,
    // The display switches to Weather (the live channel): the form ends the
    // preview of Clock, and shows Weather's values once they are loaded.
    begin: async (ctx) => {
      r4Switch(ctx);
      await settle();
      r4Pending(ctx, "GET", "/settings/weather").ok();
    },
  },
  {
    name: "settings end retry", site: "web/js/components/settings-form.js:247", page: "device", world: r4d1(), request: ["DELETE", "/settings/clock/preview"],
    // The end of Clock's preview failed when the display switched to Weather; the title status line offers Retry.
    // Nothing to do again: the failed end is kept for the device's life, across openings.
    again: null,
    setup: async (ctx) => {
      await r4Previewed(ctx);
      r4Switch(ctx);
      await settle();
      r4Pending(ctx, "GET", "/settings/weather").ok();
      r4Pending(ctx, "DELETE", "/settings/clock/preview").answer(500, {});
      await settle();
    },
    begin: (ctx) => r4Click(titleLine(ctx.root).querySelector('[data-act="end-retry"]')),
  },
  { name: "health log", site: "web/js/pages/health.js:187", page: "health", world: r4d1(), request: ["GET", "/api/v2/log"], atOpen: true },
];

/** Weather has saved m=8 and default m=6: Reset must remove the saved layer. @param {any} ctx */
async function r6ResetPreviewed(ctx) {
  r6Reset(ctx, "m");
  await settle();
  r4Pending(ctx, "PUT", "/settings/weather/preview").ok();
  await settle();
}
R4_KINDS.push(
  {
    name: "settings reset preview", site: "web/js/components/settings-form.js:443", page: "device", world: r4d1({ scene: "weather" }), request: ["PUT", "/settings/weather/preview"],
    early: true, begin: (ctx) => r6Reset(ctx, "m"), commutes: ["membership"],
    sent: (op) => assert.deepEqual(op.body.values, { m: 6 }, "Reset previews the default, not the saved value"),
  },
  {
    name: "settings reset save", site: "web/js/components/settings-form.js:474", page: "device", world: r4d1({ scene: "weather" }), request: ["PUT", "/settings/weather"],
    setup: r6ResetPreviewed, again: async (ctx) => {
      // The first Reset was already processed: the new opening may have
      // no saved layer left to reset. Carry on with a fresh edit instead.
      r4Edit(ctx, "m", "7");
      await settle();
      ctx.calls.find((/** @type {any} */ c) => !c.answered && c !== ctx.op && c.method === "PUT" && c.path.endsWith("/settings/weather/preview"))?.ok();
      await settle();
    }, begin: (ctx) => r4Click(saveButton(ctx.root)),
    commutes: ["newer draft", "other field", "schema"],
    sent: (op) => assert.deepEqual([op.body.set, op.body.reset], [{}, ["m"]], "Save removes the saved layer, not set it to the default"),
  },
);

/**
 * The combinations the stand-in DOM offers no way to make, each with the
 * reason its probe must meet: the probe begins the operation and tries the
 * change; it must find exactly this (section 4.5). Nothing is excluded by
 * argument.
 *
 * @param {R4Kind} kind
 * @param {R4Change} change
 * @returns {string|null}
 */
function r4Unreachable(kind, change) {
  if (change === "type" && !R4_PAGES[kind.page].type && !(kind.page === "devices" && !(kind.world.devices ?? []).length)) return `the ${kind.page} page has no field to type into`;
  if ((change === "commit" || change === "newer draft" || change === "other field") && kind.page !== "device") return `the ${kind.page} page has no settings form`;
  if (change === "commit" && ["settings save", "settings reset save", "settings save rejected", "settings revert", "settings clear overlays"].includes(kind.name))
    return "Save, Revert and Clear are one busy slot: Save stays disabled while the operation runs";
  // The Save is clicked and sent, and pixdcon refuses it by the same definition that refuses the preview: nothing is committed.
  if (change === "commit" && kind.name === "settings preview rejected") return R4_NO_COMMIT;
  if (change === "revisit" && kind.page !== "config") return `the ${kind.page} page has no edit row`;
  if (change === "revisit" && kind.world.devices?.[0]?.o?.origin === "blob") return R4_NO_ROW;
  return null;
}

/**
 * Stories of two changes, where an exclusion holds for one change only:
 *  - gate note2, LOW: `config adopt × revisit` has no row to revisit while
 *    the device is blob-only; once its membership changed (the adoption took
 *    effect, its answer still out) the row is there;
 *  - gate r5a D: `settings preview rejected × commit` commits nothing while
 *    the refused edit is the only one; with a newer edit of n the definition
 *    takes (0), Save commits, and then the old rejection is delivered;
 *  - gate r5a E: no other owner can slide while a brightness request runs;
 *    in a new life of the device (it was re-added), and in a new run, the
 *    range is another slot's: it sends 60 %, that request stays out, and
 *    then the first life's request ends. Replacement work is started after
 *    the old operation was invalidated, and observed before it is answered.
 * `alone`: the reason the last step alone is unreachable for.
 *
 * @type {Record<string, {kind: string, steps: string[], alone: string, gate: string}>}
 */
const R4_COMPOSITES = {
  "membership, then revisit": { kind: "config adopt", steps: ["membership", "revisit"], alone: R4_NO_ROW, gate: "gate note2 LOW" },
  "a newer draft pixdcon takes, then commit": { kind: "settings preview rejected", steps: ["a newer draft pixdcon takes", "commit"], alone: R4_NO_COMMIT, gate: "gate r5a D" },
  "reincarnate, then the new owner slides": { kind: "device brightness range", steps: ["reincarnate", "the new owner slides"], alone: R4_NO_OWNER, gate: "gate r5a E" },
  "epoch, then the new owner slides": { kind: "device brightness range", steps: ["epoch", "the new owner slides"], alone: R4_NO_OWNER, gate: "gate r5a E, in a new run" },
};
/** The single changes a change is made of. @param {string|null} change @returns {string[]} */
const r4Steps = (change) => (change === null ? [] : (R4_COMPOSITES[change]?.steps ?? [change]));
/** The identities a single change changes. @param {string} step @returns {string[]} */
const r4StepChanges = (step) => /** @type {Record<string, string[]>} */ (R4_CHANGES)[step] ?? R4_STEPS[step];

/** The page that a person leaves to (and types on there): Config, or Raw when the story is on Config. @param {any} ctx */
const r4Away = (ctx) => (ctx.kind.page === "config" ? "raw" : "config");

/** @param {any} ctx @param {string} page */
function r4Open(ctx, page) {
  r8ActiveStory = ctx;
  ctx.page = page;
  ctx.opening = (ctx.opening ?? 0) + 1;
  ctx.root = pageRoot();
  if (r7Coverage) r7Coverage.ctx = ctx;
  (ctx.modules?.[page] ?? R4_PAGES[page].module()).mount(ctx.root, R4_PAGES[page].params ?? {});
  ctx.root.addEventListener("input", (/** @type {any} */ event) => {
    if (event.target?.disabled) return;
    if (event.target?.getAttribute("type") === "range")
      ctx.controlIntent = (ctx.controlIntent ?? 0) + 1;
    else if (!event.target?.getAttribute("data-key")) ctx.revision = (ctx.revision ?? 0) + 1;
  });
}
/** @param {any} ctx */
function r4Close(ctx) {
  if (!ctx.page) return;
  (ctx.modules?.[ctx.page] ?? R4_PAGES[ctx.page].module()).unmount();
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

/** The device of the story; an empty story gets one first (d9 appears, as another client added it). @param {any} ctx @returns {string} */
function r4StoryDevice(ctx) {
  const { world } = ctx;
  if (!world.spec.devices.length) {
    world.spec.devices.push({ name: "d9", o: {} });
    world.lives.set("d9", 1);
    world.rev += 1;
    r4Live(world, "device", r4View(world, "d9", world.epoch, 1, world.rev));
  }
  return world.spec.devices[0].name;
}

/** The device's config membership changes (configured ↔ blob-only), in the same life. @param {any} ctx @param {"config"|"blob"} [to] */
function r4Membership(ctx, to) {
  const { world } = ctx;
  const name = r4StoryDevice(ctx);
  const entry = world.spec.devices.find((/** @type {any} */ d) => d.name === name);
  entry.o.origin = to ?? (entry.o.origin === "blob" ? "config" : "blob");
  world.rev += 1;
  r4Live(world, "device", r4View(world, name, world.epoch, world.lives.get(name), world.rev));
}

/**
 * The settings form can take an edit: values are there. A form whose load
 * is still out gets them through the live channel (a `settings` event), as
 * pixdcon may send them before it answers the GET (gate r4 §4).
 *
 * @param {any} ctx
 */
async function r4FormReady(ctx) {
  if (!ctx.root.querySelector(".set-body")) throw new R4Unreachable(`the ${ctx.page} page has no settings form`);
  if (!field(ctx.root, "n")) {
    const { world } = ctx;
    const entry = world.spec.devices[0];
    world.rev += 1;
    r4Live(world, "settings", r4Settings(world, r4Now(world), entry.name, r4Showing(world)));
    await settle();
  }
  assert.ok(field(ctx.root, "n"), "the form shows values to edit");
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
    if (empty) return r4Type(empty, "typed-later");
    const type = R4_PAGES[ctx.page].type;
    if (type) return type(ctx);
    const fields = r4TextFields(ctx.root);
    if (fields.length) throw new Error(`the ${ctx.page} page has ${fields.length} field(s) to type into: the harness must type there`);
    throw new R4Unreachable(`the ${ctx.page} page has no field to type into`);
  },
  epoch(ctx) {
    r4NewEpoch(ctx.world);
  },
  reincarnate(ctx) {
    const { world } = ctx;
    const name = r4StoryDevice(ctx);
    const life = world.lives.get(name);
    r4Live(world, "device-removed", { name, incarnation: life });
    world.lives.set(name, life + 1);
    world.rev += 1;
    r4Live(world, "device", r4View(world, name, world.epoch, life + 1, world.rev));
  },
  async scene(ctx) {
    // The display shows the other scene (r4, gate r5a A). A settings form then shows that scene, in a scope of its own:
    // pixdcon answers the load of its values, and a person edits its n (9: an edit only this scene's story holds).
    const scene = r4Switch(ctx);
    await settle();
    if (ctx.kind.isolation) return;
    if (ctx.page !== "device" || !ctx.root.querySelector(".set-body")) return;
    ctx.calls.find((/** @type {any} */ c) => !c.answered && c !== ctx.op && c.method === "GET" && c.path.endsWith(`/settings/${scene}`))?.ok();
    await settle();
    await r4FormReady(ctx);
    r4Edit(ctx, "n", "9");
  },
  async commit(ctx) {
    await r4FormReady(ctx);
    if (/Add the device to config\.json/.test(r4Text(ctx.root.querySelector(".set-desc")))) {
      // A Save needs the device in config.json: it was adopted meanwhile (the
      // adoption's answer may still be out, gate r4 §4). Membership changes too.
      r4Membership(ctx, "config");
      ctx.changed.add("membership");
      await settle();
    }
    if (saveButton(ctx.root).disabled) {
      r4Edit(ctx, "n", "7");
      await settle();
      const put = ctx.calls.find((/** @type {any} */ c) => !c.answered && c !== ctx.op && c.method === "PUT" && c.path.endsWith("/preview"));
      put?.ok();
      await settle();
    }
    if (saveButton(ctx.root).disabled) throw new R4Unreachable("Save, Revert and Clear are one busy slot: Save stays disabled while the operation runs");
    r4Click(saveButton(ctx.root));
    await settle();
    const save = [...ctx.calls].reverse().find((/** @type {any} */ c) => !c.answered && c !== ctx.op && c.method === "PUT" && /\/settings\/[^/]+$/.test(c.path));
    assert.ok(save, "the commit's Save was sent");
    save.ok();
    // A Save pixdcon refuses commits nothing: it is no change of the committed draft.
    if (save.refusal) throw new R4Unreachable(R4_NO_COMMIT);
  },
  async "newer draft"(ctx) {
    await r4FormReady(ctx);
    r4Edit(ctx, "n", "3");
  },
  async "other field"(ctx) {
    await r4FormReady(ctx);
    r4Edit(ctx, "m", "3");
  },
  schema(ctx) {
    // pixdcon took a changed scene file: a newer SettingsState with another
    // definition, in the same run, life, scene, and with the same draft. From
    // now on pixdcon judges values by it (the story's second definition).
    const { world } = ctx;
    const name = r4StoryDevice(ctx);
    const entry = world.spec.devices.find((/** @type {any} */ d) => d.name === name);
    const scene = entry.o.scene ?? "clock";
    world.schemas.set(scene, world.definitions[scene][1]);
    world.rev += 1;
    r4Live(world, "settings", r4Settings(world, r4Now(world), name, scene));
  },
  revisit(ctx) {
    // Cancel, and the same device's row opens again, in the same opening: a new visit of the editor.
    const cancel = ctx.root.querySelector('.ct-edit [data-act="cancel"]');
    if (cancel) r4Click(cancel);
    const edit = ctx.root.querySelector(`[data-act="edit"][data-device="${ctx.world.spec.devices[0]?.name}"]`);
    if (!edit) throw new R4Unreachable(ctx.page === "config" ? R4_NO_ROW : `the ${ctx.page} page has no edit row`);
    r4Click(edit);
    ctx.root.querySelector('.ct-edit [name="displayName"]')?.focus();
  },
  membership(ctx) {
    r4Membership(ctx);
  },
  reconnect(ctx) {
    r4Snapshot(ctx.world);
  },
};

/** The single changes of R4_STEPS. @type {Record<string, (ctx: any) => Promise<void>|void>} */
const R4_STEP = {
  "same stream epoch"(ctx) { r4NewEpoch(ctx.world, true); },
  "leave without editing"(ctx) { ctx.home = ctx.page; r4Close(ctx); r4Open(ctx, r4Away(ctx)); ctx.awayFrom = ctx.home; },
  "equal editor value"(ctx) {
    const input = r4TextFields(ctx.root).find((/** @type {any} */ el) => !el.getAttribute("data-key"));
    if (!input) throw new R4Unreachable("no editor input in this opening");
    r4Type(input, input.value);
  },
  async "replace current operation"(ctx) {
    if (!ctx.op) return;
    if (!ctx.slotKey) {
      const form = ctx.modules?.__r8SettingsForm ?? await import(new URL("../../web/js/components/settings-form.js", import.meta.url).href);
      const device = r4State().devices.get(ctx.world.spec.devices[0]?.name);
      if (!device || !ctx.op.body?.session) throw new R4Unreachable("this request has no operation slot or preview lane");
      form.retryEnd(device, r4Showing(ctx.world), ctx.op.body.session);
      ctx.slotKey = [...r4State().ops].filter(([, slot]) => slot.busy).sort((a, b) => b[1].token - a[1].token)[0]?.[0];
      return;
    }
    const ops = await import("../../web/js/ops.js");
    // A real successor in the same registry slot; identical request values.
    // The transport stays held just like Reload's replacement GET.
    void ops.follow(ctx.slotKey, () => request(ctx.op.method, ctx.op.path, { resource: ctx.op.origin?.resource ?? "config", ...(ctx.op.body === undefined ? {} : { body: ctx.op.body }),
    }), { value: r4State().ops.get(ctx.slotKey)?.value });
  },
  "same value slider input"(ctx) {
    const range = ctx.root.querySelector('input[type="range"]');
    if (!range) throw new R4Unreachable("this page has no slider");
    if (range.disabled) throw new R4Unreachable("a disabled slider cannot acquire a new input owner");
    // Input is a distinct local ownership intent; no change event/request.
    typeInto(range, range.value, "input");
  },
  "newer config position"(ctx) {
    ctx.world.configVersion += 1;
    ctx.world.rev += 1;
    r4Live(ctx.world, "config", { ...CONFIG_STATE, rev: ctx.world.rev });
  },
  async "superseded by Reload"(ctx) {
    r4Click(ctx.root.querySelector('[data-act="reload"]'));
    await settle();
    r4Pending(ctx, "POST", "/config/reload").ok();
    await settle();
    assert.ok(ctx.calls.some((/** @type {any} */ call) => call !== ctx.op && !call.answered && call.method === "GET" && call.path.endsWith("/config/raw")), "Reload's replacement GET is out while the retired GET fails");
  },
  async "a newer draft pixdcon takes"(ctx) {
    await r4FormReady(ctx);
    r4Edit(ctx, "n", "0");
  },
  async "equal value retyped"(ctx) {
    await r4FormReady(ctx);
    r4Edit(ctx, "n", "2");
  },
  async "value changed away and back"(ctx) {
    await r4FormReady(ctx);
    r4Edit(ctx, "n", "3");
    await settle();
    r4Edit(ctx, "n", "2");
  },
  async "reset replaced by equal default"(ctx) {
    await r4FormReady(ctx);
    r4Edit(ctx, "m", "6");
  },
  async "reset replaced by an edit"(ctx) {
    await r4FormReady(ctx);
    r4Edit(ctx, "m", "7");
  },
  async "another field reset"(ctx) {
    await r4FormReady(ctx);
    r6Reset(ctx, "m");
  },
  "the new owner slides"(ctx) {
    const range = ctx.root.querySelector('input[type="range"]');
    if (!range || range.disabled) throw new R4Unreachable(R4_NO_OWNER);
    typeInto(range, "60", "input");
    typeInto(range, "60", "change");
  },
};

/**
 * Revalidation (gate note2 M2; design note §3): after the scene definition
 * changed, what the form says about each edit that remains is what the
 * definition pixdcon holds now says about it.
 *  - At every point: a reason beside a field is the current definition's.
 *    A reason an earlier definition gave is not said in the form of the
 *    new one, whenever its answer comes.
 *  - Once everything was answered (`final`): an edit the current definition
 *    refuses says so, with pixdcon's reason; and an edit the form says it
 *    previews is one pixdcon holds (it was sent again and taken), so the
 *    form does not claim a preview the display does not show.
 *
 * @param {any} ctx @param {boolean} final
 * @returns {string[]}
 */
function r4Revalidation(ctx, final) {
  /** @type {string[]} */
  const out = [];
  const { world } = ctx;
  const entry = world.spec.devices[0];
  if (ctx.page !== "device" || !ctx.root || !entry) return out;
  const layer = world.layers.get(r4Scope(world, entry.name, r4Showing(world)));
  const schema = world.schemas.get(r4Showing(world)) ?? {};
  for (const row of ctx.root.querySelectorAll(".set-body [data-row]")) {
    const key = row.getAttribute("data-row");
    const marker = r4Text(row.querySelector(".mk"));
    const said = r4Refusal(ctx.root, key);
    const value = Number(r4Value(row.querySelector("[data-key]")));
    const edit = /^(previewing|not previewed)/.test(marker);
    const reason = edit ? r4Verdict(schema[key], value) : null;
    const now = reason ? `the current one says "${reason}"` : "the current one takes the value";
    if (/^pixdcon refused this value/.test(said) && said !== `pixdcon refused this value: ${reason}`) {
      out.push(`row ${key} says "${said}" about ${value}: a reason of an earlier scene definition (${now})`);
      continue;
    }
    if (!final || !edit) continue;
    if (reason && said === "none") out.push(`the edit ${key} = ${value} remains and the row says "${marker.split("·")[0].trim()}", but the current scene definition refuses it ("${reason}") and the form does not say so: the edits that remain were not revalidated`);
    if (!reason && /^previewing/.test(marker) && layer?.values?.[key] !== value)
      out.push(`the row says it previews ${key} = ${value}, but pixdcon holds no preview of it under the current scene definition: the edit that remains was not sent again`);
  }
  return out;
}

/**
 * The edits of the story survive (gate r5a B), asserted from what the story
 * typed, not from what the form still claims: an edit that was typed in the
 * scope and the opening the form shows now, and that no newer edit of its
 * key replaced, still has its value in its field; and unless a Save that
 * pixdcon answered with 200 carried it, the form still holds it as an edit.
 * An edit whose scope ended (another run, life or scene), whose opening
 * ended, or that Revert took, is not expected: the story takes those off
 * its list itself.
 *
 * @param {any} ctx
 * @returns {{found: string[], pending: Record<string, number>, resets: string[]}} pending: the sets and resets a Save has still to send
 */
function r4Survival(ctx) {
  /** @type {string[]} */
  const found = [];
  /** @type {Record<string, number>} */
  const pending = {};
  const resets = /** @type {string[]} */ ([]);
  if (ctx.page !== "device" || !ctx.root) return { found, pending, resets };
  const scene = r4Showing(ctx.world);
  const here = r4FormScope(ctx);
  for (const [key, edit] of ctx.edits) {
    if (edit.scope !== here || edit.opening !== ctx.opening) continue;
    const saved = ctx.calls.some((/** @type {any} */ c) => c.method === "PUT" && c.path.endsWith(`/settings/${scene}`) && c.status === 200 && c.submitted?.get(key) === edit && (edit.intent === "reset" ? c.body?.reset?.includes(key) : String(c.body?.set?.[key]) === edit.value));
    const shown = r4Value(field(ctx.root, key));
    const marker = r4Marker(ctx.root, key);
    const what = `the edit ${key} = ${edit.value} of the story (${saved ? "a Save that pixdcon answered carried it" : "neither saved nor reverted, its scope and opening still shown"})`;
    if (shown !== edit.value) found.push(`${what} is gone: its field reads ${shown}`);
    else if (!saved && !/^(previewing|not previewed)/.test(marker)) found.push(`${what} is gone: the form holds no edit of ${key}, its row says "${marker}"`);
    if (!saved) {
      if (edit.intent === "reset") resets.push(key);
      else pending[key] = Number(edit.value);
    }
  }
  return { found, pending, resets };
}

/**
 * What the next Save sends (gate r5a B): Save is clicked once everything
 * was observed, and the body of its request is read. It carries exactly the
 * edits of the story that are still to be saved, each with its value. Where
 * the form does not offer Save though such edits remain, it says why: the
 * device is not in config.json, or a row says its edit is not taken.
 *
 * @param {any} ctx @param {Record<string, number>} pending what the story holds as still to be saved @param {string[]} [resets]
 * @returns {Promise<{sends: string|null, found: string[]}>} sends: what it sent, as a piece of the comparison; null: the page has no settings form
 */
async function r4NextSave(ctx, pending, resets = []) {
  /** @type {string[]} */
  const found = [];
  if (ctx.page !== "device" || !ctx.root?.querySelector(".set-body")) return { sends: null, found };
  const expected = JSON.stringify(Object.fromEntries(Object.entries(pending).sort()));
  const save = saveButton(ctx.root);
  if (!save || save.disabled) {
    const why = /Add the device to config\.json/.test(r4Text(ctx.root.querySelector(".set-desc"))) || ctx.root.querySelectorAll(".set-body .mk").some((/** @type {any} */ mk) => /^not previewed, not saved/.test(r4Text(mk)));
    if ((Object.keys(pending).length || resets.length) && !why) found.push(`the next Save: the form does not offer Save and says no reason, though the story's edits ${expected}${resets.length ? ` and resets ${JSON.stringify(resets)}` : ""} are still to be saved`);
    return { sends: "Save is not offered", found };
  }
  const before = ctx.calls.length;
  r4Click(save);
  await settle();
  const put = ctx.calls.slice(before).find((/** @type {any} */ c) => c.method === "PUT" && /\/settings\/[^/]+$/.test(c.path));
  if (!put) {
    found.push("the next Save: Save was clicked and sent no request");
    return { sends: "nothing", found };
  }
  const set = JSON.stringify(Object.fromEntries(Object.entries(put.body?.set ?? {}).sort()));
  if (set !== expected) found.push(`the next Save sends set ${set}: the story's edits that are still to be saved are ${expected}`);
  if (JSON.stringify([...(put.body?.reset ?? [])].sort()) !== JSON.stringify([...resets].sort())) found.push(`the next Save sends reset ${JSON.stringify(put.body?.reset)}: the story still intends reset ${JSON.stringify(resets)}`);
  return { sends: `set ${set} · reset ${JSON.stringify([...(put.body?.reset ?? [])].sort())}`, found };
}

/** Every Save, including the first and the follow-up, carries exactly the ledger's sets and resets. @param {any} ctx @returns {string[]} */
function r6SaveBodies(ctx) {
  const found = [];
  for (const [index, call] of ctx.calls.entries()) {
    if (call.method !== "PUT" || !/\/settings\/[^/]+$/.test(call.path)) continue;
    const set = /** @type {Record<string, number>} */ ({});
    const reset = /** @type {string[]} */ ([]);
    for (const [key, edit] of call.submitted ?? []) {
      if (edit.scope !== call.formScope || edit.opening !== call.opening) continue;
      const acknowledged = ctx.calls.slice(0, index).some((/** @type {any} */ before) => before.status === 200 && before.method === "PUT" && before.path === call.path && before.submitted?.get(key) === edit);
      if (acknowledged) continue;
      if (edit.intent === "reset") reset.push(key);
      else set[key] = Number(edit.value);
    }
    const actual = { set: Object.fromEntries(Object.entries(call.body?.set ?? {}).sort()), reset: [...(call.body?.reset ?? [])].sort() };
    const expected = { set: Object.fromEntries(Object.entries(set).sort()), reset: reset.sort() };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) found.push(`Save request ${index + 1} sends ${JSON.stringify(actual)}; submitted story identities intend ${JSON.stringify(expected)}`);
  }
  return found;
}

/**
 * The Health pane holds the log of the run pixdcon is in (gate note2 M3):
 * once a load of that run was answered, or a new run began, its lines are
 * in the pane; a line of an earlier run never is. Asking again is not
 * enough: what the answer brings must reach the pane.
 *
 * @param {any} ctx
 * @returns {string[]}
 */
function r4LogOfTheRun(ctx) {
  /** @type {string[]} */
  const out = [];
  if (ctx.page !== "health" || !ctx.root) return out;
  const { world } = ctx;
  const pane = r4Text(ctx.root.querySelector(".log"));
  const answered = ctx.calls.some((/** @type {any} */ c) => c.method === "GET" && c.path === "/api/v2/log" && c.epoch === world.epoch && c.status === 200);
  const missing = R4_LOG(world.epoch).filter((line) => !pane.includes(line.message));
  if ((answered || ctx.changed.has("epoch")) && missing.length)
    out.push(
      r4InStory(world, `the log pane does not show the lines of the run pixdcon is in (${missing.map((line) => line.message).join("; ")})${answered ? ", though a load of that run was answered with them" : ": no load of that run was answered"}; it reads "${pane}"`),
    );
  for (const epoch of world.epochs.filter((/** @type {string} */ e) => e !== world.epoch))
    for (const line of R4_LOG(epoch)) if (pane.includes(line.message)) out.push(r4InStory(world, `the log pane shows a line of an earlier run: ${line.message}`));
  return out;
}

/** A request as the story reads it: its method, path and body, without the page's session and draft numbers (they rise with every edit of every story). @param {any} call */
const r4Request = (call) =>
  `${call.method} ${call.path}${call.body === undefined ? "" : ` ${JSON.stringify(Object.fromEntries(Object.entries(call.body).filter(([key]) => key !== "session" && key !== "draft")))}`}`;

/**
 * One run of a story.
 *
 * @param {any} t the test (its manual clock)
 * @param {R4Kind} kind
 * @param {string|null} change an R4Change, or a story of two (R4_COMPOSITES); null: no change (the reference of a reconnect)
 * @param {R4End} end
 * @param {"case"|"without"|"early"|"after"|"probe"|"source"} mode after: the change comes after the end (the commuted story); probe: only whether the change can be made
 * @param {Record<string, any>} [modules] pages to mount instead of the real ones (the self-tests' mutants)
 * @param {boolean} [last] the old operation ends last (r4): before it ends, pixdcon answers everything the change started, and the person carries on (`again`)
 * @returns {Promise<{points: Array<Map<string, {deps: R4Deps, value: string}>>, changed: Set<string>, absolute: string[], definition: string[], unreachable?: string, nextSave?: string|null, replacing?: string|null, calls?: any[], sent?: string[], op?: string|null, origin?: any}>} definition: what the revalidation found (part of `absolute`); nextSave: what the next Save sent; replacing: the replacement load that was still out when the old operation ended; calls: the requests of the story; sent: the same, each as r4Request reads it; op: the operation's own request
 */
async function r4Run(t, kind, change, end, mode, modules, last = false) {
  if (!r8HarnessLoaded) await r8HarnessReady;
  // The ordinary matrix and audit use the same neutral measurement adapters.
  // Fault injection remains disabled unless r7Coverage selects an outcome.
  const measuredModules = await r8MeasurementModules();
  modules = { ...measuredModules, ...modules };
  for (const key of [...r4State().ops.keys()]) r4SetOp(key, null);
  fakeDocument.activeElement = null;
  const world = r4World(kind.world);
  const steps = r4Steps(change);
  /** @type {any} */
  const ctx = { world, calls: r4Server(world), kind, page: null, root: null, op: null, modules, changed: new Set(steps.flatMap(r4StepChanges)), edits: new Map(), shows: 0, opening: 0, revision: 0, visit: 0, clock: 0 };
  world.story = ctx;
  /** The change of the story: its single changes, one after the other. */
  const make = async () => {
    const before = r8Frame(ctx);
    let completed = false;
    try {
      for (const step of steps) {
        await (/** @type {Record<string, (ctx: any) => Promise<void>|void>} */ (R4_CHANGE)[step] ?? R4_STEP[step])(ctx);
        await settle();
      }
      completed = true;
    } finally {
      const receipt = r8RecordStory(ctx, before, r8Frame(ctx), `${change ?? "no change"}/${end}/${mode}${last ? "/last" : ""}`);
      receipt.completed = completed;
    }
  };
  r4NewEpoch(world);
  /** @type {Array<Map<string, {deps: R4Deps, value: string}>>} */
  const points = [];
  ctx.points = points;
  /** What must hold in the case whatever the reference shows. @type {string[]} */
  const absolute = [];
  /** What the revalidation found: said for the reference's run too. @type {string[]} */
  const definition = [];
  const revalidate = (/** @type {number} */ point) => {
    if (!ctx.changed.has("schema")) return;
    for (const found of r4Revalidation(ctx, point === R4_LAST)) {
      definition.push(`${R4_POINTS[point]}: ${found}`);
      absolute.push(`${R4_POINTS[point]}: ${found}`);
    }
  };
  const held = () => {
    const broken = ctx.op && !ctx.op.answered && ctx.page === kind.page ? kind.invariant?.(ctx) : null;
    if (broken) absolute.push(broken);
  };
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
      ctx.op = ctx.calls.slice(before).find(isOp);
      // Synchronously, before any answer: what must hold while it runs.
      held();
      await settle();
      ctx.op = ctx.calls.slice(before).find(isOp);
      assert.ok(ctx.op, `${kind.name}: the operation sent ${method} …${tail}`);
      // The story is the one the kind names: pixdcon did with the request what the kind says (a rejection is there).
      kind.sent?.(ctx.op);
    }
    ctx.slotKey = ctx.op?.origin?.slotKey ?? [...r4State().ops].filter(([, slot]) => slot.busy).sort((a, b) => b[1].token - a[1].token)[0]?.[0];
    ctx.issuedOp = ctx.op;
    // The inventory prepass needs the request's actual source, not another
    // complete acceptance history. Cleanup still answers and retires its work.
    if (mode === "source") return { points, changed: ctx.changed, absolute, definition, origin: ctx.op?.origin, calls: ctx.calls };
    if (mode === "early" || kind.completeBeforeChange) {
      ctx.op?.ok();
      ctx.op = null;
      await settle();
    }
    if (mode === "without" && kind.atOpen) throw new Error("an operation that opens with the page has an early reference");
    ctx.clock += 10_000;
    t.mock.timers.tick(10_000);
    const observe = () => new Map(R4_PAGES[ctx.page].pieces(ctx.root).map(([name, deps, value]) => [`${ctx.page}: ${name}`, { deps, value: r4InStory(world, value) }]));
    ctx.changeAt = ctx.calls.length;
    if (mode === "probe") {
      try {
        await make();
      } catch (error) {
        if (error instanceof R4Unreachable) return { points, changed: ctx.changed, absolute, definition, unreachable: error.message };
        throw error;
      }
      return { points, changed: ctx.changed, absolute, definition };
    }
    if (mode !== "after") await make();
    await settle();
    if (last) {
      // The old operation ends last: what the change started is answered first (the new opening's load, the new
      // scope's values), and the person carries on where the change left the page: the row opened again, the text
      // typed again. So the page has become something else for good when the old answer comes.
      await r4AnswerAll(ctx, ctx.op);
      const again = kind.again === undefined ? kind.setup : kind.again;
      if (again && !ctx.changed.has("scene")) await again(ctx);
      await settle();
    }
    if (!ctx.changed.has("epoch") && !ctx.changed.has("life")) held();
    if (r7Coverage) await r7ProbeOutcomes(ctx);
    points.push(observe());
    ctx.endAt = ctx.calls.length;
    if (end === "timeout") {
      ctx.op?.abandon();
      ctx.clock += 5_000;
      t.mock.timers.tick(5_000);
      // The time bound ended the request. pixdcon's answer comes after all (r4): a late answer to a request that ran
      // out of time changes nothing, the outcome stays "did not answer within 15 s".
      await settle();
      ctx.op?.late();
    } else if (ctx.op) {
      if (end === "success") ctx.op.ok();
      else if (end === "refused") {
        if (kind.refuse) kind.refuse(ctx.op);
        else ctx.op.answer(422, { code: "invalid_config", error: "config.json is not valid", message: "Line 2: a value is missing.", line: 2 });
      } else ctx.op.answer(500, {});
    }
    // The old operation ends while what replaced it is still out (gate r5a C): the load a page sent again for the new run.
    const reload = kind.page === "raw" ? "/api/v2/config/raw" : kind.page === "health" ? "/api/v2/log" : null;
    const replacing = reload && ctx.calls.slice(ctx.changeAt).some((/** @type {any} */ c) => !c.answered && c !== ctx.op && c.method === "GET" && c.path === reload) ? `GET ${reload}` : null;
    await settle();
    if (r7Coverage) await r7ProbeOutcomes(ctx);
    points.push(observe());
    // What the old operation's answer left beside a field belongs to the definition pixdcon holds now (gate note2 M2).
    if (mode !== "after") revalidate(1);
    // The next render, while what the change started is still out (r4): pixdcon says its devices again (same data, a
    // newer revision). What the old end left for "the next render" shows before any later answer can repair it.
    const again = () => {
      for (const d of world.spec.devices) {
        world.rev += 1;
        r4Live(world, "device", r4View(world, d.name, world.epoch, world.lives.get(d.name), world.rev));
      }
    };
    again();
    await settle();
    if (r7Coverage) await r7ProbeOutcomes(ctx);
    points.push(observe());
    if (mode === "after") {
      ctx.changeAt = ctx.calls.length;
      await make();
      await settle();
    }
    if (ctx.awayFrom) {
      r4Close(ctx);
      r4Open(ctx, ctx.awayFrom);
      ctx.awayFrom = null;
    }
    await r4AnswerAll(ctx);
    // The next render: pixdcon says its devices again (same data, a newer revision), so what a
    // continuation left for "the next render" shows in both runs (the gutter, gate r4 §4).
    again();
    await r4AnswerAll(ctx);
    if (r7Coverage) await r7ProbeOutcomes(ctx);
    points.push(observe());
    // Captured identities are inherited: no request of an earlier run or life starts after it ended (gate r4 §2, §3).
    for (const call of ctx.calls.slice(ctx.changeAt)) if (call.stray) absolute.push(`a request for a scope pixdcon no longer holds was started after the change: ${call.stray}`);
    // A page whose load belongs to a run loads again in the new one (the epoch rule), and is not left loading (gate r4 §4).
    if (ctx.changed.has("epoch") && (kind.page === "raw" || kind.page === "health")) {
      const load = kind.page === "raw" ? "/api/v2/config/raw" : "/api/v2/log";
      if (!ctx.calls.slice(ctx.changeAt, ctx.endAt).some((/** @type {any} */ c) => c.method === "GET" && c.path === load))
        absolute.push(`no replacement load of ${load} was sent when the new run's snapshot was taken`);
      if (kind.page === "raw" && /Loading config\.json/.test(r4Text(ctx.root.querySelector(".edbar .state")))) absolute.push("the editor still says it is loading after everything was answered");
    }
    // The data, not only the request: the pane holds the lines of the run pixdcon is in, and none of an earlier run (gate note2 M3).
    absolute.push(...r4LogOfTheRun(ctx));
    // The edits that remain say what the definition pixdcon holds now says about them (gate note2 M2).
    revalidate(R4_LAST);
    // The story's edits survive, each with its value, and the next Save carries exactly them (gate r5a B).
    const survival = r4Survival(ctx);
    absolute.push(...survival.found.map((found) => `${R4_POINTS[R4_LAST]}: ${found}`));
    const next = await r4NextSave(ctx, survival.pending, survival.resets);
    absolute.push(...next.found, ...r6SaveBodies(ctx));
    return { points, changed: ctx.changed, absolute, definition, nextSave: next.sends, replacing, origin: ctx.op?.origin, calls: ctx.calls, sent: ctx.calls.map(r4Request), op: mode === "case" && ctx.op ? r4Request(ctx.op) : null };
  } finally {
    r4Close(ctx);
    await r4AnswerAll(ctx);
    t.mock.timers.tick(60_000);
    await settle();
    // Retained request records keep world; the completed ledger must not
    // keep this unmounted DOM and its listeners alive through that world.
    world.story = null;
    if (r8ActiveStory === ctx) r8ActiveStory = null;
  }
}

/**
 * The differences between a case and its reference, in the pieces the rule
 * protects: those whose identities include one the change changed. For a
 * reconnect and for a commuted story ("after") it is every piece: the
 * claim there is that the case ends where the other story ends, so an
 * effect the claim promises to keep (Save's acknowledgement after a change
 * of definition) is compared too, and cannot be suppressed unseen (gate
 * note2 M1).
 *
 * @param {string} change
 * @param {{points: Array<Map<string, {deps: R4Deps, value: string}>>, changed: Set<string>, absolute: string[], nextSave?: string|null}} got
 * @param {{points: Array<Map<string, {deps: R4Deps, value: string}>>, definition?: string[], nextSave?: string|null}} want
 * @param {"early"|"without"|"after"|"none"} reference how the reference ran
 * @param {boolean} atOpen the operation is the load the page's opening sent
 * @returns {string[]}
 */
function r4Differences(change, got, want, reference, atOpen) {
  const changed = got.changed;
  const story = reference === "none" ? "without the reconnect" : reference === "after" ? "with the change after the end" : "without the old operation";
  /** Every piece is compared, whatever it depends on. */
  const whole = reference === "none" || reference === "after";
  // What the revalidation finds in the reference's story is said too: that story holds the same change of definition.
  /** @type {string[]} */
  const out = [...got.absolute, ...(want.definition ?? []).map((found) => `in the story ${story}, ${found}`)];
  got.points.forEach((pieces, i) => {
    // A reference that ended its operation at once differs from the case
    // while the case's operation still runs; a reconnect is compared where
    // everything was answered (the fence may ask again meanwhile), and so is
    // a commuted story (its change came later). A load that opens with the
    // page is compared where everything was answered: until then the
    // reference holds data the case still waits for.
    if ((reference === "early" && i === 0) || (atOpen && i < R4_LAST) || ((reference === "none" || reference === "after") && i < R4_LAST)) return;
    for (const [name, piece] of pieces) {
      const value = want.points[i]?.get(name)?.value;
      // A piece whose identities follow what it says is judged by what the case says: a slot outcome there is not draft feedback.
      const deps = typeof piece.deps === "function" ? piece.deps(piece.value) : piece.deps;
      if (!whole && !deps.some((d) => changed.has(d))) continue;
      for (const receipt of r8Stories.filter((s) => s.points === got.points))
        receipt.compared.set(name, deps);
      if (piece.value !== value) out.push(`${R4_POINTS[i]}, ${name} [${deps.join(", ")}]: "${piece.value}" — the story ${story} reads "${value}"`);
    }
  });
  // What the next Save sends is the pending bookkeeping itself, read from the request (gate r5a B).
  if (got.nextSave != null && want.nextSave != null && got.nextSave !== want.nextSave && (whole || R4_BOOKKEEPING.some((d) => changed.has(d))))
    out.push(`${R4_POINTS[R4_LAST]}, the next Save [${R4_BOOKKEEPING.join(", ")}]: "${got.nextSave}" — the story ${story} sends "${want.nextSave}"`);
  return out;
}

/**
 * Between the point after the change and the two points after the end
 * nothing happens but the old operation's end (its answer, its failure or
 * its time running out) and one more render of the same data, while whatever
 * the change started in its place is still out (gate r5a C). So no piece of
 * a changed identity reads differently there than before the end, whatever
 * a later answer repairs. This is the rule itself, read in the one run; it
 * also holds where the reference cannot be compared yet (a load that opens
 * with the page: until everything was answered its reference holds data the
 * case still waits for). The reference's run guards the render: a piece
 * that the same render rewrites in the story without the old operation is
 * not counted.
 *
 * @param {{points: Array<Map<string, {deps: R4Deps, value: string}>>, changed: Set<string>, replacing?: string|null}} got
 * @param {{points: Array<Map<string, {deps: R4Deps, value: string}>>}} want
 * @returns {string[]}
 */
function r4EndAlone(got, want) {
  /** @type {string[]} */
  const out = [];
  const before = got.points[0];
  for (const i of [1, 2])
    for (const [name, piece] of got.points[i] ?? []) {
      const deps = typeof piece.deps === "function" ? piece.deps(piece.value) : piece.deps;
      if (!deps.some((d) => got.changed.has(d))) continue;
      const was = before?.get(name)?.value;
      // A piece whose identities follow what it says belonged to a changed identity before the end, too (a load's
      // "Loading" is not the typed text's: when the load ends, the line may say how the text reads).
      const depsBefore = typeof piece.deps === "function" && was !== undefined ? piece.deps(was) : deps;
      if (!depsBefore.some((d) => got.changed.has(d)) || piece.value === was) continue;
      if (want.points[i]?.get(name)?.value !== want.points[0]?.get(name)?.value) continue;
      out.push(`${R4_POINTS[i]}, ${name} [${deps.join(", ")}]: "${piece.value}" — it read "${was}" before the old operation ended${got.replacing ? `, and what replaced it (${got.replacing}) was still out` : ""}: the old operation's end changed it`);
    }
  return out;
}

/**
 * The scope the requests of a kind's continuations belong to (note §3, the
 * projection of "request start"): the settings form's is its opening and
 * the scene in one life of the device in one run; Raw's and Health's the
 * opening and the run; Create copy's the scene and the run; Add device's
 * and Overlays' the run; a device control's the device's life in one run.
 *
 * @param {R4Kind} kind
 * @returns {string[]}
 */
function r4RequestScope(kind) {
  if (kind.name.startsWith("settings ")) return ["opening", "epoch", "life", "scene"];
  if (kind.page === "raw" || kind.page === "health") return ["opening", "epoch"];
  if (kind.name === "device copy") return ["epoch", "scene"];
  if (/add device$/.test(kind.name) || kind.page === "overlays") return ["epoch"];
  return ["epoch", "life"];
}

/**
 * The requests an old operation starts (r4, from the guard-removal sweep):
 * once the scope it began in ended (another opening, run, life or scene), a
 * continuation starts no request (note §3: captured identities are
 * inherited, and checked before a request starts). So the story sends no
 * request that the story without the old operation does not send. Read
 * over the whole story, so a step that waited in a lane behind the old
 * request, and is sent when it ends, is the same request in both.
 *
 * @param {R4Kind} kind
 * @param {{changed: Set<string>, sent?: string[], op?: string|null}} got
 * @param {{sent?: string[]}} want
 * @param {"early"|"without"} reference
 * @returns {string[]}
 */
function r4Started(kind, got, want, reference) {
  if (!r4RequestScope(kind).some((d) => got.changed.has(d)) || !got.sent || !want.sent) return [];
  const left = [...want.sent];
  // The story without the old operation does not send the operation's own request.
  let own = reference === "without" ? got.op : null;
  /** @type {string[]} */
  const out = [];
  for (const request of got.sent) {
    const i = left.indexOf(request);
    if (i !== -1) left.splice(i, 1);
    else if (request === own) own = null;
    else out.push(`a request was started that the story without the old operation does not send, though the scope the operation began in had ended: ${request}`);
  }
  return out;
}

/**
 * Changes that are outside everything a kind's end may change, and that are
 * compared both ways: by the rule (the pieces of the changed identity read
 * as without the old operation), and as a commuted story (every piece ends
 * where it ends when the change comes after the end). On the Device page a
 * person types into the Create copy form while another operation runs: that
 * form's revision is no identity of any other operation, so none of their
 * outcomes may be lost to it. `device copy` is the form's own operation.
 *
 * @param {R4Kind} kind
 * @returns {string[]}
 */
const r4Keeps = (kind) => (kind.page === "device" && kind.name !== "device copy" ? ["type"] : []);

/**
 * The kinds whose effects are a scene's (r4, gate r5a A): the settings form
 * (its scope is the scene in one life of the device) and Create copy (its
 * slot is `copy:<scene>`). For every other kind the scene the display shows
 * is outside its projection.
 *
 * @param {R4Kind} kind
 */
const r4SceneScoped = (kind) => kind.name.startsWith("settings ") || kind.name === "device copy";
/**
 * Whether a change is outside the projection of a kind's effects: the case
 * then ends, in every piece, where the story ends when the change comes
 * after the end. A kind names its own (`commutes`); a change of scene is
 * outside every kind that is not a scene's.
 *
 * @param {R4Kind} kind @param {string} change
 */
const r4Commutes = (kind, change) => (kind.name === "settings save" && change === "another field reset") || /** @type {string[]} */ (kind.commutes ?? []).includes(change) || (change === "scene" && !r4SceneScoped(kind));

/**
 * The changes after which the page becomes something else by answers of its
 * own: a new opening loads again, a new run or life is a new scope with its
 * own load, another scene has its own values. For these a story also runs
 * with the old operation ending last (r4, from the guard-removal sweep):
 * the first order (the old end while what replaced it is still out) does
 * not show an old answer that overwrites what the page has become since.
 * Not for a change outside the kind's projection, nor for a reconnect:
 * those are compared where everything was answered already.
 *
 * @param {R4Kind} kind @param {string} change
 */
const r4EndsLast = (kind, change) => ["reopen", "epoch", "reincarnate", "scene"].includes(change) && !r4Commutes(kind, change) && !r4Unreachable(kind, /** @type {R4Change} */ (change));

/** The ends a kind runs. @param {R4Kind} kind @returns {R4End[]} */
const r4Ends = (kind) => kind.only ?? [...R4_ENDS, ...(kind.ends ?? [])];

/**
 * A case: the story and its reference, compared.
 *
 * @param {any} t @param {R4Kind} kind @param {string} change an R4Change, or a story of two (R4_COMPOSITES) @param {R4End} end
 * @param {{modules?: Record<string, any>, references?: Map<string, any>, last?: boolean}} [o] modules: mutants instead of the pages (self-tests); last: the old operation ends last
 */
async function r4Case(t, kind, change, end, o = {}) {
  const references = o.references ?? new Map();
  const last = Boolean(o.last);
  const early = Boolean(kind.early || kind.atOpen);
  /** @type {"early"|"without"|"after"|"none"} */
  const reference = change === "reconnect" ? "none" : r4Commutes(kind, change) ? "after" : early ? "early" : "without";
  const key = `${reference === "none" ? `${kind.name}|none|${end}` : reference === "after" ? `${kind.name}|${change}|after|${end}` : `${kind.name}|${change}`}${last ? "|last" : ""}`;
  if (!references.has(key))
    references.set(
      key,
      reference === "none" ? await r4Run(t, kind, null, end, "case", o.modules, last) : reference === "after" ? await r4Run(t, kind, change, end, "after", o.modules, last) : await r4Run(t, kind, change, end, reference, o.modules, last),
    );
  const got = await r4Run(t, kind, change, end, "case", o.modules, last);
  const differences = r4Differences(change, got, references.get(key), reference, Boolean(kind.atOpen) && change !== "reconnect");
  // The old operation's end alone changes no piece of a changed identity (gate r5a C). Not for a change outside the
  // kind's projection: there the end may change such a piece, and the story is compared in every piece at its end.
  if (reference === "early" || reference === "without") {
    for (const found of r4EndAlone(got, references.get(key))) if (!differences.includes(found)) differences.push(found);
    differences.push(...r4Started(kind, got, references.get(key), reference));
  }
  // Beside the rule: a change the operation's effects do not depend on takes none of them away (r3, with gate note2 M1).
  // The case ends, in every piece, where the story ends when that change comes after the end.
  if (reference !== "after" && r4Keeps(kind).includes(change)) {
    const after = `${kind.name}|${change}|after|${end}`;
    if (!references.has(after)) references.set(after, await r4Run(t, kind, change, end, "after", o.modules));
    for (const found of r4Differences(change, { ...got, absolute: [] }, references.get(after), "after", false)) if (!differences.includes(found)) differences.push(found);
  }
  return differences;
}

/** The gate's findings, by the case that reproduces each. */
const R4_GATE = {
  "raw reload × reopen × success": "gate r3 M1",
  "config patch × reincarnate × success": "gate r3 M2",
  "config patch × type × success": "gate r3 M2, without removal",
  "overlays clear × epoch × 500": "gate r3 M3",
  "settings preview × commit × 500": "gate r3 M4",
  "settings preview × schema × 500": "gate r4 §1, schema generation",
  "config patch × revisit × success": "gate r4 §1, edit-row visit",
  "settings save × membership × success": "gate r4 §1, config membership",
  "settings preview × epoch × success": "gate r4 §2, the queued cleanup DELETE in a new epoch",
  "settings save × other field × success": "gate r4 §3, Save acknowledges each submitted edit",
  "raw load × epoch × success": "gate r4 §4, a replacement load; gate r5a C, the old answer while the replacement load is out",
  "raw save × type × refused": "gate r4 §4, the gutter",
  "settings load × commit × success": "gate r4 §4, Save while the load is out",
  "settings load × newer draft × success": "gate r4 §4, an edit while the load is out",
  "device adopt × commit × success": "gate r4 §4, membership changes while the adoption is out",
  "device brightness range × reopen × success": "gate r4 §5, the range is disabled throughout its request",
  "settings save × schema × success": "gate note2 M1, Save's acknowledgement after a change of definition, every piece compared",
  "settings preview rejected × schema × success": "gate note2 M2, the old definition's 200 answer with rejected n; gate r5a B, the edit it was sent for survives",
  "settings save rejected × schema × refused": "gate note2 M2, a refused Save across a change of definition",
  "settings preview × schema × success": "gate note2 M2, the edit that remains is revalidated",
  "health log × epoch × success": "gate note2 M3, the new run's lines reach the pane",
  "settings preview × scene × 500": "gate r5a A, Clock's preview fails after the display switched to Weather and Weather's n was edited",
  "settings preview × scene × timeout": "gate r5a A, the same with Clock's preview running out of time",
  "settings preview rejected × scene × success": "gate r5a A, Clock's rejection of n comes after Weather's n was edited",
  "config patch × reopen × success, last": "sweep r5b, the row opened again in the new opening",
  "config add device × reopen × success, last": "sweep r5b, the form typed again in the new opening",
  "raw save × reopen × success, last": "sweep r5b, the text typed again after the new opening's load was answered",
  "raw reload × leave × success": "sweep r5b, a request started after its opening ended",
  "raw save × epoch × success, last": "sweep r5b, an old Save's text taken for the new run's",
  "settings save × scene × 500, last": "sweep r5b, an old Save's failure after Weather's preview was answered",
};

// r5: guard stories. Real module code, held transports, and observations at
// the boundary a guard protects. No source-text assertion counts as a catch.

/** @param {string} file @param {Array<[string, string]>} [edits] @param {Record<string, string>} [replace] */
async function r5Module(file, edits = [], replace = {}) {
  return import(await r4Mutant(file, edits, replace));
}

/**
 * A form without a Device page subscriber: the story delivers the values
 * explicitly, just as the page's subscription does. Requests still use the
 * real API, store and operation slots and the existing server stand-in.
 * @param {any} t @param {any} module @param {(ctx: any) => Promise<void>} story
 * @param {{ready?: boolean, session?: () => string|null}} [options]
 */
async function r5Form(t, module, story, options = {}) {
  const world = r4World({ devices: [{ name: "d1" }] });
  const calls = r4Server(world);
  r4NewEpoch(world);
  const root = pageRoot();
  /** @type {any[]} */
  const reports = [];
  let session = "s1";
  const form = module.createSettingsForm(root, {
    device: "d1",
    session: options.session ?? (() => session),
    onPreviewFailure: (/** @type {any} */ value) => reports.push(value),
  });
  const values = (/** @type {string} */ scene, /** @type {any} */ extra = {}) =>
    r4Settings(world, r4Now(world), "d1", scene, extra);
  const show = (/** @type {string|null} */ scene) =>
    form.setScene(scene, scene, { epoch: world.epoch, incarnation: 1 });
  const edit = async (/** @type {string} */ n) => {
    typeInto(root.querySelector('[data-key="n"]'), n);
    await settle();
  };
  const ctx = {
    world,
    calls,
    root,
    form,
    reports,
    values,
    show,
    edit,
    module,
    session: (/** @type {string} */ value) => {
      session = value;
    },
  };
  try {
    show("clock");
    if (options.ready !== false) {
      pending(calls, "GET", "/settings/clock").ok();
      await settle();
      form.update(values("clock"));
    }
    await story(ctx);
  } finally {
    form.destroy();
    root.remove();
    await r4AnswerAll(ctx);
  }
}

/** @param {any[]} calls @param {string} [scene] */
const r5Previews = (calls, scene = "clock") =>
  calls.filter((c) => c.method === "PUT" && c.path.endsWith(`/settings/${scene}/preview`));

/** @type {Array<{name: string, file: string, edits: Array<[string, string]>, run: (t: any, module: any) => Promise<void>, other?: {file: string, spec: string, edits: Array<[string, string]>}}>} */
const R5_STORIES = [
  {
    name: "unkeyed API cleanup cannot announce a control it never owned",
    file: "api.js",
    edits: [["if (key !== undefined) {\n      busy.delete(key);", "if (true) {\n      busy.delete(key);"]],
    run: async (_t, api) => {
      /** @type {any[]} */
      const notices = [];
      const stop = api.onBusy((/** @type {string} */ key, /** @type {boolean} */ busy) => notices.push([key, busy]));
      fakeFetch(() => new Response("{}", { status: 200 }));
      try {
        await api.request("GET", "/r5-unkeyed", { resource: "r5" });
        assert.deepEqual(notices, [], "an unkeyed request owns no control");
      } finally {
        stop();
      }
    },
  },
  {
    name: "lane tail of preview one cannot free preview two's lane before preview three",
    file: "components/settings-form.js",
    edits: [["if (lanes.get(lane) === tail) lanes.delete(lane);", "if (true) lanes.delete(lane);"]],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit }) => {
        await edit("2");
        await edit("3");
        assert.equal(r5Previews(calls).length, 1, "preview two waits");
        r5Previews(calls)[0].ok();
        await settle();
        assert.equal(r5Previews(calls).length, 2, "preview two now runs");
        await edit("4");
        assert.equal(
          r5Previews(calls).length,
          2,
          "preview three waits for preview two, even after preview one's tail ended",
        );
        r5Previews(calls)[1].ok();
        await settle();
        assert.equal(r5Previews(calls).length, 3);
        assert.equal(r5Previews(calls)[2].body.values.n, 4);
      }),
  },
  {
    name: "queued retry of an end replaced by a successful preview sends no DELETE",
    file: "components/settings-form.js",
    edits: [["if (!current()) return;", "if (false) return;"]],
    run: async (t, m) =>
      r5Form(t, m, async ({ world, calls, edit }) => {
        await edit("2");
        const key = `end:d1/clock@${world.epoch}/1`;
        r4SetOp(key, { token: 500, busy: false, label: "", value: undefined, note: null, failure: "end failed" });
        m.retryEnd({ name: "d1", epoch: world.epoch, incarnation: 1 }, "clock", "s1");
        await settle();
        assert.equal(
          calls.filter((/** @type {any} */ c) => c.method === "DELETE").length,
          0,
          "Retry waits in the lane",
        );
        r5Previews(calls)[0].ok();
        await settle();
        assert.equal(
          calls.filter((/** @type {any} */ c) => c.method === "DELETE").length,
          0,
          "the successful preview replaced Retry's token",
        );
      }),
  },
  {
    name: "unchanged preview failure is reported once across repeated updates",
    file: "components/settings-form.js",
    edits: [["if (failure === reported) return;", "if (false) return;"]],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit, form, values, reports }) => {
        await edit("2");
        r5Previews(calls)[0].answer(500, {});
        await settle();
        const before = [...reports];
        assert.equal(before.length, 1, "the first failure is reported once");
        form.update(values("clock"));
        form.update(values("clock"));
        assert.deepEqual(reports, before, "rendering unchanged values repeats no callback");
      }),
  },
  {
    name: "leave ends a server-held preview even when this opening sent none",
    file: "components/settings-form.js",
    edits: [["!of.previewed && !held && !op(endKey(of)).failure", "!of.previewed && true && !op(endKey(of)).failure"]],
    run: async (t, m) =>
      r5Form(t, m, async ({ form, values, calls }) => {
        form.update(values("clock", { preview: { session: "s1", draft: 200 }, effective: { n: 7 } }));
        const ending = form.end();
        await settle();
        const end = pending(calls, "DELETE", "/settings/clock/preview");
        end.ok();
        await ending;
      }),
  },
  {
    name: "leave retries a failed end even with no locally sent or held preview",
    file: "components/settings-form.js",
    edits: [["!of.previewed && !held && !op(endKey(of)).failure", "!of.previewed && !held && true"]],
    run: async (t, m) =>
      r5Form(t, m, async ({ world, form, calls }) => {
        r4SetOp(`end:d1/clock@${world.epoch}/1`, {
          token: 501,
          busy: false,
          label: "",
          value: undefined,
          note: null,
          failure: "previous end failed",
        });
        const ending = form.end();
        await settle();
        pending(calls, "DELETE", "/settings/clock/preview").ok();
        await ending;
      }),
  },
  {
    name: "queued preview of a scene left while preview one runs is never sent",
    file: "components/settings-form.js",
    edits: [["if (of.left || !id) return;", "if (false || !id) return;"]],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit, show, form, values }) => {
        await edit("2");
        await edit("3");
        show("weather");
        form.update(values("weather"));
        r5Previews(calls)[0].ok();
        await settle();
        assert.equal(r5Previews(calls).length, 1, "the queued draft belongs to the scene that was left");
        assert.ok(
          calls.some((/** @type {any} */ c) => c.method === "DELETE" && c.path.endsWith("/clock/preview")),
          "its end follows the old preview",
        );
      }),
  },
  {
    name: "queued preview rechecks the session when its lane becomes free",
    file: "components/settings-form.js",
    edits: [["if (of.left || !id) return;", "if (of.left || false) return;"]],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit, session }) => {
        await edit("2");
        await edit("3");
        session("");
        r5Previews(calls)[0].ok();
        await settle();
        assert.equal(r5Previews(calls).length, 1, "a session lost while waiting cannot own a new preview");
      }),
  },
  {
    name: "old preview failure cannot repeat the new scene's failure callback",
    file: "components/settings-form.js",
    edits: [
      ["if (!shown(of)) return;", "if (false) return;"],
      ["if (failure === reported) return;", "if (false) return;"],
    ],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit, show, form, values, reports }) => {
        await edit("2");
        show("weather");
        form.update(values("weather"));
        await edit("9");
        r5Previews(calls, "weather")[0].answer(500, {});
        await settle();
        const before = [...reports];
        r5Previews(calls)[0].answer(500, {});
        await settle();
        assert.deepEqual(reports, before, "an unrelated old completion does not report Weather again");
      }),
  },
  {
    name: "coalesced queued previews send the newest draft once",
    file: "components/settings-form.js",
    edits: [
      ["!session() || !mine.scene || mine.left || mine.queued", "!session() || !mine.scene || mine.left || false"],
    ],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit }) => {
        await edit("2");
        await edit("3");
        await edit("4");
        r5Previews(calls)[0].ok();
        await settle();
        const next = r5Previews(calls)[1];
        assert.ok(next);
        assert.equal(next.body.values.n, 4);
        next.ok();
        await settle();
        assert.equal(r5Previews(calls).length, 2, "the same newest draft is sent only once");
      }),
  },
  {
    name: "old Save success cannot re-preview the new scene's draft",
    file: "components/settings-form.js",
    edits: [
      ["if (shown(mine) && mine.book.edits.size > 0) preview();", "if (true && mine.book.edits.size > 0) preview();"],
    ],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit, root, show, form, values }) => {
        await edit("2");
        r5Previews(calls)[0].ok();
        await settle();
        assert.equal(click(root.querySelector('[data-act="save"]')), true);
        await settle();
        const saving = pending(calls, "PUT", "/settings/clock");
        await edit("3");
        r5Previews(calls)[1].ok();
        await settle();
        show("weather");
        form.update(values("weather"));
        await edit("9");
        r5Previews(calls, "weather")[0].ok();
        await settle();
        const count = r5Previews(calls, "weather").length;
        saving.ok();
        await settle();
        assert.equal(
          r5Previews(calls, "weather").length,
          count,
          "Clock's submitted edit leaves another Clock edit, not work for Weather",
        );
      }),
  },
  {
    name: "old Revert success cannot report the new scene's failure again",
    file: "components/settings-form.js",
    edits: [
      ["if (shown(mine)) report();", "if (true) report();"],
      ["if (failure === reported) return;", "if (false) return;"],
    ],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit, root, show, form, values, reports }) => {
        await edit("2");
        r5Previews(calls)[0].ok();
        await settle();
        click(root.querySelector('[data-act="revert"]'));
        await settle();
        const reverting = pending(calls, "DELETE", "/settings/clock/preview");
        show("weather");
        form.update(values("weather"));
        await edit("9");
        r5Previews(calls, "weather")[0].answer(500, {});
        await settle();
        const count = reports.length;
        reverting.ok();
        await settle();
        assert.equal(reports.length, count, "Revert's old scope reports nothing on the new one");
      }),
  },
  {
    name: "opening Raw preserves another page's idle outcome",
    file: "ops.js",
    edits: [["!slot.busy && mine(key)", "!slot.busy && true"]],
    run: async (_t, ops) => {
      const key = "r5-other-page";
      const slot = { token: 502, busy: false, label: "", value: undefined, note: "Saved elsewhere", failure: null };
      r4SetOp(key, slot);
      ops.forgetIdle((/** @type {string} */ name) => name.startsWith("raw-"));
      assert.deepEqual(r4State().ops.get(key), slot, "only the opening page's own idle outcomes are forgotten");
      r4SetOp(key, null);
    },
  },
  {
    name: "typing with no success note cannot manufacture an idle operation slot",
    file: "ops.js",
    edits: [["if (slot?.note) setOp(key, { ...slot, note: null });", "if (true) setOp(key, { ...slot, note: null });"]],
    run: async (_t, ops) => {
      const key = "r5-absent-note";
      r4SetOp(key, null);
      ops.clearNote(key);
      assert.equal(r4State().ops.has(key), false, "editing owns no operation before one exists");
    },
  },
  {
    name: "superseded successful operation cannot call its done callback",
    file: "ops.js",
    edits: [["(result) => {\n      if (!current()) return;", "(result) => {\n      if (false) return;"]],
    run: async (_t, ops) => {
      /** @type {any} */
      let finish;
      /** @type {any[]} */
      const done = [];
      const old = ops.follow(
        "r5-superseded",
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        {
          done: () => {
            done.push("old");
          },
        },
      );
      await ops.follow("r5-superseded", async () => "new", {
        done: () => {
          done.push("new");
        },
      });
      await settle();
      finish("old");
      await old;
      await settle();
      assert.deepEqual(done, ["new"], "the second token check cannot undo a done callback's effects");
      ops.drop("r5-superseded");
    },
  },
  {
    name: "saving d1 then visiting d2 cannot close d2's edited row",
    file: "pages/config.js",
    edits: [["mine === openings && open === name", "mine === openings && true"]],
    run: async (_t, m) => {
      const world = r4World({ devices: [{ name: "d1" }, { name: "d2" }] });
      const calls = r4Server(world);
      r4NewEpoch(world);
      const root = pageRoot();
      m.page.mount(root, {});
      try {
        click(root.querySelector('[data-act="edit"][data-device="d1"]'));
        typeInto(root.querySelector('.ct-edit [name="displayName"]'), "d1 saved");
        click(root.querySelector('[data-act="patch"]'));
        await settle();
        click(root.querySelector('[data-act="cancel"]'));
        click(root.querySelector('[data-act="edit"][data-device="d2"]'));
        typeInto(root.querySelector('.ct-edit [name="displayName"]'), "d2 draft");
        pending(calls, "PATCH", "/devices/d1").ok();
        await settle();
        assert.equal(
          root.querySelector(".ct-edit form")?.getAttribute("data-device"),
          "d2",
          "the old Save closes only d1's row",
        );
        assert.equal(root.querySelector('.ct-edit [name="displayName"]')?.value, "d2 draft");
      } finally {
        m.page.unmount();
        root.remove();
        await r4AnswerAll({ calls });
      }
    },
  },
];

/**
 * A browser timer queue keeps callbacks that were already queued when
 * clearTimeout ran. The test can deliver one such callback after replacement.
 * @param {any} t @param {any} m @param {(ctx: any) => void} story
 */
async function r5Live(t, m, story) {
  /** @type {any[]} */
  const timers = [];
  /** @type {any[]} */
  const sources = [];
  /** @type {any[]} */
  const states = [];
  /** @type {any[]} */
  const events = [];
  t.mock.method(globalThis, "setTimeout", (/** @type {any} */ callback, /** @type {number} */ ms) => {
    const timer = { callback, ms, canceled: false };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (/** @type {any} */ timer) => {
    if (timer) timer.canceled = true;
  });
  const saved = globalThis.EventSource;
  globalThis.EventSource = /** @type {any} */ (
    class extends FakeEventSource {
      constructor(/** @type {string} */ url) {
        super(url);
        sources.push(this);
      }
    }
  );
  const live = m.connectLive(
    {
      onEvent: (/** @type {any} */ event) => events.push(event),
      onState: (/** @type {any} */ state) => states.push(state),
    },
    { fence: createStore().fence() },
  );
  try {
    story({ timers, sources, states, events, live });
  } finally {
    live.close();
    globalThis.EventSource = saved;
    t.mock.restoreAll();
  }
}

R5_STORIES.push(
  {
    name: "live state reports no duplicate transition on a ping",
    file: "live.js",
    edits: [
      [
        "next.state === current.state &&\n      next.lastEventAt === current.lastEventAt &&\n      next.lostSince === current.lostSince",
        "false",
      ],
    ],
    run: async (t, m) =>
      r5Live(t, m, ({ sources, states }) => {
        sources[0].onopen();
        const count = states.length;
        sources[0].emit("ping", `${A}-20`, {});
        assert.equal(states.length, count, "updating the event time does not report another live transition");
      }),
  },
  {
    name: "queued error after live close cannot report lost or arm retry",
    file: "live.js",
    edits: [["stopStream();\n    if (closed) return;", "stopStream();\n    if (false) return;"]],
    run: async (t, m) =>
      r5Live(t, m, ({ sources, states, timers, live }) => {
        sources[0].onopen();
        live.close();
        const count = states.length;
        const made = timers.length;
        sources[0].onerror();
        assert.equal(states.length, count, "the closed session has no new state");
        assert.equal(timers.length, made, "the closed session has no new retry");
      }),
  },
  {
    name: "queued silence timeout of the replaced stream cannot close its successor",
    file: "live.js",
    edits: [["if (mine === generation) lose();", "if (true) lose();"]],
    run: async (t, m) =>
      r5Live(t, m, ({ sources, timers, states }) => {
        sources[0].onopen();
        const queued = timers.at(-1);
        sources[0].onerror();
        timers.at(-1).callback();
        sources[1].onopen();
        assert.equal(queued.canceled, true, "the old watchdog was canceled, but its task was queued");
        const count = states.length;
        queued.callback();
        assert.equal(sources[1].closed, false, "old watchdog does not close the replacement");
        assert.equal(states.length, count);
      }),
  },
  {
    name: "queued open of the replaced stream cannot claim the new stream is live",
    file: "live.js",
    edits: [
      [
        "stream.onopen = () => {\n      if (mine !== generation) return;",
        "stream.onopen = () => {\n      if (false) return;",
      ],
    ],
    run: async (t, m) =>
      r5Live(t, m, ({ sources, timers, live, states }) => {
        sources[0].onerror();
        timers.at(-1).callback();
        const before = live.state();
        const count = states.length;
        sources[0].onopen();
        assert.deepEqual(live.state(), before, "the new connection has not opened yet");
        assert.equal(states.length, count);
      }),
  },
  {
    name: "queued error of the replaced stream cannot lose the new live stream",
    file: "live.js",
    edits: [["if (mine !== generation) return;\n      lose();", "if (false) return;\n      lose();"]],
    run: async (t, m) =>
      r5Live(t, m, ({ sources, timers, states }) => {
        sources[0].onerror();
        timers.at(-1).callback();
        sources[1].onopen();
        const count = states.length;
        sources[0].onerror();
        assert.equal(sources[1].closed, false, "the successor is still open");
        assert.equal(states.length, count);
      }),
  },
);

let r5MainId = 0;
/**
 * Run all of main.js with stand-ins only at its module boundaries. The
 * bootstrap promise is held while the stream loads the store; subscriptions
 * and loadFrame's requests run exactly as main.js writes them.
 * @param {any} t @param {Array<[string, string]>} edits @param {string} story
 */
async function r5Main(t, edits, story) {
  const state = { loaded: false, epoch: A, devices: new Map(), previews: new Map(), controller: null };
  /** @type {any[]} */
  const subscriptions = [];
  /** @type {any[]} */
  const requests = [];
  /** @type {any[]} */ const frameAnswers = [];
  /** @type {any[]} */
  const errors = [];
  /** @type {any} */ let rejectBoot;
  const bootstrap = new Promise((_resolve, reject) => {
    rejectBoot = reject;
  });
  const bridge = {
    state,
    subscriptions,
    requests,
    errors,
    frameAnswers,
    toPreview: (/** @type {any} */ frame) => {
      assert.ok(frame, "a missing first frame cannot be parsed as an image");
      return frame;
    },
    request: () => bootstrap,
    requestFrame: (/** @type {string} */ name) => {
      requests.push(name);
      return Promise.resolve({ generation: 1, frame: story === "frame" ? { rgb: new Uint8Array([1, 2, 3]), width: 1, height: 1 } : null });
    },
    subscribe: (/** @type {any} */ select, /** @type {any} */ render) => {
      subscriptions.push({ select, render });
      render(select(state));
    },
    setLoadError: (/** @type {any} */ error) => errors.push(error),
  };
  const global = /** @type {any} */ (globalThis);
  const saved = global.__r5Main;
  global.__r5Main = bridge;
  const nodes = new Map(
    ["app", "version", "overlay-count", "restart", "mqtt-dot", "mqtt-text"].map((id) => [id, makeElement("div")]),
  );
  Object.assign(fakeDocument, { getElementById: (/** @type {string} */ id) => nodes.get(id) });
  const oldWindow = global.window;
  global.window = { addEventListener() {} };
  t.mock.method(globalThis, "setInterval", () => 1);
  const stub = (/** @type {string} */ code) =>
    `data:text/javascript;base64,${Buffer.from(`const b = globalThis.__r5Main;\n${code}\n// ${++r5MainId}`).toString("base64")}`;
  const replace = {
    "./api.js": stub(
      "export class ApiError extends Error {} export const request=b.request, requestFrame=b.requestFrame;",
    ),
    "./store.js": stub(
      "export const getState=()=>b.state, subscribe=b.subscribe, setLoadError=b.setLoadError; export const applyAnswer=()=>{}, applyEvent=()=>{}, applyFrameAnswer=(owner,frame)=>b.frameAnswers.push({owner,frame}), fence=()=>({}), setLive=()=>{}, tick=()=>{}, toPreview=b.toPreview;",
    ),
    "./live.js": stub('export const connectLive=()=>({session:"r5-main"});'),
    "./router.js": stub("export const startRouter=()=>{};"),
    "./theme.js": stub('export const applyTheme=()=>{}, versionDisplay=()=>"semver";'),
    "./view/model.js": stub(
      'export const header=()=>({overlayCount:0,restart:{shown:false,title:""},mqtt:{dot:"ok",text:"connected",cls:""}});',
    ),
    "./session.js": stub("export const setSession=()=>{};"),
  };
  try {
    const loading = r5Module("main.js", edits, replace);
    await settle();
    state.loaded = true;
    state.devices = new Map([["d1", view("d1")]]);
    rejectBoot(new Error("old bootstrap failed"));
    await loading;
    await settle();
    if (story === "bootstrap") {
      assert.deepEqual(errors, [], "the stream loaded the page before bootstrap failed");
      return;
    }
    assert.deepEqual(requests, ["d1"], "one frame for the first life");
    assert.deepEqual(frameAnswers.map((answer) => answer.owner), [{ device: "d1", generation: 1, epoch: A, incarnation: 1 }], "first-frame admission captures the exact epoch and device life");
    if (story === "frame") {
      assert.deepEqual([...frameAnswers[0].frame.rgb], [1, 2, 3], "a present first frame reaches its captured owner");
      return;
    }
    assert.equal(frameAnswers[0].frame, null, "a no-frame answer still completes its captured admission");
    const deviceSub = subscriptions.find((/** @type {any} */ sub) => sub.select(state) === state.devices);
    assert.ok(deviceSub);
    if (story === "asked") {
      deviceSub.render(state.devices);
      assert.deepEqual(requests, ["d1"], "another device revision does not ask again for the same life");
      state.devices = new Map([["d1", view("d1", { incarnation: 2 })]]);
      deviceSub.render(state.devices);
      assert.deepEqual(requests, ["d1", "d1"], "a new life has its own first frame");
    } else {
      state.previews.set("d2", { frameSeq: 99 });
      state.devices = new Map([...state.devices, ["d2", view("d2")]]);
      deviceSub.render(state.devices);
      assert.deepEqual(requests, ["d1"], "a frame already received on the stream needs no HTTP load");
    }
  } finally {
    global.__r5Main = saved;
    global.window = oldWindow;
    t.mock.restoreAll();
  }
}

R5_STORIES.push(
  {
    name: "late bootstrap failure leaves the stream-loaded page alone",
    file: "main.js",
    edits: [["if (!getState().loaded)", "if (true)"]],
    run: (t, m) => r5Main(t, m.__r5Edits ?? [], "bootstrap"),
  },
  {
    name: "first-frame requests remember each device life",
    file: "main.js",
    edits: [["asked.has(key) || state.previews.has(view.name)", "false || state.previews.has(view.name)"]],
    run: (t, m) => r5Main(t, m.__r5Edits ?? [], "asked"),
  },
  {
    name: "stream frame arriving before first-frame subscription needs no HTTP request",
    file: "main.js",
    edits: [["asked.has(key) || state.previews.has(view.name)", "asked.has(key) || false"]],
    run: (t, m) => r5Main(t, m.__r5Edits ?? [], "preview"),
  },
);

/** @param {any} t @param {any} api @param {"json"|"frame"} kind @param {boolean} body */
async function r5Timeout(t, api, kind, body) {
  globalThis.fetch = /** @type {any} */ (
    () =>
      body
        ? Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            text: () => new Promise(() => {}),
            arrayBuffer: () => new Promise(() => {}),
          })
        : new Promise(() => {})
  );
  const result =
    kind === "json" ? api.request("GET", "/r5-body-timeout", { resource: "r5" }) : api.requestFrame("r5-timeout");
  const checked = assert.rejects(result, (/** @type {any} */ error) => {
    assert.equal(error.code, "timeout");
    return true;
  });
  await settle();
  t.mock.timers.tick(15_000);
  await checked;
}

R5_STORIES.push(
  {
    name: "501 has its own failure sentence after an identity change",
    file: "api.js",
    edits: [["if (status === 501) return", "if (false) return"]],
    run: async (_t, api) => {
      const calls = heldFetch();
      const outcome = api.request("GET", "/r5-501", { resource: "r5" });
      const checked = assert.rejects(outcome, { message: "pixdcon cannot do this yet." });
      bootPages((e) => [view("d2", { epoch: e })]);
      calls[0].answer(501, {});
      await checked;
    },
  },
  {
    name: "external cancellation remains cancellation after the page identity changes",
    file: "api.js",
    edits: [["if (signal?.aborted)", "if (false)"]],
    run: async (_t, api) => {
      const controller = new AbortController();
      /** @type {any} */
      let fail;
      globalThis.fetch = /** @type {any} */ (
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          })
      );
      const outcome = api.request("GET", "/r5-abort", { resource: "r5", signal: controller.signal });
      const checked = assert.rejects(outcome, (/** @type {any} */ error) => {
        assert.equal(error.code, "aborted");
        return true;
      });
      bootPages((e) => [view("d2", { epoch: e })]);
      controller.abort();
      fail(new Error("aborted"));
      await checked;
    },
  },
  {
    name: "JSON body timeout keeps its timeout classification",
    file: "api.js",
    edits: [
      [
        "text = await time.race(response.text());\n    } catch {\n      if (time.timedOut())",
        "text = await time.race(response.text());\n    } catch {\n      if (false)",
      ],
    ],
    run: (t, api) => r5Timeout(t, api, "json", true),
  },
  {
    name: "frame transport timeout keeps its timeout classification",
    file: "api.js",
    edits: [
      [
        '    } catch {\n      if (time.timedOut()) throw timeoutError();\n      throw new ApiError("No answer from pixdcon.", {\n        status: 0,\n        code: "unreachable",\n      });\n    }\n    if (response.status === 204)',
        '    } catch {\n      if (false) throw timeoutError();\n      throw new ApiError("No answer from pixdcon.", {\n        status: 0,\n        code: "unreachable",\n      });\n    }\n    if (response.status === 204)',
      ],
    ],
    run: (t, api) => r5Timeout(t, api, "frame", false),
  },
  {
    name: "frame body timeout keeps its timeout classification",
    file: "api.js",
    edits: [
      [
        "bytes = new Uint8Array(await time.race(response.arrayBuffer()));\n    } catch {\n      if (time.timedOut())",
        "bytes = new Uint8Array(await time.race(response.arrayBuffer()));\n    } catch {\n      if (false)",
      ],
    ],
    run: (t, api) => r5Timeout(t, api, "frame", true),
  },
  {
    name: "empty successful API answer is a null body",
    file: "api.js",
    edits: [['if (text !== "" && payload === null)', "if (true && payload === null)"]],
    run: async (_t, api) => {
      fakeFetch(() => new Response(null, { status: 204 }));
      assert.equal((await api.request("DELETE", "/r5-empty", { resource: "r5" })).body, null);
    },
  },
  {
    name: "nonempty malformed API answer is refused",
    file: "api.js",
    edits: [['if (text !== "" && payload === null)', "if (false)"]],
    run: async (_t, api) => {
      fakeFetch(() => new Response("{not json", { status: 200 }));
      await assert.rejects(api.request("GET", "/r5-malformed", { resource: "r5" }), (/** @type {any} */ error) => {
        assert.equal(error.code, "invalid_answer");
        return true;
      });
    },
  },
  {
    name: "204 frame answer leaves the preview slot empty",
    file: "api.js",
    edits: [["if (response.status === 204) return", "if (false) return"]],
    run: async (_t, api) => {
      fakeFetch(() => new Response(null, { status: 204 }));
      assert.equal((await api.requestFrame("r5-no-frame")).frame, null);
    },
  },
  {
    name: "failed frame answer cannot become a preview",
    file: "api.js",
    edits: [["if (!response.ok)\n      throw", "if (false)\n      throw"]],
    run: async (_t, api) => {
      fakeFetch(() => new Response("", { status: 503 }));
      await assert.rejects(api.requestFrame("r5-failed-frame"), (/** @type {any} */ error) => {
        assert.equal(error.code, "http_503");
        return true;
      });
    },
  },
);

/** @param {any} module @param {(ctx: any) => Promise<void>} story */
async function r5Raw(module, story) {
  const world = r4World({ devices: [{ name: "d1" }] });
  const calls = r4Server(world);
  r4NewEpoch(world);
  const root = pageRoot();
  module.page.mount(root, {});
  try {
    await story({ world, calls, root, module });
  } finally {
    module.page.unmount();
    root.remove();
    await r4AnswerAll({ calls });
  }
}

R5_STORIES.push(
  {
    name: "Raw's superseded opening load cannot schedule another load after Reload",
    file: "pages/config-raw.js",
    edits: [['if (decision.reason === "superseded_source") return;', "if (false) return;"]],
    run: async (_t, m) =>
      r5Raw(m, async ({ calls, root }) => {
        const old = pending(calls, "GET", "/config/raw");
        click(root.querySelector('[data-act="reload"]'));
        await settle();
        old.ok();
        await settle();
        pending(calls, "POST", "/config/reload").ok();
        await settle();
        for (const call of calls.filter((/** @type {any} */ c) => !c.answered)) call.ok();
        await settle();
        assert.equal(
          calls.filter((/** @type {any} */ c) => c.method === "GET").length,
          2,
          "the opening load and Reload's load are the only two",
        );
      }),
  },
  {
    name: "Raw Reload cannot put text in the editor when the fence drops its answer",
    file: "pages/config-raw.js",
    edits: [
      [
        'applyAnswer(answer).action === "apply" && base.opened === opened && root',
        "true && base.opened === opened && root",
      ],
    ],
    run: async (_t, m) =>
      r5Raw(m, async ({ calls, world, root }) => {
        pending(calls, "GET", "/config/raw").ok();
        await settle();
        const editor = root.querySelector("textarea");
        typeInto(editor, '{"keep":"current edit"}');
        click(root.querySelector('[data-act="reload"]'));
        await settle();
        pending(calls, "POST", "/config/reload").ok();
        await settle();
        const load = pending(calls, "GET", "/config/raw");
        world.rev += 10;
        r4Live(world, "config", { ...CONFIG_STATE, rev: world.rev });
        load.answer(200, { text: '{"from":"dropped answer"}', state: { ...CONFIG_STATE, rev: load.rev } });
        await settle();
        assert.equal(editor.value, '{"keep":"current edit"}', "text and state must both pass the fence");
      }),
  },
);

R5_STORIES.push(
  {
    name: "no session means no preview even when both entry and send checks are removed separately",
    file: "components/settings-form.js",
    edits: [
      ["!session() || !mine.scene || mine.left || mine.queued", "false || !mine.scene || mine.left || mine.queued"],
      ["if (of.left || !id) return;", "if (of.left || false) return;"],
    ],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit, session }) => {
        session("");
        await edit("2");
        assert.equal(r5Previews(calls).length, 0, "entry and send independently require the preview's session");
      }),
  },
  {
    name: "old Save cannot start a preview after the display has no scene",
    file: "components/settings-form.js",
    edits: [
      ["if (shown(mine) && mine.book.edits.size > 0) preview();", "if (true && mine.book.edits.size > 0) preview();"],
      ["!session() || !mine.scene || mine.left || mine.queued", "!session() || false || mine.left || mine.queued"],
    ],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit, root, show }) => {
        await edit("2");
        r5Previews(calls)[0].ok();
        await settle();
        click(root.querySelector('[data-act="save"]'));
        await settle();
        const saving = pending(calls, "PUT", "/settings/clock");
        await edit("3");
        r5Previews(calls)[1].ok();
        await settle();
        show(null);
        saving.ok();
        await settle();
        assert.equal(
          calls.some((/** @type {any} */ c) => c.path.includes("/settings/null")),
          false,
          "the absent scene owns no draft",
        );
      }),
  },
);

/**
 * These are reachability/equivalence proofs, not mutation kills. They are
 * excluded from the sweep's caught count. Each disposition names one and
 * the sweep reruns that probe on the removed-guard module as well.
 * @type {Array<{name: string, run: (t: any) => Promise<void>}>}
 */
const R5_PROBES = [
  {
    name: "awaiting an absent lane predecessor changes no owner or request order",
    run: async () => {
      const m = await r5Module("components/settings-form.js", [
        ["function enqueue(lane, step)", "export function enqueue(lane, step)"],
      ]);
      for (const fail of [false, true]) {
        /** @type {any[]} */
        const trace = [];
        /** @type {any} */ let finish;
        const first = m.enqueue("r5-probe", async () => {
          trace.push("first");
          await new Promise((resolve) => {
            finish = resolve;
          });
          if (fail) throw new Error("failed");
        });
        const checked = first.catch(() => trace.push("failed"));
        const next = m.enqueue("r5-probe", async () => {
          trace.push("second");
        });
        await settle();
        assert.deepEqual(trace, ["first"], "a real predecessor is awaited");
        finish();
        await checked;
        await next;
        await settle();
        assert.deepEqual(
          trace,
          fail ? ["first", "failed", "second"] : ["first", "second"],
          "only awaiting undefined is added by the removal",
        );
      }
    },
  },
  {
    name: "parsing an empty body is equivalent to leaving payload null",
    run: async () => {
      const api = await r5Module("api.js");
      for (const text of ["", "{}", "[]", "0", "false", "null", "{bad json"]) {
        // JSON.parse('') throws and the existing catch writes null. The
        // removed branch adds only that caught parse, with no identity read.
        const expected =
          text === ""
            ? null
            : (() => {
                try {
                  return JSON.parse(text);
                } catch {
                  return null;
                }
              })();
        fakeFetch(() => new Response(text || null, { status: 200 }));
        const result = api.request("GET", "/r5-parse-probe", { resource: "r5" });
        if (text !== "" && expected === null)
          await assert.rejects(result, (/** @type {any} */ error) => error.code === "invalid_answer");
        else assert.deepEqual((await result).body, expected);
      }
    },
  },
  {
    name: "live state timestamp operands add no independent transition identity",
    run: async (t) => {
      const m = await r5Module("live.js", [
        ["export function connectLive", "export const __r5States = [];\nexport function connectLive"],
        [
          "const next = { ...current, ...patch };",
          "const next = { ...current, ...patch };\n    __r5States.push({patch, current, next});",
        ],
      ]);
      await r5Live(t, m, ({ sources, timers, live }) => {
        sources[0].onopen();
        sources[0].onopen();
        sources[0].emit("ping", `${A}-1`, {});
        sources[0].onerror();
        sources[0].onerror();
        timers.at(-1).callback();
        sources[1].onopen();
        sources[1].emit("ping", `${B}-1`, {});
        sources[1].onerror();
        timers.at(-1).callback();
        sources[2].onopen();
        live.close();
        sources[2].onerror();
      });
      assert.ok(m.__r5States.length >= 9, "live, lost, repeated state and reconnect paths ran");
      for (const { patch, current, next } of m.__r5States) {
        assert.equal(
          Object.hasOwn(patch, "lastEventAt"),
          false,
          "setState never patches lastEventAt; receive writes it before setState",
        );
        assert.equal(next.lastEventAt, current.lastEventAt, "this operand is always true");
        if (next.state === current.state)
          assert.equal(next.lostSince, current.lostSince, "within one state the loss time is kept, or is already null");
      }
    },
  },
  {
    name: "form preview entry cannot outlive its scene and opening",
    run: async (t) => {
      const { readFileSync } = await import("node:fs");
      const device = readFileSync(new URL("../../web/js/pages/device.js", import.meta.url), "utf8");
      assert.match(
        device,
        /void form\.end\(\);\s*form\.destroy\(\);/,
        "the only page end destroys the form in the same synchronous call",
      );
      assert.equal([...device.matchAll(/form\.end\(\)/g)].length, 1, "the page has exactly one end call");
      const formSource = readFileSync(new URL("../../web/js/components/settings-form.js", import.meta.url), "utf8");
      assert.equal(
        [...formSource.matchAll(/\bpreview\(\)/g)].length,
        5,
        "the four preview callers and declaration are all accounted for",
      );
      const m = await r5Module("components/settings-form.js", [
        ["let ids = 0;", "let ids = 0;\nexport const __r5Entries = [];"],
        [
          "function preview() {\n    const mine = scope;",
          "function preview() {\n    const mine = scope;\n    __r5Entries.push({left: mine.left, scene: mine.scene});",
        ],
      ]);
      await r5Form(t, m, async ({ calls, edit, form, show, values, root }) => {
        await edit("2");
        await edit("3");
        const oldInput = root.querySelector('[data-key="n"]');
        show("weather");
        form.update(values("weather"));
        await edit("9");
        r5Previews(calls)[0].ok();
        await settle();
        void form.end();
        form.destroy();
        const count = m.__r5Entries.length;
        typeInto(oldInput, "4");
        await settle();
        assert.equal(m.__r5Entries.length, count, "a retained old field has no listener after end/destroy");
      });
      assert.ok(m.__r5Entries.length >= 3);
      for (const entry of m.__r5Entries) {
        assert.equal(entry.left, false);
        assert.ok(entry.scene, "every reachable entry has a scene");
      }
    },
  },
  {
    name: "failed Save of the shown scope always retains at least its submitted edits",
    run: async (t) => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(new URL("../../web/js/components/settings-form.js", import.meta.url), "utf8");
      assert.equal([...src.matchAll(/\.book\.saved\(/g)].length, 1, "only success acknowledges edits");
      assert.equal([...src.matchAll(/\.book\.clear\(/g)].length, 1, "only Revert clears edits");
      const m = await r5Module("components/settings-form.js");
      for (const draft of [null, "3", "not a number"]) {
        await r5Form(t, m, async ({ calls, edit, root, form, values }) => {
          await edit("2");
          r5Previews(calls)[0].ok();
          await settle();
          click(root.querySelector('[data-act="save"]'));
          await settle();
          const saving = pending(calls, "PUT", "/settings/clock");
          assert.equal(
            click(root.querySelector('[data-act="revert"]')),
            false,
            "Save owns the action slot, so Revert cannot clear it",
          );
          if (draft !== null) await edit(draft);
          form.update(values("clock"));
          assert.equal(form.hasEdits(), true);
          saving.answer(500, {});
          await settle();
          assert.equal(form.hasEdits(), true, "failure never acknowledges any edit");
        });
      }
    },
  },
  {
    name: "Raw failure classification reads only the API error envelope",
    run: async () => {
      const api = await r5Module("api.js");
      for (const [status, body] of [
        [422, { code: "invalid_config", error: "Invalid config", line: 2 }],
        [500, { code: "disk_full", error: "Disk full", line: 2 }],
        [400, {}],
      ]) {
        fakeFetch(() => new Response(JSON.stringify(body), { status: Number(status) }));
        await assert.rejects(api.request("PUT", "/r5-envelope", { resource: "config" }), (/** @type {any} */ error) => {
          assert.ok(error instanceof api.ApiError, "HTTP and parsing failures are API error envelopes");
          assert.equal(error.status, status);
          assert.equal(error.code, /** @type {any} */ (body).code ?? `http_${status}`);
          return true;
        });
      }
      globalThis.fetch = /** @type {any} */ (
        async () => {
          throw new TypeError("network failed");
        }
      );
      await assert.rejects(api.request("PUT", "/r5-envelope", { resource: "config" }), (/** @type {any} */ error) => {
        assert.ok(error instanceof api.ApiError);
        assert.equal(error.code, "unreachable");
        return true;
      });
    },
  },
  {
    name: "Raw root and editor are consequences of the opening, not separate identities",
    run: async () => r5RawLifecycle(false),
  },
  {
    name: "Raw takeText inherits the opening checks of both callers",
    run: async () => r5RawLifecycle(true),
  },
  {
    name: "Raw retry branches retain the same base and observable work",
    run: async () => {
      // An immediate retry and `again=base` both start a load before the
      // previous slot settles: setOp synchronously calls render, which takes
      // `again` once Save/Reload are idle. The counter changes, not its base.
      const m = await r5Module("pages/config-raw.js", [
        [
          "function load(base = { opened, revision }, tries = 0) {",
          "export const __r5Bases = [];\nfunction load(base = { opened, revision }, tries = 0) {\n  __r5Bases.push({...base});",
        ],
      ]);
      await r5Raw(m, async ({ calls, world, root }) => {
        const typed = '{"devices":[],"keep":"typed before retry"}';
        typeInto(root.querySelector("textarea"), typed);
        for (let n = 0; n < 6; n += 1) {
          const old = pending(calls, "GET", "/config/raw");
          world.rev += 10;
          r4Live(world, "config", { ...CONFIG_STATE, rev: world.rev });
          old.ok();
          await settle();
          assert.equal(
            calls.filter((/** @type {any} */ c) => c.method === "GET").length,
            n + 2,
            "one retry per older answer, including the counter boundary",
          );
          assert.equal(root.querySelector("textarea").value, typed, "every retry retains the typed revision");
        }
        assert.equal(m.__r5Bases.length, 7);
        for (const base of m.__r5Bases)
          assert.deepEqual(base, m.__r5Bases[0], "retry and fallback inherit the original base");
      });
    },
  },
];

/**
 * Check the lifecycle invariant at every relevant late callback, including
 * while unmounted. The observation hook records values; it changes no guard.
 * @param {boolean} textOnly
 */
async function r5RawLifecycle(textOnly) {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../web/js/pages/config-raw.js", import.meta.url), "utf8");
  const writes = [...src.matchAll(/\broot\s*=(?!=)\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(
    writes,
    ["null", "target", "null"],
    "root has exactly its declaration, mount and unmount writers; both lifecycle writers also advance opened",
  );
  assert.match(src, /mount\(target, _params\)\s*\{\s*opened \+= 1;\s*root = target;/);
  assert.match(src, /unmount\(\)\s*\{\s*opened \+= 1;/);
  if (textOnly) {
    assert.equal([...src.matchAll(/\btakeText\(/g)].length, 3, "exactly the two callers and declaration");
    assert.match(
      src,
      /done: \(\{ answer, decision \}\) => \{\s*if \(base\.opened !== opened \|\| !root\) return;/,
      "load inherits the opening and root checks",
    );
    assert.match(
      src,
      /applyAnswer\(answer\)\.action === "apply" && base\.opened === opened && root\) takeText\(answer, base\)/,
      "Reload inherits the same opening and root checks",
    );
  }
  const m = await r5Module("pages/config-raw.js", [
    [
      "let revision = 0;",
      "let revision = 0;\nexport const __r5Observed = [];\nexport const __r5Read = () => ({root, opened});",
    ],
    [
      "done: ({ answer, decision }) => {",
      "done: ({ answer, decision }) => {\n        __r5Observed.push({at:'load done', base:base.opened, opened, root:!!root});",
    ],
    [
      "failed: () => {",
      "failed: () => {\n        __r5Observed.push({at:'load failed', base:base.opened, opened, root:!!root});",
    ],
    [
      "function takeText(answer, base) {",
      "function takeText(answer, base) {\n  __r5Observed.push({at:'takeText', base:base.opened, opened, root:!!root, editor:!!editorOf()});",
    ],
    [
      "done: (answer) => {",
      "done: (answer) => {\n        __r5Observed.push({at:'save done', base:mine, opened, root:!!root});",
    ],
    [
      "failed: (error) => {",
      "failed: (error) => {\n        __r5Observed.push({at:'save failed', base:mine, opened, root:!!root});",
    ],
    [
      "if (applyAnswer(answer).action",
      "__r5Observed.push({at:'reload text', base:base.opened, opened, root:!!root});\n      if (applyAnswer(answer).action",
    ],
  ]);
  for (const action of ["load", "save", "reload"])
    for (const reopen of [false, true])
      for (const fail of [false, true]) {
        const world = r4World({ devices: [{ name: "d1" }] });
        const calls = r4Server(world);
        r4NewEpoch(world);
        let root = pageRoot();
        m.page.mount(root, {});
        try {
          let old = pending(calls, "GET", "/config/raw");
          if (action !== "load") {
            old.ok();
            await settle();
            typeInto(root.querySelector("textarea"), '{"devices":[],"draft":2}');
            click(root.querySelector(`[data-act="${action}"]`));
            await settle();
            if (action === "reload") {
              pending(calls, "POST", "/config/reload").ok();
              await settle();
              old = pending(calls, "GET", "/config/raw");
            } else old = pending(calls, "PUT", "/config/raw");
          }
          const before = m.__r5Read();
          m.page.unmount();
          root.remove();
          assert.equal(m.__r5Read().root, null);
          assert.equal(m.__r5Read().opened, before.opened + 1);
          if (reopen) {
            root = pageRoot();
            m.page.mount(root, {});
            await r4AnswerAll({ calls }, old);
          }
          if (fail) old.answer(422, { code: "invalid_config", error: "invalid", line: 2 });
          else old.ok();
          await settle();
        } finally {
          m.page.unmount();
          root.remove();
          await r4AnswerAll({ calls });
        }
      }
  assert.ok(
    m.__r5Observed.some((/** @type {any} */ at) => !at.root),
    "late callbacks ran while the page was unmounted",
  );
  assert.ok(
    m.__r5Observed.some((/** @type {any} */ at) => at.at === "takeText"),
    "both accepted loads and late callbacks were exercised",
  );
  for (const at of m.__r5Observed) {
    if (at.base === at.opened) assert.equal(at.root, true, `${at.at}: same opening implies a root`);
    if (textOnly && at.at === "takeText") {
      assert.equal(at.editor, true);
      assert.equal(at.base, at.opened);
    }
  }
}

R5_STORIES.push(
  {
    name: "an operation whose done starts its successor cannot clear the successor's busy state",
    file: "ops.js",
    edits: [
      [
        "if (!current()) return;\n      setOp(key, { ...op(key), busy: false, failure: null, note });",
        "if (false) return;\n      setOp(key, { ...op(key), busy: false, failure: null, note });",
      ],
    ],
    run: async (_t, ops) => {
      /** @type {any} */ let finish;
      /** @type {any} */ let successor;
      await ops.follow("r5-reentrant", async () => "old", {
        done: () => {
          successor = ops.follow(
            "r5-reentrant",
            () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
            { label: "new operation" },
          );
          return "old outcome";
        },
      });
      await settle();
      try {
        assert.equal(ops.op("r5-reentrant").busy, true, "the successor still owns a busy slot");
        assert.equal(ops.op("r5-reentrant").note, null);
      } finally {
        finish();
        await successor;
        await settle();
        ops.drop("r5-reentrant");
      }
    },
  },
  {
    name: "dropping an absent operation emits no store update",
    file: "ops.js",
    edits: [["if (getState().ops.has(key)) setOp(key, null);", "if (true) setOp(key, null);"]],
    run: async (_t, ops) => {
      const store = await import(new URL("../../web/js/store.js", import.meta.url).href);
      const key = "r5-absent-drop";
      r4SetOp(key, null);
      let updates = 0;
      const stop = store.subscribe(
        (/** @type {any} */ state) => state.ops,
        () => {
          updates += 1;
        },
      );
      try {
        const before = updates;
        ops.drop(key);
        assert.equal(updates, before, "there is no slot to remove and no render to notify");
      } finally {
        stop();
      }
    },
  },
  {
    name: "superseded Raw load starts no retry while Reload is still pending",
    file: "pages/config-raw.js",
    edits: [
      ['if (decision.reason === "superseded_source") return;', "if (false) return;"],
      ['decision.reason === "not_newer" && tries < 3', "true && tries < 3"],
    ],
    run: async (_t, m) =>
      r5Raw(m, async ({ calls, root }) => {
        const old = pending(calls, "GET", "/config/raw");
        click(root.querySelector('[data-act="reload"]'));
        await settle();
        old.ok();
        await settle();
        assert.equal(
          calls.filter((/** @type {any} */ c) => c.method === "GET").length,
          1,
          "superseded_source is not the not_newer retry branch",
        );
      }),
  },
  {
    name: "reopened Raw load never retries a late answer from its old opening",
    file: "pages/config-raw.js",
    edits: [
      ["if (base.opened !== opened || !root) return;", "if (false) return;"],
      ['if (decision.reason === "superseded_source") return;', "if (false) return;"],
    ],
    other: {
      file: "ops.js",
      spec: "../ops.js",
      edits: [["(result) => {\n      if (!current()) return;", "(result) => {\n      if (false) return;"]],
    },
    run: async (_t, m) => {
      const world = r4World({ devices: [{ name: "d1" }] });
      const calls = r4Server(world);
      r4NewEpoch(world);
      let root = pageRoot();
      m.page.mount(root, {});
      const old = pending(calls, "GET", "/config/raw");
      try {
        m.page.unmount();
        root.remove();
        root = pageRoot();
        m.page.mount(root, {});
        await r4AnswerAll({ calls }, old);
        const before = calls.length;
        old.ok();
        await settle();
        world.rev += 1;
        r4Live(world, "device", r4View(world, "d1", world.epoch, 1, world.rev));
        await settle();
        assert.equal(calls.length, before, "the old opening cannot put its retry base into the new opening");
      } finally {
        m.page.unmount();
        root.remove();
        await r4AnswerAll({ calls });
      }
    },
  },
  {
    name: "old settings load failure cannot replace the new scene's pending load",
    file: "components/settings-form.js",
    edits: [['if (!shown(mine) || phase === "ready") return;', 'if (false || phase === "ready") return;']],
    other: {
      file: "ops.js",
      spec: "../ops.js",
      edits: [["(error) => {\n      if (!current()) return;", "(error) => {\n      if (false) return;"]],
    },
    run: async (t, m) =>
      r5Form(
        t,
        m,
        async ({ calls, show, root }) => {
          const old = pending(calls, "GET", "/settings/clock");
          show("weather");
          old.answer(500, {});
          await settle();
          assert.doesNotMatch(
            r4Text(root.querySelector(".set-body")),
            /could not be loaded/,
            "Weather's load has not failed",
          );
          assert.match(r4Text(root.querySelector(".set-body")), /Loading settings for weather/i);
        },
        { ready: false },
      ),
  },
);

R5_STORIES.push(
  {
    name: "Raw load with no position waits for the pending Reload instead of retrying",
    file: "pages/config-raw.js",
    edits: [['decision.reason === "not_newer" && tries < 3', "true && tries < 3"]],
    run: async (_t, m) => {
      const boot = bootPages((e) => [view("d1", { epoch: e })]);
      const calls = heldFetch();
      const root = pageRoot();
      m.page.mount(root, {});
      try {
        const old = pending(calls, "GET", "/config/raw");
        click(root.querySelector('[data-act="reload"]'));
        await settle();
        old.answer(200, { text: "{}", state: CONFIG_STATE });
        await settle();
        assert.equal(
          calls.filter((/** @type {any} */ c) => c.method === "GET").length,
          1,
          "no_position is not the not_newer immediate retry branch",
        );
        pending(calls, "POST", "/config/reload").answer(
          200,
          { state: { ...CONFIG_STATE, rev: 2 } },
          `${boot.epoch}-20`,
        );
        await settle();
      } finally {
        m.page.unmount();
        root.remove();
        await drain(calls);
      }
    },
  },
  {
    name: "Raw non-validation failure with a line number cannot mark the editor gutter",
    file: "pages/config-raw.js",
    edits: [
      ['if (error instanceof ApiError && error.code === "invalid_config")', "if (error instanceof ApiError && true)"],
    ],
    run: async (_t, m) =>
      r5Raw(m, async ({ calls, root, world }) => {
        pending(calls, "GET", "/config/raw").ok();
        await settle();
        typeInto(root.querySelector("textarea"), '{"devices":[],\n"edit":2}');
        click(root.querySelector('[data-act="save"]'));
        await settle();
        pending(calls, "PUT", "/config/raw").answer(500, { code: "disk_full", error: "Disk is full", line: 2 });
        await settle();
        world.rev += 1;
        r4Live(world, "device", r4View(world, "d1", world.epoch, 1, world.rev));
        await settle();
        assert.equal(
          root.querySelectorAll(".gut b.err").length,
          0,
          "a transport/storage failure is not config validation",
        );
        assert.match(r4Text(root.querySelector(".errline")), /Disk is full/);
      }),
  },
  {
    name: "Save success with no newer edit sends no empty duplicate preview",
    file: "components/settings-form.js",
    edits: [["if (shown(mine) && mine.book.edits.size > 0) preview();", "if (shown(mine) && true) preview();"]],
    run: async (t, m) =>
      r5Form(t, m, async ({ calls, edit, root }) => {
        await edit("2");
        r5Previews(calls)[0].ok();
        await settle();
        click(root.querySelector('[data-act="save"]'));
        await settle();
        pending(calls, "PUT", "/settings/clock").ok();
        await settle();
        assert.equal(r5Previews(calls).length, 1, "the Save committed every edit and no newer draft exists");
      }),
  },
  {
    name: "settings values received while their load is pending survive its late failure",
    file: "components/settings-form.js",
    edits: [['if (!shown(mine) || phase === "ready") return;', "if (!shown(mine) || false) return;"]],
    other: {
      file: "ops.js",
      spec: "../ops.js",
      edits: [["(error) => {\n      if (!current()) return;", "(error) => {\n      if (false) return;"]],
    },
    run: async (t, m) =>
      r5Form(
        t,
        m,
        async ({ calls, form, values, root }) => {
          const old = pending(calls, "GET", "/settings/clock");
          form.update(values("clock"));
          old.answer(500, {});
          await settle();
          assert.ok(root.querySelector('[data-key="n"]'), "the received values remain ready");
          assert.doesNotMatch(r4Text(root), /could not be loaded/);
        },
        { ready: false },
      ),
  },
  {
    name: "live open reports the live transition",
    file: "live.js",
    edits: [["next.state === current.state &&", "true &&"]],
    run: async (t, m) =>
      r5Live(t, m, ({ sources, states }) => {
        sources[0].onopen();
        assert.equal(states.at(-1)?.state, "live");
      }),
  },
  {
    name: "queued event of a replaced stream never reaches the current page",
    file: "live.js",
    edits: [
      [
        "stream.addEventListener(type, (/** @type {any} */ message) => {\n        if (mine !== generation) return;",
        "stream.addEventListener(type, (/** @type {any} */ message) => {\n        if (false) return;",
      ],
    ],
    run: async (t, m) =>
      r5Live(t, m, ({ sources, timers, events }) => {
        sources[0].onopen();
        sources[0].onerror();
        timers.at(-1).callback();
        sources[1].onopen();
        sources[1].emit("device", `${B}-2`, view("d2", { epoch: B }));
        const before = [...events];
        sources[0].emit("device", `${A}-30`, view("d1"));
        assert.deepEqual(events, before, "the replaced stream cannot send to the page");
      }),
  },
  {
    name: "live event without a readable position is ignored without a callback error",
    file: "live.js",
    edits: [["if (!position) return;", "if (false) return;"]],
    run: async (t, m) =>
      r5Live(t, m, ({ sources, events }) => {
        assert.doesNotThrow(() => sources[0].emit("device", "broken-position", view("d1")));
        assert.deepEqual(events, []);
      }),
  },
  {
    name: "a busy operation slot admits no competing start",
    file: "ops.js",
    edits: [["if (busy(key)) return false;", "if (false) return false;"]],
    run: async (_t, ops) => {
      /** @type {any} */ let finish;
      const work = new Promise((resolve) => {
        finish = resolve;
      });
      let sent = 0;
      try {
        assert.equal(
          ops.start("r5-busy", () => work, { value: "first" }),
          true,
        );
        assert.equal(
          ops.start(
            "r5-busy",
            async () => {
              sent += 1;
            },
            { value: "second" },
          ),
          false,
        );
        assert.equal(sent, 0);
        assert.equal(ops.op("r5-busy").value, "first");
      } finally {
        finish();
        await settle();
        ops.drop("r5-busy");
      }
    },
  },
);

test("r4 harness self-test: b1a r4 Reload's follow-up GET cannot finish a replacement epoch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const kind = r4KindOf("raw reload load");
  const raw = (await r5Module("pages/config-raw.js", [[
    'const answer = await request("GET", "/api/v2/config/raw", { resource: "config" });\n      if (!current(["epoch", "opening"])) return;',
    'const answer = await request("GET", "/api/v2/config/raw", { resource: "config" });\n      if (false) return;',
  ]])).page;
  for (const change of ["epoch"]) {
    assert.deepEqual(await r4Case(t, kind, change, "success"), [], `the real follow-up GET preserves the replacement ${change}`);
    const differences = await r4Case(t, kind, change, "success", { modules: { raw } });
    assert.ok(differences.some((piece) => piece.includes("load and validity state")), `the old follow-up GET ended the replacement ${change}'s loading state: ${differences.join("\n")}`);
    t_log(`B1a r4 Reload GET/${change}: ${differences.join("\n")}`);
  }
});

// B1a: new guard boundaries; existing harness stories and self-tests stay frozen.
R5_STORIES.push(
  {
    name: "b1a: an inherited scope cannot start cleanup in a replacement epoch",
    file: "ops.js",
    edits: [['if (!owned(inherited, projections.start ?? ["epoch"]))', 'if (false)']],
    run: async (_t, ops) => {
      const world = r4World(r4d1());
      r4NewEpoch(world);
      const owner = ops.capture();
      r4NewEpoch(world);
      /** @type {string[]} */
      const sent = [];
      await ops.follow("b1a-cleanup", async () => sent.push("DELETE"), { owner });
      assert.deepEqual(sent, [], "a queued end inherits the run it was queued in");
      assert.equal(r4State().ops.has("b1a-cleanup"), false, "stale work creates no busy slot");
    },
  },
  {
    name: "b1a: starting an action with a stale capture reports that it did not start",
    file: "ops.js",
    edits: [['if (!owned(owner, options.effects?.start ?? ["epoch"])) return false;', 'if (false) return false;']],
    run: async (_t, ops) => {
      const world = r4World(r4d1());
      r4NewEpoch(world);
      const owner = ops.capture();
      r4NewEpoch(world);
      assert.equal(ops.start("b1a-stale-action", async () => {}, { owner }), false);
    },
  },
  {
    name: "b1a: projected effects admit unrelated edits and reject their own changed opening",
    file: "ops.js",
    edits: [["if (read() !== owner.values[name]) return false;", "if (false) return false;"]],
    run: async (_t, ops) => {
      let opening = 1;
      let revision = 1;
      const owner = ops.capture({ opening: () => opening, revision: () => revision });
      /** @type {string[]} */
      const seen = [];
      ops.effect(owner, ["epoch", "opening"], () => seen.push("first"));
      revision += 1;
      ops.effect(owner, ["epoch", "opening"], () => seen.push("unrelated edit"));
      opening += 1;
      ops.effect(owner, ["epoch", "opening"], () => seen.push("stale opening"));
      assert.deepEqual(seen, ["first", "unrelated edit"], "each effect checks exactly its projection");
    },
  },
  {
    name: "b1a: a deferred child inherits its parent's capture instead of reading the replacement run",
    file: "ops.js",
    edits: [["follow(key, work, { ...options, owner });", "follow(key, work, { ...options, owner: capture() });"]],
    run: async (_t, ops) => {
      const world = r4World(r4d1());
      r4NewEpoch(world);
      /** @type {any} */
      let parent;
      await ops.follow("b1a-parent", async (/** @type {any} */ current) => { parent = current; });
      r4NewEpoch(world);
      /** @type {string[]} */
      const sent = [];
      await parent.follow("b1a-child", async () => sent.push("request"));
      assert.deepEqual(sent, [], "the child cannot authorize an old continuation with a new capture");
    },
  },
  {
    name: "b1a: dropping a superseded load leaves its successor's slot intact",
    file: "ops.js",
    edits: [["if (op(key).token === token) drop(key);", "if (true) drop(key);"]],
    run: async (_t, ops) => {
      await ops.follow("b1a-drop", async () => "first");
      const first = ops.op("b1a-drop").token;
      await ops.follow("b1a-drop", async () => "successor");
      const next = ops.op("b1a-drop");
      ops.dropOwn("b1a-drop", first);
      assert.deepEqual(ops.op("b1a-drop"), next, "a predecessor does not own the successor's slot");
      ops.dropOwn("b1a-drop", next.token);
      assert.equal(r4State().ops.has("b1a-drop"), false, "the actual owner can drop it");
    },
  },
  {
    name: "b1a: a named effect checks its own projection while the slot outcome survives an unrelated edit",
    file: "ops.js",
    edits: [['effect(owner, projections[name] ?? ["epoch"], work)', 'effect(owner, ["epoch"], work)']],
    run: async (_t, ops) => {
      let opening = 1;
      let revision = 1;
      /** @type {any} */ let current;
      await ops.follow("b1a-projection", async (/** @type {any} */ action) => { current = action; }, {
        owns: { opening: () => opening, revision: () => revision },
        effects: { editor: ["epoch", "opening"] },
        done: () => "Saved",
      });
      /** @type {string[]} */ const changes = [];
      revision += 1;
      current.effect("editor", () => changes.push("same opening"));
      opening += 1;
      current.effect("editor", () => changes.push("obsolete editor"));
      assert.deepEqual(changes, ["same opening"]);
      assert.equal(ops.op("b1a-projection").note, "Saved", "the slot outcome has a smaller projection");
      ops.drop("b1a-projection");
    },
  },
  {
    name: "b1a: Raw's already-started Reload GET cannot finish the replacement run's loading state",
    file: "pages/config-raw.js",
    edits: [[
      'const answer = await request("GET", "/api/v2/config/raw", { resource: "config" });\n      if (!current(["epoch", "opening"])) return;',
      'const answer = await request("GET", "/api/v2/config/raw", { resource: "config" });\n      if (false) return;',
    ]],
    run: async (_t, m) => r5Raw(m, async ({ world, calls, root }) => {
      pending(calls, "GET", "/config/raw").ok();
      await settle();
      click(root.querySelector('[data-act="reload"]'));
      await settle();
      pending(calls, "POST", "/config/reload").ok();
      await settle();
      const old = pending(calls, "GET", "/config/raw");
      r4NewEpoch(world);
      await settle();
      const before = r4Text(root.querySelector(".edbar .state"));
      assert.match(before, /Loading config/);
      old.ok();
      await settle();
      world.rev += 1;
      r4Live(world, "device", r4View(world, "d1", world.epoch, 1, world.rev));
      await settle();
      assert.equal(r4Text(root.querySelector(".edbar .state")), before, "the replacement GET is still out");
      pending(calls, "GET", "/config/raw").ok();
      await settle();
      assert.doesNotMatch(r4Text(root.querySelector(".edbar .state")), /Loading/);
    }),
  },
  {
    name: "b1a: Raw replaces the opening load once on restart and preserves it on reconnect",
    file: "pages/config-raw.js",
    edits: [["if (state.epoch !== epoch)", "if (false)"]],
    run: async (_t, m) => r5Raw(m, async ({ world, calls }) => {
      const count = () => calls.filter((/** @type {any} */ c) => c.method === "GET").length;
      assert.equal(count(), 1);
      r4Snapshot(world);
      await settle();
      assert.equal(count(), 1, "a reconnect keeps the run and its opening load");
      r4NewEpoch(world);
      await settle();
      assert.equal(count(), 2, "a restart sends exactly one replacement load");
    }),
  },
  {
    name: "b1a: Revert queued behind a preview sends no DELETE after an epoch change",
    file: "components/settings-form.js",
    edits: [[
      'enqueue(laneOf(mine), async () => {\n          if (!current()) return;',
      'enqueue(laneOf(mine), async () => {\n          if (false) return;',
    ]],
    run: async (t, m) => r5Form(t, m, async ({ world, calls, edit, root, form, values }) => {
      await edit("2");
      const old = r5Previews(calls)[0];
      click(root.querySelector('[data-act="revert"]'));
      await settle();
      r4NewEpoch(world);
      form.setScene("clock", "Clock", { epoch: world.epoch, incarnation: 1 });
      form.update(values("clock"));
      old.ok();
      await settle();
      assert.equal(calls.filter((/** @type {any} */ c) => c.method === "DELETE").length, 0, "a queued Revert keeps its original operation owner");
    }),
  },
  ...[
    {
      name: "b1a: the replacement epoch can reuse a control while its old request is pending",
      edits: [['return busy.get(key)?.epoch === storeFence().epoch;', 'return busy.has(key);']],
    },
    {
      name: "b1a: an old request's cleanup cannot release the replacement epoch's control",
      edits: [["if (key === undefined || busy.get(key) === control)", "if (true)"]],
    },
  ].map(({ name, edits }) => ({
    name,
    file: "api.js",
    edits: /** @type {Array<[string, string]>} */ (edits),
    run: async (/** @type {any} */ _t, /** @type {any} */ api) => {
      const world = r4World(r4d1());
      const calls = r4Server(world);
      r4NewEpoch(world);
      const key = "b1a-reused-control";
      const old = api.request("GET", "/api/v2/config/raw", { resource: "config", key });
      void old.catch(() => {});
      const first = pending(calls, "GET", "/config/raw");
      r4NewEpoch(world);
      const next = api.request("GET", "/api/v2/config/raw", { resource: "config", key });
      void next.catch(() => {});
      try {
        await settle();
        assert.equal(calls.length, 2, "the current run immediately owns its own request");
        first.ok();
        await old;
        assert.equal(api.isBusy(key), true, "old cleanup leaves the new owner busy");
        pending(calls, "GET", "/config/raw").ok();
        await next;
        assert.equal(api.isBusy(key), false, "only the new request frees its control");
      } finally {
        await r4AnswerAll({ calls });
        await Promise.allSettled([old, next]);
      }
    },
  })),
  {
    name: "b1a: the same run refuses a second request for a control that is still busy",
    file: "api.js",
    edits: [["if (key !== undefined && isBusy(key))", "if (false)"]],
    run: async (_t, api) => {
      const world = r4World(r4d1());
      const calls = r4Server(world);
      r4NewEpoch(world);
      const key = "b1a-single-control";
      const first = api.request("GET", "/api/v2/config/raw", { resource: "config", key });
      try {
        const second = api.request("GET", "/api/v2/config/raw", { resource: "config", key });
        // A missing guard sends a second held request: answer it so a
        // must-fail self-test terminates instead of waiting for a timeout.
        void second.catch(() => {});
        if (calls.length > 1) calls[1].ok();
        await assert.rejects(second, (/** @type {any} */ error) => error.code === "busy");
        assert.equal(calls.length, 1, "no second request reached pixdcon");
      } finally {
        await r4AnswerAll({ calls });
        await first;
      }
    },
  },
);

R5_PROBES.push(
  {
    name: "b1a: Raw's admitted effects already have their captured editor and opening",
    run: async () => {
      const m = await r5Module("pages/config-raw.js", [
        ["let revision = 0;", "let revision = 0;\nexport const __b1aEntries = [];"],
        ["function save() {\n  const editor = editorOf();", "function save() {\n  const editor = editorOf();\n  __b1aEntries.push({kind:'entry', editor:!!editor, root:!!root});"],
        ['effect(/** @type {import("../ops.js").Ownership} */ (base.owner), ["epoch", "opening", "revision"], () => {', 'effect(/** @type {import("../ops.js").Ownership} */ (base.owner), ["epoch", "opening", "revision"], () => {\n    __b1aEntries.push({kind:"text", editor:!!editor, root:!!root, opened, revision, baseOpening:base.opened, baseRevision:base.revision, ownerOpening:base.owner.values.opening, ownerRevision:base.owner.values.revision});'],
        ['effect(owner, ["epoch", "opening"], () => {', 'effect(owner, ["epoch", "opening"], () => {\n          __b1aEntries.push({kind:"saved", root:!!root, opened, baseOpening:mine, ownerOpening:owner.values.opening});'],
        ['effect(owner, ["epoch", "opening", "revision"], () => {', 'effect(owner, ["epoch", "opening", "revision"], () => {\n          __b1aEntries.push({kind:"refused", root:!!root, opened, revision, baseOpening:mine, ownerOpening:owner.values.opening, ownerRevision:owner.values.revision});'],
        ["  redraw();\n}\n\n/**\n * Reload from disk", "  __b1aEntries.push({kind:'start',started,root:!!root});\n  redraw();\n}\n\n/**\n * Reload from disk"],
      ]);
      for (const change of ["none", "type", "reopen", "epoch"]) for (const failure of [false, true]) {
        await r5Raw(m, async ({ world, calls, root }) => {
          pending(calls, "GET", "/config/raw").ok();
          await settle();
          typeInto(root.querySelector("textarea"), '{"devices":[],\n"edit":1}');
          click(root.querySelector('[data-act="save"]'));
          await settle();
          assert.equal(click(root.querySelector('[data-act="save"]')), false, "the busy button cannot enter Save again");
          const old = pending(calls, "PUT", "/config/raw");
          if (change === "type") typeInto(root.querySelector("textarea"), '{"devices":[],\n"edit":2}');
          if (change === "reopen") { m.page.unmount(); m.page.mount(root, {}); }
          if (change === "epoch") r4NewEpoch(world);
          await r4AnswerAll({ calls }, old);
          if (failure) old.answer(422, { code: "invalid_config", error: "Invalid config", line: 2 }); else old.ok();
          await settle();
          typeInto(root.querySelector("textarea"), '{"devices":[],\n"edit":3}');
          const retained = root.querySelector('[data-act="save"]');
          const entries = m.__b1aEntries.length;
          m.page.unmount();
          click(retained);
          await settle();
          assert.equal(m.__b1aEntries.length, entries, "an unmounted editor has no action listener");
        });
      }
      for (const entry of m.__b1aEntries) {
        assert.equal(entry.root, true, "every admitted effect has its mounted root");
        if ("editor" in entry) assert.equal(entry.editor, true, "the mounted markup has its editor");
        if ("baseOpening" in entry) assert.equal(entry.baseOpening, entry.opened, "the central projection already requires this opening");
        if ("ownerOpening" in entry) assert.equal(entry.ownerOpening, entry.opened);
        if ("baseRevision" in entry) assert.equal(entry.baseRevision, entry.revision, "base and capture inherited the same revision");
        if ("ownerRevision" in entry) assert.equal(entry.ownerRevision, entry.revision);
        if ("started" in entry) assert.equal(entry.started, true, "every reachable enabled Save starts; busy clicks never enter");
      }
      assert.ok(m.__b1aEntries.some((/** @type {any} */ e) => e.kind === "refused"));
      assert.ok(m.__b1aEntries.some((/** @type {any} */ e) => e.kind === "saved"));
    },
  },
  {
    name: "b1a: retirement alone prevents old callbacks from entering any page effect",
    run: async () => {
      const ops = await r5Module("ops.js");
      const world = r4World(r4d1());
      for (const failure of [false, true]) {
        r4NewEpoch(world);
        /** @type {any} */ let finish;
        /** @type {any} */ let action;
        /** @type {string[]} */ const outcomes = [];
        const old = ops.follow("b1a-retired", (/** @type {any} */ current) => {
          action = current;
          return new Promise((resolve, reject) => {
          finish = () => failure ? reject(new Error("old failure")) : resolve("old success");
          });
        }, { done: () => { outcomes.push("done"); }, failed: () => { outcomes.push("failed"); } });
        void old.catch(() => {});
        const token = ops.op("b1a-retired").token;
        r4NewEpoch(world);
        assert.notEqual(ops.op("b1a-retired").token, token, "the old token is retired synchronously");
        assert.equal(action([]), false, "the retired token independently rejects every projection");
        action.effect("unconfigured", () => outcomes.push("effect"));
        finish();
        await old.catch(() => {});
        await settle();
        assert.deepEqual(outcomes, [], "every page callback remains behind token admission, even without an extra epoch projection");
      }
    },
  },
  {
    name: "b1a: inherited admission independently blocks a queued cleanup's old epoch",
    run: async () => {
      const ops = await r5Module("ops.js");
      const world = r4World(r4d1());
      r4NewEpoch(world);
      const owner = ops.capture();
      r4NewEpoch(world);
      /** @type {string[]} */ const sent = [];
      await ops.follow("b1a-proof-end", async () => sent.push("DELETE"), { owner });
      assert.deepEqual(sent, []);
      assert.equal(r4State().ops.has("b1a-proof-end"), false);
    },
  },
  {
    name: "b1a: an unkeyed API request never owns a keyed control",
    run: async () => {
      const api = await r5Module("api.js");
      const world = r4World(r4d1());
      const calls = r4Server(world);
      /** @type {any[]} */ const notices = [];
      const stop = api.onBusy((/** @type {string} */ key, /** @type {boolean} */ busy) => notices.push([key, busy]));
      try {
        for (let n = 0; n < 2; n += 1) {
          r4NewEpoch(world);
          assert.equal(api.isBusy(undefined), false);
          const read = api.request("GET", "/api/v2/config/raw", { resource: "config" });
          assert.equal(api.isBusy(undefined), false);
          pending(calls, "GET", "/config/raw").ok();
          await read;
          assert.equal(api.isBusy(undefined), false);
        }
        assert.deepEqual(notices, [], "unkeyed work creates, owns and releases no control");
      } finally { stop(); }
    },
  },
  {
    name: "b1a: queued previews of an old epoch are left and their outcomes are hidden",
    run: async (t) => {
      const m = await r5Module("components/settings-form.js", [
        ["let ids = 0;", "let ids = 0;\nexport const __b1aSends = [];\nexport const __b1aOutcomes = [];"],
        ["async function sendPreview(of) {\n    of.queued = false;", "async function sendPreview(of) {\n    __b1aSends.push({left:of.left, epoch:of.owner.values.epoch, now:getState().epoch});\n    of.queued = false;"],
        ["if (!shown(of)) return;", "__b1aOutcomes.push({shown:shown(of), epoch:of.owner.values.epoch, now:getState().epoch});\n    if (!shown(of)) return;"],
      ]);
      for (const failure of [false, true]) await r5Form(t, m, async ({ world, form, values, calls, edit }) => {
        await edit("2");
        await edit("3");
        const old = r5Previews(calls)[0];
        r4NewEpoch(world);
        form.setScene("clock", "Clock", { epoch: world.epoch, incarnation: 1 });
        form.update(values("clock"));
        await edit("4");
        if (failure) old.answer(500, {}); else old.ok();
        await settle();
        assert.equal(calls.filter((/** @type {any} */ c) => c.method === "DELETE").length, 0);
      });
      assert.ok(m.__b1aSends.some((/** @type {any} */ s) => s.epoch !== s.now), "an old queued preview reached its send entry");
      assert.ok(m.__b1aOutcomes.some((/** @type {any} */ s) => s.epoch !== s.now), "a late failed preview reached its outcome entry");
      for (const s of m.__b1aSends) if (s.epoch !== s.now) assert.equal(s.left, true, "leaving the scope independently prevents its queued PUT");
      for (const s of m.__b1aOutcomes) if (s.epoch !== s.now) assert.equal(s.shown, false, "an old book is hidden and cannot report to the shown scope");
    },
  },
);

/** Cases that fail at fbf3f61: phase B makes each one pass and takes it off this list. */
/** @type {Set<string>} */
// r6 / gate F-J. Extra histories supplement every A5 story and assertion.
/** @type {Array<{name: string, kind: string, change: string, end: R4End}>} */
const R6_CASES = [];
const R8_EQUAL_OVERLAY_RECORDS = ["o1", "o2", "o3"].map((id) => ({ ...record("same-topic", "setting", { device: "d1", scene: "clock", key: "n", value: 8 }), id }));
for (const change of ["equal value retyped", "value changed away and back"])
  for (const end of R4_ENDS) R6_CASES.push({ name: `settings save × ${change} × ${end} (gate r5b F)`, kind: "settings save", change, end });
for (const change of ["epoch", "reincarnate"])
  for (const end of /** @type {R4End[]} */ (["500", "timeout"])) R6_CASES.push({ name: `device brightness range × ${change} × ${end} (gate r5b I, .bri-hint)`, kind: "device brightness range", change, end });
for (const kind of ["settings reset preview", "settings reset save"])
  for (const change of ["reset replaced by an edit", "reset replaced by equal default"])
    for (const end of R4_ENDS) R6_CASES.push({ name: `${kind} × ${change} × ${end} (gate r5b G)`, kind, change, end });

/** The old Reload GET differs from both its opening text and the newer config event, within one epoch. @param {any} module */
async function r6RawVersion(module) {
  return r5Raw(module, async ({ world, calls, root }) => {
    pending(calls, "GET", "/config/raw").ok();
    await settle();
    world.configVersion = 2;
    world.rev += 1;
    r4Click(root.querySelector('[data-act="reload"]'));
    await settle();
    pending(calls, "POST", "/config/reload").ok();
    await settle();
    const older = pending(calls, "GET", "/config/raw");
    assert.equal(older.configVersion, 2);
    world.configVersion = 3;
    world.rev += 1;
    assert.equal(r4Live(world, "config", { ...CONFIG_STATE, rev: world.rev }).action, "apply");
    const typed = R4_RAW(world.epoch, 2);
    r4Type(root.querySelector("textarea"), typed);
    assert.match(r4Text(root.querySelector(".edbar .state")), / · unsaved changes$/);
    older.ok();
    await settle();
    for (let render = 0; render < 2; render += 1) {
      assert.equal(r4Value(root.querySelector("textarea")), typed, "the old payload cannot change the replacement edit");
      assert.match(r4Text(root.querySelector(".edbar .state")), / · unsaved changes$/, "a dropped fence decision cannot become the editor's saved baseline");
      world.rev += 1;
      r4Live(world, "device", r4View(world, "d1", world.epoch, 1, world.rev));
      await settle();
    }
    r4Click(root.querySelector('[data-act="reload"]'));
    await settle();
    pending(calls, "POST", "/config/reload").ok();
    await settle();
    pending(calls, "GET", "/config/raw").ok();
    await settle();
    assert.equal(r4Value(root.querySelector("textarea")), R4_RAW(world.epoch, 3), "a current resource version does reach the editor");
    assert.match(r4Text(root.querySelector(".edbar .state")), /no unsaved changes$/);
  });
}

/** @param {any} module @param {boolean} overlap @param {R4End} end @param {any} [t] */
async function r6Overlays(module, overlap, end, t = /** @type {any} */ (null), isolated = false) {
  const records = isolated ? structuredClone(R8_EQUAL_OVERLAY_RECORDS) : [record("o1", "scene", { device: "d1", value: "clock" }), record("o2", "mode", { device: "d1", value: "pause" }), record("o3", "brightness", { device: "d1", value: 44 })];
  const world = r4World({ ...r4d1(), overlays: () => overlap ? records : isolated ? [records[0], records[2]] : records.slice(0, 1) });
  const calls = r4Server(world);
  r4NewEpoch(world);
  const root = pageRoot();
  module.page.mount(root, {});
  const row = (/** @type {string} */ id) => root.querySelector(`[data-id="${id}"]`)?.closest(".ot-row");
  try {
    r4Click(root.querySelector('[data-act="clear"][data-id="o1"]'));
    await settle();
    const old = pending(calls, "DELETE", "/overlays/o1");
    if (end === "timeout") t.mock.timers.tick(10_000);
    const audit = { world, kind: r4KindOf("overlays clear"), op: old, page: "overlays", root, opening: 1, edits: new Map(), clock: end === "timeout" ? 10_000 : 0, slotKey: [...r4State().ops].find(([, slot]) => slot.busy)?.[0] };
    const beforeIdentity = r8Frame(audit);
    if (overlap) {
      assert.equal(root.querySelector('[data-act="clear"][data-id="o2"]').disabled, false, "o1 cannot disable o2's independent Clear");
      r4Click(root.querySelector('[data-act="clear"][data-id="o2"]'));
      await settle();
      assert.equal(calls.filter((/** @type {any} */ c) => c.method === "DELETE").length, 2, "different overlay ids admit independent Clears");
    } else r4Live(world, "overlays", records.slice(1));
    await settle();
    if (isolated && !overlap) assert.doesNotMatch(r4Text(row("o2")), /Not cleared|Clearing/, "o2 owns neither o1's pending state nor its failure before the old end");
    const measured = r8RecordStory(audit, beforeIdentity, r8Frame(audit), `${overlap ? "overlap" : "replacement"}/${end}/${isolated ? "equal-kind" : "different-kind"}`);
    const piece = R4_PAGES.overlays.pieces(root).find(([name]) => name === "row o2 Clear and outcome");
    assert.ok(piece, "the equal-id comparison reads its declared row piece");
    measured.compared.set("overlays: row o2 Clear and outcome", typeof piece[1] === "function" ? piece[1](piece[2]) : piece[1]);
    const third = r4Text(row("o3"));
    if (end === "success") old.ok();
    else if (end === "500") old.answer(500, {});
    else { old.abandon(); t.mock.timers.tick(5_000); }
    await settle();
    if (overlap) {
      assert.match(r4Text(row("o2")), /Clearing/, "o2 keeps its own pending operation");
      pending(calls, "DELETE", "/overlays/o2").ok();
      await settle();
      assert.doesNotMatch(r4Text(row("o2")), /Not cleared/);
      if (end !== "success") assert.match(r4Text(row("o1")), /Not cleared/, "o1 owns its failure");
    } else assert.doesNotMatch(r4Text(row("o2")), /Not cleared|Clearing/, "o2 owns neither o1's pending state nor its failure");
    assert.equal(r4Text(row("o3")), third, "every unaffected row is observed too");
  } finally {
    module.page.unmount();
    root.remove();
    await r4AnswerAll({ calls });
  }
}

const R4_KNOWN = new Set([
  "config add device × type × success",
  "config patch × leave × success",
  "config patch × membership × 500",
  "config patch × membership × success",
  "config patch × membership × timeout",
  "config patch × reincarnate × success",
  "config patch × reincarnate × success, last",
  "config patch × reopen × 500, last",
  "config patch × reopen × success, last",
  "config patch × reopen × timeout, last",
  "config patch × revisit × success",
  "config patch × type × success",
  "health log × epoch × 500",
  "health log × epoch × 500, last",
  "health log × epoch × success",
  "health log × epoch × success, last",
  "health log × epoch × timeout",
  "health log × epoch × timeout, last",
  "settings preview rejected × reincarnate × success",
  "settings preview rejected × reincarnate × success, last",
  "settings preview rejected × schema × success",
  "settings preview × commit × 500",
  "settings preview × commit × timeout",
  "settings preview × newer draft × 500",
  "settings preview × newer draft × timeout",
  "settings preview × other field × 500",
  "settings preview × other field × timeout",
  "settings preview × reincarnate × 500",
  "settings preview × reincarnate × 500, last",
  "settings preview × reincarnate × success",
  "settings preview × reincarnate × success, last",
  "settings preview × reincarnate × timeout",
  "settings preview × reincarnate × timeout, last",
  "settings preview × schema × 500",
  "settings preview × schema × success",
  "settings preview × schema × timeout",
  "settings revert × reincarnate × 500",
  "settings revert × reincarnate × 500, last",
  "settings revert × reincarnate × success",
  "settings revert × reincarnate × success, last",
  "settings revert × reincarnate × timeout",
  "settings revert × reincarnate × timeout, last",
  "settings save rejected × membership × 500",
  "settings save rejected × membership × refused",
  "settings save rejected × membership × timeout",
  "settings save rejected × reincarnate × 500",
  "settings save rejected × reincarnate × 500, last",
  "settings save rejected × reincarnate × refused",
  "settings save rejected × reincarnate × refused, last",
  "settings save rejected × reincarnate × timeout",
  "settings save rejected × reincarnate × timeout, last",
  "settings save rejected × schema × 500",
  "settings save rejected × schema × refused",
  "settings save rejected × schema × timeout",
  "settings save × membership × 500",
  "settings save × membership × success",
  "settings save × membership × timeout",
  "settings save × reincarnate × 500",
  "settings save × reincarnate × 500, last",
  "settings save × reincarnate × success",
  "settings save × reincarnate × success, last",
  "settings save × reincarnate × timeout",
  "settings save × reincarnate × timeout, last",
  "settings save × schema × 500",
  "settings save × schema × timeout",
  // r6: Reset stories expose the same phase-B ownership bugs.
  "settings reset preview × commit × 500",
  "settings reset preview × commit × timeout",
  "settings reset preview × newer draft × 500",
  "settings reset preview × newer draft × timeout",
  "settings reset preview × other field × 500",
  "settings reset preview × other field × timeout",
  "settings reset preview × reincarnate × 500",
  "settings reset preview × reincarnate × 500, last",
  "settings reset preview × reincarnate × success",
  "settings reset preview × reincarnate × success, last",
  "settings reset preview × reincarnate × timeout",
  "settings reset preview × reincarnate × timeout, last",
  "settings reset preview × reset replaced by an edit × 500 (gate r5b G)",
  "settings reset preview × reset replaced by an edit × timeout (gate r5b G)",
  "settings reset preview × reset replaced by equal default × 500 (gate r5b G)",
  "settings reset preview × reset replaced by equal default × timeout (gate r5b G)",
  "settings reset preview × schema × 500",
  "settings reset preview × schema × timeout",
  "settings reset save × membership × 500",
  "settings reset save × membership × success",
  "settings reset save × membership × timeout",
  "settings reset save × reincarnate × 500",
  "settings reset save × reincarnate × success",
  "settings reset save × reincarnate × timeout",
  "settings reset save × schema × 500",
  "settings reset save × schema × timeout",
  "settings reset save × reincarnate × 500, last",
  "settings reset save × reincarnate × success, last",
  "settings reset save × reincarnate × timeout, last",
]);

const R4_STRICT = process.env.R4_HARNESS_STRICT === "1";
/** Known cases that executed and passed: a todo must never hide a repaired product. @type {Set<string>} */
const r7UnexpectedPasses = new Set();
/** Every named todo is checked against its actual execution, including an
 * accidental early return: passing a known case makes the ordinary gate fail.
 * @param {string} name @param {string} label @param {(t: any) => Promise<void>} run */
function r7CaseTest(name, label, run) {
  const known = !R4_STRICT && R4_KNOWN.has(name);
  test(label, { todo: known ? `fails at fbf3f61: ${name}` : undefined }, async (t) => {
    await run(t);
    if (known) r7UnexpectedPasses.add(name);
  });
}
/** @param {Set<string>} passes */
function r7RequireKnownLiveness(passes) {
  assert.deepEqual([...passes], [], "remove it from R4_KNOWN: a listed product failure now passes");
}
const { appendFileSync: r4Append } = await import("node:fs");
/** With R4_HARNESS_REPORT=<file>: what each case found, one JSON line per case that found something (the harness log is written from it). @param {string} name @param {string[]} differences */
function r4Report(name, differences) {
  if (process.env.R4_HARNESS_REPORT && differences.length) r4Append(process.env.R4_HARNESS_REPORT, `${JSON.stringify({ name, differences })}\n`);
}
/** The reference runs, by kind and change (and end, for a reconnect's and a commuted story's). @type {Map<string, any>} */
const r4References = new Map();
let r4Count = 0;
/** @type {string[]} */
const r4Probes = [];
/** The cases where the old operation ends last, by name. @type {string[]} */
const r4Last = [];
/** @param {string} name @param {string} change */
function r6CaseKind(name, change) {
  const kind = r4KindOf(name);
  return change === "another field reset" ? { ...kind, world: r4d1({ scene: "weather" }), request: /** @type {[string, string]} */ (["PUT", "/settings/weather"]) } : kind;
}
for (const end of R4_ENDS) R6_CASES.push({ name: `settings save × another field reset × ${end} (gate r5b G)`, kind: "settings save", change: "another field reset", end });

const R6_ID_STORIES = {
  "superseded loads in the matrix (r7)": ["token"],
  "same-value replacement cases (gate F)": ["draft"],
  "Reset preview and Save cases (gate G)": ["draft"],
  "Raw newer config within one epoch (gate H)": ["resource"],
  "replacement overlay ids and overlapping Clears (gate J)": ["overlay"],
};
/** @type {Array<{name: string, run: (t: any) => Promise<void>}>} */
const R6_FOCUSED = [
  { name: "Raw Reload × newer config in the same epoch × success (gate r5b H)", run: async () => r6RawVersion(await r5Module("pages/config-raw.js")) },
  ...[false, true].flatMap((overlap) => ["success", "500", "timeout"].map((end) => ({ name: `overlays clear × ${overlap ? "overlapping distinct ids" : "replacement overlay id"} × ${end} (gate r5b J)`, run: async (/** @type {any} */ t) => r6Overlays(await r5Module("pages/overlays.js"), overlap, /** @type {R4End} */ (end), t) }))),
];
// r7: K1 varies only the retained record id, including all three ends.
const R7_OVERLAY_CASES = [false, true].flatMap((overlap) => R4_ENDS.map((end) => ({
  name: `overlays clear × ${overlap ? "overlapping equal-kind ids" : "replacement equal-kind id"} × ${end} (gate r5d K1)`,
  run: async (/** @type {any} */ t) => r6Overlays(await r5Module("pages/overlays.js"), overlap, end, t, true),
})));
R6_FOCUSED.push(...R7_OVERLAY_CASES);
for (const change of ["scene", "epoch", "reincarnate"])
  for (const end of R4_ENDS) R6_FOCUSED.push({
    name: `shown preview failure × ${change} × ${end} (gate r5e M2)`,
    run: (t) => r8ShownPreviewFailure(t, change, end),
  });

for (const end of /** @type {R4End[]} */ (["500", "timeout"])) R6_CASES.push({ name: `raw load × superseded by Reload × ${end} (gate r5d ops)`, kind: "raw load", change: "superseded by Reload", end });
for (const story of R6_CASES)
  r7CaseTest(story.name, `r4 harness: r6: ${story.name}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const differences = await r4Case(t, r6CaseKind(story.kind, story.change), story.change, story.end);
    r4Report(story.name, differences);
    assert.deepEqual(differences, []);
  });
for (const story of R6_FOCUSED)
  r7CaseTest(story.name, `r4 harness: r6: ${story.name}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await story.run(t);
  });

for (const kind of R4_KINDS)
  for (const change of /** @type {R4Change[]} */ (Object.keys(R4_CHANGES))) {
    const why = r4Unreachable(kind, change);
    if (why) {
      r4Probes.push(`${kind.name} × ${change}: ${why}`);
      // The exclusion is a claim the harness checks: the probe begins the operation and tries the change through the stand-in DOM.
      test(`r4 harness: unreachable: ${kind.name} × ${change}`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const probe = await r4Run(t, kind, change, "success", "probe");
        assert.equal(probe.unreachable, why, `${kind.name} × ${change}: the change ${probe.unreachable === undefined ? "could be made: the case must run" : `is unreachable for another reason: ${probe.unreachable}`}`);
      });
      continue;
    }
    for (const end of r4Ends(kind)) {
      const name = `${kind.name} × ${change} × ${end}`;
      r4Count += 1;
      const gate = /** @type {Record<string, string>} */ (R4_GATE)[name];
      const label = `r4 harness: ${name}${gate ? ` (${gate})` : ""}`;
      r7CaseTest(name, label, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const differences = await r4Case(t, kind, change, end, { references: r4References });
        r4Report(name, differences);
        assert.deepEqual(differences, [], `${kind.site}: the old operation changed UI state that depends on an identity the change changed`);
      });
    }
    // The same story with the old operation ending last (r4): after everything the change started was answered,
    // and after the person carried on in what the page became.
    if (r4EndsLast(kind, change))
      for (const end of r4Ends(kind)) {
        const name = `${kind.name} × ${change} × ${end}, last`;
        r4Last.push(name);
        const gate = /** @type {Record<string, string>} */ (R4_GATE)[name];
        r7CaseTest(name, `r4 harness: ${name}${gate ? ` (${gate})` : ""}`, async (t) => {
          t.mock.timers.enable({ apis: ["setTimeout"] });
          const differences = await r4Case(t, kind, change, end, { references: r4References, last: true });
          r4Report(name, differences);
          assert.deepEqual(differences, [], `${kind.site}: the old operation, ending last, changed UI state that depends on an identity the change changed`);
        });
      }
  }

// Stories of two changes: what an exclusion that holds for one change leaves open (gate note2, LOW).
let r4Composites = 0;
/** The names of the cases of two changes, as R4_KNOWN lists them. @type {string[]} */
const r4CompositeNames = [];
for (const [change, { kind: kindName, steps, alone, gate }] of Object.entries(R4_COMPOSITES)) {
  const kind = /** @type {R4Kind} */ (R4_KINDS.find((k) => k.name === kindName));
  for (const end of r4Ends(kind)) {
    r4Composites += 1;
    const name = `${kind.name} × ${change} × ${end}`;
    r4CompositeNames.push(name);
    r7CaseTest(name, `r4 harness: two changes: ${name} (${gate}: ${kind.name} × ${steps[steps.length - 1]} is unreachable as one change only)`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      // The last change alone is unreachable, for the stated reason (its probe runs here); after the first it can be made.
      assert.equal((await r4Run(t, kind, steps[steps.length - 1], end, "probe")).unreachable, alone, `${kind.name} × ${steps[steps.length - 1]} alone`);
      assert.equal((await r4Run(t, kind, change, end, "probe")).unreachable, undefined, `${kind.name} × ${change} can be made through the stand-in DOM`);
      const differences = await r4Case(t, kind, change, end, { references: r4References });
      r4Report(name, differences);
      assert.deepEqual(differences, [], `${kind.site}: the old operation changed UI state that depends on an identity the changes changed`);
    });
  }
}

test("r4 harness: the matrix covers every operation kind, change and end; every exclusion is a probe that runs", () => {
  const combinations = R4_KINDS.reduce((sum, kind) => sum + Object.keys(R4_CHANGES).length * r4Ends(kind).length, 0);
  const excluded = r4Probes.reduce((sum, line) => sum + r4Ends(/** @type {R4Kind} */ (R4_KINDS.find((k) => line.startsWith(`${k.name} ×`)))).length, 0);
  assert.equal(r4Count + excluded, combinations);
  // A named case is a case of the matrix: its kind, its change and its end exist, and it is not excluded.
  /** @type {string[]} */
  const names = [];
  for (const kind of R4_KINDS) for (const change of Object.keys(R4_CHANGES)) if (!r4Unreachable(kind, /** @type {R4Change} */ (change))) for (const end of r4Ends(kind)) names.push(`${kind.name} × ${change} × ${end}`);
  assert.equal(names.length, r4Count);
  for (const name of Object.keys(R4_GATE)) assert.ok(names.includes(name) || r4Last.includes(name), `${name} is a case of the matrix`);
  // The known failures are cases of the matrix too: a name that matches no case would hide nothing, and is a mistake.
  for (const name of R4_KNOWN) assert.ok(names.includes(name) || r4CompositeNames.includes(name) || r4Last.includes(name) || R6_CASES.some((story) => story.name === name) || R6_FOCUSED.some((story) => story.name === name) || R5_STORIES.some((story) => `guard story: ${story.name}` === name), `${name} (R4_KNOWN) is a case of the matrix`);
  t_log(
    `r4 harness: ${R4_KINDS.length} kinds × ${Object.keys(R4_CHANGES).length} changes × ends (${R4_ENDS.join(", ")}; raw save also refused; settings preview rejected: success only; settings save rejected: refused in place of success): ${combinations} combinations, ${r4Count} cases run, ${r4Probes.length} combinations (${excluded} with their ends) unreachable, each a probe that runs; ${r4Last.length} cases with the old operation ending last (reopen, epoch, reincarnate, scene, where the change is inside the kind's projection); ${r4Composites} cases of two changes; ${R4_KNOWN.size} known failures:\n  ${r4Probes.join("\n  ")}`,
  );
});

/**
 * The identities of the model (note §1), each by the name the pieces and
 * the changes use for it, with what makes the stand-in's data differ per
 * value of it (r5b: every gate so far found a gap where data was uniform).
 * `data` runs the stand-in and returns pairs that must differ: [what, the
 * data for one value of the identity, the data for another].
 *
 * @type {Record<string, {model: string, data: (t: any) => Promise<Array<[string, unknown, unknown]>>|Array<[string, unknown, unknown]>}>}
 */
const R4_IDENTITIES = {
  token: {
    model: "operation token (one owner within a slot)",
    data: async () => {
      const ops = await import("../../web/js/ops.js");
      const first = ops.follow("r7-token-data", async () => null);
      const a = r4State().ops.get("r7-token-data").token;
      await first;
      const second = ops.follow("r7-token-data", async () => null);
      const b = r4State().ops.get("r7-token-data").token;
      await second; ops.drop("r7-token-data");
      return [["two equal-valued operations in the same slot", a, b]];
    },
  },
  resource: {
    model: "same-epoch config resource version",
    data: async () => {
      await r6RawVersion(await r5Module("pages/config-raw.js"));
      return [["Raw payload within one epoch", R4_RAW("e0000001", 1), R4_RAW("e0000001", 2)]];
    },
  },
  overlay: {
    model: "overlay id (independent row and operation slot)",
    data: async () => {
      for (const overlap of [false, true]) await r6Overlays(await r5Module("pages/overlays.js"), overlap, "500");
      return [["overlay id alone", record("o1", "setting", { device: "d1", key: "n", value: 8 }), record("o2", "setting", { device: "d1", key: "n", value: 8 })]];
    },
  },
  epoch: {
    model: "server epoch (the run of pixdcon)",
    data: () => {
      const world = r4World({ ...r4d1({ override: 30 }), overlays: r4KindOf("overlays clear").world.overlays });
      world.epochs.push("e0000001", "e0000002");
      const view = (/** @type {string} */ epoch) => r4View(world, "d1", epoch, 1, 1);
      return [
        ["config.json as Raw loads it", R4_RAW("e0000001"), R4_RAW("e0000002")],
        ["the log lines", R4_LOG("e0000001").map((l) => l.message), R4_LOG("e0000002").map((l) => l.message)],
        ["the device's display name", view("e0000001").displayName, view("e0000002").displayName],
        ["the device's brightness override", view("e0000001").desired.brightness.override, view("e0000002").desired.brightness.override],
        ["the device's last brightness", view("e0000001").effective.lastBrightness, view("e0000002").effective.lastBrightness],
        ["the retained overlay record", world.spec.overlays("e0000001")[0].value, world.spec.overlays("e0000002")[0].value],
      ];
    },
  },
  life: {
    model: "device life (name + incarnation)",
    data: () => {
      const world = r4World(r4d1({ override: 30 }));
      world.epochs.push("e0000001");
      const view = (/** @type {number} */ life) => r4View(world, "d1", "e0000001", life, 1);
      return [
        ["the device's display name", view(1).displayName, view(2).displayName],
        ["the device's brightness override", view(1).desired.brightness.override, view(2).desired.brightness.override],
        ["the device's last brightness", view(1).effective.lastBrightness, view(2).effective.lastBrightness],
      ];
    },
  },
  scene: {
    model: "scene (settings scope)",
    data: () => {
      /** @type {Array<[string, unknown, unknown]>} */
      const out = [];
      for (const [name, definitions] of /** @type {Array<[string, Record<string, any[]>]>} */ ([["the narrowing world", R4_DEFINITIONS], ["the widening world", R4_DEFINITIONS_WIDENING]])) {
        const world = r4World({ ...r4d1(), definitions });
        world.epochs.push("e0000001");
        world.epoch = "e0000001";
        const state = (/** @type {string} */ scene) => r4Settings(world, r4Now(world), "d1", scene);
        out.push([`${name}: the scene definition`, state("clock").schema, state("weather").schema], [`${name}: the values`, state("clock").values, state("weather").values]);
        // Saved values are kept per device and scene: a Save of Clock on d1 (n = 1, a value both worlds take) changes
        // neither Weather's nor another device's.
        r4Server(world);
        void fetch("/api/v2/devices/d1/settings/clock", { method: "PUT", body: JSON.stringify({ set: { n: 1 } }) });
        assert.deepEqual([r4Saved(world, "d1", "clock"), r4Saved(world, "d1", "weather"), r4Saved(world, "d2", "clock")], [{ n: 1 }, { m: 8 }, {}], `${name}: a Save is kept for its device and scene`);
        out.push([`${name}: the saved values after a Save of Clock`, r4Saved(world, "d1", "clock"), r4Saved(world, "d1", "weather")]);
      }
      return out;
    },
  },
  schema: {
    model: "scene definition",
    data: () => {
      /** @type {Array<[string, unknown, unknown]>} */
      const out = [];
      for (const [name, definitions] of /** @type {Array<[string, Record<string, any[]>]>} */ ([["the narrowing world", R4_DEFINITIONS], ["the widening world", R4_DEFINITIONS_WIDENING]]))
        for (const [scene, [first, second]] of Object.entries(definitions)) {
          out.push([`${name}, ${scene}: the definition`, first, second]);
          // pixdcon's verdict on the story's edit of that scene differs between its two definitions.
          const edit = { n: scene === "clock" ? 2 : 9 };
          out.push([`${name}, ${scene}: pixdcon's verdict on n = ${edit.n}`, r4Refused(first, edit), r4Refused(second, edit)]);
        }
      return out;
    },
  },
  draft: {
    model: "draft (pending, committed)",
    data: async (t) => {
      // Every edit of a story is another draft with another value: the preview requests of a story with a newer draft.
      const story = await r4Run(t, r4KindOf("settings preview"), "newer draft", "success", "case");
      const previews = (story.calls ?? []).filter((/** @type {any} */ c) => c.method === "PUT" && c.path.endsWith("/settings/clock/preview"));
      assert.equal(previews.length, 2, "the story sends two previews");
      const equal = await r4Run(t, r4KindOf("settings save"), "equal value retyped", "success", "case");
      const equalPreviews = (equal.calls ?? []).filter((/** @type {any} */ c) => c.method === "PUT" && c.path.endsWith("/settings/clock/preview"));
      assert.equal(equalPreviews[0].body.values.n, equalPreviews[1].body.values.n, "equal values still identify different drafts");
      return [
        ["equal-valued replacement's own draft number (gate F)", equalPreviews[0].body.draft, equalPreviews[1].body.draft],
        ["the draft number", previews[0].body.draft, previews[1].body.draft],
        ["the value of n", previews[0].body.values.n, previews[1].body.values.n],
      ];
    },
  },
  membership: {
    model: "config membership",
    data: () => {
      const world = r4World(r4d1());
      world.epochs.push("e0000001");
      const view = (/** @type {string} */ origin) => r4View(world, "d1", "e0000001", 1, 1, [{ name: "d1", o: { origin } }]);
      return [["the device's origin", view("config").origin, view("blob").origin]];
    },
  },
  visit: {
    model: "edit-row visit",
    data: async (t) => {
      // What a row's editor holds belongs to the visit: the name typed in the first is not in the row opened again.
      const kind = r4KindOf("config patch");
      const [same, again] = [await r4Run(t, kind, null, "success", "without"), await r4Run(t, kind, "revisit", "success", "without")];
      return [["the edit row's fields", same.points[0].get("config: edit row fields")?.value, again.points[0].get("config: edit row fields")?.value]];
    },
  },
  opening: {
    model: "page opening",
    data: async (t) => {
      const kind = r4KindOf("raw save");
      const [same, again] = [await r4Run(t, kind, null, "success", "without"), await r4Run(t, kind, "reopen", "success", "without")];
      return [["Raw's editor text", same.points[0].get("raw: editor text")?.value, again.points[0].get("raw: editor text")?.value]];
    },
  },
  revision: {
    model: "editor revision",
    data: async (t) => {
      const kind = r4KindOf("raw save");
      const [same, typed] = [await r4Run(t, kind, null, "success", "without"), await r4Run(t, kind, "type", "success", "without")];
      return [["Raw's editor text", same.points[0].get("raw: editor text")?.value, typed.points[0].get("raw: editor text")?.value]];
    },
  },
  owner: {
    model: "control slot (its owner: the slider's)",
    data: async (t) => {
      // Each owner of the slider sends a level of its own, and holds a stored level of its own.
      const story = await r4Run(t, r4KindOf("device brightness range"), "reincarnate, then the new owner slides", "success", "case");
      const sent = (story.calls ?? []).filter((/** @type {any} */ c) => c.method === "PUT" && c.path.endsWith("/brightness"));
      assert.equal(sent.length, 2, "each life sends its level");
      return [
        ["the level sent", sent[0].body.override, sent[1].body.override],
        ["the life it was sent in", sent[0].lives.get("d1"), sent[1].lives.get("d1")],
      ];
    },
  },
};

test("r4 audit: every identity of the model has data of its own in the stand-in, and is a change of the matrix or a step of a story of two changes that runs (r5b)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Every identity a change changes, and every identity a piece names, is one of the audited ones: a new one needs data of its own first.
  const changed = new Set([...Object.values(R4_CHANGES).flat(), ...Object.values(R4_STEPS).flat()]);
  for (const identity of changed) assert.ok(identity in R4_IDENTITIES, `the identity "${identity}" a change changes is audited`);
  const named = new Set(R4_REJECTION.concat(R4_BOOKKEEPING, R4_FEEDBACK));
  for (const page of Object.values(R4_PAGES)) {
    const root = pageRoot();
    for (const [, deps] of page.pieces(root)) for (const identity of typeof deps === "function" ? [...deps("Loading config.json…"), ...deps("x")] : deps) named.add(identity);
    root.remove();
  }
  for (const identity of named) assert.ok(identity in R4_IDENTITIES, `the identity "${identity}" a piece depends on is audited`);
  /** @type {string[]} */
  const lines = [];
  for (const [identity, { model, data }] of Object.entries(R4_IDENTITIES)) {
    // It is a change of the matrix, or a step of a story of two changes (whose probe and cases run).
    const changes = Object.entries(R4_CHANGES).filter(([, ids]) => /** @type {string[]} */ (ids).includes(identity)).map(([change]) => change);
    const steps = [...Object.entries(R6_ID_STORIES).filter(([, ids]) => ids.includes(identity)).map(([story]) => `r6: ${story}`), ...Object.entries(R4_COMPOSITES).filter(([, story]) => story.steps.some((step) => r4StepChanges(step).includes(identity))).map(([story]) => `two changes: ${story}`)];
    assert.ok(changes.length + steps.length > 0, `${model}: a change of the matrix or a story of two changes changes it`);
    const pairs = await data(t);
    assert.ok(pairs.length > 0, `${model}: the stand-in has data for it`);
    for (const [what, a, b] of pairs) assert.notDeepEqual(a, b, `${model}: ${what} is the same for two values of the identity`);
    lines.push(`${model} [${identity}]: changed by ${[...changes, ...steps].join(", ")}; differs per value: ${pairs.map(([what]) => what).join("; ")}`);
  }
  t_log(`r4 audit, identity × data:\n  ${lines.join("\n  ")}`);
});


for (const probe of R5_PROBES)
  test(`r4 guard probe: ${probe.name}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await probe.run(t);
  });

// Each new interleaving has a normal named case and a must-fail in-memory
// guard removal beside the passing control. Main is loaded by its story.
for (const story of R5_STORIES) {
  const name = `guard story: ${story.name}`;
  r7CaseTest(
    name,
    `r4 harness: ${name}`,
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const module = story.file === "main.js" ? {} : await r5Module(story.file);
      try {
        await story.run(t, module);
      } catch (error) {
        r4Report(name, [String(error)]);
        throw error;
      }
    },
  );
  test(`r4 harness self-test: guard story: ${story.name}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const control = story.file === "main.js" ? {} : await r5Module(story.file);
    await story.run(t, control);
    const replace = story.other ? { [story.other.spec]: await r4Mutant(story.other.file, story.other.edits) } : {};
    const mutant =
      story.file === "main.js" ? { __r5Edits: story.edits } : await r5Module(story.file, story.edits, replace);
    await assert.rejects(
      story.run(t, mutant),
      (/** @type {any} */ error) => error.name === "AssertionError" || error.name === "ApiError",
      "the removed guard must violate the same observation the control passed",
    );
  });
}

// --- self-tests: product mutations the harness must catch (gate r4 §3, §4) ---

/**
 * A page module with its source changed in memory: relative imports point
 * to the real modules (the same store and ops), or to other mutants.
 *
 * @param {string} file under web/js
 * @param {Array<[string, string]>} edits [what is there, what it becomes]; each must be found
 * @param {Record<string, string>} [replace] relative import → module URL
 */
async function r4Mutant(file, edits, replace = {}) {
  const { readFileSync } = await import("node:fs");
  const url = new URL(`../../web/js/${file}`, import.meta.url);
  let src = readFileSync(url, "utf8");
  for (const [from, to] of edits) {
    const anchor = r8SourceAnchor(src, from, r8AnchorHint(file, from));
    src = src.replace(anchor, to);
  }
  src = src.replace(/from\s+"(\.{1,2}\/[^"]+)"/g, (_, spec) => `from "${replace[spec] ?? new URL(spec, url).href}"`);
  return `data:text/javascript;base64,${Buffer.from(src).toString("base64")}`;
}

/** The central admission has two independent old-run barriers: retired slot
 * token and captured epoch. Remove both to expose the original page-local
 * defects; opening/revision checks and the store fence remain executable.
 * @type {Array<[string, string]>}
 */
const R4_B1A_OLD_EPOCH_GUARD_REMOVALS = [
  ["if (owner.slot && op(owner.slot.key).token !== owner.slot.token) return false;", "if (false) return false;"],
  ["if (read() !== owner.values[name]) return false;", 'if (name !== "epoch" && read() !== owner.values[name]) return false;'],
];

test("r4 harness self-test: an epoch guard on Raw's load without a replacement load is caught (gate r4 §4)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Remove the new restart trigger; retain the old recipe and every observation.
  const mutant = await r4Mutant("pages/config-raw.js", [
    ["if (state.epoch !== epoch)", "if (false)"],
    ["function load(base = { opened, revision }, tries = 0) {", "function load(base = { opened, revision, epoch: getState().epoch }, tries = 0) {"],
    ["if (base.opened !== opened || !root) return;\n        if (decision", "if (base.opened !== opened || !root || /** @type {any} */ (base).epoch !== getState().epoch) return;\n        if (decision"],
  ]);
  const raw = (await import(mutant)).page;
  const kind = /** @type {R4Kind} */ (R4_KINDS.find((k) => k.name === "raw load"));
  const differences = await r4Case(t, kind, "epoch", "success", { modules: { raw } });
  assert.ok(differences.some((d) => /editor text/.test(d)), `the harness reports the empty editor: ${differences.join("\n")}`);
  assert.ok(differences.some((d) => /replacement load/.test(d)), "and the missing replacement load");
  assert.deepEqual(await r4Case(t, kind, "epoch", "success"), [], "the real replacement trigger supplies the new run's editor");
});

test("r4 harness self-test: no longer reachable: the page-local Raw epoch guard alone cannot lose the replacement load (gate r4 §4)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mutant = await r4Mutant("pages/config-raw.js", [
    ["function load(base = { opened, revision }, tries = 0) {", "function load(base = { opened, revision, epoch: getState().epoch }, tries = 0) {"],
    ["if (base.opened !== opened || !root) return;\n        if (decision", "if (base.opened !== opened || !root || /** @type {any} */ (base).epoch !== getState().epoch) return;\n        if (decision"],
  ]);
  const raw = (await import(mutant)).page;
  const kind = /** @type {R4Kind} */ (R4_KINDS.find((k) => k.name === "raw load"));
  const differences = await r4Case(t, kind, "epoch", "success", { modules: { raw } });
  // Original A5 mutant, unchanged: a page-local epoch check adds no replacement load.
  // The B1a render trigger supplies that load independently. If it disappears,
  // this check reports the original empty-editor / missing-replacement defect.
  assert.deepEqual(differences, [], "no longer reachable: the old page-local Raw epoch mutant cannot lose the replacement load");
});

test("r4 harness self-test: Save suppressed while a newer draft exists is caught (gate r4 §3)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const form = await r4Mutant("components/settings-form.js", [
    ["const plan = mine.book.saveBody(session());\n    if (!plan) return;", "const plan = mine.book.saveBody(session());\n    if (!plan) return;\n    const at = mine.book.draft();"],
    ["done: (answer) => {\n          // What was saved", "done: (answer) => {\n          if (mine.book.draft() !== at) return null;\n          // What was saved"],
  ]);
  const device = (await import(await r4Mutant("pages/device.js", [], { "../components/settings-form.js": form }))).page;
  const kind = /** @type {R4Kind} */ (R4_KINDS.find((k) => k.name === "settings save"));
  const differences = await r4Case(t, kind, "other field", "success", { modules: { device } });
  assert.ok(differences.some((d) => /row marker of n|edits the next Save sends/.test(d)), `the harness reports the unacknowledged edit: ${differences.join("\n")}`);
  // The same story with the real form passes: the submitted edit is acknowledged, the newer one stays and is sent.
  assert.deepEqual(await r4Case(t, kind, "other field", "success"), []);
});

test("r4 harness self-test: a brightness range left enabled while its request runs is caught (gate r4 §5)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const device = (await import(await r4Mutant("pages/device.js", [["range.disabled = override === null || briDisabled;", "range.disabled = override === null;"]]))).page;
  const kind = /** @type {R4Kind} */ (R4_KINDS.find((k) => k.name === "device brightness range"));
  const differences = await r4Case(t, kind, "reopen", "success", { modules: { device } });
  assert.ok(differences.some((d) => /range is enabled/.test(d)), `the harness reports the enabled range: ${differences.join("\n")}`);
});

test("r4 harness self-test: a probe finds the combinations the first note excluded reachable (gate r4 §4)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [name, change] of /** @type {Array<[string, R4Change]>} */ ([["settings load", "commit"], ["settings load", "newer draft"], ["device adopt", "commit"]])) {
    const kind = /** @type {R4Kind} */ (R4_KINDS.find((k) => k.name === name));
    const probe = await r4Run(t, kind, change, "success", "probe");
    assert.equal(probe.unreachable, undefined, `${name} × ${change} can be made through the stand-in DOM`);
    assert.equal(r4Unreachable(kind, change), null, `${name} × ${change} runs as cases`);
  }
});

// --- r3: the mutants of the gate on harness r2 (findings-note2, M1 to M3), each caught ---

/**
 * A declaration, so it is there whenever a test runs: with a name pattern
 * that leaves a test as the first to run, the runner starts it while this
 * file is still being evaluated (the audit runs alone).
 *
 * @param {string} name @returns {R4Kind}
 */
function r4KindOf(name) {
  return /** @type {R4Kind} */ (R4_KINDS.find((k) => k.name === name));
}
/** The Device page with a changed settings form. @param {Array<[string, string]>} edits @param {Record<string, string>} [replace] what the form imports instead: relative import → module URL */
const r4DeviceWithForm = async (edits, replace = {}) =>
  (await import(await r4Mutant("pages/device.js", [], { "../components/settings-form.js": await r4Mutant("components/settings-form.js", edits, replace) }))).page;
/** In sendPreview: the scene definition the preview was sent under. @type {[string, string]} */
const R4_EDIT_SENT_UNDER = ["const plan = of.book.previewPlan(id);\n    of.previewed = true;", "const plan = of.book.previewPlan(id);\n    of.previewed = true;\n    const definition = JSON.stringify(current?.schema);"];
/** In sendPreview: a transport failure is said only while the definition is the one the preview was sent under (the gate's memory fix). @type {[string, string]} */
const R4_EDIT_GUARD_FAILURE = ["} catch (error) {\n      of.previewFailure = failureText(error);\n    }", "} catch (error) {\n      if (JSON.stringify(current?.schema) === definition) of.previewFailure = failureText(error);\n    }"];

/**
 * The Device page with a settings form that keeps the three parts of the
 * definition rule (note §3): the control of gate note2 M2, and the form the
 * gate's deletion mutant starts from (r5a B). Its book sends the edits that
 * remain again under a newer draft number (pixdcon changes nothing for a
 * draft it has seen), and each edit keeps its own draft: a Save that was
 * under way still acknowledges the edit it submitted.
 *
 * @param {string} [stale] what the form does with a rejection an earlier definition gave, where the rule does nothing (a mutant's statement)
 */
async function r4DefinitionRuleForm(stale = "") {
  const book = await r4Mutant("view/drafts.js", [
    [
      "    /** Revert: nothing typed is kept. The page's draft number keeps rising. */",
      "    again() {\n      draft = ++pageDraft;\n      for (const edit of edits.values())\n        if (edit.refused) {\n          delete edit.error;\n          delete edit.refused;\n        }\n    },\n    /** Revert: nothing typed is kept. The page's draft number keeps rising. */",
    ],
  ]);
  return r4DeviceWithForm(
    [
      R4_EDIT_SENT_UNDER,
      R4_EDIT_GUARD_FAILURE,
      // What pixdcon refused belongs to the definition it judged by: an answer of an earlier definition marks nothing.
      ["of.book.rejected(plan.sent, answer.body?.rejected);", `if (JSON.stringify(current?.schema) === definition) of.book.rejected(plan.sent, answer.body?.rejected);${stale ? `\n      else ${stale}` : ""}`],
      // A newer definition: what pixdcon said about the edits that remain is dropped at once, and they are sent again.
      [
        'current = settingsState;\n        phase = "ready";',
        'const before = current?.schema ? JSON.stringify(current.schema) : null;\n        current = settingsState;\n        phase = "ready";\n        if (before !== null && before !== JSON.stringify(current.schema) && scope.book.edits.size > 0) {\n          /** @type {any} */ (scope.book).again();\n          scope.previewFailure = null;\n          report();\n          preview();\n        }',
      ],
    ],
    { "../view/drafts.js": book },
  );
}

test("r4 harness self-test: Save's acknowledgement suppressed when the scene definition changed during the Save is caught (gate note2 M1)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const device = await r4DeviceWithForm([
    ["const plan = mine.book.saveBody(session());\n    if (!plan) return;", "const plan = mine.book.saveBody(session());\n    if (!plan) return;\n    const definition = JSON.stringify(current?.schema);"],
    ["done: (answer) => {\n          // What was saved", "done: (answer) => {\n          if (JSON.stringify(current?.schema) !== definition) return null;\n          // What was saved"],
  ]);
  const kind = r4KindOf("settings save");
  const differences = await r4Case(t, kind, "schema", "success", { modules: { device } });
  // n stays an unsaved edit, the next Save would send it again, and "Saved to config.json" is not said: none of these
  // pieces depends on the scene definition. They are compared because a commuted story is compared in every piece.
  const pieces = differences.filter((d) => /the story with the change after the end reads/.test(d));
  for (const piece of [/row marker of n \[draft, membership, schema, scene\]: "previewing".*reads "saved/, /edits the next Save sends \[draft, membership, schema, scene\]: "n".*reads "none"/, /settings status line .*reads "Saved to config\.json"/])
    assert.ok(pieces.some((d) => piece.test(d)), `the harness reports ${piece}:\n${differences.join("\n")}`);
  // The same story with the real form passes: pixdcon wrote what was submitted, and the form says so.
  assert.deepEqual(await r4Case(t, kind, "schema", "success"), []);
});

test("r4 harness self-test: a fix that guards only transport failures against a changed scene definition is caught, and a form that also binds the rejection to its definition and sends the remaining edits again passes every schema case of the settings form (gate note2 M2)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** Every case of the change `schema` of the settings form's kinds, with a form: the names of those that fail. @param {any} device */
  const failing = async (device) => {
    /** @type {string[]} */
    const names = [];
    for (const kind of R4_KINDS.filter((k) => k.name.startsWith("settings ") && !r4Unreachable(k, "schema")))
      for (const end of r4Ends(kind)) if ((await r4Case(t, kind, "schema", end, { modules: { device } })).length) names.push(`${kind.name} × schema × ${end}`);
    return names;
  };
  // The gate's memory fix: the old preview's transport failure is not said in the form of the new definition.
  const partial = await r4DeviceWithForm([R4_EDIT_SENT_UNDER, R4_EDIT_GUARD_FAILURE]);
  const rejected = r4KindOf("settings preview rejected");
  // It does what it was made for: with the old preview failing in transport, nothing of it is said (the real form says it: R4_KNOWN).
  const transport = await r4Case(t, r4KindOf("settings preview"), "schema", "500", { modules: { device: partial } });
  assert.ok(!transport.some((d) => /preview feedback|Not previewed/.test(d)), `the fix takes the old transport failure off the new form:\n${transport.join("\n")}`);
  assert.ok((await r4Case(t, r4KindOf("settings preview"), "schema", "500")).some((d) => /preview feedback/.test(d)), "the real form says the old transport failure");
  // But the old definition's 200 answer still marks n in the form of the new definition, with the old reason.
  const stale = await r4Case(t, rejected, "schema", "success", { modules: { device: partial } });
  assert.ok(stale.some((d) => /^after the end: row n says "pixdcon refused this value: above the maximum of 1" about 2: a reason of an earlier scene definition/.test(d)), `the harness reports the old definition's rejection:\n${stale.join("\n")}`);
  const withPartial = await failing(partial);
  assert.ok(withPartial.includes("settings preview rejected × schema × success"), "the fix does not make all schema cases pass");
  // A form that keeps the three parts of the rule for a definition (note §3) passes all of them: the checks can be met.
  const whole = await r4DefinitionRuleForm();
  assert.deepEqual(await failing(whole), [], "a form that binds field rejection to its definition and revalidates the edits that remain passes every schema case of the settings form's kinds");
  t_log(`r4 self-test (gate note2 M2): with the transport-only fix these schema cases still fail: ${withPartial.join("; ")}`);
});

test("r4 harness self-test: an outcome dropped because the person typed in another form meanwhile is caught (r3, with gate note2 M1)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Save's acknowledgement suppressed when the focus is no longer where it was when Save was clicked: a guard on an
  // identity (another editor's) that Save's effects do not depend on.
  const device = await r4DeviceWithForm([
    ["const plan = mine.book.saveBody(session());\n    if (!plan) return;", "const plan = mine.book.saveBody(session());\n    if (!plan) return;\n    const focused = document.activeElement;"],
    ["done: (answer) => {\n          // What was saved", "done: (answer) => {\n          if (document.activeElement !== focused) return null;\n          // What was saved"],
  ]);
  const kind = r4KindOf("settings save");
  const differences = await r4Case(t, kind, "type", "success", { modules: { device } });
  for (const piece of [/row marker of n \[draft, membership, schema, scene\]: "previewing".*the story with the change after the end reads "saved/, /settings status line .*the story with the change after the end reads "Saved to config\.json"/])
    assert.ok(differences.some((d) => piece.test(d)), `the harness reports ${piece}:\n${differences.join("\n")}`);
  // The rule's own comparison (the pieces of the typed form, against the story without the Save) does not see it.
  assert.ok(!differences.some((d) => /the story without the old operation/.test(d)), differences.join("\n"));
  // The real form passes: what is typed into the Create copy form takes no outcome away.
  assert.deepEqual(await r4Case(t, kind, "type", "success"), []);
});

test("r4 harness self-test: field rejection given Save's projection (config membership) is caught (gate note2 M2)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const kind = r4KindOf("settings preview rejected");
  const apply = "of.book.rejected(plan.sent, answer.body?.rejected);";
  // Bound to config membership, as Save's acknowledgement is: a device that turned blob-only while the preview was out
  // loses pixdcon's verdict on n for good (no other preview follows), though it previews like any other device.
  const device = await r4DeviceWithForm([
    [R4_EDIT_SENT_UNDER[0], `${R4_EDIT_SENT_UNDER[0]}\n    const member = Boolean(context.overlayOnly);`],
    [apply, `if (Boolean(context.overlayOnly) === member) ${apply}`],
  ]);
  const differences = await r4Case(t, kind, "membership", "success", { modules: { device } });
  assert.ok(differences.some((d) => /refusal of n .*: "none" — the story with the change after the end reads "pixdcon refused this value: above the maximum of 1"/.test(d)), `the harness reports the verdict on n that was dropped:\n${differences.join("\n")}`);
  // The real form keeps the verdict. So it does when another field is edited meanwhile: the verdict is on the edit of n that was sent.
  assert.deepEqual(await r4Case(t, kind, "membership", "success"), []);
  assert.deepEqual(await r4Case(t, kind, "other field", "success"), []);
});

test("r4 harness self-test: a Health page that asks again in a new run but keeps the opening's epoch guard on the answer is caught; one that takes the answer passes (gate note2 M3)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** Health asks for the log again when the store holds a new run. @type {[string, string]} */
  const reload = [
    "unsubscribe = subscribe((state) => state, render);\n    loadLog();",
    "r4Opened = getState().epoch;\n    let r4Seen = r4Opened;\n    unsubscribe = subscribe((state) => state, (state) => {\n      if (state.epoch !== r4Seen) {\n        r4Seen = state.epoch;\n        loadLog();\n      }\n      render(state);\n    });\n    loadLog();",
  ];
  /** @type {[string, string]} */
  const opened = ['let copied = "";', 'let copied = "";\n/** @type {string|null} */\nlet r4Opened = null;'];
  // The gate's mutant: the replacement GET is sent, and its answer is dropped by the epoch the page was opened in.
  const mutant = (
    await import(
      await r4Mutant("pages/health.js", [
        opened,
        reload,
        [
          'followOp("log", async () => applyAnswer(await request("GET", "/api/v2/log", { resource: "log" })), {',
          'followOp("log", async () => {\n    const answer = await request("GET", "/api/v2/log", { resource: "log" });\n    if (getState().epoch !== r4Opened) return;\n    applyAnswer(answer);\n  }, {',
        ],
      ])
    )
  ).page;
  const kind = r4KindOf("health log");
  for (const end of R4_ENDS) {
    const differences = await r4Case(t, kind, "epoch", end, { modules: { health: mutant } });
    assert.ok(!differences.some((d) => /no replacement load/.test(d)), `× ${end}: the mutant sends the replacement load, so the check of the request alone passes:\n${differences.join("\n")}`);
    assert.ok(differences.some((d) => /the log pane does not show the lines of the run pixdcon is in .*though a load of that run was answered with them/.test(d)), `× ${end}: the harness reports that the new run's lines did not reach the pane:\n${differences.join("\n")}`);
  }
  // A page that asks again and takes the answer (the store's fence decides) passes: the check can be met.
  const fixed = (await import(await r4Mutant("pages/health.js", [opened, reload]))).page;
  for (const end of R4_ENDS) assert.deepEqual(await r4Case(t, kind, "epoch", end, { modules: { health: fixed } }), [], `health log × epoch × ${end} with a page that asks again and takes the answer`);
  // And a line of an earlier run in the pane is reported: a page that keeps the lines of its last answer and shows them while the store holds none.
  const keeping = (
    await import(
      await r4Mutant("pages/health.js", [
        ['let copied = "";', 'let copied = "";\n/** @type {any[]} */\nlet r4Kept = [];'],
        [
          'followOp("log", async () => applyAnswer(await request("GET", "/api/v2/log", { resource: "log" })), {',
          'followOp("log", async () => {\n    const answer = await request("GET", "/api/v2/log", { resource: "log" });\n    r4Kept = Array.isArray(answer.body) ? answer.body : [];\n    applyAnswer(answer);\n  }, {',
        ],
        ["const lines = state.log.filter(", "const lines = (state.log.length ? state.log : r4Kept).filter("],
      ])
    )
  ).page;
  const old = await r4Case(t, kind, "epoch", "success", { modules: { health: keeping } });
  assert.ok(old.some((d) => /the log pane shows a line of an earlier run: \[pixdcon\] line 1 of run 1/.test(d)), `the harness reports the old run's line in the pane:\n${old.join("\n")}`);
});

// --- r4: the mutants of the gate on harness r3 (findings-r5a, A to E), each caught, each beside a control that passes ---

test("r4 harness self-test: a preview failure written to the scene the form shows now, with opening, run and life checked and the scene not, is caught; the real form passes (gate r5a A)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The gate's mutant: the failure of a preview goes to the scope the form shows, while the opening, the run and the
  // device's life are the ones the preview was sent in. The scene is not asked.
  const device = await r4DeviceWithForm([
    [
      "} catch (error) {\n      of.previewFailure = failureText(error);\n    }\n    if (!shown(of)) return;",
      "} catch (error) {\n      if (!destroyed && scope.epoch === of.epoch && scope.incarnation === of.incarnation) scope.previewFailure = failureText(error);\n    }\n    if (destroyed || scope.epoch !== of.epoch || scope.incarnation !== of.incarnation) return;",
    ],
  ]);
  const kind = r4KindOf("settings preview");
  // Clock's preview is held, the display shows Weather, Weather's n is edited to 9, then Clock's preview fails, or runs out of time.
  for (const end of /** @type {R4End[]} */ (["500", "timeout"])) {
    const differences = await r4Case(t, kind, "scene", end, { modules: { device } });
    for (const piece of [
      /after the end, device: preview feedback \[opening, epoch, life, scene, draft, schema\]: "title says it · marker says it" — the story without the old operation reads "title - · marker -"/,
      /after the end, device: row marker of n \[opening, epoch, life, scene, draft, schema\]: "not previewed" — the story without the old operation reads "previewing"/,
      /device: settings status line .*: "Not previewed: .*the old operation's end changed it/,
    ])
      assert.ok(differences.some((d) => piece.test(d)), `× ${end}: the harness reports ${piece}:\n${differences.join("\n")}`);
    // The real form passes: Clock's failure stays with Clock's scope.
    assert.deepEqual(await r4Case(t, kind, "scene", end), [], `settings preview × scene × ${end} with the real form`);
  }
  // No change that r3 had sees the mutant: with the page opened again it reports what the real form reports.
  assert.deepEqual(await r4Case(t, kind, "reopen", "500", { modules: { device } }), await r4Case(t, kind, "reopen", "500"));
  // Every scene has data of its own: Weather's rows are not Clock's.
  const shown = await r4Run(t, kind, "scene", "success", "case");
  const [clock, weather] = [(await r4Run(t, kind, "reopen", "success", "case")).points[R4_LAST], shown.points[R4_LAST]].map((point) => point.get("device: scene definition shown")?.value);
  assert.match(String(weather), /^Settings · Weather \| n: N of Weather0 – 99; m: M of Weather$/);
  assert.match(String(clock), /^Settings · Clock \| n: N0 – 50; m: M$/);
  assert.equal(shown.points[R4_LAST].get("device: field n")?.value, "9", "Weather's edit");
  assert.equal(shown.points[R4_LAST].get("device: field m")?.value, "8", "Weather's saved value, kept for the device and the scene");
});

test("r4 harness self-test: a stale rejection that deletes the edit it was sent for is caught: the story's edit is gone, and the next Save does not send it; the form of the definition rule passes (gate r5a B)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The gate's mutant starts from the form that passes every schema case (the control of note2 M2). Its branch for a
  // rejection that an earlier definition gave deletes the edit that was sent, where the rule marks nothing.
  const mutant = await r4DefinitionRuleForm("for (const key of Object.keys(answer.body?.rejected ?? {})) if (of.book.edits.get(key)?.draft === plan.sent.get(key)) of.book.edits.delete(key);");
  const kind = r4KindOf("settings preview rejected");
  const differences = await r4Case(t, kind, "schema", "success", { modules: { device: mutant } });
  for (const piece of [
    // From the story's own edits, not from what the form still claims: n = 2 was typed and neither saved nor reverted.
    /after everything was answered: the edit n = 2 of the story \(neither saved nor reverted, its scope and opening still shown\) is gone: its field reads 1/,
    // The request of the next Save: the form offers none, and says no reason.
    /the next Save: the form does not offer Save and says no reason, though the story's edits \{"n":2\} are still to be saved/,
    // The pending bookkeeping is compared across the change of definition.
    /device: row marker of n \[draft, membership, schema, scene\]: "default" — the story without the old operation reads "previewing"/,
    /device: edits the next Save sends \[draft, membership, schema, scene\]: "none" — the story without the old operation reads "n"/,
    /the next Save \[draft, membership, schema, scene\]: "Save is not offered" — the story without the old operation sends "set \{"n":2\} · reset \[\]"/,
  ])
    assert.ok(differences.some((d) => piece.test(d)), `the harness reports ${piece}:\n${differences.join("\n")}`);
  // The revalidation alone does not see it (r3 reported []): it reads only the edits the form still shows.
  assert.ok(!differences.some((d) => /scene definition \(|not revalidated|not sent again/.test(d)), differences.join("\n"));
  // The control: the same form without the deletion keeps the edit, and the next Save sends it.
  const control = await r4DefinitionRuleForm();
  assert.deepEqual(await r4Case(t, kind, "schema", "success", { modules: { device: control } }), []);
  const kept = await r4Run(t, kind, "schema", "success", "case", { device: control });
  assert.equal(kept.nextSave, 'set {"n":2} · reset []', "with the control the next Save's request carries n = 2");
});

test("r4 harness self-test: an old answer that fills Raw's editor for a moment while the replacement load is out is caught, though the replacement repairs it; a page that drops the old answer passes (gate r5a C)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** A load belongs to the run it was sent in. @type {[string, string]} */
  const base = ["function load(base = { opened, revision }, tries = 0) {", "function load(base = { opened, revision, epoch: getState().epoch }, tries = 0) {"];
  /** A failure of a load of an earlier run says nothing. @type {[string, string]} */
  const failed = ["failed: () => {\n        if (base.opened !== opened || !root) return;\n        loading = false;", "failed: () => {\n        if (base.opened !== opened || !root || /** @type {any} */ (base).epoch !== getState().epoch) return;\n        loading = false;"];
  const done = "if (base.opened !== opened || !root) return;\n        if (decision.action === \"apply\") {";
  // The control: the answer of a load of an earlier run changes nothing.
  const control = (await import(await r4Mutant("pages/config-raw.js", [base, failed, [done, done.replace("|| !root)", "|| !root || /** @type {any} */ (base).epoch !== getState().epoch)")]]))).page;
  const unguarded = await r4Mutant("ops.js", R4_B1A_OLD_EPOCH_GUARD_REMOVALS);
  // The gate's mutant: Raw loads again in the new run, each run's load has a slot of its own, and the 200 answer of the
  // old run's load is let into the editor. The replacement's answer repairs it later.
  const mutant = (
    await import(
      await r4Mutant("pages/config-raw.js", [
        base,
        failed,
        ['"raw-load",\n    async () => {', "`raw-load:${/** @type {any} */ (base).epoch}`,\n    async () => {"],
        [done, done.replace('decision.action === "apply")', 'decision.action === "apply" || /** @type {any} */ (base).epoch !== getState().epoch)')],
      ], { "../ops.js": unguarded })
    )
  ).page;
  const kind = r4KindOf("raw load");
  const differences = await r4Case(t, kind, "epoch", "success", { modules: { raw: mutant } });
  for (const piece of [
    /after the end, raw: editor text \[opening, revision, epoch, resource\]: "\{"devices": \[\], "run": "run 1"\}" — it read "" before the old operation ended, and what replaced it \(GET \/api\/v2\/config\/raw\) was still out: the old operation's end changed it/,
    /after the end, raw: load and validity state \[opening, revision, epoch, token, resource\]: "Valid · .*" — it read "Loading config\.json…" before the old operation ended, and what replaced it/,
  ])
    assert.ok(differences.some((d) => piece.test(d)), `the harness reports ${piece}:\n${differences.join("\n")}`);
  // Nothing else reports it: where everything was answered the editor holds the new run's text (r3 passed this mutant).
  assert.deepEqual(differences.filter((d) => !/the old operation's end changed it$/.test(d)), [], "the comparison at the end and the absolute checks pass with the mutant");
  // The ends without an answer of pixdcon's own bring no text: the mutant passes them.
  for (const end of /** @type {R4End[]} */ (["500", "timeout"])) assert.deepEqual(await r4Case(t, kind, "epoch", end, { modules: { raw: mutant } }), [], `raw load × epoch × ${end} with the mutant`);
  // The control passes all three ends, with the replacement load still out when the old answer comes.
  for (const end of R4_ENDS) assert.deepEqual(await r4Case(t, kind, "epoch", end, { modules: { raw: control } }), [], `raw load × epoch × ${end} with a page that drops the old run's answer`);
  assert.equal((await r4Run(t, kind, "epoch", "success", "case", { raw: control })).replacing, "GET /api/v2/config/raw", "the old answer was delivered while the replacement load was still out");
});

test("r4 harness self-test: no longer reachable: the page-local old Raw answer mutant cannot cross central ownership (gate r5a C)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** A load belongs to the run it was sent in. @type {[string, string]} */
  const base = ["function load(base = { opened, revision }, tries = 0) {", "function load(base = { opened, revision, epoch: getState().epoch }, tries = 0) {"];
  /** Raw loads again when the store holds a new run. @type {[string, string]} */
  const reload = [
    "unsubscribe = subscribe((state) => state, render);\n    load();",
    "let r4Seen = getState().epoch;\n    unsubscribe = subscribe((state) => state, (state) => {\n      if (state.epoch !== r4Seen) {\n        r4Seen = state.epoch;\n        load();\n      }\n      render(state);\n    });\n    load();",
  ];
  /** A failure of a load of an earlier run says nothing. @type {[string, string]} */
  const failed = ["failed: () => {\n        if (base.opened !== opened || !root) return;\n        loading = false;", "failed: () => {\n        if (base.opened !== opened || !root || /** @type {any} */ (base).epoch !== getState().epoch) return;\n        loading = false;"];
  const done = "if (base.opened !== opened || !root) return;\n        if (decision.action === \"apply\") {";
  // The gate's mutant: Raw loads again in the new run, each run's load has a slot of its own, and the 200 answer of the
  // old run's load is let into the editor. The replacement's answer repairs it later.
  const mutant = (
    await import(
      await r4Mutant("pages/config-raw.js", [
        base,
        reload,
        failed,
        ['"raw-load",\n    async () => {', "`raw-load:${/** @type {any} */ (base).epoch}`,\n    async () => {"],
        [done, done.replace('decision.action === "apply")', 'decision.action === "apply" || /** @type {any} */ (base).epoch !== getState().epoch)')],
      ])
    )
  ).page;
  const kind = r4KindOf("raw load");
  // Original A5 recipe above, including its extra replacement subscription.
  // That duplicate subscription can still interfere with its final loading
  // state; the obsolete stale-write path is checked directly, before any
  // replacement answer repairs it. The retargeted test checks final state.
  for (const end of R4_ENDS) {
    const made = await r4Run(t, kind, "epoch", end, "case", { raw: mutant });
    assert.equal(made.replacing, "GET /api/v2/config/raw", "the original mutant's replacement is still out");
    assert.equal(made.points[0].get("raw: editor text")?.value, "");
    assert.match(made.points[0].get("raw: load and validity state")?.value ?? "", /Loading config/);
    for (const at of [1, 2])
      for (const name of ["raw: editor text", "raw: load and validity state"])
        assert.equal(made.points[at].get(name)?.value, made.points[0].get(name)?.value, `no longer reachable: ${name} cannot change at the old Raw answer (${end}, point ${at})`);
  }
});

test("r4 harness self-test: an old rejection that brings back the edit a Save committed meanwhile is caught; the real form passes (gate r5a D)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The gate's mutant: a rejection whose edit no longer exists makes the edit again, and marks it.
  const apply = "of.book.rejected(plan.sent, answer.body?.rejected);";
  const device = await r4DeviceWithForm([
    [apply, `for (const key of Object.keys(answer.body?.rejected ?? {})) if (!of.book.edits.has(key) && plan.sent.has(key)) of.book.edits.set(key, { raw: String(plan.body.values[key]), value: plan.body.values[key], draft: /** @type {number} */ (plan.sent.get(key)) });\n      ${apply}`],
  ]);
  const kind = r4KindOf("settings preview rejected");
  const story = "a newer draft pixdcon takes, then commit";
  // The rejected preview of n = 2 is held, n is edited to 0, Save commits it, then the old rejection is delivered.
  const differences = await r4Case(t, kind, story, "success", { modules: { device } });
  for (const piece of [
    /after the end, device: refusal of n \[opening, epoch, life, scene, schema, draft\]: "pixdcon refused this value: above the maximum of 1" — the story without the old operation reads "none"/,
    /after the end, device: settings status line .*: "pixdcon refused this value: above the maximum of 1" — the story without the old operation reads "Saved to config\.json"/,
    // The committed edit is back among the edits a Save would send.
    /after everything was answered, device: edits the next Save sends \[draft, membership, schema, scene\]: "n" — the story without the old operation reads "none"/,
  ])
    assert.ok(differences.some((d) => piece.test(d)), `the harness reports ${piece}:\n${differences.join("\n")}`);
  // The real form passes the story, and the story can be made: the commit is a commit.
  assert.deepEqual(await r4Case(t, kind, story, "success"), []);
  const made = await r4Run(t, kind, story, "success", "case");
  assert.ok(made.calls?.some((/** @type {any} */ c) => c.method === "PUT" && c.path.endsWith("/settings/clock") && c.status === 200 && c.body.set.n === 0), "Save of n = 0 was sent and answered with 200");
  // No single change sees the mutant: with a newer draft pixdcon refuses (the matrix's), the edit is still there and nothing is brought back.
  assert.deepEqual(await r4Case(t, kind, "newer draft", "success", { modules: { device } }), []);
});

test("r4 harness self-test: a slider cleanup that runs without its condition is caught when the device's new life slides while the first life's request ends; the real page passes (gate r5a E)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The gate's mutant: the end of a control's request forgets the slider's level, whoever owns the slider now.
  const device = (await import(await r4Mutant("pages/device.js", [["if (sliding?.key === key) sliding = null;", "sliding = null;"]]))).page;
  // In a new epoch, remove central token/epoch admission as well as the old
  // page-local cleanup condition. The reincarnation recipe remains unchanged.
  const epochDevice = (await import(await r4Mutant("pages/device.js", [["if (sliding?.key === key) sliding = null;", "sliding = null;"]], {
    "../ops.js": await r4Mutant("ops.js", R4_B1A_OLD_EPOCH_GUARD_REMOVALS),
  }))).page;
  const kind = r4KindOf("device brightness range");
  // Life 1 sends 40 %, the device is re-added, life 2 sends 60 % and its request stays out, then life 1's request ends.
  for (const [story, own] of /** @type {Array<[string, string]>} */ ([["reincarnate, then the new owner slides", "35"], ["epoch, then the new owner slides", "32"]]))
    for (const end of R4_ENDS) {
      const differences = await r4Case(t, kind, story, end, { modules: { device: story.startsWith("epoch") ? epochDevice : device } });
      // A request that ends well runs its cleanup before the slot is written, so the level shows at once; one that fails
      // or runs out of time runs it after, so it shows at the next render.
      const piece = `after the end${end === "success" ? "" : ", at the next render"}, device: brightness [epoch, life, owner, token]: "${own} [disabled] | ${own} % | xx" — the story without the old operation reads "60 [disabled] | 60 % | xx"`;
      assert.ok(differences.some((d) => d.includes(piece)), `${story} × ${end}: the harness reports the new owner's slider put back to the stored ${own} % while its own request runs:\n${differences.join("\n")}`);
      // The real page passes: the cleanup asks whether the slider is still the ended request's.
      assert.deepEqual(await r4Case(t, kind, story, end), [], `${story} × ${end} with the real page`);
    }
  // No single change sees the mutant (the gate: the failing set stays as it is).
  for (const change of ["reincarnate", "epoch", "reopen"]) assert.deepEqual(await r4Case(t, kind, change, "success", { modules: { device } }), await r4Case(t, kind, change, "success"), `device brightness range × ${change} × success`);
  // The device's lives and runs hold levels of their own: 30 in the first life of the first run, 35 in its second life, 32 in the next run.
  const world = r4World(r4d1({ override: 30 }));
  world.epochs.push("e-a", "e-b");
  assert.deepEqual([r4View(world, "d1", "e-a", 1, 1), r4View(world, "d1", "e-a", 2, 1), r4View(world, "d1", "e-b", 1, 1)].map((v) => v.desired.brightness.override), [30, 35, 32]);
});

test("r4 harness self-test: no longer reachable: the page-local slider cleanup mutant cannot cross epoch ownership (gate r5a E)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Original A5 mutant. Its life-change defect is still tested above; only
  // its old-epoch path is now unreachable behind central admission.
  const device = (await import(await r4Mutant("pages/device.js", [["if (sliding?.key === key) sliding = null;", "sliding = null;"]]))).page;
  for (const end of R4_ENDS)
    assert.deepEqual(await r4Case(t, r4KindOf("device brightness range"), "epoch, then the new owner slides", end, { modules: { device } }), [], `no longer reachable: old slider cleanup cannot reset its successor (${end})`);
});

/** Browser-owned APIs used by the remaining view, route and render predicates. @param {(browser: any) => Promise<void>} story */
async function r6Browser(story) {
  const global = /** @type {any} */ (globalThis);
  const saved = new Map(["window", "location", "localStorage", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(global, key)]));
  const document = /** @type {any} */ (fakeDocument);
  const documentKeys = ["documentElement", "addEventListener", "removeEventListener", "querySelectorAll"];
  const documentSaved = new Map(documentKeys.map((key) => [key, Object.getOwnPropertyDescriptor(document, key)]));
  const window = /** @type {any} */ (new FakeElement("window"));
  window.scrollTo = () => {};
  const storage = new Map();
  const copies = /** @type {string[]} */ ([]);
  const location = { hash: "#/devices", search: "", replace(/** @type {string} */ value) { this.hash = value; } };
  Object.assign(document, {
    documentElement: makeElement("html"),
    addEventListener: (/** @type {string} */ type, /** @type {any} */ listener) => fakeDocument.body.addEventListener(type, listener),
    removeEventListener: (/** @type {string} */ type, /** @type {any} */ listener) => fakeDocument.body.removeEventListener(type, listener),
    querySelectorAll: (/** @type {string} */ selector) => fakeDocument.body.querySelectorAll(selector),
  });
  Object.assign(global, { window, location, localStorage: { getItem: (/** @type {string} */ key) => storage.get(key) ?? null, setItem: (/** @type {string} */ key, /** @type {string} */ value) => storage.set(key, value), removeItem: (/** @type {string} */ key) => storage.delete(key) } });
  Object.defineProperty(global, "navigator", { configurable: true, value: { clipboard: { writeText: (/** @type {string} */ value) => { copies.push(value); return Promise.resolve(); } } } });
  try { await story({ window, location, storage, copies, document }); }
  finally {
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(global, key, descriptor); else Reflect.deleteProperty(global, key);
    for (const [key, descriptor] of documentSaved) if (descriptor) Object.defineProperty(document, key, descriptor); else Reflect.deleteProperty(document, key);
  }
}

test("r4 harness: guard probe r6: browser theme precedence, saved choices and storage failure", async () => r6Browser(async ({ location, storage, document }) => {
  const theme = await r5Module("theme.js");
  for (const saved of ["system", "light", "dark", "invalid"])
    for (const address of ["", "light", "dark", "invalid"]) {
      storage.set("pixdcon.theme", saved);
      location.search = address ? `?theme=${address}` : "";
      const expected = address === "light" || address === "dark" ? address : saved === "light" || saved === "dark" ? saved : "system";
      assert.equal(theme.currentTheme(), expected);
      assert.equal(theme.savedTheme(), saved === "light" || saved === "dark" ? saved : "system");
      theme.applyTheme();
      assert.equal(document.documentElement.getAttribute("data-theme"), expected === "system" ? null : expected);
    }
  location.search = "";
  for (const value of ["dark", "light", "system"]) { theme.setTheme(value); assert.equal(theme.currentTheme(), value); }
  for (const value of ["semver", "pretty"]) { theme.setVersionDisplay(value); assert.equal(theme.versionDisplay(), value); }
  const local = /** @type {any} */ (globalThis).localStorage;
  local.getItem = () => { throw new Error("storage denied"); };
  assert.equal(theme.savedTheme(), "system");
  assert.equal(theme.versionDisplay(), "pretty");
  local.setItem = local.removeItem = () => { throw new Error("storage denied"); };
  assert.doesNotThrow(() => theme.setTheme("system"));
  assert.doesNotThrow(() => theme.setVersionDisplay("semver"));
}));

test("r4 harness: guard probe r6: route identity, same-route reuse, replacement pages and enlarged callbacks", async () => r6Browser(async ({ location, window }) => {
  const log = /** @type {any[]} */ ([]);
  const global = /** @type {any} */ (globalThis);
  global.__r6Routes = { log, zoom: null };
  const stub = (/** @type {string} */ code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const replace = /** @type {Record<string, string>} */ ({});
  for (const route of ["config", "config-raw", "device", "devices", "health", "overlays"])
    replace[`./pages/${route}.js`] = stub(`export const page={mount(root,params){globalThis.__r6Routes.log.push(['mount',${JSON.stringify(route)},params]);root.innerHTML='<h1>route</h1>';},unmount(){globalThis.__r6Routes.log.push(['unmount',${JSON.stringify(route)}]);}};`);
  replace["./components/enlarged-preview.js"] = stub("export function openEnlargedPreview(name,opener,options){globalThis.__r6Routes.zoom={name,options};return {close(){globalThis.__r6Routes.log.push(['close',name]);options.onClose();}};}");
  const router = await r5Module("router.js", [], replace);
  const examples = [
    ["#/devices", "devices", {}], ["#/devices/a%20b", "device", { name: "a b" }], ["#/devices/d1/recovery", "device", { name: "d1", recovery: "1" }],
    ["#/devices/d2/enlarged", "enlarged", { name: "d2" }], ["#/overlays", "overlays", {}], ["#/config/raw", "config-raw", {}], ["#/config/d1", "config", { open: "d1" }],
    ["#/config", "config", {}], ["#/health", "health", {}], ["#/unknown", "devices", {}], ["#/devices/%zz", "device", { name: "%zz" }], ["#///", "devices", {}],
  ];
  for (const [hash, route, params] of examples) assert.deepEqual(router.parseHash(hash), { route, params, nav: String(route).startsWith("config") ? "config" : route === "device" || route === "enlarged" ? "devices" : route });
  const root = pageRoot();
  const nav = makeElement("a"); nav.setAttribute("data-nav", "devices"); fakeDocument.body.append(nav);
  try {
    const running = router.startRouter(root);
    assert.equal(nav.getAttribute("aria-current"), "page");
    assert.deepEqual(running.current(), { route: "devices", params: {} });
    const before = log.length;
    window.dispatchEvent(new FakeEvent("hashchange"));
    assert.equal(log.length, before, "same route and params reuse the opening");
    for (const hash of ["#/devices/d1", "#/devices/d2", "#/config/d1", "#/health", "#/overlays", "#/config/raw"]) {
      running.go(hash); window.dispatchEvent(new FakeEvent("hashchange"));
      assert.deepEqual(running.current(), { route: router.parseHash(hash).route, params: router.parseHash(hash).params });
      assert.equal(fakeDocument.activeElement, root.querySelector("h1"), "replacement page receives focus");
    }
    running.go("#/devices/d1/enlarged"); window.dispatchEvent(new FakeEvent("hashchange"));
    assert.equal(global.__r6Routes.zoom.name, "d1");
    const zoom = global.__r6Routes.zoom;
    zoom.options.onStep("d2"); assert.equal(location.hash, "#/devices/d2/enlarged");
    window.dispatchEvent(new FakeEvent("hashchange")); assert.equal(global.__r6Routes.zoom, zoom, "enlarged stepping keeps its own opening");
    zoom.options.onClose(); assert.equal(location.hash, "#/config/raw");
    running.go("#/devices/d1/enlarged"); window.dispatchEvent(new FakeEvent("hashchange"));
    running.go("#/health"); window.dispatchEvent(new FakeEvent("hashchange"));
    assert.equal(location.hash, "#/health", "closing for a new route cannot restore the old address");
    assert.equal(nav.hasAttribute("aria-current"), false);
  } finally { root.remove(); nav.remove(); Reflect.deleteProperty(global, "__r6Routes"); }
}));

test("r4 harness: guard probe r6: pixel frame validity, canvas pixels, grid, veil, cache and fit resize", async (t) => r6Browser(async () => {
  const pixel = await r5Module("components/pixel-preview.js");
  const images = /** @type {any[]} */ ([]);
  t.mock.method(/** @type {any} */ (FakeCanvas.prototype), "getContext", () => ({ createImageData: (/** @type {number} */ width, /** @type {number} */ height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }), putImageData: (/** @type {any} */ image) => images.push(image) }));
  for (const scale of [1, 4]) {
    const host = pageRoot();
    const preview = pixel.createPixelPreview(host, { scale, grid: true, size: { width: 2, height: 1 }, veil: 0.6, label: "own frame" });
    try {
      preview.draw(null, { veil: false, reason: "waiting", spinner: false });
      assert.equal(host.querySelector("canvas").hidden, true);
      assert.equal(r4Text(host.querySelector(".pv-empty")), "waiting");
      preview.draw({ width: 2, height: 1, rgb: new Uint8Array(1) }, { veil: false, reason: null });
      assert.equal(r4Text(host.querySelector(".pv-empty")), "bad frame");
      const frame = { width: 2, height: 1, rgb: new Uint8Array([100, 120, 140, 200, 220, 240]) };
      for (const veil of [false, true]) {
        const before = images.length;
        preview.draw(frame, { veil, reason: null });
        const image = images.at(-1);
        assert.deepEqual([image.width, image.height], [2 * scale, scale]);
        assert.deepEqual([...image.data.slice(0, 4)], scale === 1 ? veil ? [40, 48, 56, 255] : [100, 120, 140, 255] : veil ? [6, 7, 8, 255] : [15, 18, 21, 255]);
        assert.equal(host.querySelector(".pv-empty").hidden, true);
        assert.equal(host.querySelector("canvas").hidden, false);
        preview.draw(frame, { veil, reason: null });
        assert.equal(images.length, before + 1, "unchanged frame and render state are cached");
      }
      preview.setGrid(false); preview.draw(frame, { veil: false, reason: null });
      assert.deepEqual([...images.at(-1).data.slice(0, 4)], [100, 120, 140, 255]);
      assert.equal(host.querySelector("canvas").width, 2 * scale);
      assert.equal(host.querySelector("canvas").height, scale);
      if (scale === 4) {
        preview.setGrid(true); preview.draw(frame, { veil: false, reason: null });
        const sample = (/** @type {number} */ x, /** @type {number} */ y) => [...images.at(-1).data.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
        assert.deepEqual(sample(1, 1), [100, 120, 140, 255], "an interior pixel is not a grid line");
        assert.deepEqual(sample(0, 1), [15, 18, 21, 255], "vertical grid edge");
        assert.deepEqual(sample(1, 0), [15, 18, 21, 255], "horizontal grid edge");
        preview.setGrid(false); preview.draw(frame, { veil: false, reason: null });
      }
      const before = images.length;
      preview.setGrid(false); preview.draw(frame, { veil: false, reason: null });
      assert.equal(images.length, before, "unchanged grid does not invalidate the cache");
      preview.resize(); preview.draw(frame, { veil: false, reason: null });
      assert.equal(images.length, before + 1);
      assert.equal(preview.scale(), scale);
      const replacement = { ...frame, rgb: new Uint8Array([25, 50, 75, 125, 150, 175]) };
      const previous = images.length;
      preview.draw(replacement, { veil: false, reason: null });
      assert.equal(images.length, previous + 1, "a different frame owns a new draw even with the same grid, scale and veil");
      assert.deepEqual([...images.at(-1).data.slice(0, 4)], [25, 50, 75, 255], "the current frame's bytes reach its canvas");
    } finally { preview.destroy(); assert.equal(host.children.length, 0); host.remove(); }
  }
  const host = pageRoot(); host.clientWidth = 100; host.clientHeight = 40;
  const preview = pixel.createPixelPreview(host, { scale: "fit", grid: false, size: { width: 2, height: 1 } });
  try {
    assert.equal(preview.scale(), 1, "before the first draw");
    preview.draw(null, { veil: false, reason: "loading", spinner: true });
    assert.equal(preview.scale(), 40);
    host.clientWidth = 1; host.clientHeight = 1; preview.resize(); preview.draw(null, { veil: false, reason: "small" });
    assert.equal(preview.scale(), 1, "fit never scales below one");
    const canvas = host.querySelector("canvas"); canvas.getContext = () => null;
    assert.doesNotThrow(() => preview.draw({ width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) }, { veil: false, reason: null }));
  } finally { preview.destroy(); host.remove(); }
}));

test("r4 harness: guard probe r6: enlarged preview follows device ids, replacement lives, keyboard, resize and close ownership", async () => r6Browser(async ({ window }) => {
  const world = r4World({ devices: [{ name: "d1" }, { name: "d2", o: { scene: "weather", source: "overlay" } }] });
  r4NewEpoch(world);
  const enlarged = await r5Module("components/enlarged-preview.js");
  const opener = pageRoot();
  const steps = /** @type {string[]} */ ([]);
  let closed = 0;
  let preview = enlarged.openEnlargedPreview("d1", opener, { onStep: (/** @type {string} */ name) => steps.push(name), onClose: () => { closed += 1; } });
  try {
    assert.match(r4Text(fakeDocument.body.querySelector(".zoom .pos")), /1 of 2/);
    click(fakeDocument.body.querySelector('.zoom [data-act="next"]'));
    assert.equal(steps.at(-1), "d2");
    assert.match(r4Text(fakeDocument.body.querySelector(".zoom .meta")), /Weather · MQTT overlay/);
    fakeDocument.body.dispatchEvent(new FakeEvent("keydown", { key: "ArrowLeft" }));
    assert.equal(steps.at(-1), "d1");
    fakeDocument.body.dispatchEvent(new FakeEvent("keydown", { key: "ArrowRight" }));
    assert.equal(steps.at(-1), "d2");
    const canvas = fakeDocument.body.querySelector(".zoom canvas");
    world.lives.set("d2", 2); world.rev += 1;
    r4Live(world, "device", r4View(world, "d2", world.epoch, 2, world.rev));
    assert.notEqual(fakeDocument.body.querySelector(".zoom canvas"), canvas, "a replacement life owns a new preview canvas");
    window.dispatchEvent(new FakeEvent("resize"));
    assert.match(r4Text(fakeDocument.body.querySelector(".zoom .pos")), /2 of 2/);
    fakeDocument.body.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    preview.close();
    assert.equal(closed, 1, "close callback belongs to one opening");
    assert.equal(fakeDocument.activeElement, opener);
    assert.equal(fakeDocument.body.querySelector(".zoom"), null);
    for (const mode of ["close", "stage", "double"]) {
      preview = enlarged.openEnlargedPreview("missing", opener);
      assert.match(r4Text(fakeDocument.body.querySelector(".zoom-f")), /no device of this name/);
      if (mode === "close") click(fakeDocument.body.querySelector('.zoom [data-act="close"]'));
      else fakeDocument.body.querySelector(".zoom-stage").dispatchEvent(new FakeEvent(mode === "stage" ? "click" : "dblclick"));
      assert.equal(fakeDocument.body.querySelector(".zoom"), null);
    }
  } finally { preview.close(); opener.remove(); }
}));

test("r4 harness: guard probe r6: field parsing preserves typed enum values, booleans, JSON, time and numeric errors", async () => {
  const form = await r5Module("components/settings-form.js");
  const cases = /** @type {Array<[any, string, any, boolean?]>} */ ([
    [{ type: "boolean" }, "off", { value: true }, true], [{ type: "boolean" }, "on", { value: false }, false],
    [{ type: "int" }, "2.6", { value: 3 }], [{ type: "float" }, "2.6", { value: 2.6 }], [{ type: "int" }, "", { error: "Enter a number." }], [{ type: "float" }, "NaN", { error: "Enter a number." }],
    [{ type: "json" }, '{"a":1}', { value: { a: 1 } }], [{ type: "time" }, " 23:59 ", { value: "23:59" }], [{ type: "time" }, "24:00", { error: "Enter a time as HH:MM, 24-hour." }],
    [{ type: "enum", options: [{ value: 1, label: "one" }, { value: 2, label: "two" }, "three"] }, "2", { value: 2 }],
    [{ type: "enum", options: [1, 2] }, "1", { value: 1 }], [{ type: "enum", options: ["one", "two"] }, "two", { value: "two" }], [{ type: "enum" }, "new", { value: "new" }], [{ type: "text" }, "raw", { value: "raw" }],
  ]);
  for (const [field, raw, expected, checked] of cases) assert.deepEqual(form.parseField(field, raw, checked), expected);
  assert.match(form.parseField({ type: "json" }, "{").error, /Not valid JSON:.*Not previewed or saved/);
  assert.equal(form.showValue({ type: "boolean" }, true), "on");
  assert.equal(form.showValue({ type: "boolean" }, false), "off");
  assert.equal(form.showValue({ type: "json" }, { x: 1 }), '{"x":1}');
  for (const value of [null, undefined]) assert.equal(form.showValue({}, value), "");
  assert.equal(form.showValue({}, 7), "7");
  assert.deepEqual(form.groupsOf({ a: { group: "First" }, b: { group: "Second" }, c: { group: "First" }, d: {} }), [{ group: "First", keys: ["a", "c"] }, { group: "Second", keys: ["b"] }, { group: "General", keys: ["d"] }]);
});

test("r4 harness: guard probe r6: render every settings field type and keep validation local to its edit", async (t) => {
  const module = await r5Module("components/settings-form.js");
  await r5Form(t, module, async ({ world, form, values, root, calls }) => {
    const schema = {
      b: { type: "boolean", default: false, label: "Boolean" }, j: { type: "json", default: { a: 1 }, label: "JSON" },
      t: { type: "time", default: "12:30", label: "Time" }, c: { type: "color", default: "#112233", label: "Color" },
      e: { type: "enum", default: 2, label: "Choice", options: [{ value: 1, label: "First" }, { value: 2, label: "Second" }] },
      s: { type: "string", default: "text", label: "String", description: "own description" }, i: { type: "int", default: 4, label: "Integer", min: 0, max: 10, step: 1 }, f: { type: "float", default: 1.5, label: "Float" },
    };
    world.schemas.set("clock", schema);
    form.update(values("clock"));
    pending(calls, "GET", "/settings/clock").ok(); await settle();
    for (const key of Object.keys(schema)) assert.ok(root.querySelector(`[data-row="${key}"] [data-key="${key}"]`), `schema field ${key} renders`);
    assert.equal(r4Value(root.querySelector('[data-key="j"]')), '{"a":1}');
    assert.equal(r4Value(root.querySelector('[data-key="e"]')), "2");
    assert.equal(form.hasEdits(), false);
    typeInto(root.querySelector('[data-hex="c"]'), "#aabbcc", "change"); await r4AnswerAll({ calls });
    assert.equal(r5Previews(calls).at(-1).body.values.c, "#aabbcc");
    assert.equal(form.hasEdits(), true);
    const boolean = root.querySelector('[data-key="b"]'); boolean.checked = true; boolean.dispatchEvent(new FakeEvent("change"));
    await r4AnswerAll({ calls });
    assert.equal(r5Previews(calls).at(-1).body.values.b, true);
    typeInto(root.querySelector('[data-key="j"]'), "{"); await settle();
    assert.match(r4Text(root.querySelector('[data-row="j"] .jerr')), /Not valid JSON/);
    assert.equal(root.querySelector('[data-act="save"]').disabled, true);
    typeInto(root.querySelector('[data-key="j"]'), '{"a":2}'); await r4AnswerAll({ calls });
    assert.equal(root.querySelector('[data-row="j"] [aria-invalid="true"]'), null);
    assert.equal(root.querySelector('[data-act="save"]').disabled, false);
    typeInto(root.querySelector('[data-key="t"]'), "25:00"); await settle();
    assert.match(r4Text(root.querySelector('[data-row="t"] .ferr')), /HH:MM/);
    assert.equal(root.querySelector('[data-row="j"] [aria-invalid="true"]'), null, "another field's validation cannot mark JSON");
    typeInto(root.querySelector('[data-key="t"]'), "12:31"); await r4AnswerAll({ calls });
    r4Click(root.querySelector('[data-act="save"]')); await settle();
    const saving = pending(calls, "PUT", "/settings/clock");
    saving.answer(200, { .../** @type {any} */ (r4Answer(world, saving)), overlaysNotCleared: ["own-overlay"] }); await settle();
    form.update(values("clock"));
    assert.match(r4Text(root.querySelector(".set-status")), /1 MQTT overlay could not be cleared/);
  }, { ready: false });
});

test("r4 harness: guard probe r6: view helpers select the exact scene, type, device and overlay identity", async () => {
  const model = await r5Module("view/model.js");
  const state = /** @type {any} */ (loadedStore().store.getState());
  state.scenes = [...SCENES, { key: "pixels", name: "pixel scene", pretty_name: "Pixels", deviceType: "pixoo" }, { key: "unnamed", name: "fallback name", pretty_name: "" }];
  state.builtins = { ulanzi: [{ key: "builtin:time", label: "Clock mode" }], pixoo: [{ key: "builtin:time", label: "Pixoo mode" }] };
  for (const key of [null, undefined, ""]) assert.equal(model.sceneName(state, key), "None");
  for (const [key, expected] of [["clock", "Clock"], ["weather", "Weather"], ["pixels", "Pixels"], ["unnamed", "fallback name"], ["unknown", "unknown"], ["builtin:unknown", "unknown"]]) assert.equal(model.sceneName(state, key), expected);
  assert.equal(model.sceneName(state, "builtin:time", "ulanzi"), "Clock mode");
  assert.equal(model.sceneName(state, "builtin:time", "pixoo"), "Pixoo mode");
  assert.equal(model.sceneName(state, "builtin:time"), "Clock mode");
  assert.equal(model.sceneMeta(state, "pixels").key, "pixels");
  assert.equal(model.sceneMeta(state, "missing"), undefined);
  for (const type of ["ulanzi", "pixoo", "other"]) {
    const device = view("owner", { type });
    assert.deepEqual(model.sizeOf({ type }), type === "pixoo" ? { width: 64, height: 64 } : { width: 32, height: 8 });
    assert.deepEqual(model.sizeOf({ size: { width: 3, height: 2 } }), { width: 3, height: 2 });
    assert.equal(model.deviceTitle(device), "owner");
    device.displayName = "Display title"; assert.equal(model.deviceTitle(device), "Display title");
    const choices = model.sceneChoices(state, device);
    const scenes = choices.groups.find((/** @type {any} */ group) => group.label === "Scenes").options;
    assert.equal(scenes.some((/** @type {any} */ option) => option.value === "pixels"), type === "pixoo");
  }
  assert.equal(model.deviceTitle(null), "");
  const d1 = view("d1", { source: "overlay" }); const d2 = view("d2", { source: "overlay", scene: "weather" });
  d1.desired.scene.overlayId = "oa"; d2.desired.scene.overlayId = "ob";
  state.overlays = [record("ob", "device-scene", { device: "d2", value: "weather" }), record("oa", "device-scene", { device: "d1", value: "clock" })];
  assert.equal(model.showingNow(state, d1).source.topic, state.overlays[1].topic);
  assert.equal(model.showingNow(state, d2).source.topic, state.overlays[0].topic);
  for (const [mode, label] of [["play", "Playing"], ["pause", "Paused"], ["stop", "Stopped"]]) { d1.desired.mode.value = mode; assert.equal(model.modeCell(d1).label, label); }
  for (const level of [0, 37, 100]) { d1.desired.brightness.override = level; assert.equal(model.brightnessCell(d1).big, `${level} %`); assert.equal(model.brightnessCell(d1).meta.text, "Override"); }
  d1.desired.brightness.override = null; d1.effective.lastBrightness = null;
  assert.equal(model.brightnessCell(d1).big, "—");
  d1.effective.lastBrightness = 42; assert.equal(model.brightnessCell(d1).big, "42 %");
});

test("r4 harness: guard probe r6: overlay kind, confirmation, clear authority and replaced-row projection", async () => {
  const model = await r5Module("view/model.js");
  const state = /** @type {any} */ (loadedStore([view("d1"), view("d2", { type: "pixoo" })]).store.getState());
  const kinds = ["device-scene", "device-ip", "device-enabled", "setting", "mode", "brightness", "scene-path", "blob", "unknown"];
  for (const kind of kinds)
    for (const confirmed of [false, true]) {
      const value = kind === "device-enabled" ? false : kind === "brightness" ? 37 : kind === "blob" ? { devices: [{}], scenes: { clock: {} } } : kind === "mode" ? "pause" : kind === "device-scene" ? "clock" : "own value";
      const r = record(`own-${kind}`, kind, { device: "d1", scene: "clock", key: "n", value, confirmed });
      const row = model.overlayRow(state, r);
      assert.equal(row.id, r.id); assert.equal(row.device, "d1"); assert.equal(row.topic, r.topic);
      assert.equal(row.clear.disabled, false, "confirmed and waiting records can both be cleared");
      if (!confirmed && kind !== "device-enabled") assert.match(row.status, /Waiting for the broker/);
      state.mqtt = { ...state.mqtt, state: "offline" };
      assert.equal(model.overlayRow(state, r).clear.disabled, true);
      state.mqtt = { ...state.mqtt, state: "connected" };
      r.valid = false; r.problem = "bad own value"; r.confirmed = true;
      assert.match(model.overlayRow(state, r).status, /Not used/);
      r.valid = true; r.problem = null; r.supersededBy = "ui";
      assert.equal(model.overlayRow(state, r).status, "Replaced by your choice");
      r.supersededBy = null; r.inEffect = false; r.problem = "own problem";
      assert.match(model.overlayRow(state, r).status, /own problem/);
    }
  const a = record("a", "device-scene", { device: "d1", value: "clock" }); const b = record("b", "mode", { device: "d2", value: "stop" }); const c = record("c", "brightness", { device: "d1", value: { value: 42 } });
  state.overlays = [b, c]; state.gone = new Map([["a", { record: a, at: 200 }]]);
  const rows = model.overlayRows(state, { shown: ["a", "b"], since: 100 });
  assert.deepEqual(rows.map((/** @type {any} */ row) => row.id), ["a", "b", "c"]);
  assert.equal(rows[0].clear, null); assert.match(rows[0].cleared, /Cleared/); assert.equal(rows[1].cleared, null);
  assert.deepEqual(model.overlayRows(state, { shown: ["a", "b"], since: 201 }).map((/** @type {any} */ row) => row.id), ["b", "c"]);
  const blob = record("blob", "blob", { value: { devices: [{}, {}], scenes: {} } });
  state.controller = { ...state.controller, blobWriter: { writer: false, reason: "v1_writes" } };
  assert.match(model.overlayRow(state, blob).clear.reason, /v1/);
  state.controller.blobWriter.reason = "never"; assert.match(model.overlayRow(state, blob).clear.reason, /never writes/);
  for (const [mode, expected] of [["pause", "Pause"], ["stop", "Stop"], ["play", "Play"]]) assert.equal(model.overlayRow(state, record("mode", "mode", { value: mode })).value.text, expected);
});

test("r4 harness: guard probe r6: Health filters all warning levels, copies its current pane and keeps scroll ownership", async () => r6Browser(async ({ copies }) => {
  const world = r4World(r4d1()); const calls = r4Server(world); r4NewEpoch(world);
  const health = await r5Module("pages/health.js"); const root = pageRoot(); health.page.mount(root, {});
  try {
    const lines = ["DEBUG", "INFO", "WARN", "ERROR"].map((level, index) => ({ seq: index + 1, at: at("18:42:00"), level, message: `own-${level}` }));
    pending(calls, "GET", "/log").answer(200, lines); await settle();
    for (const line of lines) assert.match(r4Text(root.querySelector(".log")), new RegExp(line.message));
    r4Click(root.querySelector('[data-act="filter"][data-value="warn"]'));
    assert.doesNotMatch(r4Text(root.querySelector(".log")), /own-DEBUG|own-INFO/);
    assert.match(r4Text(root.querySelector(".log")), /own-WARN.*own-ERROR/);
    r4Click(root.querySelector('[data-act="copy-log"]')); assert.equal(copies.at(-1), root.querySelector(".log").textContent);
    assert.match(r4Text(root.querySelector(".copy-log")), /Copied/);
    r4Click(root.querySelector('[data-act="version-display"][data-value="semver"]'));
    assert.match(r4Text(root.querySelector(".kv-px")), /SemVer/);
    r4Click(root.querySelector('[data-act="copy-version"]')); assert.equal(copies.at(-1), r4State().controller.version);
    const pane = root.querySelector(".log"); pane.scrollTop = 0; pane.clientHeight = 10; pane.scrollHeight = 100;
    pane.dispatchEvent(new FakeEvent("scroll"));
    r4Live(world, "log", { seq: 5, at: at("18:42:01"), level: "WARN", message: "later own line" }); await settle();
    assert.equal(pane.scrollTop, 0, "new lines cannot steal a reader's scroll position");
    pane.scrollTop = 90; pane.dispatchEvent(new FakeEvent("scroll"));
    r4Live(world, "log", { seq: 6, at: at("18:42:02"), level: "WARN", message: "latest own line" }); await settle();
    assert.equal(pane.scrollTop, 100, "following at the bottom keeps following");
    r4Click(root.querySelector('[data-act="filter"][data-value="all"]')); assert.match(r4Text(pane), /own-INFO/);
  } finally { health.page.unmount(); root.remove(); await r4AnswerAll({ calls }); }
}));

/**
 * Pure view selections must be insensitive to another owner's resources.
 * Distinct frames, previews, records and values make a wrong selector
 * observable even when the renderer's wording happens to be identical.
 * @param {any} model
 */
function r6ViewOwners(model) {
  for (const type of ["ulanzi", "pixoo"])
    for (const health of ["online", "stale", "offline", "idle", "starting"])
      for (const source of ["config", "ui", "overlay", "blob", "fallback"])
        for (const variant of [0, 1, 2]) {
          const own = view("d1", { type, health, source, scene: variant === 2 ? null : "clock" });
          own.displayName = "Own display";
          own.desired.scene.overlayId = "own-scene";
          own.desired.choice = { scene: "weather", persisted: variant === 0, chosenAt: variant === 1 ? at("17:01:00") : null, notSavedReason: variant === 1 ? "config_invalid" : "storage", overridden: variant === 2 };
          own.health.consecutiveErrors = variant;
          own.health.lastFrameAt = variant === 2 ? null : at("18:42:00");
          own.health.lastContactAt = variant === 2 ? null : at("18:42:01");
          own.effective.nextRetryAt = variant === 1 ? at("18:43:00") : null;
          own.health.lastError = variant === 0 ? null : { message: "Own error" };
          own.health.powerCycles = { count: variant, max: 10 };
          own.facts = { powerCyclePlugTopic: variant === 1 ? "own/plug" : null };
          own.settingOverlayCount = variant;
          const frame = /** @type {any} */ ({ width: 1, height: 1, rgb: new Uint8Array([11, 22, 33]), receivedAt: at("18:42:00") });
          const ownRecords = [record("own-scene", "device-scene", { device: "d1", value: "clock", confirmed: variant === 0 }), record("own-setting", "setting", { device: "d1", scene: "clock", key: "n", value: 42, confirmed: false })];
          const decoy = view("d2", { health: "offline", scene: "weather" });
          const base = /** @type {any} */ (loadedStore([own, decoy]).store.getState());
          const state = { ...base, now: Date.parse(at("18:42:10")), scenes: SCENES, overlays: [...ownRecords, record("decoy", "device-scene", { device: "d2", value: "weather", confirmed: false })], previews: new Map([["d1", frame], ["d2", { ...frame, rgb: new Uint8Array([99, 88, 77]), receivedAt: at("17:00:00") }]]), settings: new Map([["d1/clock", { preview: { draft: 4 }, values: { n: { default: 1, saved: 2, preview: 42 }, m: { default: 3, preview: 4 } } }], ["d2/clock", { preview: { draft: 9 }, values: { n: { default: 91, saved: 92 } } }]]) };
          const other = { ...state, devices: new Map([["d2", { ...decoy, displayName: "Changed decoy" }], ["d1", own]]), overlays: [record("new-decoy", "device-scene", { device: "d2", value: "only the decoy changed", confirmed: false }), ...ownRecords.toReversed()], previews: new Map([["d2", { ...frame, receivedAt: at("16:00:00"), rgb: null }], ["d1", frame]]), settings: new Map([["d2/clock", { values: { n: { preview: 99 } } }], ["d1/clock", state.settings.get("d1/clock")]]) };
          for (const name of ["deviceStatus", "deviceCondition", "showingNow", "sourceLines", "previewCount", "waitingSceneOverlay", "facts", "previewCaption", "previewState", "healthRow"])
            assert.deepEqual(model[name](state, own), model[name](other, own), `${name}: unrelated device, overlay, preview and settings state cannot change d1's projection (${type}/${health}/${source}/${variant})`);
          assert.equal(model.waitingSettingsLine(state, "d1", "clock"), model.waitingSettingsLine(other, "d1", "clock"));
          assert.equal(model.previewCount(state, own), variant === 2 ? 0 : 2, "the current scene's own preview data is retained");
          assert.match(model.waitingSettingsLine(state, "d1", "clock"), /^1 setting overlay/);
          assert.equal(model.waitingSceneOverlay(state, own), variant === 0 ? undefined : `MQTT overlay 'clock' is not confirmed since the reconnect at ${model.reconnectAt(state)} · Overlays`);
          assert.equal(model.healthRow(state, own).name, "d1");
          assert.equal(model.previewState(state, own).frame, frame, "the current owner's frame is selected exactly");
        }
}
test("r4 harness: guard probe r6: every view projection separates current device resources from reordered replacement decoys", async () => r6ViewOwners(await r5Module("view/model.js")));

test("r4 harness: guard probe r6: recovery focus, copy, device type, current life and detached opening", async () => r6Browser(async ({ copies }) => {
  const world = r4World(r4d1()); const calls = r4Server(world); r4NewEpoch(world);
  const module = await r5Module("components/recovery-dialog.js");
  const root = pageRoot(); const opener = makeElement("button"); root.append(opener);
  let dialog = /** @type {any} */ (null);
  try {
    for (const type of ["ulanzi", "pixoo"]) {
      const device = view("d1", { type, health: "stale", epoch: world.epoch });
      device.facts = { powerCyclePlugTopic: type === "pixoo" ? "own/plug" : null };
      device.health.powerCycles = { count: 2, max: 5 };
      dialog = module.openRecoveryDialog(device, opener);
      const scrim = root.querySelector(".scrim");
      assert.match(r4Text(scrim.querySelector("h2")), /stale/);
      const buttons = scrim.querySelectorAll("button"); const first = buttons[0]; const last = buttons.at(-1);
      first.focus(); fakeDocument.body.dispatchEvent(new FakeEvent("keydown", { key: "Tab", shiftKey: true })); assert.equal(fakeDocument.activeElement, last);
      last.focus(); fakeDocument.body.dispatchEvent(new FakeEvent("keydown", { key: "Tab" })); assert.equal(fakeDocument.activeElement, first);
      const copy = scrim.querySelector("[data-copy]");
      if (type === "ulanzi") { assert.ok(copy); click(copy); assert.match(copies.at(-1), /awtrix-rescue/); }
      else assert.match(r4Text(scrim.querySelector(".dlg-b")), /own\/plug/);
      device.health.reason = "scene_error"; device.health.state = "starting"; dialog.update(device);
      assert.match(r4Text(scrim.querySelector(".dlg-b")), /scene fails/);
      assert.doesNotMatch(r4Text(scrim.querySelector(".dlg-b")), /Power-cycle by hand/);
      fakeDocument.body.dispatchEvent(new FakeEvent("keydown", { key: "ArrowRight" })); assert.ok(root.querySelector(".scrim"));
      fakeDocument.body.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
      assert.equal(root.querySelector(".scrim"), null); assert.equal(fakeDocument.activeElement, opener);
      dialog.close(); dialog = null;
    }
    const device = view("d1", { epoch: world.epoch, health: "offline" });
    dialog = module.openRecoveryDialog(device, opener);
    click(root.querySelector('[data-act="retry"]')); await settle();
    const old = pending(calls, "POST", "/retry"); dialog.close();
    dialog = module.openRecoveryDialog({ ...device, name: "d2" }, opener);
    const before = r4Text(root.querySelector(".scrim")); old.answer(500, {}); await settle();
    assert.equal(r4Text(root.querySelector(".scrim")), before, "detached d1's Retry cannot change d2's dialog");
  } finally { dialog?.close(); root.remove(); await r4AnswerAll({ calls }); }
}));

test("r4 harness: guard probe r6: page input and render predicates across MQTT, config errors, scene failures and keyboard choices", async () => r6Browser(async () => {
  for (const page of ["device", "devices", "config", "overlays", "health", "raw"])
    for (const mqtt of ["connected", "offline", "disabled"]) {
      const world = r4World({ devices: [{ name: "d1" }, { name: "d2", o: { health: "offline", type: "pixoo" } }], overlays: () => [record("blob", "blob", { value: { devices: [{ name: "d1" }] } }), record("setting", "setting", { device: "d1", scene: "clock", key: "n", value: 7 })] });
      const calls = r4Server(world); r4NewEpoch(world);
      r4Live(world, "mqtt", { ...r4State().mqtt, state: mqtt });
      r4Live(world, "config", { ...CONFIG_STATE, rev: ++world.rev, valid: false, error: { message: "own config error" }, lastReload: { ok: false, message: "own reload error" } });
      r4Live(world, "scenes", [...SCENES.map((scene) => ({ ...scene, status: scene.key === "clock" ? "error" : "ok", error: "own scene error" })), { ...SCENES[0], key: "extra", pretty_name: "", name: "extra", deviceType: "pixoo" }]);
      const device = r4View(world, "d1", world.epoch, 1, ++world.rev);
      device.health.state = mqtt === "connected" ? "starting" : "offline";
      device.desired.scene.source = "ui"; device.desired.choice = { scene: "clock", persisted: false, notSavedReason: "config_invalid", chosenAt: at("18:00:00") };
      r4Live(world, "device", device);
      const root = pageRoot(); const module = R4_PAGES[page].module(); module.mount(root, page === "device" ? { name: "d1" } : page === "config" ? { open: "d1" } : {});
      try {
        await r4AnswerAll({ calls });
        assert.ok(root.querySelector("h1"), `${page}/${mqtt}: page heading remains mounted`);
        assert.doesNotMatch(r4Text(root), /undefined|\[object Object\]/, `${page}: render data is explicit`);
        if (page === "raw") {
          const editor = root.querySelector("textarea"); typeInto(editor, '{"devices":[],"scenes":{"clock":{}}}');
          assert.match(r4Text(root.querySelector(".edbar .state")), /1 scene/);
          editor.scrollTop = 31; editor.dispatchEvent(new FakeEvent("scroll")); assert.equal(root.querySelector(".gut").scrollTop, 31);
        }
        if (page === "config") {
          const theme = root.querySelector('#theme-seg button[value="dark"]'); assert.ok(theme); click(theme);
          assert.equal(/** @type {any} */ (fakeDocument).documentElement.getAttribute("data-theme"), "dark");
          assert.ok(root.querySelector(".ct-edit"), "mount open=d1 selects that exact row");
        }
        if (page === "device" && mqtt === "connected") {
          for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]) {
            const options = root.querySelectorAll('.opt[role="radio"]');
            const before = calls.length; options.at(-1).dispatchEvent(new FakeEvent("keydown", { key })); await settle();
            const sent = calls.slice(before).find((/** @type {any} */ call) => call.path.endsWith("/scene"));
            assert.ok(sent, `radio ${key} changes the chosen scene`); sent.ok(); await settle();
          }
          const before = calls.length; root.querySelector('.opt[role="radio"]').dispatchEvent(new FakeEvent("keydown", { key: "Escape" })); await settle(); assert.equal(calls.length, before);
          const copy = root.querySelector(".copyf"); typeInto(copy.querySelector('[name="targetKey"]'), "copy-own"); copy.querySelector('[name="replace"]').checked = true; copy.dispatchEvent(new FakeEvent("submit")); await settle();
          pending(calls, "POST", "/copy").answer(200, { scene: { key: "copy-own" }, path: "own/path", backup: "own/backup" }); await settle();
          assert.match(r4Text(root.querySelector(".adv .slot")), /backup/);
        }
      } finally { module.unmount(); root.remove(); await r4AnswerAll({ calls }); }
    }
}));

test("r4 harness: guard probe r6: format boundaries, scenes-answer envelope and empty overlays", async () => r6Browser(async () => {
  const format = await r5Module("format.js");
  assert.equal(format.duration(3_660_000), "1 h 1 min");
  assert.equal(format.frameLabel(null, 0), "no frame yet");
  assert.match(format.frameLabel(at("18:00:00"), Date.parse(at("18:00:05")), { stale: true }), /5 s ago/);
  assert.doesNotMatch(format.frameLabel(at("18:00:00"), 0), /ago/);
  const { store, stream } = loadedStore(); const generation = beginRequest(store.fence(), "scenes");
  const body = { scenes: [{ key: "own-scene" }], builtins: { ulanzi: [{ key: "builtin:own", label: "Own mode" }], pixoo: [] } };
  assert.equal(store.applyAnswer({ resource: "scenes", generation, epoch: A, seq: 20, body }).action, "apply");
  assert.deepEqual(store.getState().scenes, body.scenes); assert.deepEqual(store.getState().builtins, body.builtins);
  assert.equal(store.applyEvent({ type: "ping", epoch: A, seq: 21, stream, data: {} }).action, "apply");
  const world = r4World({ devices: [] }); r4NewEpoch(world);
  const overlays = await r5Module("pages/overlays.js"); const root = pageRoot(); overlays.page.mount(root, {});
  try { assert.match(r4Text(root), /No overlays are stored/); assert.match(r4Text(root), /Scene settings/); }
  finally { overlays.page.unmount(); root.remove(); }
}));

test("r4 harness: guard probe r6: bootstrap API and network errors, top-bar version modes and canonical copy", async (t) => r6Browser(async ({ copies }) => {
  const global = /** @type {any} */ (globalThis);
  const document = /** @type {any} */ (fakeDocument);
  const saved = Object.getOwnPropertyDescriptor(document, "getElementById");
  t.mock.method(globalThis, "setInterval", () => 1);
  try {
    for (const kind of ["api", "network"])
      for (const display of ["pretty", "semver"]) {
        /** @type {Map<string, any>} */
        const nodes = new Map(["app", "version", "overlay-count", "restart", "mqtt-dot", "mqtt-text"].map((id) => [id, makeElement("div")]));
        document.getElementById = (/** @type {string} */ id) => nodes.get(id);
        const errors = /** @type {any[]} */ ([]);
        const paints = /** @type {Array<(state: any) => void>} */ ([]);
        const top = { overlayCount: 2, restart: { shown: true, title: "Own restart reason" }, mqtt: { dot: "bad", text: "Own MQTT status", cls: "bad" } };
        global.__r6Main = { kind, display, errors, paints, top, state: { loaded: false, controller: { version: "261009065314.0.0" }, devices: new Map(), previews: new Map(), epoch: A } };
        const stub = (/** @type {string} */ code) => `data:text/javascript;base64,${Buffer.from(`const b=globalThis.__r6Main;\n${code}\n// ${++r5MainId}`).toString("base64")}`;
        const api = stub('export class ApiError extends Error {} export const request=async()=>{throw b.kind === "api" ? new ApiError("Own API reason") : new Error("network");}; export const requestFrame=async()=>({});');
        await r5Module("main.js", [], {
          "./api.js": api,
          "./store.js": stub('export const getState=()=>b.state, subscribe=(select,paint)=>{b.paints.push(paint);paint(select(b.state));return()=>{};}, setLoadError=(error)=>b.errors.push(error); export const applyAnswer=()=>{}, applyEvent=()=>{}, applyFrameAnswer=()=>{}, fence=()=>({}), setLive=()=>{}, tick=()=>{}, toPreview=()=>null;'),
          "./live.js": stub('export const connectLive=()=>({session:"r6-main"});'), "./router.js": stub('export const startRouter=()=>{};'),
          "./theme.js": stub('export const applyTheme=()=>{}, versionDisplay=()=>b.display;'),
          "./view/model.js": stub('export const header=()=>b.top;'),
          "./session.js": stub('export const setSession=()=>{};'),
        });
        assert.deepEqual(errors.map((error) => error.message), [kind === "api" ? "Own API reason" : "No answer from pixdcon."]);
        assert.equal(nodes.get("version").textContent, display === "pretty" ? "26·10·09 06:53" : "261009065314.0.0");
        click(nodes.get("version")); assert.equal(copies.at(-1), "261009065314.0.0");
        nodes.get("version").removeAttribute("data-canonical"); const count = copies.length; click(nodes.get("version")); assert.equal(copies.length, count);
        assert.equal(nodes.get("overlay-count").textContent, "2"); assert.equal(nodes.get("restart").hidden, false);
        assert.equal(nodes.get("overlay-count").hidden, false);
        assert.equal(nodes.get("restart").title, "Own restart reason");
        assert.equal(nodes.get("mqtt-dot").className, "dot bad");
        assert.equal(nodes.get("mqtt-text").textContent, "Own MQTT status");
        assert.equal(nodes.get("mqtt-text").style.color, "var(--bad)");
        top.overlayCount = 0; top.restart.shown = false; top.mqtt.cls = "";
        paints[0](global.__r6Main.state);
        assert.equal(nodes.get("overlay-count").textContent, ""); assert.equal(nodes.get("overlay-count").hidden, true);
        assert.equal(nodes.get("restart").hidden, true); assert.equal(nodes.get("mqtt-text").style.color, "");
      }
  } finally { Reflect.deleteProperty(global, "__r6Main"); if (saved) Object.defineProperty(document, "getElementById", saved); else Reflect.deleteProperty(document, "getElementById"); }
}));

test("r4 harness: guard probe r6: present and absent first frames retain captured device admission", async (t) => {
  await r5Main(t, [], "frame");
  await r5Main(t, [], "asked");
});

test("r4 harness: guard probe r6: form updates admit only the shown scene, epoch and device life", async (t) => {
  await r5Form(t, await r5Module("components/settings-form.js"), async ({ form, values, world, root, calls }) => {
    const own = values("weather", { effective: { n: 37, m: 38 } });
    form.setScene("weather", "Weather", { epoch: world.epoch, incarnation: 1 });
    form.update(own);
    assert.equal(r4Value(field(root, "n")), "37");
    for (const changed of [{ scene: "clock" }, { epoch: `${world.epoch}-old` }, { incarnation: 2 }]) {
      form.update({ ...values("weather", { effective: { n: 99, m: 98 } }), ...changed });
      assert.equal(r4Value(field(root, "n")), "37", `a foreign settings update cannot enter the shown form: ${JSON.stringify(changed)}`);
    }
    form.update(null);
    assert.equal(r4Value(field(root, "n")), "37", "absence of values cannot replace the current values");
    form.update(values("weather", { effective: { n: 42, m: 43 } }));
    assert.equal(r4Value(field(root, "n")), "42", "the current owner's newer data reaches its form");
    for (const scene of [null, "", "builtin:own"]) {
      const sent = calls.length;
      form.setScene(scene, scene, { epoch: world.epoch, incarnation: 1 });
      form.update(own);
      assert.equal(field(root, "n"), null, "a scene with no settings cannot admit another scene's form");
      await settle();
      assert.equal(calls.length, sent, "none and built-in scenes start no settings request");
      await form.end();
      assert.equal(calls.length, sent, "none and built-in scenes own no preview to end");
    }
  });
});

test("r4 harness: guard probe r6: render fallbacks and authority boundaries have executable domain witnesses", async () => r6Browser(async () => {
  const model = await r5Module("view/model.js");
  const state = /** @type {any} */ (loadedStore([view("d1"), view("d2", { health: "starting" })]).store.getState());
  state.scenes = [...SCENES, { ...SCENES[0], key: "fallback-label", pretty_name: "", name: "Own fallback label" }];
  for (const [status, text] of [["offline", "MQTT offline"], ["connecting", "MQTT connecting"], ["disabled", "MQTT not configured"]]) {
    state.mqtt = { ...state.mqtt, state: status }; assert.equal(model.header(state).mqtt.text, text);
  }
  assert.match(model.devicesSummary(state).text, /1 online/);
  assert.ok(model.sceneChoices(state, state.devices.get("d1")).groups[0].options.some((/** @type {any} */ option) => option.label === "Own fallback label"));
  state.mqtt.state = "connected";
  const own = state.devices.get("d1"); own.desired.enabled = false; own.desired.held = true;
  state.overlays = [record("other", "mode", { device: "d2", value: "pause" })];
  assert.equal(model.heldBy(own, state.overlays).kind, "device");
  own.desired.address.value = null; assert.equal(model.heldBy(own, state.overlays).value, "");
  const held = record("held", "blob", { restricts: "held", value: { devices: [{ name: "d1" }] } });
  state.overlays.push(held); assert.equal(model.heldBy(own, state.overlays), held);
  assert.match(model.deviceCondition(state, own).text, /On hold/);
  own.desired.held = false; assert.equal(model.heldBy(own, state.overlays), null, "the current view's explicit held=false is authoritative");
  delete own.desired.held; own.desired.address.source = "blob"; assert.equal(model.heldBy(own, state.overlays), held);
  state.overlays = []; assert.equal(model.heldBy(own, state.overlays), null);
  own.desired.enabled = true; own.desired.scene.source = "blob"; state.controller.mqttNamespace = null;
  assert.match(model.showingNow(state, own).source.topic, /overlay\/blob/);
  own.desired.scene.source = "config";
  for (const health of ["online", "idle", "unknown"]) { own.health.state = health; own.health.lastFrameAt = null; assert.ok(model.showingNow(state, own).display.text); }
  state.settings.set("d1/clock", { values: { n: { saved: 17, default: 3 }, m: { default: 4 } } });
  for (const [key, expected] of [["n", "instead of the saved 17"], ["m", "instead of the default 4"]]) assert.equal(model.overlayRow(state, record("setting", "setting", { device: "d1", scene: "clock", key, value: 8 })).status, expected);
  for (const kind of ["brightness", "unknown"]) { const r = record("raw", kind); r.raw = "own raw"; assert.equal(model.overlayRow(state, r).value.text, "own raw"); }
  const replay = record("replay", "device-scene", { device: "d1", value: "clock" }); replay.origin = "replay";
  assert.equal(model.overlayRow(state, replay).received.time, "at startup");
  replay.confirmed = false; assert.notEqual(model.overlayRow(state, replay).received.time, "at startup");
  own.desired.output = "shadow";
  assert.equal(model.overlayRow(state, record("mode", "mode", { device: "d1", value: "pause" })).clear.disabled, true);
  assert.equal(model.overlayRow(state, record("setting", "setting", { device: "d1", scene: "clock", key: "n", value: 8 })).clear.disabled, false);
  assert.equal(model.overlayRow(state, record("path", "scene-path", { device: "d1", scene: "clock", value: "own/path" })).clear.disabled, false);

  for (const page of ["config", "device", "devices", "health", "overlays"]) {
    const world = r4World({ devices: [{ name: "d1" }, { name: "d2" }], overlays: () => [record("o1", "mode", { device: "d1", value: "pause" })] });
    const calls = r4Server(world); r4NewEpoch(world);
    r4Live(world, "config", { ...CONFIG_STATE, rev: ++world.rev, valid: true, reload: { ok: false, message: "Own loader failure" } });
    r4Live(world, "scenes", SCENES.map((scene) => ({ ...scene, status: "broken", error: "Own scene failure" })));
    const current = r4View(world, "d1", world.epoch, 1, ++world.rev);
    current.health.state = "starting"; current.effective.lastBrightness = null; current.desired.brightness.override = null; current.settingOverlayCount = 1;
    current.pending = { op: "scene", target: "weather" };
    r4Live(world, "device", current);
    r4Live(world, "mqtt", { state: "connecting", url: null });
    r4Live(world, "controller", { ...r4State().controller, version: null });
    const root = pageRoot(); const module = R4_PAGES[page].module(); module.mount(root, page === "device" ? { name: "d1", recovery: "1" } : {});
    try {
      await r4AnswerAll({ calls });
      if (page === "config") { assert.match(r4Text(root.querySelector(".head .sub")), /Own loader failure/); assert.match(r4Text(root.querySelector(".st-body")), /Own scene failure/); }
      if (page === "device") {
        assert.match(r4Text(root.querySelector(".bri-hint")), /once it runs/);
        assert.match(r4Text(root.querySelector('[data-scene="weather"]')), /switching/);
        current.pending = null; current.desired.scene.source = "overlay"; current.desired.scene.scene = "weather"; current.desired.choice.scene = "clock"; current.rev = ++world.rev;
        r4Live(world, "device", current); assert.match(r4Text(root.querySelector('[data-scene="clock"]')), /your choice/);
        current.desired.scene.scene = "builtin:own"; current.desired.scene.source = "config"; current.rev = ++world.rev;
        r4Live(world, "device", current); assert.match(r4Text(root.querySelector(".scene-below")), /Drawn by the display/);
        current.health.state = "offline"; current.rev = ++world.rev; r4Live(world, "device", current);
        assert.ok(root.querySelector(".scrim"), "requested recovery opens when the device becomes offline");
      }
      if (page === "overlays") {
        r4Live(world, "mqtt", { state: "connected" }); click(root.querySelector('[data-act="clear"]')); await settle();
        pending(calls, "DELETE", "/overlays/o1").answer(200, { pending: true, confirmed: false, overlays: world.spec.overlays(world.epoch) }); await settle();
        assert.match(r4Text(root.querySelector('[data-id="o1"]')?.closest(".ot-row")), /waiting for the broker/, "the row says the current Clear outcome with any correctly owned slot key");
      }
    } finally { module.unmount(); root.remove(); await r4AnswerAll({ calls }); }
  }
}));

test("r4 harness: guard probe r6: cold Devices and Overlays load, error, snapshot and unmounted subscriber", async () => {
  const global = /** @type {any} */ (globalThis);
  try {
    for (const page of ["devices", "overlays"]) {
      const store = createStore(); global.__r6Loading = store;
      const code = `const store=globalThis.__r6Loading; export const getState=store.getState,subscribe=store.subscribe,applyAnswer=store.applyAnswer; // ${++r5MainId}`;
      const module = await r5Module(`pages/${page}.js`, [], { "../store.js": `data:text/javascript;base64,${Buffer.from(code).toString("base64")}` });
      const root = pageRoot(); module.page.mount(root, {});
      try {
        assert.match(r4Text(root.querySelector(".head .sub")), /Loading/);
        store.setLoadError({ message: "Own initial load error", at: Date.now() });
        assert.match(r4Text(root.querySelector(".head .sub")), /No answer from pixdcon since.*retrying every 5 s/);
        const stream = openSource(store.fence(), "stream");
        assert.equal(store.applyEvent({ type: "snapshot", epoch: A, seq: 10, stream, data: snapshot(A, 10, []) }).action, "apply");
        assert.doesNotMatch(r4Text(root.querySelector(".head .sub")), /Loading|No answer from pixdcon/);
        module.page.unmount(); const before = root.innerHTML;
        store.setLive({ state: "lost", lostSince: Date.now(), lastEventAt: null, retryEveryMs: 5000 });
        assert.equal(root.innerHTML, before, "an unmounted subscriber cannot repaint its old root");
      } finally { module.page.unmount(); root.remove(); }
    }
  } finally { Reflect.deleteProperty(global, "__r6Loading"); }
});

/** The real API must open the bootstrap source, not register an ordinary resource request. @param {any} api */
async function r6BootstrapSource(api) {
  const world = r4World(r4d1()); const calls = r4Server(world); r4NewEpoch(world);
  try {
    const first = api.request("GET", "/api/v2/bootstrap", { resource: "bootstrap" }); await settle();
    const call = pending(calls, "GET", "/bootstrap");
    const own = r4View(world, "d1", call.epoch, 1, call.rev); own.displayName = "Current bootstrap data";
    call.answer(200, snapshot(call.epoch, call.seq, [own]));
    assert.equal(applyDefaultAnswer(await first).action, "apply", "a current bootstrap must actually load its data through the real API's source generation");
    assert.equal(r4State().devices.get("d1").displayName, "Current bootstrap data");
    const late = api.request("GET", "/api/v2/bootstrap", { resource: "bootstrap" }); await settle();
    const old = pending(calls, "GET", "/bootstrap");
    const obsolete = snapshot(old.epoch, old.seq, [own]); r4NewEpoch(world);
    const current = r4State().devices.get("d1");
    old.answer(200, obsolete);
    assert.equal(applyDefaultAnswer(await late).action, "drop", "the replacement stream owns the new snapshot");
    assert.equal(r4State().devices.get("d1"), current, "a late bootstrap cannot replace the stream's current device data");
  } finally { await r4AnswerAll({ calls }); }
}
test("r4 harness: guard probe r6: real API bootstrap admits current data and drops a superseded source", async () => r6BootstrapSource(await r5Module("api.js")));
test("r4 guard probe: bootstrap source and ordinary request generations preserve snapshot admission", async () => {
  await r6BootstrapSource(await r5Module("api.js"));
  await r6BootstrapSource(await r5Module("api.js", [['resource === "bootstrap"', 'false']]));
});

test("r4 guard probe: unkeyed transport admission never finds an undefined busy key", async () => {
  const global = /** @type {any} */ (globalThis);
  let observed = 0;
  global.__r6BusyKey = (/** @type {unknown} */ key, /** @type {boolean} */ absentBusy) => {
    assert.equal(absentBusy, false, "the busy set contains only explicitly keyed controls");
    if (key === undefined) observed += 1;
  };
  const api = await r5Module("api.js", [[
    "const { resource, body, key, signal } = options;",
    "const { resource, body, key, signal } = options; globalThis.__r6BusyKey(key, busy.has(undefined));",
  ]]);
  const answers = /** @type {Array<(value: Response) => void>} */ ([]);
  const calls = fakeFetch(() => new Promise((resolve) => answers.push(resolve)));
  const notices = /** @type {any[]} */ ([]);
  const stop = api.onBusy((/** @type {string} */ key, /** @type {boolean} */ busy) => notices.push([key, busy]));
  try {
    const first = api.request("GET", "/r6-unkeyed-1", { resource: "r6-unkeyed" });
    const second = api.request("GET", "/r6-unkeyed-2", { resource: "r6-unkeyed" });
    const keyed = api.request("POST", "/r6-keyed", { resource: "r6-keyed", key: "own-control" });
    await assert.rejects(api.request("POST", "/r6-keyed", { resource: "r6-keyed", key: "own-control" }), (/** @type {any} */ error) => error.code === "busy");
    assert.equal(calls.length, 3, "independent unkeyed work proceeds; a busy keyed control sends no duplicate");
    for (const answer of answers) answer(new Response("{}", { status: 200 }));
    await Promise.all([first, second, keyed]);
    fakeFetch(() => new Response("{}", { status: 200 }));
    await api.request("GET", "/r6-after-cleanup", { resource: "r6-unkeyed" });
    assert.equal(observed, 3);
    assert.deepEqual(notices, [["own-control", true], ["own-control", false]], "unkeyed work has no control outcome to announce");
  } finally { stop(); Reflect.deleteProperty(global, "__r6BusyKey"); }
});

test("r4 harness: guard probe r6: transport envelopes preserve omitted bodies, metadata defaults, frame headers and external cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = await r5Module("api.js");
  for (const extra of [undefined, null]) assert.deepEqual(new api.ApiError("own", { status: 400, code: "own", extra }).extra, {});
  const calls = fakeFetch(() => new Response("{}", { status: 200 }));
  const answer = await api.request("GET", "/r6-envelope", { resource: "r6-envelope" });
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json" });
  assert.equal(calls[0].init.body, undefined); assert.equal(answer.epoch, null); assert.equal(answer.seq, 0);
  await api.request("PUT", "/r6-envelope", { resource: "r6-envelope", body: { own: 7 } });
  assert.equal(calls[1].init.headers["Content-Type"], "application/json"); assert.equal(calls[1].init.body, '{"own":7}');
  for (const [payload, code, message] of [[{ error: "Own reason", code: "own_code", rejected: { n: "own rejection" } }, "own_code", "Own reason."], [{ error: "Already punctuated!", code: 7 }, "http_400", "Already punctuated!"], [null, "http_400", "pixdcon refused the request (400)."]]) {
    fakeFetch(() => new Response(JSON.stringify(payload), { status: 400 }));
    await assert.rejects(api.request("GET", "/r6-envelope", { resource: "r6-envelope" }), (/** @type {any} */ error) => {
      assert.equal(error.code, code); assert.equal(error.message, message);
      if (code === "own_code") assert.deepEqual(error.extra.rejected, { n: "own rejection" });
      return true;
    });
  }
  for (const explicit of [false, true]) {
    const frames = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "X-Frame-Width": "1", "X-Frame-Height": "1", ...(explicit ? { "X-Frame-Source": "display", "X-Frame-Seq": "7" } : {}) } }));
    const frame = await api.requestFrame("a/b");
    assert.match(frames[0].url, /a%2Fb/); assert.equal(frame.frame.source, explicit ? "display" : "runtime"); assert.equal(frame.frame.frameSeq, explicit ? 7 : 0);
  }
  const controller = new AbortController();
  fakeFetch((_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(new Error("aborted"))); }));
  const canceled = assert.rejects(api.request("GET", "/r6-cancel", { resource: "r6-cancel", signal: controller.signal }), (/** @type {any} */ error) => error.code === "aborted");
  controller.abort(); await settle(); t.mock.timers.tick(15_000); await canceled;
});

/** Outcomes of independent end slots cannot appear under another device, run or life. @param {any} module */
async function r6EndOwners(module) {
  for (const key of [...r4State().ops.keys()]) if (key.startsWith("end:")) r4SetOp(key, null);
  const world = r4World({ devices: [{ name: "d1" }, { name: "d2" }] }); const calls = r4Server(world); r4NewEpoch(world);
  const first = r4View(world, "d1", world.epoch, 1, world.rev); const second = r4View(world, "d2", world.epoch, 1, world.rev);
  try {
    module.retryEnd(first, "clock", "s1"); await settle();
    const one = pending(calls, "DELETE", "/d1/settings/clock/preview");
    assert.deepEqual(module.failedEnds(second), [], "d2 owns no part of d1's pending Retry");
    assert.deepEqual(module.failedEnds(first).map((/** @type {any} */ end) => [end.scene, end.busy]), [["clock", true]]);
    module.retryEnd(second, "weather", "s1"); await settle();
    const two = pending(calls, "DELETE", "/d2/settings/weather/preview");
    const ops = await r5Module("ops.js");
    /** @type {any} */ let finishAutomatic;
    const automatic = ops.follow(`end:d1/automatic@${world.epoch}/1`, () => new Promise((resolve) => { finishAutomatic = resolve; }), { value: "end", label: "Ending…" });
    assert.deepEqual(module.failedEnds(first).map((/** @type {any} */ end) => end.scene), ["clock"], "ordinary automatic ends are not pending Retries");
    finishAutomatic(); await automatic; await settle();
    one.answer(500, {}); await settle();
    assert.deepEqual(module.failedEnds(first).map((/** @type {any} */ end) => [end.scene, end.busy]), [["clock", false]]);
    assert.deepEqual(module.failedEnds(second).map((/** @type {any} */ end) => [end.scene, end.busy]), [["weather", true]]);
    assert.deepEqual(module.failedEnds({ ...first, incarnation: 2 }), [], "the replacement life owns no earlier failure");
    module.retryEnd(first, "clock", "s1"); await settle();
    pending(calls, "DELETE", "/d1/settings/clock/preview").ok(); await settle();
    assert.deepEqual(module.failedEnds(first), [], "a completed Retry is no longer busy and has no failure");
    r4NewEpoch(world); const now = r4View(world, "d2", world.epoch, 1, world.rev);
    assert.deepEqual(module.failedEnds(now), [], "the new epoch owns no earlier failure");
    two.answer(500, {}); await settle(); assert.deepEqual(module.failedEnds(now), []);
  } finally { await r4AnswerAll({ calls }); }
}
test("r4 harness: guard probe r6: preview end outcomes separate device, epoch, life and pending Retry", async () => r6EndOwners(await r5Module("components/settings-form.js")));
test("r4 harness self-test: end outcome selectors require both device and life ownership", async () => {
  await r6EndOwners(await r5Module("components/settings-form.js"));
  for (const guard of ["!key.startsWith(prefix)", "!key.endsWith(life)"])
    await assert.rejects(r6EndOwners(await r5Module("components/settings-form.js", [[guard, "false"]])), (/** @type {any} */ error) => error.name === "AssertionError");
});

/** A drop decision must preserve actual resource data, immediately and in subscribers. @param {any} module */
function r6ResourceFences(module) {
  for (const resource of ["controller", "mqtt", "config", "scenes", "overlays"]) {
    const store = module.createStore(); const stream = openSource(store.fence(), "stream");
    const boot = snapshot(A, 10, [view("d1")]);
    assert.equal(store.applyEvent({ type: "snapshot", epoch: A, seq: 10, stream, data: boot }).action, "apply");
    assert.equal(store.getState().loaded, true, "current snapshot data must load, not merely return an apply decision");
    const value = (/** @type {string} */ tag, /** @type {number} */ rev) => resource === "controller" ? { ...boot.controller, version: tag } : resource === "mqtt" ? { ...boot.mqtt, state: tag === "old" ? "connected" : "offline", url: `mqtt://${tag}` } : resource === "config" ? { ...boot.config, rev, path: `${tag}/config.json`, valid: tag === "old" } : resource === "scenes" ? [{ ...SCENES[0], key: `${tag}-scene`, pretty_name: tag }] : [record(`${tag}-overlay`, "mode", { device: "d1", value: tag === "old" ? "play" : "pause" })];
    const body = (/** @type {any} */ data) => resource === "config" ? { state: data } : resource === "scenes" ? { scenes: data } : resource === "overlays" ? { overlays: data } : data;
    const shown = /** @type {any[]} */ ([]); const stop = store.subscribe((/** @type {any} */ state) => state[resource], (/** @type {any} */ data) => shown.push(data));
    try {
      const generation = beginRequest(store.fence(), resource); const fresh = value("current", 30); const old = value("old", 20);
      assert.equal(store.applyEvent({ type: resource, epoch: A, seq: 30, stream, data: fresh }).action, "apply");
      assert.deepEqual(store.getState()[resource], fresh); assert.deepEqual(shown.at(-1), fresh);
      assert.equal(store.applyAnswer({ resource, generation, epoch: A, seq: 20, body: body(old) }).action, "drop");
      assert.deepEqual(store.getState()[resource], fresh, `${resource}: a returned drop must not admit old resource data`);
      assert.deepEqual(shown.at(-1), fresh, `${resource}: the subscriber must not render the dropped data`);
      const first = beginRequest(store.fence(), resource); const replacement = beginRequest(store.fence(), resource);
      assert.equal(store.applyAnswer({ resource, generation: first, epoch: A, seq: 100, body: body(old) }).action, "drop");
      assert.deepEqual(shown.at(-1), fresh, `${resource}: a superseded request cannot transiently publish data`);
      const current = value("replacement", 40);
      assert.equal(store.applyAnswer({ resource, generation: replacement, epoch: A, seq: 40, body: body(current) }).action, "apply");
      assert.deepEqual(store.getState()[resource], current, `${resource}: current replacement data reaches the store`);
      assert.deepEqual(shown.at(-1), current);
      const stale = snapshot(A, 20, [view("d1")]); stale[resource] = old;
      assert.equal(store.applyEvent({ type: "snapshot", epoch: A, seq: 20, stream, data: stale }).action, "drop");
      assert.deepEqual(shown.at(-1), current, `${resource}: a dropped snapshot cannot publish old resource data`);
      const partial = snapshot(A, 35, [view("d1")]); partial[resource] = old;
      assert.equal(store.applyEvent({ type: "snapshot", epoch: A, seq: 35, stream, data: partial }).action, "apply");
      assert.deepEqual(store.getState()[resource], current, `${resource}: the snapshot keeps a newer resource answer`);
    } finally { stop(); }
  }
}
test("r4 harness: guard probe r6: resource fence decisions preserve current data and subscribers across answers and snapshots", async () => r6ResourceFences(await r5Module("store.js")));
test("r4 harness self-test: a returned drop without guarding actual resource writes is caught", async () => {
  r6ResourceFences(await r5Module("store.js"));
  for (const anchor of ['if (decision.action !== "apply") return decision;\n    const next = draft();\n    next.dataAt = Date.now();\n    switch (resource)', 'if (decision.action !== "apply") return decision;\n    /** @type {ClientState} */\n    let next = draft();']) {
    const mutant = await r5Module("store.js", [[anchor, anchor.replace('if (decision.action !== "apply")', 'if ((decision.action !== "apply", false))')]]);
    assert.throws(() => r6ResourceFences(mutant), (/** @type {any} */ error) => error.name === "AssertionError");
  }
});

/** Every cache belongs to the same device life/epoch as its view; unrelated owners survive cleanup. @param {any} module */
function r6StoreOwners(module) {
  const store = module.createStore(); let stream = openSource(store.fence(), "stream");
  const first = view("d1", { incarnation: 1 }); const other = view("d2", { incarnation: 2 });
  store.applyEvent({ type: "snapshot", epoch: A, seq: 10, stream, data: snapshot(A, 10, [first, other], { incarnations: 2 }) });
  const one = sceneSettings("d1", "clock", { epoch: A, incarnation: 1, rev: 5, effective: { n: 2 }, preview: { session: "s1", draft: 2 } });
  const two = sceneSettings("d2", "clock", { epoch: A, incarnation: 2, rev: 5, effective: { n: 8 } });
  assert.equal(store.applyEvent({ type: "settings", epoch: A, seq: 11, stream, data: one }).action, "apply");
  assert.equal(store.applyEvent({ type: "settings", epoch: A, seq: 12, stream, data: two }).action, "apply");
  const frame = (/** @type {number} */ byte) => ({ width: 1, height: 1, rgb: new Uint8Array([byte, byte, byte]), source: "runtime", receivedAt: at("18:42:00"), frameSeq: byte });
  const capture = (/** @type {string} */ device, /** @type {number} */ incarnation) => ({ device, epoch: A, incarnation, generation: beginRequest(store.fence(), `frame:${device}`) });
  const oldFrame = capture("d1", 1);
  assert.equal(store.applyFrameAnswer(oldFrame, null).action, "apply");
  assert.equal(store.getState().previews.has("d1"), false, "204 creates no fictitious cached frame");
  assert.equal(store.applyFrameAnswer(oldFrame, frame(1)).action, "apply");
  const obsoleteOther = capture("d2", 2); const currentOther = capture("d2", 2);
  assert.equal(store.applyFrameAnswer(obsoleteOther, frame(99)).action, "drop", "an older frame request cannot fill an empty current slot");
  assert.equal(store.getState().previews.has("d2"), false);
  assert.equal(store.applyFrameAnswer(currentOther, frame(2)).action, "apply");
  assert.equal(store.getState().settings.get("d1/clock").incarnation, 1);
  assert.equal(store.getState().settings.get("d2/clock").incarnation, 2);
  assert.equal(store.applyEvent({ type: "device-removed", epoch: A, seq: 20, stream, data: { name: "d1", incarnation: 1 } }).action, "apply");
  assert.equal(store.getState().devices.has("d1"), false); assert.equal(store.getState().settings.has("d1/clock"), false); assert.equal(store.getState().previews.has("d1"), false);
  assert.equal(store.getState().settings.get("d2/clock"), two); assert.equal(store.getState().previews.get("d2").frameSeq, 2);
  const replacement = view("d1", { incarnation: 3, rev: 1 });
  assert.equal(store.applyEvent({ type: "device", epoch: A, seq: 21, stream, data: replacement }).action, "apply");
  assert.equal(store.getState().settings.has("d1/clock"), false, "new life starts without the old life's settings");
  const current = sceneSettings("d1", "clock", { epoch: A, incarnation: 3, rev: 1, effective: { n: 9 } });
  assert.equal(store.applyEvent({ type: "settings", epoch: A, seq: 22, stream, data: current }).action, "apply");
  assert.equal(store.applyEvent({ type: "settings", epoch: A, seq: 23, stream, data: { ...one, rev: 999 } }).action, "drop");
  assert.equal(store.getState().settings.get("d1/clock"), current, "old life cannot overwrite current settings");
  const currentView = { ...replacement, rev: 30, displayName: "Current revision thirty" };
  assert.equal(store.applyEvent({ type: "device", epoch: A, seq: 24, stream, data: currentView }).action, "apply");
  assert.equal(store.applyEvent({ type: "device", epoch: A, seq: 25, stream, data: { ...currentView, rev: 29, displayName: "Obsolete revision twenty-nine" } }).action, "drop");
  assert.equal(store.getState().devices.get("d1"), currentView, "a newer carrier position cannot admit an older revision of the same life");
  assert.equal(store.applyFrameAnswer(oldFrame, frame(99)).action, "drop"); assert.equal(store.getState().previews.has("d1"), false);
  assert.equal(store.applyFrameAnswer(capture("d1", 3), frame(3)).action, "apply");
  stream = openSource(store.fence(), "stream");
  assert.equal(store.applyEvent({ type: "snapshot", epoch: A, seq: 40, stream, data: snapshot(A, 40, [view("d1", { incarnation: 3, rev: 10 })], { incarnations: 3 }) }).action, "apply");
  assert.equal(store.getState().devices.has("d2"), false); assert.equal(store.getState().settings.has("d2/clock"), false); assert.equal(store.getState().previews.has("d2"), false);
  assert.equal(store.getState().settings.get("d1/clock"), current); assert.equal(store.getState().previews.get("d1").frameSeq, 3);
  assert.equal(store.getState().devices.get("d1"), currentView, "an accepted snapshot keeps a newer device revision");
  const oldAnswer = beginRequest(store.fence(), "device:d1"); stream = openSource(store.fence(), "stream");
  assert.equal(store.applyEvent({ type: "snapshot", epoch: B, seq: 1, stream, data: snapshot(B, 1, [], { incarnations: 0 }) }).action, "apply");
  assert.deepEqual([store.getState().devices.size, store.getState().settings.size, store.getState().previews.size], [0, 0, 0], "a new epoch cannot retain absent devices, settings or frames");
  assert.equal(store.applyAnswer({ resource: "device:d1", generation: oldAnswer, epoch: A, seq: 999, body: first }).action, "drop");
  assert.equal(store.applyFrameAnswer(oldFrame, frame(99)).action, "drop");
  assert.deepEqual([store.getState().devices.size, store.getState().settings.size, store.getState().previews.size], [0, 0, 0]);
}
test("r4 harness: guard probe r6: store caches follow exact device life, snapshot membership and epoch", async () => r6StoreOwners(await r5Module("store.js")));

test("r4 harness: guard probe r6: page openings retire only their idle outcomes and detach owned listeners", async () => {
  for (const page of ["config", "device", "devices", "raw", "health", "overlays"]) {
    const world = r4World(r4d1()); const calls = r4Server(world); r4NewEpoch(world);
    const scope = `d1@${world.epoch}/1`;
    const owned = page === "config" ? [`patch:${scope}`, `adopt:${scope}`, "add-device"] : page === "devices" ? [`scene:${scope}`, `restore:${scope}`, "add-device"] : page === "device" ? [`scene:${scope}`, `mode:${scope}`, `brightness:${scope}`, `restore:${scope}`, `adopt:${scope}`] : [];
    const busy = owned.map((key) => `${key}/busy`);
    const unrelated = page === "device" ? [`brightness:d2@${world.epoch}/1`, `foreign:${scope}`, "unrelated:r6"] : ["unrelated:r6"];
    for (const key of [...owned, ...unrelated, ...busy]) r4SetOp(key, { token: 900, busy: busy.includes(key), label: "own operation", value: null, failure: null, note: "own kept note" });
    const root = pageRoot(); const module = R4_PAGES[page].module();
    try {
      module.mount(root, page === "device" ? { name: "d1" } : {});
      await r4AnswerAll({ calls });
      for (const key of owned) assert.equal(r4State().ops.has(key), false, `${page} retires its own idle outcome: ${key}`);
      for (const key of [...busy, ...unrelated]) assert.equal(r4State().ops.has(key), true, `${page} preserves another owner or pending outcome: ${key}`);
      const formHost = root.querySelector(".settings-host");
      const count = (/** @type {any} */ node) => [...node.listeners.values()].reduce((sum, listeners) => sum + listeners.length, 0);
      assert.ok(count(root) > 0, "the mounted root owns interaction listeners");
      module.unmount();
      assert.equal(count(root), 0, `${page} releases its interaction listeners on unmount`);
      if (formHost) { assert.equal(count(formHost), 0, "the form releases its own listeners"); assert.equal(formHost.children.length, 0, "the ended form owns no surviving fields"); }
      module.unmount();
    } finally {
      module.unmount(); root.remove(); await r4AnswerAll({ calls });
      for (const key of [...owned, ...unrelated, ...busy]) r4SetOp(key, null);
    }
  }
});

test("r4 harness: guard probe r6: HTML slots retain unchanged nodes and ignore absent targets", async () => {
  const dom = await r5Module("dom.js"); const root = pageRoot();
  try {
    assert.equal(dom.setHtml(null, "<input>"), false);
    assert.equal(dom.setHtml(undefined, "<input>"), false);
    assert.equal(dom.setHtml(root, '<input value="own">'), true);
    const input = root.querySelector("input"); input.focus();
    assert.equal(dom.setHtml(root, '<input value="own">'), false);
    assert.equal(root.querySelector("input"), input, "an unchanged current slot retains its field and focus owner");
    assert.equal(fakeDocument.activeElement, input);
    assert.equal(dom.setHtml(root, '<input value="new">'), true);
    assert.notEqual(root.querySelector("input"), input);
  } finally { root.remove(); }
});

test("r4 harness: guard probe r6: current form outcomes report failure, recovery, remaining preview and Revert", async (t) => {
  const module = await r5Module("components/settings-form.js");
  await r5Form(t, module, async ({ edit, calls, root, reports, form, session }) => {
    await edit("2"); r5Previews(calls).at(-1).answer(500, {}); await settle();
    assert.match(reports.at(-1), /500/, "a current preview failure must reach its page");
    await edit("3"); r5Previews(calls).at(-1).ok(); await settle();
    assert.equal(reports.at(-1), null, "a current successful preview clears its page's failure");
    r4Click(saveButton(root)); await settle(); const saving = pending(calls, "PUT", "/settings/clock");
    await edit("4"); r5Previews(calls).at(-1).ok(); await settle();
    const before = r5Previews(calls).length;
    saving.ok(); await settle();
    assert.equal(r5Previews(calls).length, before + 1, "Save re-previews the current scope's remaining edit");
    assert.deepEqual(r5Previews(calls).at(-1).body.values, { n: 4 });
    r5Previews(calls).at(-1).answer(500, {}); await settle();
    assert.match(reports.at(-1), /500/);
    r4Click(root.querySelector('[data-act="revert"]')); await settle();
    const reverting = pending(calls, "DELETE", "/settings/clock/preview");
    assert.match(reverting.url, /\?session=s1$/, "Revert ends the captured session's preview");
    reverting.ok(); await settle();
    assert.equal(reports.at(-1), null, "the current Revert clears its page's preview failure");
    session(""); const sent = calls.length; const ended = form.end(); await settle();
    assert.equal(calls.length, sent, "leaving without a session cannot send an end for the previewed scope");
    await ended;
  });
  await r5Form(t, module, async ({ calls, root }) => {
    pending(calls, "GET", "/settings/clock").answer(500, {}); await settle();
    assert.match(r4Text(root), /Settings could not be loaded:.*500/);
    assert.equal(root.querySelector('[data-act="retry"]').disabled, false, "a current load failure offers Retry");
  }, { ready: false });
});

test("r4 harness: guard probe r6: registry outcomes preserve labels, notes, idle ownership and superseded callbacks", async () => {
  const ops = await r5Module("ops.js"); const store = await import(new URL("../../web/js/store.js", import.meta.url).href);
  const keys = ["r6-registry", "r6-registry-idle", "r6-registry-busy", "other:r6-registry"];
  try {
    const first = ops.follow(keys[0], async () => 1, { label: "Own label", done: () => "Own outcome" });
    assert.equal(ops.op(keys[0]).label, "Own label"); assert.equal(ops.op(keys[0]).busy, true);
    await first; await settle(); assert.equal(ops.op(keys[0]).note, "Own outcome");
    ops.clearNote(keys[0]); assert.equal(ops.op(keys[0]).note, null);
    await ops.follow(keys[0], async () => 2); await settle();
    assert.equal(ops.op(keys[0]).label, ""); assert.equal(ops.op(keys[0]).note, null, "an absent callback produces the idle null note");
    for (const [index, key] of keys.entries()) r4SetOp(key, { token: 901, busy: index === 2, label: "kept", value: null, note: "own", failure: null });
    ops.forgetIdle((/** @type {string} */ key) => key.startsWith("r6-registry"));
    assert.equal(r4State().ops.has(keys[1]), false); assert.equal(r4State().ops.has(keys[2]), true); assert.equal(r4State().ops.has(keys[3]), true);
    let updates = 0; const stop = store.subscribe((/** @type {any} */ state) => state.ops, () => { updates += 1; });
    try { const before = updates; ops.drop("r6-never-started"); assert.equal(updates, before, "an absent slot cannot announce an update"); } finally { stop(); }
    /** @type {any} */ let finish; let called = false;
    const old = ops.follow(keys[0], () => new Promise((resolve) => { finish = resolve; }), { done: () => { called = true; return "obsolete"; } });
    await ops.follow(keys[0], async () => 3, { done: () => "current" }); await settle(); finish(1); await old; await settle();
    assert.equal(called, false, "a superseded operation cannot call done even when a later token check protects its slot");
    assert.equal(ops.op(keys[0]).note, "current");
  } finally { for (const key of keys) ops.drop(key); }
});

test("r4 harness: guard probe r6: rejection reasons and repeated Reset acknowledgements retain exact edit identity", async () => {
  const { createDraftBook } = await r5Module("view/drafts.js");
  const book = createDraftBook(); book.edit("n", "2", { value: 2 });
  const preview = book.previewPlan("s1"); book.rejected(preview.sent, { n: "Own server rejection" });
  assert.equal(book.edits.get("n").error, "Own server rejection"); assert.equal(book.edits.get("n").refused, true);
  book.clear(); book.reset("m", 6, "6"); const save = book.saveBody("s1");
  book.reset("m", 6, "6"); book.saved(save.committed, save.body.reset);
  const next = book.saveBody("s1");
  assert.deepEqual(next.body.set, {}); assert.deepEqual(next.body.reset, ["m"], "an equal-valued newer Reset remains a Reset after the old Save");
});

test("r4 harness: guard probe r6: store protocol preserves snapshot positions, order, legacy lives and stream ownership", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at("18:42:00")) });
  const m = await r5Module("store.js"); const store = m.createStore();
  const d1 = view("d1", { incarnation: 1 }); const d2 = view("d2", { incarnation: 2 });
  const boot = snapshot(A, 10, [d1, d2], { incarnations: 2 });
  const builtins = { ulanzi: [{ key: "builtin:own", label: "Own mode" }], pixoo: [] }; boot.builtins = builtins;
  const generation = openSource(store.fence(), "bootstrap");
  assert.equal(store.applyAnswer({ resource: "bootstrap", generation, epoch: B, seq: 11, body: boot }).action, "apply");
  assert.deepEqual([store.getState().epoch, store.getState().seq], [A, 10], "snapshot body position is authoritative over its carrier");
  const oldStream = openSource(store.fence(), "stream"); const stream = openSource(store.fence(), "stream");
  let commits = 0; const stop = store.subscribe((/** @type {any} */ state) => state, () => { commits += 1; });
  try {
    const before = commits;
    assert.equal(store.applyEvent({ type: "snapshot", epoch: A, seq: 20, stream: oldStream, data: snapshot(A, 20, []) }).action, "drop");
    assert.equal(commits, before, "a superseded snapshot source publishes no state");
    assert.equal(store.applyEvent({ type: "snapshot", epoch: A, seq: 20, stream, data: { ...snapshot(A, 20, [d2, d1], { incarnations: 2 }), builtins } }).action, "apply");
    assert.deepEqual([...store.getState().devices.keys()], ["d2", "d1"], "snapshot config order survives equal-revision views");
    t.mock.timers.tick(1000); const dataAt = store.getState().dataAt;
    assert.equal(store.applyEvent({ type: "device", epoch: A, seq: 21, stream, data: d1 }).action, "drop", "a live view cannot replay an equal revision using snapshot rules");
    assert.equal(store.getState().dataAt, dataAt, "a dropped view advances position without announcing new data");
    const count = commits;
    assert.equal(store.applyEvent({ type: "ping", epoch: A, seq: 20, stream, data: {} }).action, "drop");
    assert.equal(commits, count, "an unchanged rejected position causes no render");
    assert.equal(store.applyEvent({ type: "device", epoch: A, seq: 22, stream, data: view("omitted", { incarnation: 1 }) }).action, "drop", "snapshot census excludes an already ended unlisted life");
    assert.equal(store.applyEvent({ type: "builtins", epoch: A, seq: 23, stream, data: { ulanzi: [], pixoo: [] } }).action, "apply");
    assert.deepEqual(store.getState().builtins, builtins, "builtins are snapshot data, not a stream resource");
    const logRequest = beginRequest(store.fence(), "log");
    store.applyEvent({ type: "log", epoch: A, seq: 24, stream, data: { seq: 2, at: at("18:42:00"), level: "INFO", message: "new line" } });
    assert.equal(store.applyAnswer({ resource: "log", generation: logRequest, epoch: A, seq: 23, body: [{ seq: 1, at: at("18:41:59"), level: "INFO", message: "history" }] }).action, "apply");
    assert.deepEqual(store.getState().log.map((/** @type {any} */ line) => line.seq), [1, 2], "live log data does not discard older history");
    const scenes = beginRequest(store.fence(), "scenes");
    store.applyAnswer({ resource: "scenes", generation: scenes, epoch: A, seq: 25, body: { scenes: SCENES } });
    assert.deepEqual(store.getState().builtins, builtins, "a scene envelope with no builtins cannot clear another resource");
    const config = store.getState().config;
    store.applyEvent({ type: "snapshot", epoch: A, seq: 30, stream, data: { epoch: A, seq: 30, devices: [d2, d1], incarnations: 2 } });
    assert.equal(store.getState().config, config, "an omitted snapshot resource retains its current value");
    const newer = view("d1", { incarnation: 3, rev: 1 });
    store.applyEvent({ type: "device", epoch: A, seq: 31, stream, data: newer });
    store.applyEvent({ type: "device-removed", epoch: A, seq: 32, stream, data: { name: "d1", incarnation: 1 } });
    assert.equal(store.getState().devices.get("d1"), newer, "a late named removal cannot remove its successor life");
  } finally { stop(); }
  const legacyStore = m.createStore(); const legacyStream = openSource(legacyStore.fence(), "stream");
  const legacy = view("legacy"); Reflect.deleteProperty(legacy, "incarnation");
  legacyStore.applyEvent({ type: "snapshot", epoch: A, seq: 1, stream: legacyStream, data: snapshot(A, 1, [legacy]) });
  const oldSettings = sceneSettings("legacy", "clock", { epoch: A, rev: 1 }); Reflect.deleteProperty(oldSettings, "incarnation");
  legacyStore.applyEvent({ type: "settings", epoch: A, seq: 2, stream: legacyStream, data: oldSettings });
  assert.equal(legacyStore.getState().settings.has("legacy/clock"), true);
  legacyStore.applyEvent({ type: "device", epoch: A, seq: 3, stream: legacyStream, data: view("legacy", { incarnation: 3, rev: 1 }) });
  assert.equal(legacyStore.getState().settings.has("legacy/clock"), false, "an unnamed legacy life yields to a named replacement and clears its settings");
});

test("r4 harness: guard probe r6: Raw current validation marks and retry starts retain editor ownership", async () => {
  await r5Raw(await r5Module("pages/config-raw.js"), async ({ calls, root, world }) => {
    pending(calls, "GET", "/config/raw").ok(); await settle();
    r4Type(root.querySelector("textarea"), '{\n"devices":[]\n}'); r4Click(root.querySelector('[data-act="save"]')); await settle();
    pending(calls, "PUT", "/config/raw").answer(422, { code: "invalid_config", error: "Own validation", line: 2 }); await settle();
    r4Live(world, "mqtt", { ...r4State().mqtt }); await settle();
    assert.deepEqual(root.querySelectorAll(".gut b.err").map(r4Text), ["2"], "the current failed Save marks its own validation line");
    r4Click(root.querySelector('[data-act="save"]')); await settle();
    assert.deepEqual(root.querySelectorAll(".gut b.err"), [], "starting the current retry clears the old mark");
    pending(calls, "PUT", "/config/raw").ok(); await settle();
  });
});

test("r4 harness: guard probe r6: completed brightness releases its slider and recovery keeps one dialog and opener", async () => {
  const world = r4World(r4d1({ override: 30 })); const calls = r4Server(world); r4NewEpoch(world);
  const module = (await r5Module("pages/device.js")).page; const root = pageRoot();
  module.mount(root, { name: "d1" });
  try {
    await r4AnswerAll({ calls });
    const range = root.querySelector('input[type="range"]');
    typeInto(range, "40", "input"); typeInto(range, "40", "change"); await settle();
    pending(calls, "PUT", "/brightness").ok(); await settle();
    root.querySelector("h1").focus();
    const next = r4View(world, "d1", world.epoch, 1, ++world.rev); next.desired.brightness.override = 73; next.health.state = "offline";
    r4Live(world, "device", next); await settle();
    assert.equal(r4Value(root.querySelector('input[type="range"]')), "73", "a later current value cannot be masked by a completed slider draft");
    assert.equal(fakeDocument.body.querySelector(".scrim"), null, "recovery was not requested on this opening");
    const opener = root.querySelector('[data-act="recovery"]'); opener.focus(); r4Click(opener);
    r4Click(opener); assert.equal(fakeDocument.body.querySelectorAll(".scrim").length, 1, "a repeated recovery request keeps the same dialog");
    r4Click(fakeDocument.body.querySelector('.scrim [data-act="close"]'));
    assert.equal(fakeDocument.activeElement, opener, "the recovery button retains focus ownership");
    r4Click(opener); assert.equal(fakeDocument.body.querySelectorAll(".scrim").length, 1, "closing releases the dialog owner for another opening");
    r4Click(fakeDocument.body.querySelector('.scrim [data-act="close"]'));
  } finally { module.unmount(); root.remove(); await r4AnswerAll({ calls }); }
});

// r6: every gate mutant must fail the same named story that its control passes.
test("r4 harness self-test: same-value replacements require draft identity, never value equality (gate r5b F)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const book = await r4Mutant("view/drafts.js", [
    ["committed.set(key, edit.draft);", "committed.set(key, edit.value);"],
    ["edits.get(key)?.draft === number", "edits.get(key)?.value === number"],
  ]);
  const device = await r4DeviceWithForm([], { "../view/drafts.js": book });
  for (const change of ["equal value retyped", "value changed away and back"]) {
    assert.deepEqual(await r4Case(t, r4KindOf("settings save"), change, "success"), [], "the real draft identity preserves equal-valued edits");
    const differences = await r4Case(t, r4KindOf("settings save"), change, "success", { modules: { device } });
    assert.ok(differences.some((d) => /the next Save|holds no edit/.test(d)), differences.join("\n"));
  }
});

test("r4 harness self-test: an old Reset Save cannot delete a replacement edit (gate r5b G)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const book = await r4Mutant("view/drafts.js", [[
    "for (const key of reset) if (!edits.has(key)) resets.delete(key);",
    "for (const key of reset) { edits.delete(key); resets.delete(key); }",
  ]]);
  const device = await r4DeviceWithForm([], { "../view/drafts.js": book });
  const kind = r4KindOf("settings reset save");
  assert.deepEqual(await r4Case(t, kind, "reset replaced by an edit", "success"), []);
  const differences = await r4Case(t, kind, "reset replaced by an edit", "success", { modules: { device } });
  assert.ok(differences.some((d) => /the next Save|holds no edit/.test(d)), differences.join("\n"));
});

test("r4 harness self-test: Raw must obey the fence result even after applyAnswer ran (gate r5b H)", async () => {
  await r6RawVersion(await r5Module("pages/config-raw.js"));
  const mutant = await r5Module("pages/config-raw.js", [[
    'applyAnswer(answer).action === "apply" && base.opened === opened && root',
    '(applyAnswer(answer), true) && base.opened === opened && root',
  ]]);
  await assert.rejects(r6RawVersion(mutant), (/** @type {any} */ error) => error.name === "AssertionError" && /saved baseline/.test(error.message));
});

const R6_FEEDBACK_MUTANT = /** @type {Array<[string, string]>} */ ([
  ["let previewFailure = null;", "let previewFailure = null;\nlet r6FeedbackCache = null;"],
  ["start(key, async () => applyAnswer(await send(key)), {", "start(key, async () => {\n    try { return applyAnswer(await send(key)); }\n    catch (error) {\n      if (control === 'brightness') { r6FeedbackCache = String(error); render(getState()); }\n      throw error;\n    }\n  }, {"],
  ['const briOp = opOf("brightness", view);', 'const briOp = { ...opOf("brightness", view), ...(r6FeedbackCache ? { failure: r6FeedbackCache } : {}) };'],
]);
test("r4 harness self-test: brightness feedback cached by old work is observed independently of operation slots (gate r5b I)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const change of ["epoch", "reincarnate"])
    for (const end of /** @type {R4End[]} */ (["500", "timeout"])) {
      const fresh = R6_FEEDBACK_MUTANT.map(([from, to]) => /** @type {[string, string]} */ ([from, `${to}\n// independent gate-I run: ${change}/${end}\n`]));
      const device = (await r5Module("pages/device.js", fresh)).page;
      const kind = r4KindOf("device brightness range");
      assert.deepEqual(await r4Case(t, kind, change, end), []);
      const differences = await r4Case(t, kind, change, end, { modules: { device } });
      assert.ok(differences.some((d) => /brightness feedback.*Not changed/.test(d)), differences.join("\n"));
      const view = r4State().devices.get("d1");
      const current = [...r4State().ops].filter(([key]) => key === `brightness:d1@${view.epoch}/${view.incarnation}`);
      assert.equal(current.filter(([, slot]) => slot.failure).length, 0, "no retained failure in the new owner's brightness slot explains the hint");
    }
});

test("r4 harness self-test: distinct overlay ids cannot share one Clear slot (gate r5b J)", async () => {
  for (const overlap of [false, true]) {
    await r6Overlays(await r5Module("pages/overlays.js"), overlap, "500");
    const mutant = await r7OverlaySlotMutant('return "overlay:shared";');
    await assert.rejects(r6Overlays(mutant, overlap, "500"), (/** @type {any} */ error) => error.name === "AssertionError");
  }
});

/** @param {string} line */
function t_log(line) {
  if (process.env.R4_HARNESS_STRICT === "1") process.stdout.write(`# ${line.replaceAll("\n", "\n# ")}\n`);
}

// ---------------------------------------------------------------------------
// r4, phase A revision: the effect inventory, re-run by the suite (gate r4 §2)
//
// The section between the <effects-r4> marks is the extractor itself, and
// the only copy: effects-r4.mjs beside the design note runs this section.
// It finds every continuation in web/js (ops.js done/failed/describe, the
// code after each await, then/catch/finally, SSE handlers, timers) and the
// UI effects each performs, following indirection: named callbacks
// (`done: settled`), helper functions of the file (a helper that writes UI
// or starts a request is the continuation's effect), and callbacks passed
// as arguments (`return step()` in a lane is every step the file queues;
// a call that passes a step binds it). render/redraw/draw are not followed:
// render reads the current state and is the one DOM writer (note §3).
// R4_INVENTORY lists every continuation with its effects; the suite fails on
// one that is not listed or a listed one that vanished.
// ---------------------------------------------------------------------------

// <effects-r4>
/** Strings, comments and template text blanked (template expressions kept), so brackets and patterns match code only. @param {string} src */
function r4xCodeOnly(src) {
  let out = "";
  let i = 0;
  /** @type {string[]} */
  const stack = [];
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (stack.length > 0 && stack[stack.length - 1] === "`") {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === "`") { stack.pop(); out += c; i += 1; continue; }
      if (c === "$" && n === "{") { stack.push("{"); out += "${"; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i += 1; continue;
    }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i += 1; } continue; }
    if (c === "/" && n === "*") { while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i += 1; } out += "  "; i += 2; continue; }
    if (c === '"' || c === "'") {
      out += c; i += 1;
      while (i < src.length && src[i] !== c) { if (src[i] === "\\") { out += " "; i += 1; } out += src[i] === "\n" ? "\n" : " "; i += 1; }
      out += c; i += 1; continue;
    }
    if (c === "`") { stack.push("`"); out += c; i += 1; continue; }
    if (c === "{" && stack.length) { stack.push("{"); out += c; i += 1; continue; }
    if (c === "}" && stack.length && stack[stack.length - 1] === "{") { stack.pop(); out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}
/** @param {string} code @param {number} open an opening bracket @returns {number} its match */
function r4xMatch(code, open) {
  /** @type {Record<string, string>} */
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const want = pairs[code[open]];
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === code[open]) depth += 1;
    else if (code[i] === want) { depth -= 1; if (depth === 0) return i; }
  }
  return code.length - 1;
}
/** @param {string} code @param {number} at @returns {number} the 1-based line */
const r4xLineOf = (code, at) => code.slice(0, at).split("\n").length;
/** An expression from `start` up to the comma, semicolon or bracket that ends it at depth 0. @param {string} code @param {number} start @returns {[number, number]} */
function r4xExpression(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    const c = code[i];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) { if (depth === 0) return [start, i - 1]; depth -= 1; }
    else if ((c === "," || c === ";") && depth === 0) return [start, i - 1];
    else if (c === "\n" && depth === 0 && /^\s*(const|let|function|export|return|if|for)\b/.test(code.slice(i + 1, i + 40))) return [start, i - 1];
  }
  return [start, code.length - 1];
}
/** The body of a function whose parameters close at `close`: a block, or an arrow's expression. @param {string} code @param {number} close @returns {[number, number]|null} */
function r4xBodyAfter(code, close) {
  const after = /^\s*(=>\s*)?/.exec(code.slice(close + 1, close + 40));
  let start = close + 1 + (after ? after[0].length : 0);
  if (code[start] === "{") return [start, r4xMatch(code, start)];
  if (!after?.[1]) return null;
  while (/\s/.test(code[start])) start += 1;
  return r4xExpression(code, start);
}
/** A function value that starts at `at` (an arrow, a function, or the name of a function of the file): its body. @param {string} code @param {any[]} fns @param {number} at @returns {[number, number]|null} */
function r4xFunctionAt(code, fns, at) {
  const rest = code.slice(at, at + 200);
  const fn = /^\s*(?:async\s+)?function\b[^(]*\(/.exec(rest);
  if (fn) return r4xBodyAfter(code, r4xMatch(code, at + fn[0].length - 1));
  const paren = /^\s*(?:async\s*)?\(/.exec(rest);
  if (paren) {
    const close = r4xMatch(code, at + paren[0].length - 1);
    if (/^\s*=>/.test(code.slice(close + 1, close + 10))) return r4xBodyAfter(code, close);
    return null;
  }
  const single = /^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.exec(rest);
  if (single) {
    let start = at + single[0].length;
    while (/\s/.test(code[start])) start += 1;
    return code[start] === "{" ? [start, r4xMatch(code, start)] : r4xExpression(code, start);
  }
  const name = /^\s*([A-Za-z_$][\w$]*)\s*(?=[,)}\n])/.exec(rest);
  const named = name ? fns.find((f) => f.name === name[1]) : null;
  return named ? [named.start, named.end] : null;
}
const R4X_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "await", "function", "async", "typeof", "new", "void", "delete", "in", "of", "super", "import"]);
/** Every named function of a file: declarations, const/let functions and arrows, and methods. @param {string} code */
function r4xFunctions(code) {
  /** @type {Array<{name: string, at: number, params: string[], start: number, end: number}>} */
  const fns = [];
  const re = /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\*?\s*[\w$]*\s*)?\(/g;
  for (let m; (m = re.exec(code)); ) {
    const name = m[1] || m[2] || m[3];
    if (!name || R4X_KEYWORDS.has(name)) continue;
    const open = m.index + m[0].length - 1;
    const close = r4xMatch(code, open);
    const body = r4xBodyAfter(code, close);
    if (!body) continue;
    // A call at the start of a line is not a method: a method's parameters are followed by its block.
    if (m[2] && code[body[0]] !== "{") continue;
    if (m[2] && !/^\s*\{/.test(code.slice(close + 1, close + 20))) continue;
    const params = code.slice(open + 1, close).replace(/[{}[\]]/g, ",").split(",").map((p) => p.replace(/=.*$/s, "").replace(/\.\.\./, "").trim()).filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
    fns.push({ name, at: m.index, params, start: body[0], end: body[1] });
  }
  return fns;
}
/** The arguments of a call whose parenthesis opens at `open`. @param {string} code @param {number} open @returns {Array<[number, number]>} */
function r4xArguments(code, open) {
  const close = r4xMatch(code, open);
  /** @type {Array<[number, number]>} */
  const args = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const c = code[i];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) { args.push([from, i - 1]); from = i + 1; }
  }
  if (code.slice(from, close).trim()) args.push([from, close - 1]);
  return args;
}
/** The effects a continuation performs, by pattern, in its code and in what it calls. */
const R4X_EFFECTS = /** @type {Array<[string, RegExp]>} */ ([
  ["DOM write", /\bsetHtml\(|\.innerHTML\s*=(?!=)|\.textContent\s*=(?!=)|\bsetStatusLine\(|\bsetAttr\(|\bsetClass\(|\.replaceChildren\(|\.value\s*=(?!=)|\.style\.[a-zA-Z]+\s*=(?!=)|\.className\s*=(?!=)/],
  ["slot drop", /(?<![\w$.])drop\(/],
  ["close", /\.close\(|\bopen\s*=\s*null|scrim\.remove\(\)/],
  ["blur", /\.blur\b/],
  // Save's acknowledgement and Revert (the book forgets edits), and a form's reset.
  ["reset", /\.reset\(|\bbook\.(saved|clear)\(/],
  // What pixdcon refused is marked on the edits that were sent: an effect of its own, with its own projection (gate note2 M2).
  ["field rejection", /\bbook\.rejected\(/],
  ["focus", /\.focus\(/],
  ["enable/disable", /\.disabled\s*=(?!=)/],
  ["request start", /(?<![\w$.])(request|requestFrame|follow|start)\(/],
  ["page state", /\b(loading|loaded|again|errorLine|phase|loadError|sliding|open|copied|current|reported)\s*=(?!=)|\.(previewed|queued|left)\s*=(?!=)/],
  ["preview feedback", /\.previewFailure\s*=(?!=)/],
  ["page callback", /\boptions\.on[A-Z]\w*\s*\??\.?\(/],
  ["connection feedback", /(?<![\w$.])(setLive|lose)\(/],
  ["timer start", /(?<![\w$.])(setTimeout|setInterval)\(/],
  ["slot outcome", /(?<![\w$.])setOp\(/],
  ["store", /(?<![\w$.])(applyAnswer|applyFrameAnswer|applyEvent|setLive|setLoadError)\(/],
]);
/** Called, not followed: render reads the current state (note §3). */
const R4X_RENDER = new Set(["render", "redraw", "draw"]);
/**
 * State that a renderer reads, including through local helpers. Discover
 * names from readers and assignments, never a hand-maintained name list.
 * Conservative on shadowed locals: an extra writer is inventoried too.
 * @param {string} code @param {any[]} fns @param {[number, number]} range
 * @returns {Array<{name: string, line: number}>}
 */
function r6RenderWrites(code, fns, range) {
  const readers = fns.filter((f) => R4X_RENDER.has(f.name));
  const seen = new Set(readers.map((f) => f.name));
  for (let i = 0; i < readers.length; i += 1)
    for (const call of code.slice(readers[i].start, readers[i].end + 1).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const fn = fns.find((f) => f.name === call[1]);
      if (fn && !seen.has(fn.name)) { readers.push(fn); seen.add(fn.name); }
    }
  const reads = new Set(readers.flatMap((f) => code.slice(f.start, f.end + 1).match(/[A-Za-z_$][\w$]*/g) ?? []));
  const writes = [];
  for (const m of code.slice(range[0], range[1] + 1).matchAll(/\b([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*(?:=(?!=|>)|\+\+|--|[+&|?]?=)/g)) {
    const name = m[2] ? `${m[1]}.${m[2]}` : m[1];
    if (reads.has(m[2] ?? m[1])) writes.push({ name, line: r4xLineOf(code, range[0] + m.index) });
  }
  return writes;
}

/**
 * The effects of the code in `range`, and of what it calls.
 *
 * @param {string} code @param {any[]} fns @param {[number, number]} range
 * @param {Map<string, Array<[number, number]>>} bound parameters bound to the callbacks a call passed
 * @param {Set<string>} seen @param {Set<string>} via the helpers and callbacks followed
 * @param {Array<[number, number]>} [spans] the code of what was followed (the guard-removal sweep reads the conditions in it)
 * @returns {Set<string>}
 */
function r4xFollow(code, fns, range, bound, seen, via, spans = []) {
  const body = code.slice(range[0], range[1] + 1);
  const effects = new Set(R4X_EFFECTS.filter(([, re]) => re.test(body)).map(([name]) => name));
  if (r6RenderWrites(code, fns, range).length) effects.add("page state");
  for (const m of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (R4X_KEYWORDS.has(name)) continue;
    if (R4X_RENDER.has(name)) { effects.add("render"); continue; }
    const at = range[0] + m.index;
    /** @type {Array<{range: [number, number], bind: Map<string, Array<[number, number]>>}>} */
    const targets = [];
    const fn = fns.find((f) => f.name === name && f.at !== at && !(f.at <= at && at < f.start));
    if (fn) {
      // What this call passes as callbacks is what the helper's parameters call.
      /** @type {Map<string, Array<[number, number]>>} */
      const bind = new Map();
      r4xArguments(code, at + m[0].length - 1).forEach((arg, i) => {
        const value = r4xFunctionAt(code, fns, arg[0]);
        if (value && fn.params[i]) bind.set(fn.params[i], [value]);
      });
      targets.push({ range: [fn.start, fn.end], bind });
    } else if (bound.has(name)) {
      for (const r of /** @type {Array<[number, number]>} */ (bound.get(name))) targets.push({ range: r, bind: new Map() });
    } else {
      // A parameter of the function that holds the call, not bound here: every callback the file passes for it.
      const owner = fns.filter((f) => f.start <= at && at <= f.end && f.params.includes(name)).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      if (owner) {
        const index = owner.params.indexOf(name);
        for (const call of code.matchAll(new RegExp(`(?<![\\w$.])${owner.name}\\s*\\(`, "g"))) {
          if (call.index === owner.at || (owner.at <= call.index && call.index < owner.start)) continue;
          const arg = r4xArguments(code, call.index + call[0].length - 1)[index];
          const value = arg ? r4xFunctionAt(code, fns, arg[0]) : null;
          if (value) targets.push({ range: value, bind: new Map() });
        }
      }
    }
    for (const target of targets) {
      const key = `${target.range[0]}|${[...target.bind.values()].flat().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      via.add(name);
      spans.push(target.range);
      for (const effect of r4xFollow(code, fns, target.range, target.bind, seen, via, spans)) effects.add(effect);
    }
  }
  return effects;
}
/**
 * The inventory of a set of files.
 *
 * @param {Array<{file: string, src: string}>} files paths relative to v2/
 * @returns {{rows: any[], hits: number, unmapped: string[]}}
 */
function r4xExtract(files) {
  /** @type {any[]} */
  const rows = [];
  let hits = 0;
  /** @type {string[]} */
  const unmapped = [];
  for (const { file, src } of files) {
    const code = r4xCodeOnly(src);
    const fns = r4xFunctions(code);
    /** @type {Array<[number, number]>} */
    const mine = [];
    const holder = (/** @type {number} */ at) =>
      fns.filter((f) => f.start <= at && at <= f.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0]?.name ?? "(module)";
    /** @param {string} kind @param {number} at @param {[number, number]|null} range @param {string[]} [extra] @param {string} [what] */
    const add = (kind, at, range, extra = [], what = "") => {
      if (!range) return;
      const via = new Set();
      /** @type {Array<[number, number]>} */
      const spans = [];
      const effects = new Set([...r4xFollow(code, fns, range, new Map(), new Set(), via, spans), ...extra]);
      mine.push([Math.min(at, range[0]), range[1]], [at, at + 60]);
      const stateWrites = [range, ...spans].flatMap((span) => r6RenderWrites(code, fns, span)).filter((write, i, list) => list.findIndex((w) => w.line === write.line && w.name === write.name) === i);
      // Each write has an explicit ownership obligation, including cache variables new code may introduce.
      const writes = stateWrites.map((write) => ({ ...write, owner: r4xProjection(file, "page state", holder(at)) }));
      // range, spans: the continuation's own code and the code it calls (offsets in the file), for the guard-removal sweep.
      rows.push({ site: `${file}:${r4xLineOf(code, at)}`, file, line: r4xLineOf(code, at), kind, fn: holder(at), what, writes, effects: [...effects].sort(), via: [...via].sort(), range, spans });
    };
    // 1. ops.js callbacks: done (what it returns is the slot's note), failed, describe (the slot's failure text)
    for (const m of code.matchAll(/\b(done|failed|describe)\s*:\s*/g)) {
      const range = r4xFunctionAt(code, fns, m.index + m[0].length);
      const named = /^([A-Za-z_$][\w$]*)\s*[,}\n]/.exec(code.slice(m.index + m[0].length));
      const body = range ? code.slice(range[0], range[1] + 1) : "";
      // A note is text: a string, a template or a named sentence (SAVED) that it returns.
      const text = /["'`]|\b[A-Z][A-Z_]{2,}\b/;
      const returns = range && (code[range[0]] !== "{" ? text.test(body) : [...body.matchAll(/\breturn\s+([^;]*)/g)].some((r) => text.test(r[1])));
      /** @type {string[]} */
      const extra = m[1] === "describe" ? ["slot failure text"] : m[1] === "done" && returns ? ["slot note"] : [];
      add(`ops ${m[1]}`, m.index, range, extra, named?.[1] ?? "");
    }
    // 2. await: from the awaited expression to the end of the async function that holds it
    /** @type {Array<[number, number]>} */
    const asyncBodies = [];
    for (const a of code.matchAll(/\basync\b/g)) {
      const range = r4xFunctionAt(code, fns, a.index);
      if (range) asyncBodies.push(range);
    }
    for (const m of code.matchAll(/\bawait\b/g)) {
      const body = asyncBodies.filter(([a, b]) => a <= m.index && m.index <= b).sort((x, y) => x[1] - x[0] - (y[1] - y[0]))[0];
      const awaited = /^\s*(?:new\s+)?[A-Za-z_$][\w$.]*\s*(\()?/.exec(code.slice(m.index + 5));
      const from = awaited?.[1] ? r4xMatch(code, m.index + 5 + awaited[0].length - 1) + 1 : m.index + 5 + (awaited?.[0].length ?? 0);
      // `f(await x)`: f runs after x, in the continuation.
      /** @type {string[]} */
      const wrappers = [];
      let depth = 0;
      for (let i = m.index - 1; i >= (body ? body[0] : 0); i -= 1) {
        if (")]}".includes(code[i])) depth += 1;
        else if ("([{".includes(code[i])) {
          if (depth === 0) {
            if (code[i] === "{") break;
            const callee = /([A-Za-z_$][\w$.]*)\s*$/.exec(code.slice(Math.max(0, i - 60), i));
            if (callee && code[i] === "(") wrappers.push(callee[1]);
          } else depth -= 1;
        }
      }
      const wrapped = wrappers.flatMap((w) => R4X_EFFECTS.filter(([, re]) => re.test(`${w}(`)).map(([name]) => name));
      add("await", m.index, [from, body ? body[1] : code.length - 1], wrapped);
    }
    // 3. then/catch/finally
    for (const m of code.matchAll(/\.(then|catch|finally)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      add(`.${m[1]}`, m.index, [open, r4xMatch(code, open)]);
    }
    // 4. SSE handlers and EventSource callbacks
    for (const m of code.matchAll(/\b(source|es|stream)\.addEventListener\s*\(|\.(onopen|onerror|onmessage)\s*=/g)) {
      if (m[2]) add(`SSE ${m[2]}`, m.index, r4xFunctionAt(code, fns, m.index + m[0].length));
      else {
        const open = m.index + m[0].length - 1;
        add("SSE handler", m.index, [open, r4xMatch(code, open)]);
      }
    }
    // 5. timers
    for (const m of code.matchAll(/(?<![\w$.])(setTimeout|setInterval)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      add(`timer ${m[1]}`, m.index, [open, r4xMatch(code, open)]);
    }
    // The cross-check: an independent line search; every hit must lie inside a continuation of the inventory.
    const SEARCH = /\bawait\b|\.then\s*\(|\.catch\s*\(|\.finally\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|\bdone\s*:|\bfailed\s*:|\bdescribe\s*:|\.onopen\b|\.onerror\b|\.onmessage\b|source\.addEventListener/;
    const lines = code.split("\n");
    let offset = 0;
    lines.forEach((line, i) => {
      const hit = line.search(SEARCH);
      if (hit !== -1) {
        hits += 1;
        const at = offset + hit;
        if (!mine.some(([a, b]) => at >= a - 400 && at <= b + 1)) unmapped.push(`${file}:${i + 1}: ${src.split("\n")[i].trim()}`);
      }
      offset += line.length + 1;
    });
  }
  return { rows, hits, unmapped };
}
/**
 * Conservative inventory of persistent bindings, object writes and collection
 * mutations across every imported UI module. No variable-name whitelist and
 * no async-span restriction: helpers called by continuations count too.
 * Local collection builders are intentionally included for review.
 * @param {Array<{file: string, src: string}>} files
 */
function r6xPersistentWrites(files) {
  const owners = (/** @type {string} */ file) => {
    if (file.includes("settings-form") || file.includes("drafts")) return "opening, epoch, device life, scene, definition and each submitted edit's draft/Reset intent; slot token for outcomes";
    if (file.includes("config-raw")) return "opening, editor revision, load token, epoch and config resource position; obey the caller's fence decision";
    if (file.endsWith("/live.js")) return "live stream generation";
    if (file.endsWith("/ops.js")) return "operation key and token, epoch and device life carried by the key";
    if (file.endsWith("/store.js")) return "client fence: epoch, stream/request generation, resource position and device life";
    if (file.endsWith("/api.js")) return "request's captured resource/control key and its single pending transport";
    if (file.endsWith("/main.js")) return "live/bootstrap generation; frame requests capture epoch and device life";
    if (file.includes("overlays")) return "page opening for DOM; exact overlay id and operation token for each row's outcome";
    if (file.includes("device")) return "page opening, exact device id, epoch, life, scene and control owner; form/row revision where edited";
    if (file.includes("config.js")) return "opening, edit-row visit, exact device id, life, revision and config membership";
    if (file.includes("health")) return "opening and epoch for log data; current reader's filter and scroll position";
    if (file.includes("router")) return "current route and page/dialog opening";
    if (file.includes("preview") || file.endsWith("/dom.js")) return "mounted DOM/canvas target and its current device/frame owner; callback's opening";
    if (file.includes("model.js")) return "pure current-state projection, exact device/scene/overlay id; guarded caller owns async admission";
    if (file.includes("theme") || file.includes("session")) return "current browser preference/session, synchronously changed by its current owner";
    return "current function inputs; imported caller owns async admission";
  };
  /** @type {any[]} */
  const out = [];
  for (const { file, src } of files) {
    if (file.endsWith("/ordering.js")) continue;
    const code = r4xCodeOnly(src); const fns = r4xFunctions(code);
    const holder = (/** @type {number} */ at) => fns.filter((f) => f.start <= at && at <= f.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    const declarations = [...code.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => ({ name: m[1], at: m.index, fn: holder(m.index) }));
    const add = (/** @type {number} */ at, /** @type {string} */ name, /** @type {string} */ kind) => out.push({ file, line: r4xLineOf(code, at), fn: holder(at)?.name ?? "(module)", name, kind, owner: owners(file) });
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)(\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?\s*(=(?!=|>)|\+\+|--|\+=|-=|&&=|\|\|=|\?\?=)/g)) {
      if (/\b(?:let|const|var)\s*$/.test(code.slice(Math.max(0, m.index - 16), m.index))) continue;
      const binding = declarations.filter((d) => d.name === m[1] && d.at < m.index && (!d.fn || d.fn.start <= m.index && m.index <= d.fn.end)).at(-1);
      if (m[2] || binding && binding.fn !== holder(m.index)) add(m.index, `${m[1]}${m[2] ?? ""}`, m[3]);
    }
    // Computed properties are state writes too (including nested keys),
    // independent of whether their base is a local builder or outer cache.
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?=(?:\.[A-Za-z_$][\w$]*\s*)*\[)/g)) {
      if (["const", "let", "var", "return"].includes(m[1]) || code[m.index - 1] === ".") continue;
      let cursor = m.index + m[1].length; let computed = false;
      for (;;) {
        while (/\s/.test(code[cursor] ?? "")) cursor += 1;
        const property = /^\.[A-Za-z_$][\w$]*/.exec(code.slice(cursor));
        if (property) { cursor += property[0].length; continue; }
        if (code[cursor] !== "[") break;
        computed = true; cursor = r4xMatch(code, cursor) + 1;
      }
      const operation = /^(=(?!=|>)|\+\+|--|\+=|-=|&&=|\|\|=|\?\?=)/.exec(code.slice(cursor));
      if (computed && operation) add(m.index, src.slice(m.index, cursor).trim().replace(/\s+/g, " "), operation[1]);
    }
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(set|delete|add|clear|push|splice)\s*\(/g)) add(m.index, m[1], `.${m[2]}`);
  }
  return out;
}
/** Line-independent inventory key; adding or changing a writer requires ownership review. @param {any} row */
const r6xWriteKey = (row) => `${row.file} · ${row.fn} · ${row.name} · ${row.kind} · ${row.owner}`;

/** A row as the inventory lists it: no line number, so code that moves keeps its row. @param {any} row */
const r4xKey = (row) => `${row.file} · ${row.fn} · ${row.kind} · ${row.effects.join(", ") || "none"}`;
/**
 * The identities an effect depends on: its projection (note §1, §3). The
 * one guard in ops.js checks exactly these for the effect, with the values
 * captured when the operation began.
 *
 * @param {string} file @param {string} effect @param {string} [fn] the function that holds the continuation
 */
function r4xProjection(file, effect, fn = "") {
  if (file.endsWith("/pages/device.js") && effect === "page callback" && fn === "onPreviewFailure") return r8Project(["scene", "epoch", "life", "owner"], "preview feedback follows its scene, epoch, life and owner");
  const settings = /settings-form/.test(file);
  const raw = /config-raw/.test(file);
  const config = /pages\/config\.js/.test(file);
  // The live channel's continuations belong to one EventSource: its generation owns connection feedback and event admission.
  if (/live\.js/.test(file) && effect !== "store") return r8Project(["stream"], "stream generation (it owns connection feedback and event admission)");
  const device = /device\.js|devices\.js|config\.js|recovery-dialog|settings-form/.test(file) && !/addDevice|copyScene/.test(fn);
  const member = (settings && fn === "save") || (config && /patch|adopt/.test(fn));
  const slot = `slot token · epoch${device ? " · life" : ""}${settings || fn === "copyScene" ? " · scene" : ""}${file.endsWith("/overlays.js") ? " · overlay id" : ""}`;
  switch (effect) {
    case "slot note":
    case "slot failure text":
    case "slot outcome":
      return r8Project(["token", "epoch", ...(device ? ["life"] : []), ...(settings || fn === "copyScene" ? ["scene"] : []), ...(file.endsWith("/overlays.js") ? ["overlay"] : []), ...(member ? ["membership"] : [])], `${slot}${member ? " · config membership" : ""}`);
    case "slot drop":
      return r8Project(["token", "opening"], "the dropped slot still holds the operation this one superseded (its token) · opening");
    case "close":
    case "blur":
    case "focus":
      return r8Project(["opening", ...(config ? ["visit"] : []), "revision", "epoch", "life", ...(member ? ["membership"] : [])], `opening · ${config ? "edit-row visit · " : ""}editor revision · epoch · life${member ? " · config membership" : ""}; blur and focus only inside the opening's root`);
    case "reset":
      return settings ? r8Project(["draft", "scene", "epoch", "life", "membership"], "each submitted edit's draft (monotonic acknowledgement) · scope (scene, epoch, life) · config membership") : r8Project(["opening", "revision"], "opening · editor revision (the form's)");
    case "field rejection":
      // Not Save's acknowledgement: no config membership (a blob-only device previews too), and the scene definition is part of it.
      return r8Project(["schema", "draft", "scene", "epoch", "life"], "scene-definition generation (the definition pixdcon judged the value by is the one the form shows) · the submitted edit's own draft (the edit of that key is still the one that was sent) · scope (scene, epoch, life)");
    case "request start": {
      const scope = settings ? "opening, scene, epoch, life" : raw || file.endsWith("/health.js") ? "opening, epoch" : fn === "copyScene" ? "scene, epoch" : fn === "addDevice" || file.endsWith("/overlays.js") ? "epoch" : "epoch, life";
      return r8Project(scope.split(/, */), `the identities captured when the operation began, inherited and never re-read (scope: ${scope}), checked before the request starts`);
    }
    case "page state":
    case "preview feedback":
    case "page callback":
      // The end of a control's request forgets the slider's level (gate r5a E): only while the slider is still that
      // request's. Its owner is the brightness slot of one life of the device in one run, and the operation in it.
      if (/pages\/device\.js/.test(file) && fn === "act") return r8Project(["owner", "epoch", "life", "token", "opening"], "the slider's current owner: the brightness slot of the device's life (epoch · life) that the level was typed for · that slot's own operation (slot token) · opening");
      return settings ? r8Project(["opening", "scene", "epoch", "life", "schema", "draft"], "opening · scope (scene, epoch, life) · scene-definition generation · newest draft and > committed") : raw ? r8Project(["opening", "token", "revision", "epoch"], "opening · load token · editor revision · epoch") : config ? r8Project(["opening", "visit"], "opening · edit-row visit") : r8Project(["opening", "token"], "opening · slot token");
    case "DOM write":
      return raw ? r8Project(["opening", "revision", "epoch", "resource"], "opening · editor revision · epoch · config resource (a replacement load writes the new run's text)") : r8Project([], "none beyond render's reading of the current state");
    case "enable/disable":
      return r8Project(["token", "epoch", ...(device ? ["life"] : []), ...(settings || fn === "copyScene" ? ["scene"] : []), ...(file.endsWith("/overlays.js") ? ["overlay"] : [])], slot);
    case "connection feedback":
    case "timer start":
      return r8Project(["stream"], "stream generation (it owns connection feedback and event admission)");
    case "render":
      return r8Project([], "none: render reads the current state");
    case "store":
      return r8Project([], "none: the store's fence decides (ordering.js)");
    default:
      return "?";
  }
}
/**
 * Every continuation of web/js at fbf3f61, with its effects (r4xKey): the
 * suite fails on one that is not listed here and on a listed one that
 * vanished. Phase B updates this list with the code, and each row's
 * projection follows from its effects (r4xProjection).
 */
const R4_INVENTORY = [
  "web/js/api.js · request · await · none",
  "web/js/api.js · request · await · none",
  "web/js/api.js · requestFrame · await · none",
  "web/js/api.js · requestFrame · await · none",
  "web/js/api.js · bound · timer setTimeout · none",
  "web/js/components/recovery-dialog.js · retry · ops done · render",
  "web/js/components/recovery-dialog.js · retry · ops failed · render",
  "web/js/components/recovery-dialog.js · retry · await · store",
  "web/js/components/settings-form.js · load · ops failed · page state, render",
  "web/js/components/settings-form.js · save · ops done · field rejection, page callback, page state, preview feedback, render, request start, reset, slot drop, slot note, store",
  "web/js/components/settings-form.js · save · ops describe · slot failure text",
  "web/js/components/settings-form.js · save · ops failed · field rejection, page callback, page state, preview feedback, render, request start, slot drop, store",
  "web/js/components/settings-form.js · revert · ops done · page callback, page state, preview feedback",
  "web/js/components/settings-form.js · revert · ops describe · slot failure text",
  "web/js/components/settings-form.js · clearOverlays · ops done · slot note",
  "web/js/components/settings-form.js · clearOverlays · ops describe · slot failure text",
  "web/js/components/settings-form.js · enqueue · await · field rejection, page callback, page state, preview feedback, render, request start, slot drop, store",
  "web/js/components/settings-form.js · enqueue · await · none",
  "web/js/components/settings-form.js · retryEnd · await · store",
  "web/js/components/settings-form.js · leave · await · none",
  "web/js/components/settings-form.js · leave · await · store",
  "web/js/components/settings-form.js · load · await · store",
  "web/js/components/settings-form.js · sendPreview · await · field rejection, page callback, page state, preview feedback, render, slot drop, store",
  "web/js/components/settings-form.js · save · await · store",
  "web/js/components/settings-form.js · revert · await · slot drop, store",
  "web/js/components/settings-form.js · clearOverlays · await · store",
  "web/js/live.js · open · SSE onopen · close, connection feedback, page state, timer start",
  "web/js/live.js · open · SSE onerror · close, connection feedback, page state, timer start",
  "web/js/live.js · open · SSE handler · close, connection feedback, page state, timer start",
  "web/js/live.js · lose · timer setTimeout · none",
  "web/js/live.js · armSilence · timer setTimeout · close, connection feedback, page state, timer start",
  "web/js/main.js · (module) · await · request start, store, timer start",
  "web/js/main.js · loadFrame · await · store",
  "web/js/main.js · (module) · timer setInterval · none",
  "web/js/ops.js · run · .then · slot outcome",
  "web/js/pages/config-raw.js · load · ops done · DOM write, page state, render, request start, store",
  "web/js/pages/config-raw.js · load · ops describe · slot failure text",
  "web/js/pages/config-raw.js · load · ops failed · page state, render",
  "web/js/pages/config-raw.js · save · ops done · page state, slot note",
  "web/js/pages/config-raw.js · save · ops describe · slot failure text",
  "web/js/pages/config-raw.js · save · ops failed · page state",
  "web/js/pages/config-raw.js · reloadFromDisk · ops done · slot note",
  "web/js/pages/config-raw.js · reloadFromDisk · ops describe · slot failure text",
  "web/js/pages/config-raw.js · load · await · store",
  "web/js/pages/config-raw.js · save · await · store",
  "web/js/pages/config-raw.js · reloadFromDisk · await · DOM write, page state, render, request start, slot drop, store",
  "web/js/pages/config-raw.js · reloadFromDisk · await · DOM write, page state, render, store",
  "web/js/pages/config.js · patch · ops done · blur, close, page state",
  "web/js/pages/config.js · addDevice · ops done · reset, slot note",
  "web/js/pages/config.js · patch · await · store",
  "web/js/pages/config.js · adopt · await · store",
  "web/js/pages/config.js · addDevice · await · store",
  "web/js/pages/device.js · act · ops done · page state",
  "web/js/pages/device.js · act · ops failed · page state",
  "web/js/pages/device.js · copyScene · ops done · slot note",
  "web/js/pages/device.js · act · await · store",
  "web/js/pages/devices.js · addDevice · ops done · slot note",
  "web/js/pages/devices.js · chooseScene · await · store",
  "web/js/pages/devices.js · restore · await · store",
  "web/js/pages/devices.js · addDevice · await · store",
  "web/js/pages/health.js · loadLog · ops failed · render",
  "web/js/pages/health.js · loadLog · await · store",
  "web/js/pages/overlays.js · clear · ops done · slot note",
  "web/js/pages/overlays.js · clear · await · store",
];
// </effects-r4>

const { readdirSync: r4ReadDir, readFileSync: r4ReadFile, statSync: r4Stat } = await import("node:fs");
/** The files of web/js, as the extractor reads them. @returns {Array<{file: string, src: string}>} */
function r4WebFiles() {
  const v2 = new URL("../../", import.meta.url);
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    r4ReadDir(new URL(dir, v2))
      .sort()
      .flatMap((name) => (r4Stat(new URL(`${dir}${name}`, v2)).isDirectory() ? walk(`${dir}${name}/`) : name.endsWith(".js") ? [`${dir}${name}`] : []));
  return walk("web/js/").map((file) => ({ file, src: r4ReadFile(new URL(file, v2), "utf8") }));
}
/** What the extraction finds that the list does not hold, and what the list holds that the extraction no longer finds. @param {any[]} rows */
function r4InventoryDiff(rows) {
  const left = [...R4_INVENTORY];
  /** @type {string[]} */
  const unlisted = [];
  for (const row of rows) {
    const i = left.indexOf(r4xKey(row));
    if (i === -1) unlisted.push(`${r4xKey(row)}  (${row.site})`);
    else left.splice(i, 1);
  }
  return { unlisted, vanished: left };
}

test("r4 inventory: the extraction re-run over web/js finds exactly the listed continuations and effects; the line search finds nothing outside them", () => {
  const { rows, hits, unmapped } = r4xExtract(r4WebFiles());
  assert.deepEqual(unmapped, [], "every hit of the independent line search lies inside a continuation of the inventory");
  assert.ok(hits > 50, "the line search ran");
  const { unlisted, vanished } = r4InventoryDiff(rows);
  assert.deepEqual({ unlisted, vanished }, { unlisted: [], vanished: [] }, "a continuation or an effect was added or vanished: list it in R4_INVENTORY with its projection (design note §2)");
  // Each effect declares the identities it depends on (its projection): the one guard checks those, captured at the start.
  const unprojected = rows.flatMap((row) => row.effects.filter((/** @type {string} */ e) => r4xProjection(row.file, e, row.fn) === "?").map((/** @type {string} */ e) => `${row.site}: ${e}`));
  assert.deepEqual(unprojected, [], "every effect of the inventory has a projection");
});

test("r4 inventory: every asynchronous render-state writer has an ownership obligation; arbitrary feedback caches cannot disappear (gate r5b I)", async () => {
  const files = r4WebFiles();
  const inventory = r4xExtract(files);
  for (const row of inventory.rows)
    for (const write of row.writes) assert.ok(write.owner && write.owner !== "?", `${row.site}: ${write.name} needs its ownership check`);
  for (const name of ["r6FeedbackCache", "unanticipatedFeedback", "differentStateName"]) {
    const url = await r4Mutant("pages/device.js", R6_FEEDBACK_MUTANT.map(([a, b]) => [a, b.replaceAll("r6FeedbackCache", name)]));
    const source = Buffer.from(url.split(",")[1], "base64").toString("utf8");
    const mutant = r4xExtract(files.map((file) => file.file === "web/js/pages/device.js" ? { ...file, src: source } : file));
    assert.ok(mutant.rows.some((row) => row.file === "web/js/pages/device.js" && row.kind === "await" && row.writes.some((/** @type {any} */ write) => write.name === name)), `${name}: the work continuation's render-state write is inventoried`);
    assert.ok(r4InventoryDiff(mutant.rows).unlisted.some((row) => row.startsWith("web/js/pages/device.js")), "the added async state effect requires inventory review");
  }
});

test("r4 inventory: persistent UI state writers across imported helpers all declare ownership (r6)", async () => {
  const { createHash } = await import("node:crypto");
  const rows = r6xPersistentWrites(r4WebFiles());
  assert.ok(rows.length > 100, "all UI modules, not only async spans, were scanned");
  for (const row of rows) assert.ok(row.owner.length > 10, `${r6xWriteKey(row)} requires ownership review`);
  const digest = createHash("sha256").update(rows.map(r6xWriteKey).join("\n")).digest("hex");
  // PIXD-96 B1a inventory review: 377 -> 384 writers; extractor unchanged.
  // API busy.add/request-delete -> busy.set/release-delete: captured request
  // and epoch (control reuse, old cleanup, same-run exclusivity stories).
  // current.owner/effect/follow: immutable captured operation (inherited child
  // and named-effect projection stories). Raw render/mount epoch, errorLine
  // and again: current opening/restart (replacement-load story and Raw's
  // admitted-effect runtime probe). Exact before/after rows in the B1a report.
  assert.equal(digest, "2de91f910f50acedf31143d0c3cbe81350eab7e11252536c9f6639fc25421295", "a persistent binding/object/collection writer changed: inventory its ownership and name a runtime case before accepting it");
});
test("r4 inventory self-test: arbitrary new persistent caches are reported even outside local render readers (r6)", () => {
  for (const name of ["newAsyncCache", "unlistedState", "anotherFeedbackStore"]) {
    const source = `let ${name}=null; export async function work(){await Promise.resolve();${name}='late';} export const read=()=>${name};`;
    const rows = r6xPersistentWrites([{ file: "web/js/view/fake-state.js", src: source }]);
    assert.ok(rows.some((row) => row.name === name && row.fn === "work"), `${name}: a persistent write needs ownership review regardless of reader name or module boundary`);
    const computed = `const ${name}={}; export async function work(){await Promise.resolve();${name}[keys[index]].feedback='late';} export const read=()=>${name};`;
    assert.ok(r6xPersistentWrites([{ file: "web/js/view/fake-state.js", src: computed }]).some((row) => row.name === `${name}[keys[index]].feedback` && row.fn === "work"), "computed cache writes require the same ownership review");
  }
});

test("r4 inventory self-test: one fake site of each kind is reported as unlisted, a removed file's rows as vanished", () => {
  const fake = `import { request } from "../api.js";
import { follow, start } from "../ops.js";
let open = null;
const book = { saved() {}, rejected() {} };
function paint(root) { root.textContent = "x"; }
function lane(step) { return (async () => { await null; return step(); })(); }
const settledFake = () => { open = null; };
export function fake(root, source) {
  start("fake", async () => { await request("GET", "/a"); paint(root); }, { done: () => "Done", failed: () => { open = null; }, describe: () => "Not done" });
  follow("fake-2", async () => request("GET", "/b"), { done: settledFake });
  request("GET", "/c").then(() => paint(root)).catch(() => root.focus()).finally(() => root.blur());
  setTimeout(() => paint(root), 1);
  setInterval(() => root.blur(), 1);
  source.addEventListener("snapshot", () => paint(root));
  source.onopen = () => root.focus();
  source.onerror = () => { open = null; };
  lane(() => request("DELETE", "/d"));
}
export async function mark(sent) { const answer = await request("PUT", "/e"); book.rejected(sent, answer.body.rejected); }
export async function acknowledge(sent) { await request("PUT", "/f"); book.saved(sent, []); }
`;
  const files = [...r4WebFiles(), { file: "web/js/pages/fake.js", src: fake }];
  const { rows, unmapped } = r4xExtract(files);
  assert.deepEqual(unmapped, [], "the fake file's sites are all continuations");
  const { unlisted } = r4InventoryDiff(rows);
  const reported = unlisted.filter((u) => u.startsWith("web/js/pages/fake.js"));
  /** @type {Array<[string, RegExp]>} */
  const expected = [
    ["an await whose continuation calls a helper that writes UI", / · fake · await · .*DOM write/],
    ["a done that returns the slot's note", / · fake · ops done · .*slot note/],
    ["a named done callback (indirection)", / · fake · ops done · .*close/],
    ["a failed callback", / · fake · ops failed · .*close/],
    ["a describe (the slot's failure text)", / · fake · ops describe · .*slot failure text/],
    ["a then", / · fake · \.then · .*DOM write/],
    ["a catch", / · fake · \.catch · .*focus/],
    ["a finally", / · fake · \.finally · .*blur/],
    ["a setTimeout", / · fake · timer setTimeout · .*DOM write/],
    ["a setInterval", / · fake · timer setInterval · .*blur/],
    ["an SSE listener", / · fake · SSE handler · .*DOM write/],
    ["an SSE onopen", / · fake · SSE onopen · .*focus/],
    ["an SSE onerror", / · fake · SSE onerror · .*close/],
    ["a deferred `return step()` of a lane, resolved to the request its caller queued", / · lane · await · .*request start/],
    // Field rejection is an effect of its own (gate note2 M2): it is not listed as Save's acknowledgement ("reset"), nor the other way round.
    ["an answer's `rejected` map marked on the edits (field rejection, and not reset)", / · mark · await · field rejection {2}\(/],
    ["Save's acknowledgement (reset, and not field rejection)", / · acknowledge · await · reset {2}\(/],
  ];
  for (const [what, pattern] of expected) assert.ok(reported.some((u) => pattern.test(u)), `${what} is reported:\n${reported.join("\n")}`);
  // The two effects have different projections: field rejection names the scene definition and no config membership; Save's acknowledgement the reverse.
  const [rejection, acknowledgement] = ["field rejection", "reset"].map((effect) => r4xProjection("web/js/components/settings-form.js", effect, "sendPreview"));
  assert.ok(/scene-definition generation/.test(rejection) && /submitted edit's own draft/.test(rejection) && !/config membership/.test(rejection), rejection);
  assert.ok(/config membership/.test(acknowledgement) && !/scene-definition/.test(acknowledgement), acknowledgement);
  // The slider's cleanup is bound to the slider's current owner (gate r5a E): the run, the device's life and the operation, not the slot token alone.
  const cleanup = r4xProjection("web/js/pages/device.js", "page state", "act");
  assert.ok(/epoch · life/.test(cleanup) && /own operation \(slot token\)/.test(cleanup) && /current owner/.test(cleanup), cleanup);
  assert.equal(r4xExtract(r4WebFiles()).rows.filter((row) => row.file === "web/js/pages/device.js" && row.fn === "act" && row.effects.includes("page state")).length, 2, "the cleanup is the done and the failed of act");
  // A file the list holds rows of, gone: its rows are reported as vanished.
  const without = r4xExtract(r4WebFiles().filter((f) => f.file !== "web/js/pages/overlays.js"));
  assert.ok(r4InventoryDiff(without.rows).vanished.some((v) => v.startsWith("web/js/pages/overlays.js")), "the rows of a removed file are reported as vanished");
});

// The passing case stays a named todo for this run; this ordinary test makes
// the gate red until its now-obsolete R4_KNOWN entry is removed.
test("r4 harness: R4_KNOWN liveness: every executed listed case still fails", () => {
  r7RequireKnownLiveness(r7UnexpectedPasses);
});

// r7: permanent runtime certificates for all 27 reviewed sweep entries.
test("r4 harness: guard probe r6 sweep: form lifetime and legacy input boundaries", async (t) => {
  const module = await r5Module("components/settings-form.js");
  await r5Form(
    t,
    module,
    async ({ world, calls, root, form, values, edit }) => {
      await edit("2");
      r5Previews(calls).at(-1).ok();
      await settle();
      world.lives.set("d1", 2);
      world.rev++;
      r4Live(world, "device", r4View(world, "d1", world.epoch, 2, world.rev));
      const own = values("clock");
      form.setScene("clock", "Clock", { epoch: world.epoch, incarnation: 2 });
      form.update(own);
      assert.equal(
        r4Value(field(root, "n")),
        String(own.values.n.effective),
        "new life cannot retain the preceding life's edit",
      );
      for (const incarnation of [0, undefined]) {
        const state = values("clock", { effective: { n: 43 } });
        state.incarnation = incarnation;
        form.update(state);
        assert.equal(
          r4Value(field(root, "n")),
          "43",
          "legacy life metadata still admits the current caller-fenced settings",
        );
      }
      form.setScene("builtin:own", "Own mode", {
        epoch: world.epoch,
        incarnation: 2,
      });
      form.update({ ...values("clock"), scene: "builtin:own" });
      assert.equal(
        field(root, "n"),
        null,
        "a builtin cannot admit settings fields even if a payload names it",
      );
    },
  );
});

test("r4 harness: guard probe r6 sweep: first loss before any event records its own time", async (t) => {
  await r5Live(t, await r5Module("live.js"), ({ sources, live }) => {
    const before = Date.now();
    sources[0].onerror();
    const loss = live.state().lostSince;
    assert.equal(typeof loss, "number");
    assert.ok(loss >= before && loss <= Date.now());
    sources[0].onerror();
    assert.equal(live.state().lostSince, loss);
  });
});

test("r4 harness: guard probe r6 sweep: dropped Reload releases the superseded opening load state", async () => {
  await r5Raw(
    await r5Module("pages/config-raw.js"),
    async ({ world, calls, root }) => {
      const typed = '{"devices":[],"keep":"typed while opening loads"}';
      r4Type(root.querySelector("textarea"), typed);
      world.configVersion = 2;
      world.rev++;
      r4Click(root.querySelector('[data-act="reload"]'));
      await settle();
      pending(calls, "POST", "/config/reload").ok();
      await settle();
      const old = calls.findLast(
        (/** @type {any} */ c) =>
          !c.answered && c.method === "GET" && c.path.endsWith("/config/raw"),
      );
      assert.equal(old.configVersion, 2);
      world.configVersion = 3;
      world.rev++;
      r4Live(world, "config", { ...CONFIG_STATE, rev: world.rev });
      old.ok();
      await settle();
      assert.equal(r4Value(root.querySelector("textarea")), typed);
      assert.doesNotMatch(
        r4Text(root.querySelector(".edbar .state")),
        /Loading config/,
      );
      assert.match(
        r4Text(root.querySelector(".edbar .state")),
        /unsaved changes/,
      );
    },
  );
});

test("r4 harness: guard probe r6 sweep: Config route parameters preserve the reserved Add destination", async () => {
  const saved = Object.getOwnPropertyDescriptor(
    FakeElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(FakeElement.prototype, "scrollIntoView", {
    value() {},
    configurable: true,
  });
  try {
    for (const params of [{}, { open: "" }, { open: "add" }, { open: "d1" }]) {
      const world = r4World({ devices: [{ name: "d1" }, { name: "add" }] });
      const calls = r4Server(world);
      r4NewEpoch(world);
      const module = (await r5Module("pages/config.js")).page;
      const root = pageRoot();
      try {
        module.mount(root, params);
        await r4AnswerAll({ calls });
        assert.equal(
          root.querySelectorAll(".ct-edit").length,
          params.open === "d1" ? 1 : 0,
          "only a device route opens an edit row; Add remains reserved even with a device named add",
        );
      } finally {
        module.unmount();
        root.remove();
        await r4AnswerAll({ calls });
      }
    }
  } finally {
    if (saved)
      Object.defineProperty(FakeElement.prototype, "scrollIntoView", saved);
    else Reflect.deleteProperty(FakeElement.prototype, "scrollIntoView");
  }
});

test("r4 harness: guard probe r6 sweep: rejected settings advance position without freshness and malformed views remain classified", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at("18:42:00")) });
  const m = await r5Module("store.js");
  const store = m.createStore();
  const stream = openSource(store.fence(), "stream");
  store.applyEvent({
    type: "snapshot",
    epoch: A,
    seq: 10,
    stream,
    data: snapshot(A, 10, [view("d1", { incarnation: 1 })]),
  });
  const current = sceneSettings("d1", "clock", {
    epoch: A,
    incarnation: 1,
    rev: 2,
  });
  store.applyEvent({
    type: "settings",
    epoch: A,
    seq: 11,
    stream,
    data: current,
  });
  const dataAt = store.getState().dataAt;
  t.mock.timers.tick(1000);
  const dropped = store.applyEvent({
    type: "settings",
    epoch: A,
    seq: 12,
    stream,
    data: { ...current, rev: 1 },
  });
  assert.equal(dropped.action, "drop");
  assert.equal(store.getState().seq, 12);
  assert.equal(store.getState().settings.get("d1/clock"), current);
  assert.equal(
    store.getState().dataAt,
    dataAt,
    "a rejected settings carrier cannot publish fresh data time",
  );
  assert.equal(
    store.applyEvent({ type: "device", epoch: A, seq: 13, stream, data: 7 })
      .reason,
    "no_view",
    "shape rejection precedes per-view fence admission",
  );
});

test("r4 harness: guard probe r6 sweep: Raw opening owns its root writers", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../../web/js/pages/config-raw.js", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    [...source.matchAll(/\broot\s*=(?!=)\s*([^;]+);/g)].map((m) => m[1].trim()),
    ["null", "target", "null"],
  );
  assert.match(
    source,
    /mount\(target,[\s\S]*?opened \+= 1;[\s\S]*?root = target;/,
  );
  assert.match(source, /unmount\(\) \{\s*opened \+= 1;[\s\S]*?root = null;/);
});

// r7 K1/K2: mutants run through the same public stories as their controls.
const R7_OVERLAY_MUTANTS = [
  {
    name: "X1",
    body: "const row = getState().overlays.find((row) => row.id === id); return `overlay:${row?.device}/${row?.kind}`;",
  },
  {
    name: "X1c",
    body: 'const row = getState().overlays.find((row) => row.id === id); return row?.kind === "setting" ? `overlay:${row.device}/${row.kind}` : `overlay:${id}`;',
  },
];
for (const { name, body } of R7_OVERLAY_MUTANTS)
  test(`r4 harness self-test: r7 K1 ${name}: device and kind cannot stand in for overlay id`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const mutant = await r7OverlaySlotMutant(body);
    for (const overlap of [false, true])
      for (const end of R4_ENDS) {
        await r6Overlays(
          await r5Module("pages/overlays.js"),
          overlap,
          end,
          t,
          true,
        );
        await assert.rejects(
          r6Overlays(mutant, overlap, end, t, true),
          (/** @type {any} */ error) => {
            assert.equal(error.name, "AssertionError");
            assert.match(error.message, /o1 cannot disable o2|o2 owns neither/);
            t_log(
              `${name} ${overlap ? "overlap" : "replacement"}/${end}: ${error.message.split("\n")[0]}`,
            );
            return true;
          },
        );
      }
  });

const R7_RETURN_MUTANTS = [
  {
    name: "X10",
    edits: [
      [
        "let previewFailure = null;",
        "let previewFailure = null; let r7ReturnFailure = null;",
      ],
      [
        "start(key, async () => applyAnswer(await send(key)), {",
        `start(key, async () => { try { return applyAnswer(await send(key)); } catch (error) { if (control === "return") { r7ReturnFailure = String(error); render(getState()); } throw error; } }, {`,
      ],
      [
        'const returning = opOf("return", view);',
        'const returning = { ...opOf("return", view), ...(r7ReturnFailure ? { failure: r7ReturnFailure } : {}) };',
      ],
    ],
  },
  {
    name: "X10b",
    edits: [
      [
        'const returning = opOf("return", view);',
        'const returning = { ...opOf("return", view), failure: [...state.ops].find(([key, slot]) => key.includes("restore") && key.split(/[:/@]/).includes(name) && slot.failure)?.[1].failure ?? null };',
      ],
    ],
  },
];
for (const { name, edits } of R7_RETURN_MUTANTS)
  test(`r4 harness self-test: r7 K2 ${name}: Return failure is observed across runs and lives`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const change of ["epoch", "reincarnate"])
      for (const end of /** @type {R4End[]} */ (["500", "timeout"])) {
        const kind = r4KindOf("device return");
        assert.deepEqual(await r4Case(t, kind, change, end), []);
        const fresh = edits.map(
          ([from, to]) =>
            /** @type {[string, string]} */ ([
              from,
              `${to}\n// ${change}/${end}\n`,
            ]),
        );
        // In a new epoch B1a retires the old slot before it can hold a
        // failure. Retain X10b's foreign-slot reader and restore that path
        // by removing central token/epoch admission only for this mutant.
        /** @type {Record<string, string>} */
        const replace = name === "X10b" && change === "epoch"
          ? { "../ops.js": await r4Mutant("ops.js", R4_B1A_OLD_EPOCH_GUARD_REMOVALS) }
          : {};
        const device = (await r5Module("pages/device.js", fresh, replace)).page;
        const differences = await r4Case(t, kind, change, end, {
          modules: { device },
        });
        const failure = differences.find((d) =>
          /action and adopt \[epoch, life, token\].*failed to answer|action and adopt \[epoch, life, token\].*15 s/.test(
            d,
          ),
        );
        assert.ok(failure, differences.join("\n"));
        t_log(`${name} ${change}/${end}: ${failure}`);
      }
  });

test("r4 harness self-test: no longer reachable: r7 K2 X10b cannot read an old epoch's failure behind central ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const kind = r4KindOf("device return");
  const original = R7_RETURN_MUTANTS.find((mutant) => mutant.name === "X10b");
  assert.ok(original);
  const edits = /** @type {Array<[string, string]>} */ (original.edits);
  for (const end of /** @type {R4End[]} */ (["500", "timeout"])) {
    assert.deepEqual(await r4Case(t, kind, "epoch", end), [], "the real Return control passes");
    // Exact A7 page-local recipe; no central guard is removed. Reincarnation
    // remains reachable and is still caught under the original test name.
    const fresh = edits.map(([from, to]) => /** @type {[string, string]} */ ([from, `${to}\n// epoch/${end}\n`]));
    const device = (await r5Module("pages/device.js", fresh)).page;
    assert.deepEqual(await r4Case(t, kind, "epoch", end, { modules: { device } }), [], `no longer reachable: X10b cannot display an old run's Return failure (${end})`);
  }
});

// ---------------------------------------------------------------------------
// r7: extract rendered operation readers and persistent async outcome reads.
// No list of controls or DOM selectors: sources come from the effect inventory,
// ops imports, render call graph, and persistent bindings read by that graph.
// ---------------------------------------------------------------------------

// r7 identity vocabulary: design-note §1 plus the resource identity added in
// r6. These are axes/interpretations, never an identity × kind coverage list.
const R7_IDENTITY_WORDS = {
  epoch: /\bepoch\b/,
  life: /\blife\b/,
  scene: /\bscene\b(?!-definition)/,
  schema: /scene-definition|\bdefinition\b/,
  draft: /\bdraft\b/,
  membership: /\bmembership\b/,
  opening: /\bopening\b/,
  visit: /edit-row visit/,
  revision: /editor revision/,
  overlay: /overlay id/,
  owner: /slider's current owner/,
  token: /slot token|load token|\(its token\)/,
  stream: /stream generation/,
  resource: /config resource/,
};

/** @param {Array<{file: string, src: string}>} files */
function r7OutcomeSites(files) {
  const inventory = r4xExtract(files).rows;
  const structure = r8Structure(files, inventory);
  const modules = files.map(({ file, src }) => {
    const code = r4xCodeOnly(src);
    return {
      file,
      src,
      code,
      fns: r8Functions(src),
      rows: inventory.filter((row) => row.file === file),
      structure: structure.find((m) => m.file === file) ?? assert.fail(`source structure missing: ${file}`),
    };
  });
  const graphs = new Map(
    modules.map((m) => [m.file, new Set(m.fns.filter((fn) =>
      R4X_EFFECTS.find(([effect]) => effect === "DOM write")?.[1].test(m.code.slice(fn.start, fn.end + 1)) ||
      /\.(?:disabled|className)\s*=(?!=)/.test(m.code.slice(fn.start, fn.end + 1)),
    ).map((fn) => fn.name))]),
  );
  // A page may move a pure outcome projection into a module with no async
  // rows of its own. Follow those readers transitively too; the async effect
  // still belongs to the caller's inventory.
  const pureReaders = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of modules)
      for (const fn of m.fns) {
        const body = m.code.slice(fn.start, fn.end + 1);
        if (
          pureReaders.has(fn.name) ||
          /\b(?:await|start|follow|request)\b\s*\(?/.test(body) ||
          /\.(?:textContent|innerHTML|value|disabled)\s*=(?!=)/.test(body)
        )
          continue;
        if (
          /\.ops\b|\b(?:op|slotBusy)\s*\(/.test(body) ||
          m.structure.registry.some((read) => fn.start <= read.at && read.end <= fn.end + 1) ||
          m.structure.callbacks.some((callback) => [...m.code.slice(callback.at, callback.end + 1).matchAll(/\b([A-Za-z_$][\w$]*)\s*=(?!=|>)/g)].some((write) => new RegExp(`\\b${write[1]}\\b`).test(body))) ||
          [...body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].some(
            (call) => pureReaders.has(call[1]),
          )
        ) {
          pureReaders.add(fn.name);
          changed = true;
        }
      }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of modules) {
      const reached = /** @type {Set<string>} */ (graphs.get(m.file));
      const synchronous = new Set(["map", "filter", "find", "findIndex", "findLast", "some", "every", "forEach", "reduce", "reduceRight", "sort", "flatMap", "from"]);
      for (const fn of m.fns.filter((fn) => reached.has(fn.name))) {
        for (const callback of m.fns.filter((child) => child !== fn && fn.start <= child.at && child.end <= fn.end && synchronous.has(child.caller)))
          if (!reached.has(callback.name)) { reached.add(callback.name); changed = true; }
        for (const { node } of m.structure.nodes)
          if (node.type === "CallExpression" && fn.start <= node.start && node.end - 1 <= fn.end && synchronous.has(node.callee.property?.name))
            for (const argument of node.arguments)
              if (argument.type === "Identifier" && m.fns.some((child) => child.name === argument.name) && !reached.has(argument.name)) { reached.add(argument.name); changed = true; }
      }
      for (const fn of m.fns)
        if (reached.has(fn.name))
          for (const call of m.code
            .slice(fn.start, fn.end + 1)
            .matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
            if (
              m.fns.some(
                (f) =>
                  f.name === call[1] &&
                  !/\b(?:await|start|follow|request)\s*\(?/.test(
                    m.code.slice(f.start, f.end + 1),
                  ),
              ) &&
              !reached.has(call[1])
            ) {
              reached.add(call[1]);
              changed = true;
            }
            // Imported read helpers, unlike API/store writers, can project an
            // operation registry into this renderer (failedEnds today).
            for (const other of modules)
              if (other !== m)
                for (const exported of other.fns.filter(
                  (f) =>
                    (m.structure.bindings.has(call[1]) ? m.structure.bindings.get(call[1]).file === other.file && f.name === m.structure.bindings.get(call[1]).imported : f.name === call[1]) &&
                    (pureReaders.has(f.name) ||
                      /\.ops\b/.test(other.code.slice(f.start, f.end + 1))),
                ))
                  if (!graphs.get(other.file)?.has(exported.name)) {
                    graphs.get(other.file)?.add(exported.name);
                    changed = true;
                  }
          }
    }
  }
  /** @type {any[]} */
  const sites = [];
  for (const m of modules) {
    if (m.file.endsWith("/ops.js") || m.file.endsWith("/store.js"))
      continue;
    const reachable = /** @type {Set<string>} */ (graphs.get(m.file));
    const holder = (/** @type {number} */ at) =>
      m.fns
        .filter((f) => f.start <= at && at <= f.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    // A wrapper returning an operation (opOf) is instrumented at its callers,
    // so Return and Brightness never collapse into one generic helper site.
    const opReaders = new Set(["op", ...[...m.structure.bindings].filter(([, binding]) => binding.imported === "op" && binding.file.endsWith("/ops.js")).map(([name]) => name)]);
    const busyReaders = new Set(["slotBusy", ...[...m.structure.bindings].filter(([, binding]) => binding.imported === "busy" && binding.file.endsWith("/ops.js")).map(([name]) => name)]);
    const wrappers = m.fns
      .filter(
        (f) =>
          new RegExp(`^\\s*(?:${[...opReaders].join("|")})\\s*\\(`).test(m.code.slice(f.start, f.end + 1)) &&
          [...m.code.matchAll(new RegExp(`\\b${f.name}\\s*\\(`, "g"))].some(
            (call) => call.index < f.at || call.index > f.end,
          ),
      )
      .map((f) => f.name);
    const readers = new Set([...opReaders, ...busyReaders, ...wrappers]);
    const add = (
      /** @type {number} */ at,
      /** @type {number} */ end,
      /** @type {string} */ type,
      /** @type {string[]} */ variants,
    ) => {
      const text = m.src.slice(at, end);
      const fn = holder(at);
      const anchor = `${m.file} · ${type} · ${text.replace(/\s+/g, " ")}`;
      const ordinal = sites.filter((s) => s.anchor === anchor).length;
      sites.push({
        id: `${anchor} · ${ordinal}`,
        anchor,
        file: m.file,
        at,
        end,
        text,
        type,
        variants,
        fn: fn?.name,
        line: r4xLineOf(m.code, at),
      });
    };
    for (const call of m.code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const fn = holder(call.index);
      if (
        !fn ||
        !reachable.has(fn.name) ||
        wrappers.includes(fn.name) ||
        !readers.has(call[1])
      )
        continue;
      const end = r4xMatch(m.code, call.index + call[0].length - 1) + 1;
      const before = m.code.slice(
        Math.max(fn.start, call.index - 100),
        call.index,
      );
      const alias = /\b(?:const|let)\s+(\w+)\s*=\s*$/.exec(before)?.[1];
      const direct = /^\s*\??\.(busy|failure|note|label|value)\b/.exec(
        m.code.slice(end),
      );
      const props = new Set(
        direct
          ? [direct[1]]
          : alias
            ? [
                ...m.code
                  .slice(fn.start, fn.end + 1)
                  .matchAll(
                    new RegExp(
                      `\\b${alias}\\??\\.(busy|failure|note|label|value)\\b`,
                      "g",
                    ),
                  ),
              ].map((hit) => hit[1])
            : ["failure", "note"],
      );
      const variants = [
        ...new Set([...props].map((p) => (p === "label" ? "busy" : p))),
      ];
      if (busyReaders.has(call[1])) variants.splice(0, variants.length, "busy");
      if (variants.length)
        add(
          call.index,
          end,
          busyReaders.has(call[1]) ? "boolean" : "slot",
          variants,
        );
    }
    // Registry iteration is a rendered outcome reader too (failedEnds).
    for (const hit of m.structure.registry) {
      const fn = holder(hit.at);
      if (fn && reachable.has(fn.name)) {
        add(hit.at, hit.end, "registry", [
          "failure",
          "busy",
        ]);
        sites.at(-1).busyValue = /\.value\s*===\s*["']([^"']+)["']/.exec(
          m.src.slice(fn.start, fn.end + 1),
        )?.[1];
      }
    }
    // Direct async DOM results (Raw's takeText today) bypass render-state
    // readers. Inventory spans discover and instrument their actual writers.
    for (const hit of m.code.matchAll(
      /\b([A-Za-z_$][\w$.]*)\.(value|textContent|innerHTML|disabled)\s*=(?!=)/g,
    )) {
      const carried = m.rows.some(
        (row) =>
          row.effects.includes("DOM write") &&
          [row.range, ...row.spans].some(
            ([from, to]) => hit.index >= from && hit.index <= to,
          ),
      );
      if (!carried) continue;
      const from = hit.index + hit[0].length;
      const [, last] = r4xExpression(m.code, from);
      add(hit.index, last + 1, "writer", ["foreign"]);
      Object.assign(sites.at(-1), {
        writer: { node: hit[1], property: hit[2], from, to: last + 1 },
      });
    }
    for (const hit of m.code.matchAll(/(?:\?\.|\.)reset\(\)/g)) {
      const carried = m.rows.some(
        (row) =>
          row.effects.includes("reset") &&
          [row.range, ...row.spans].some(
            ([from, to]) => hit.index >= from && hit.index <= to,
          ),
      );
      if (!carried) continue;
      let at = hit.index;
      while (/\s/.test(m.code[at - 1] ?? "")) at -= 1;
      if (m.code[at - 1] === ")") {
        let depth = 1;
        at -= 1;
        while (at > 0 && depth) {
          at -= 1;
          if (m.code[at] === ")") depth += 1;
          else if (m.code[at] === "(") depth -= 1;
        }
      } else while (at > 0 && /[\w$.]/.test(m.code[at - 1])) at -= 1;
      add(at, hit.index + hit[0].length, "reset", ["foreign"]);
      sites.at(-1).reset = m.src.slice(at, hit.index).trim();
    }
    const persistent = r6xPersistentWrites([{ file: m.file, src: m.src }]);
    const names = new Set(
      [...m.rows,
        ...m.structure.callbacks.map((callback) => ({ writes: [...m.code.slice(callback.at, callback.end + 1).matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=(?!=|>)/g)].map((hit) => ({ name: hit[1] })) })),
        { writes: persistent.filter((write) => m.rows.some((row) => [row.range, ...row.spans].some(([from, to]) => write.line >= r4xLineOf(m.code, from) && write.line <= r4xLineOf(m.code, to)))) },
      ]
        .flatMap((row) => row.writes.map((/** @type {any} */ w) => w.name))
        .filter((name) => persistent.some((w) => w.name === name)),
    );
    const bindings = [
      ...m.code.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g),
    ].map((match) => ({
      name: match[1],
      at: match.index,
      fn: holder(match.index),
    }));
    const collectionRoots = new Set(
      persistent
        .filter(
          (write) =>
            (write.name.includes("[") || write.kind.startsWith(".")) &&
            m.rows.some((row) =>
              [row.range, ...row.spans].some(
                ([from, to]) =>
                  write.line >= r4xLineOf(m.code, from) &&
                  write.line <= r4xLineOf(m.code, to),
              ),
            ),
        )
        .map((write) => write.name.split(/[.[]/, 1)[0]),
    );
    for (const name of collectionRoots) {
      for (const hit of m.code.matchAll(
        new RegExp(`\\b${name}\\s*(\\[|\\.get\\s*\\()`, "g"),
      )) {
        const fn = holder(hit.index);
        if (!fn || !reachable.has(fn.name)) continue;
        const binding = bindings
          .filter(
            (b) =>
              b.name === name &&
              b.at < hit.index &&
              (!b.fn || (b.fn.start <= hit.index && hit.index <= b.fn.end)),
          )
          .at(-1);
        if (!binding || binding.fn === fn) continue;
        const end = r4xMatch(m.code, hit.index + hit[0].length - 1) + 1;
        if (/^\s*=(?!=)/.test(m.code.slice(end))) continue;
        if (
          sites.some(
            (site) =>
              site.file === m.file &&
              (site.reads ?? [{ at: site.at, end: site.end }]).some(
                (/** @type {any} */ read) =>
                  read.at === hit.index && read.end === end,
              ),
          )
        )
          continue;
        add(hit.index, end, "state", ["foreign"]);
        sites.at(-1).binding = name;
      }
    }
    // Ignore local aliases, object-builder members and retry scheduling that
    // never reaches a DOM sink. Their persistent inventory remains mandatory.
    for (const name of names) {
      const property = name.includes(".") ? name.split(".").at(-1) : null;
      const aliases = new Set([name.split(".")[0]]);
      if (property)
        for (let changed = true; changed; ) {
          changed = false;
          const link = (/** @type {string} */ a, /** @type {string} */ b) => {
            if (aliases.has(a) && !aliases.has(b)) {
              aliases.add(b);
              changed = true;
            }
            if (aliases.has(b) && !aliases.has(a)) {
              aliases.add(a);
              changed = true;
            }
          };
          for (const alias of m.code.matchAll(
            /\b(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*[;,]/g,
          ))
            link(alias[1], alias[2]);
          for (const fn of m.fns)
            for (const call of m.code.matchAll(
              new RegExp(`(?<![\\w$.])${fn.name}\\s*\\(`, "g"),
            )) {
              if (call.index >= fn.at && call.index < fn.start) continue;
              r4xArguments(m.code, call.index + call[0].length - 1).forEach(
                ([from, to], i) => {
                  const arg = m.code.slice(from, to + 1).trim();
                  if (fn.params[i] && /^\w+$/.test(arg))
                    link(fn.params[i], arg);
                },
              );
            }
        }
      const pattern = property
        ? new RegExp(`\\b[A-Za-z_$][\\w$]*\\.${property}\\b`, "g")
        : new RegExp(`\\b${name}\\b`, "g");
      /** @type {Array<{at: number, end: number}>} */ const reads = [];
      for (const hit of m.code.matchAll(pattern)) {
        const fn = holder(hit.index);
        if (!fn || !reachable.has(fn.name)) continue;
        const schedulingOnly = m.structure.nodes.some(({ node }) => node.type === "IfStatement" && node.test.start <= hit.index && hit.index < node.test.end && !node.alternate && (node.consequent.type === "ReturnStatement" && !node.consequent.argument || node.consequent.type === "BlockStatement" && node.consequent.body.length === 1 && node.consequent.body[0].type === "ReturnStatement" && !node.consequent.body[0].argument));
        if (schedulingOnly) continue;
        if (!property && /[\w$.]/.test(m.code[hit.index - 1] ?? "")) continue;
        if (property && !aliases.has(hit[0].split(".")[0])) continue;
        const schedulingBranch = [
          ...m.code.slice(fn.start, fn.end + 1).matchAll(/\bif\s*\(/g),
        ].some((condition) => {
          const open = fn.start + condition.index + condition[0].length - 1;
          const close = r4xMatch(m.code, open);
          const block =
            close +
            1 +
            (m.code.slice(close + 1).match(/^\s*/)?.[0].length ?? 0);
          if (m.code[block] !== "{") return false;
          const end = r4xMatch(m.code, block);
          return (
            hit.index > open &&
            hit.index < end &&
            !/\b(?:setHtml|setStatusLine|return)\b|\.(?:textContent|value|disabled)\s*=/.test(
              m.code.slice(block, end + 1),
            )
          );
        });
        if (schedulingBranch) continue;
        if (
          /^\s*(?:=(?!=)|\+\+|--|[+|&?]=)/.test(
            m.code.slice(hit.index + hit[0].length),
          )
        )
          continue;
        const binding = bindings
          .filter(
            (b) =>
              b.name === name &&
              b.at < hit.index &&
              (!b.fn || (b.fn.start <= hit.index && hit.index <= b.fn.end)),
          )
          .at(-1);
        if (!property && (!binding || binding.fn === fn)) continue;
        // Only scalar/object state feeding render output, not a request gate.
        const body = m.code.slice(fn.start, fn.end + 1);
        const tail = body.slice(hit.index - fn.start);
        if (/^\s*[:(]/.test(tail.slice(hit[0].length))) continue;
        reads.push({ at: hit.index, end: hit.index + hit[0].length });
      }
      if (!reads.length) continue;
      const first = reads[0];
      // All references to one persistent outcome share a site, so conditions
      // and the text they guard see the same planted value.
      const constants = [
        ...m.src.matchAll(
          new RegExp(`\\b${property ?? name}\\s*=\\s*["']([^"']+)["']`, "g"),
        ),
      ].map((hit) => hit[1]);
      const variants = constants.length ? [...new Set(constants)] : ["foreign"];
      add(first.at, first.end, "state", variants);
      sites.at(-1).reads = reads;
      sites.at(-1).binding = property ?? name;
      const declaration = bindings.find((b) => b.name === name);
      sites.at(-1).numeric =
        declaration &&
        /@type\s*\{number\|null\}/.test(
          m.src.slice(Math.max(0, declaration.at - 160), declaration.at),
        );
    }
  }
  for (const site of sites) {
    const module = modules.find((m) => m.file === site.file);
    assert.ok(module?.structure, `source module missing: ${site.file}`);
    const callback = module.structure.callbacks.find((callback) => site.binding && new RegExp(`\\b${site.binding}\\b`).test(module.code.slice(callback.at, callback.end + 1)));
    const writers = module.rows.filter((row) => row.writes.some((/** @type {any} */ write) => write.name === site.binding));
    const writer = writers.find((row) => r8ProjectionAxes(r4xProjection(site.file, "page state", row.fn)).includes("owner")) ?? writers[0];
    const parentWriter = writer && module.fns.find((fn) => fn.start <= writer.range[0] && writer.range[1] <= fn.end && r8ProjectionAxes(r4xProjection(site.file, "page state", fn.name)).includes("owner"));
    const projection = r4xProjection(site.file, callback ? "page callback" : site.type === "state" ? "page state" : site.type === "writer" ? "DOM write" : site.type === "reset" ? "reset" : "slot outcome", parentWriter?.name ?? callback?.name ?? writer?.fn ?? site.fn);
    site.identities = r8ProjectionAxes(projection);
    if (!site.identities.length && site.type === "writer") site.identities = r8ProjectionAxes(r4xProjection(site.file, "request start", site.fn));
    site.identity = callback?.name === "onPreviewFailure" ? site.identities[0] : site.identities.includes("owner") ? "owner" : site.identities.includes("epoch") ? "epoch" : site.identities[0];
    assert.ok(site.identity, `outcome owner cannot be extracted: ${site.id}; declare its projection`);
  }
  return sites;
}

/** @param {string} site @param {any} value */
function r7ReadOutcome(site, value) {
  if (!r7Coverage) return value;
  r7Coverage.reads.set(site, value);
  if (!r7Coverage.instances.has(site))
    r7Coverage.instances.set(site, new Set());
  r7Coverage.instances.get(site).add(value);
  if (r7Coverage.target !== site) return value;
  const alien = r4State().ops.get(r7Coverage.foreignKey);
  assert.ok(
    alien,
    "the planted outcome is read from another owner's actual registry slot",
  );
  r7ValidateForeign(r7Coverage.foreignFrame, alien, r7Coverage.foreignKey);
  const variant = r7Coverage.variant;
  if (value instanceof Map) {
    const map = new Map(value);
    for (const [key, slot] of map)
      if (
        key !== r7Coverage.foreignKey
      )
        map.set(key, { ...slot, ...alien });
    return map;
  }
  if (value && typeof value === "object" && "token" in value)
    return { ...value, ...alien };
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value === 2 ? 1 : 2;
  if (r7Coverage.sites.find((/** @type {any} */ s) => s.id === site)?.numeric)
    return 1;
  if (variant !== "foreign") return variant;
  if (value && typeof value === "object" && "level" in value) {
    return { ...value, level: 77 };
  }
  if (value && typeof value === "object") return value;
  return alien.failure;
}

/** Leaf-level DOM deltas: a button observing busy cannot stand in for a
 * sibling failure span. Every changed text/value/disabled leaf needs a sensor.
 * @param {any} root */
function r7Leaves(root) {
  /** @type {Map<string, {node: any, property: string, value: any, text?: string, contextText?: string}>} */ const out =
    new Map();
  const walk = (/** @type {any} */ node, /** @type {string} */ path) => {
    if (node.hidden) return;
    if (node instanceof FakeText) {
      if (node.textContent.trim())
        out.set(`${path}:text`, {
          node,
          property: "textContent",
          value: node.textContent,
        });
      return;
    }
    if (node instanceof FakeElement)
      out.set(`${path}:class`, {
        node,
        property: "className",
        value: node.className,
        text: node.textContent,
        contextText: node.parentNode?.textContent,
      });
    if (/^(input|select|textarea)$/.test(node.localName ?? ""))
      out.set(`${path}:value`, { node, property: "value", value: node.value });
    if (/^(input|select|textarea|button)$/.test(node.localName ?? ""))
      out.set(`${path}:disabled`, {
        node,
        property: "disabled",
        value: node.disabled,
      });
    node.childNodes.forEach(
      (/** @type {any} */ child, /** @type {number} */ i) =>
        walk(child, `${path}/${child.localName ?? "text"}[${i}]`),
    );
  };
  walk(root, "page");
  for (const [i, dialog] of fakeDocument.body
    .querySelectorAll(".scrim")
    .entries())
    if (!root.contains(dialog)) walk(dialog, `dialog${i}`);
  return out;
}
/** @param {any} ctx */
const r7Pieces = (ctx) =>
  new Map(
    R4_PAGES[ctx.page].pieces(ctx.root).map(([name, , value]) => [name, value]),
  );
/** @param {Map<string, string>} before @param {Map<string, string>} after @param {string|null} [identity] @param {any} [ctx] */
const r7PieceChanges = (before, after, identity = r7Coverage?.crossedIdentity ?? null, ctx = r7Coverage?.ctx) =>
  [...after]
    .filter(([name, value]) => before.get(name) !== value)
    .filter(([name]) => !identity || R4_PAGES[ctx.page].pieces(ctx.root).some(([piece, deps, value]) => piece === name && (typeof deps === "function" ? deps(value) : deps).includes(identity)))
    .map(([name]) => name);

/** @param {any} ctx @param {string[]} names */
const r8PieceDependencies = (ctx, names) => Object.fromEntries(R4_PAGES[ctx.page].pieces(ctx.root).filter(([name]) => names.includes(name)).map(([name, deps, value]) => [name, typeof deps === "function" ? deps(value) : deps]));

/** @param {any} ctx */
async function r7ProbeOutcomes(ctx) {
  if (
    !r7Coverage ||
    r7Coverage.probing ||
    !r7NeedsAudit(ctx.page, ctx.kind.name)
  )
    return;
  const coverage = r7Coverage;
  coverage.probing = true;
  const render = async () => {
    for (const entry of ctx.world.spec.devices)
      r4Live(
        ctx.world,
        "device",
        r4View(
          ctx.world,
          entry.name,
          ctx.world.epoch,
          ctx.world.lives.get(entry.name),
          ++ctx.world.rev,
        ),
      );
    // An empty Devices page renders on a config event as well.
    if (!ctx.world.spec.devices.length)
      r4Live(ctx.world, "config", { ...CONFIG_STATE, rev: ++ctx.world.rev });
    await settle();
  };
  try {
    coverage.reads.clear();
    coverage.instances.clear();
    await render();
    const seen = [...coverage.reads.keys()];
    for (const id of seen) {
      const site = coverage.sites.find((/** @type {any} */ s) => s.id === id);
      if (!site) continue;
      for (const variant of site.variants) {
        const key = `${id} × ${variant}`;
        if (coverage.observed.has(key)) continue;
        {
          coverage.target = null;
          coverage.crossedIdentity = site.identity;
          const original = coverage.reads.get(id);
          await render();
          const before = r7Leaves(ctx.root);
          const beforePieces = r7Pieces(ctx);
          const value = site.busyValue ?? (variant === "value" ? original?.value === "weather" ? "clock" : original?.value === "save" ? "revert" : "weather" : original?.value ?? "save");
          r4State().ops.delete(coverage.foreignKey);
          coverage.foreignFrame = r8ForeignOutcomeFrame(ctx, site.identity, value, coverage.stories);
          coverage.foreignKey = `r7-foreign:${JSON.stringify(coverage.foreignFrame.b.identities)}`;
          r4State().ops.set(coverage.foreignKey, {
            token: coverage.foreignFrame.b.identities.token, busy: variant === "busy" || variant === "value",
            label: "r7 alien pending", value,
            failure: variant === "failure" || site.type === "state" ? "r7 alien failure" : null,
            note: variant === "note" ? "r7 alien result" : null,
          });
          coverage.target = id;
          coverage.variant = variant;
          await render();
          const after = r7Leaves(ctx.root);
          const changed = [...after].filter(([path, leaf]) => {
            const was = before.get(path);
            if (
              leaf.property === "className" &&
              (!was ||
                was.node.localName !== leaf.node.localName ||
                was.text !== leaf.text ||
                was.contextText !== leaf.contextText)
            )
              return false;
            if (
              leaf.property === "disabled" &&
              (!was ||
                ["data-act", "data-key", "name"].some(
                  (attribute) =>
                    was.node.getAttribute?.(attribute) !==
                    leaf.node.getAttribute?.(attribute),
                ))
            )
              return false;
            return was?.value !== leaf.value;
          });
          const structural =
            before.size > after.size
              ? r7PieceChanges(beforePieces, r7Pieces(ctx))
              : [];
          if (!changed.length && !structural.length) continue; // Try the next reachable UI state.
          const sensors = new Set(structural);
          for (const [path, leaf] of changed) {
            const baseline = r7Pieces(ctx);
            const saved = leaf.node[leaf.property];
            leaf.node[leaf.property] =
              leaf.property === "className"
                ? before.get(path)?.value
                : leaf.property === "disabled"
                  ? !saved
                  : leaf.node instanceof FakeSelect && leaf.property === "value"
                    ? leaf.node.options
                        .map(
                          (/** @type {any} */ option) =>
                            option.getAttribute("value") ?? option.textContent,
                        )
                        .find((/** @type {string} */ value) => value !== saved)
                    : `${saved} r7 leaf witness`;
            const names = r7PieceChanges(baseline, r7Pieces(ctx));
            leaf.node[leaf.property] = saved;
            if (!names.length)
              coverage.gaps.set(
                `${id} × ${variant} · ${path}`,
                `unobserved outcome site: ${id} × ${variant}; ${path} = ${JSON.stringify(leaf.value)}; no piece depends on crossed ${coverage.crossedIdentity}; add a harness piece`,
              );
            for (const name of names) sensors.add(name);
          }
          coverage.observed.set(key, {
            kind: ctx.kind.name,
            leaves: changed.length,
            structure: structural.length,
            pieces: [...sensors],
            identity: site.identity,
            dependencies: r8PieceDependencies(ctx, [...sensors]),
          });

        }
      }
    }
  } finally {
    coverage.target = null;
    coverage.crossedIdentity = null;
    r4State().ops.delete(coverage.foreignKey);
    await render();
    coverage.probing = false;
  }
}

/** @param {any[]} sites */
async function r7ObservedModules(sites) {
  const urls = new Map();
  for (const file of [...new Set(sites.map((s) => s.file))]) {
    const original = r4ReadFile(
      new URL(`../../${file}`, import.meta.url),
      "utf8",
    );
    let src = original;
    const edits = sites
      .filter((s) => s.file === file)
      .flatMap((s) =>
        (s.reads ?? [{ at: s.at, end: s.end }]).map((/** @type {any} */ r) => ({
          ...r,
          id: s.id,
          writer: s.writer,
          reset: s.reset,
        })),
      );
    const code = r4xCodeOnly(original);
    const fns = r4xFunctions(code);
    const operationNames = new Set();
    r8Walk(r8Syntax(original), (node) => {
      if (node.type === "ImportDeclaration" && /(?:^|\/)ops\.js$/.test(node.source.value))
        for (const spec of node.specifiers)
          if (["start", "follow"].includes(spec.imported?.name)) operationNames.add(spec.local.name);
      if (node.type === "Property" && node.shorthand)
        for (const edit of edits)
          if (edit.at === node.value.start && edit.end === node.value.end)
            edit.shorthand = node.key.name;
    });
    r8Walk(r8Syntax(original), (node) => {
      if (node.type === "CallExpression" && operationNames.has(node.callee.name))
        edits.push({ at: node.callee.start, end: code.indexOf("(", node.callee.end) + 1, operation: node.callee.name });
    });
    for (const call of r8RequestSites([{ file, src: original }]).filter((call) => !call.frame)) {
      const fn = fns
        .filter((f) => f.start <= call.at && call.at <= f.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      if (fn)
        edits.push({
          at: call.at,
          end: code.indexOf("(", call.at + call.callee.length) + 1,
          request: {
            file,
            fn: fn.name,
            anchor: original.slice(fn.start, fn.end + 1).replace(/\s+/g, " "),
            call: call.call,
            site: call.site,
            callee: call.callee,
          },
        });
    }
    const rewrite = (
      /** @type {number} */ from,
      /** @type {number} */ to,
      /** @type {any[]} */ nested,
    ) => {
      let out = "";
      let at = from;
      const pending = [...nested].sort((a, b) => a.at - b.at || b.end - a.end);
      while (pending.length) {
        const edit = pending.shift();
        const children = pending.filter(
          (child) => child.at >= edit.at && child.end <= edit.end,
        );
        for (const child of children) pending.splice(pending.indexOf(child), 1);
        assert.ok(edit.at >= at, `overlapping outcome source: ${edit.id}`);
        out +=
          original.slice(at, edit.at) +
          (edit.operation
            ? `globalThis.__r8Operation(${edit.operation}, `
            : edit.request
            ? `globalThis.__r7Request(${JSON.stringify(edit.request)}, ${edit.request.callee}, `
            : edit.reset
              ? `globalThis.__r7ResetOutcome(${JSON.stringify(edit.id)}, ${edit.reset})`
              : edit.writer
                ? `globalThis.__r7WriteOutcome(${JSON.stringify(edit.id)}, ${edit.writer.node}, (${rewrite(edit.writer.from, edit.writer.to, children)}), (node, value) => node.${edit.writer.property} = value)`
                : `${edit.shorthand ? `${edit.shorthand}: ` : ""}globalThis.__r7ReadOutcome(${JSON.stringify(edit.id)}, (${rewrite(edit.at, edit.end, children)}))`);
        at = edit.end;
      }
      return out + original.slice(at, to);
    };
    src = rewrite(0, original.length, edits);
    if (process.env.R7_OBSERVATION_DEBUG)
      r4Append(
        `${process.env.R7_OBSERVATION_DEBUG}/${file.replaceAll("/", "-")}-${Date.now()}`,
        src,
      );
    urls.set(file, { original, src });
  }
  // Components first, then their importing pages. Imports retain the real
  // registry/API/store; only rendered owner reads are fault-injected.
  /** @type {Record<string, string>} */ const replacements = {};
  for (const [file, source] of [...urls].sort(
    ([a], [b]) => Number(a.includes("pages/")) - Number(b.includes("pages/")),
  )) {
    const url = await r4Mutant(
      file.replace("web/js/", ""),
      [[source.original, source.src]],
      replacements,
    );
    urls.set(file, url);
    replacements[`../${file.replace("web/js/", "")}`] = url;
  }
  /** @type {Record<string, any>} */ const modules = {};
  for (const [page, definition] of Object.entries(R4_PAGES)) {
    const file = page === "raw" ? "config-raw" : page;
    const url = urls.get(`web/js/pages/${file}.js`);
    modules[page] = url ? (await import(url)).page : definition.module();
  }
  const settings = urls.get("web/js/components/settings-form.js");
  if (settings) modules.__r8SettingsForm = await import(settings);
  return modules;
}

/** @param {any[]} sites @param {Map<string, any>} observed */
function r7RequireObservation(sites, observed) {
  const gaps = sites.flatMap((site) =>
    site.variants
      .filter((/** @type {string} */ variant) => {
        const receipt = observed.get(`${site.id} × ${variant}`);
        return (
          !receipt?.pieces?.length ||
          receipt.identity !== site.identity ||
          receipt.pieces.some((/** @type {string} */ piece) => !receipt.dependencies?.[piece]?.includes(site.identity)) ||
          !(receipt.leaves > 0 || receipt.structure > 0)
        );
      })
      .map((/** @type {string} */ variant) => `${site.id} × ${variant}`),
  );
  assert.deepEqual(
    gaps,
    [],
    "unobserved outcome site: every extracted rendered owner read needs an observing harness piece",
  );
}

/** Reused receipts are immutable evidence; all fault-injected modules and
 * physical foreign slots are retired before another test starts. @type {any} */
let r7AuditEvidence = null;
/** @param {any} t */
async function r7RunAudits(t) {
  if (r7AuditEvidence) return r7AuditEvidence;
  const files = r4WebFiles();
  const sites = r7OutcomeSites(files);
  assert.ok(
    sites.length > 20,
    "slot readers, registry iteration and persistent outcomes were extracted",
  );
  const global = /** @type {any} */ (globalThis);
  const saved = global.__r7ReadOutcome;
  const savedRequest = global.__r7Request;
  const savedWriter = global.__r7WriteOutcome;
  const savedReset = global.__r7ResetOutcome;
  const savedOperation = global.__r8Operation;
  global.__r7ReadOutcome = r7ReadOutcome;
  global.__r7WriteOutcome = r7WriteOutcome;
  global.__r7ResetOutcome = r7ResetOutcome;
  global.__r8Operation = r8OwnOperation;
  global.__r7Request = r8CaptureRequest;
  /** @type {any} */ const coverage = {
    sites,
    requirements: [],
    instances: new Map(),
    reads: new Map(),
    observed: new Map(),
    gaps: new Map(),
    target: null,
    variant: null,
    foreignKey: "r7-foreign-owner@other-epoch/99",
    probing: false,
  };
  try {
    const modules = await r7ObservedModules(sites);
    coverage.pageSources = r7PageSources(files, sites);
    const origins = new Map();
    coverage.origins = origins;
    const requestOrigins = new Map();
    coverage.requestOrigins = requestOrigins;
    for (const kind of R4_KINDS) {
      const receipt = await r8SourceReceipt(t, kind, modules, files);
      assert.ok(
        receipt.origin,
        `${kind.name}: its actual request must carry an extracted source receipt`,
      );
      origins.set(kind.name, receipt.origin);
      for (const [index, call] of (receipt.calls ?? []).entries())
        if (call.origin) requestOrigins.set(`${kind.name} · request ${index}`, call.origin);
    }
    const requirements = r7IsolationRequirements(files, origins, sites, requestOrigins);
    coverage.isolationRequirements = requirements;
    // Data coverage is established from real executions before an outcome
    // is planted. Foreign-read frames never discharge story obligations.
    coverage.stories = await r8RunStoryAudit(t, requirements, modules);
    coverage.requirements = requirements;
    r7Coverage = coverage;
    for (const kind of R4_KINDS) {
      const owner = requirements.some(
        (r) => r.kind === kind.name && r.identity === "owner",
      );
      const isolatedKind = owner
        ? {
            ...kind,
            world: {
              ...kind.world,
              devices: kind.world.devices.map((/** @type {any} */ d) => ({
                ...d,
                o: { ...d.o, override: 30 },
              })),
            },
            setup: async (/** @type {any} */ ctx) => {
              await kind.setup?.(ctx);
              const range = ctx.root.querySelector('input[type="range"]');
              if (range && !range.disabled) typeInto(range, "40", "input");
            },
          }
        : kind;
      await r4Run(t, isolatedKind, null, r4Ends(kind)[0], "case", modules);
    }
    // Idle editors, a failed load, and an invalid Save expose branches that
    // an in-flight/success story cannot display at the same instant.
    for (const kind of R4_KINDS.filter((kind) => !kind.atOpen))
      if (r7NeedsAudit(kind.page, kind.name))
        await r4Run(t, kind, null, r4Ends(kind)[0], "without", modules);
    if (r7NeedsAudit("device", "settings load"))
      await r4Run(t, r4KindOf("settings load"), null, "500", "case", modules);
    if (r7NeedsAudit("raw", "raw save"))
      await r4Run(t, r4KindOf("raw save"), null, "refused", "case", modules);
    r7Coverage = null;
    assert.deepEqual(
      [...coverage.gaps.values()],
      [],
      "unobserved outcome sites: each changed DOM leaf must have a piece of its own",
    );
    r7RequireObservation(sites, coverage.observed);
    r7AuditEvidence = coverage;
    t_log(
      `r7 observation: ${sites.length} sources; ${coverage.observed.size} outcome variants; ${JSON.stringify([...coverage.observed])}`,
    );
    t_log(
      `r8 isolation: ${requirements.length} extracted identity × kind combinations; ${coverage.stories.length} measured executed stories`,
    );
    return coverage;
  } finally {
    r7Coverage = null;
    global.__r7ReadOutcome = saved;
    global.__r7Request = savedRequest;
    global.__r7WriteOutcome = savedWriter;
    global.__r7ResetOutcome = savedReset;
    global.__r8Operation = savedOperation;
  }
}

test("r4 harness: r7 observation coverage: every extracted rendered outcome has a leaf-level observing piece", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await r7RunAudits(t);
});
test("r4 audit: r8 identity isolation: every extracted identity × operation kind has a measured isolating story", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await r7RunAudits(t);
});

test("r4 harness self-test: r7 observation audit rejects a newly extracted unobserved outcome writer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const evidence = await r7RunAudits(t);
  const files = r4WebFiles();
  const changed = files.map((file) =>
    file.file.endsWith("/pages/device.js")
      ? {
          ...file,
          src: file.src.replace(
            r8DeviceWorkAnchor(file.src),
            `async () => { const answer = await send(key); const r7UnseenNode = root?.querySelector(".r7-unseen"); if (r7UnseenNode) r7UnseenNode.textContent = "unobserved result"; return applyAnswer(answer); }`,
          ),
        }
      : file,
  );
  const site = r7OutcomeSites(changed).find(
    (site) =>
      site.type === "writer" && site.text.includes("r7UnseenNode.textContent"),
  );
  assert.ok(
    site,
    "an arbitrary new outcome writer is extracted, without a site whitelist",
  );
  const root = pageRoot();
  root.innerHTML = '<span class="r7-unseen">ready</span>';
  const before = r7Coverage;
  const coverage = {
    ctx: { page: "device", root, kind: { name: "unobserved-site self-test" }, world: r4World(r4d1()), opening: 1 },
    stories: evidence.stories,
    sites: [site],
    requirements: [],
    observed: new Map(),
    gaps: new Map(),
  };
  try {
    r7Coverage = coverage;
    r7WriteOutcome(
      site.id,
      root.querySelector(".r7-unseen"),
      "unobserved result",
      (node, value) => (node.textContent = value),
    );
    assert.ok(
      coverage.gaps.size,
      "the real piece readers do not observe the planted text",
    );
    assert.throws(
      () => r7RequireObservation([site], coverage.observed),
      /unobserved outcome site/,
    );
  } finally {
    r7Coverage = before;
    root.remove();
  }
});

/** Requirements are a join, not a handwritten coverage table: the kind's
 * inventoried source function → extracted continuations/called effects →
 * effect projections → identity vocabulary. Slot creation itself also writes
 * pending/failure/result state, even when the caller supplies no callbacks.
 * @param {Array<{file: string, src: string}>} files @param {Map<string, any>} origins @param {any[]} sites @param {Map<string, any>} [requestOrigins] */
function r7IsolationRequirements(files, origins, sites, requestOrigins = origins) {
  r8RequireRequestKinds(files, requestOrigins);
  const rows = r4xExtract(files).rows;
  /** @type {any[]} */ const requirements = [];
  for (const kind of R4_KINDS) {
    const origin = origins.get(kind.name);
    assert.ok(
      origin,
      `${kind.name}: an executed request supplies its source anchor`,
    );
    const file = origin.file;
    const source = files.find((f) => f.file === file);
    assert.ok(source, `${kind.name}: inventoried source exists`);
    const code = r4xCodeOnly(source.src);
    const fns = r4xFunctions(code);
    const fn = fns.find(
      (f) =>
        source.src.slice(f.start, f.end + 1).replace(/\s+/g, " ") ===
        origin.anchor,
    );
    assert.ok(
      fn,
      `${kind.name}: executed source anchor must resolve without line numbers`,
    );
    const via = new Set();
    /** @type {Array<[number, number]>} */
    const spans = [];
    const effects = r4xFollow(
      code,
      fns,
      [fn.start, fn.end],
      new Map(),
      new Set(),
      via,
      spans,
    );
    /** @type {any[]} */ const projections = [...effects]
      .filter((effect) => effect === "request start")
      .map((effect) => ({
        effect,
        source: `${file} · ${fn.name} · ${effect}`,
        projection: r4xProjection(file, effect, fn.name),
        writes: [],
      }));
    const ranges = [[fn.start, fn.end], ...spans];
    const actualBindings = new Set(
      sites
        .filter((site) => site.file === file && site.type === "state")
        .map((site) => site.binding),
    );
    const selectedRows = rows.filter(
      (row) =>
        row.file === file &&
        ranges.some(([from, to]) => row.range[0] >= from && row.range[1] <= to),
    );
    const allBindings = [
      ...new Set(
        selectedRows
          .flatMap((row) =>
            row.writes.map((/** @type {any} */ write) =>
              write.name.split(".").at(-1),
            ),
          )
          .filter((name) => actualBindings.has(name)),
      ),
    ];
    for (const row of selectedRows)
      for (const effect of row.effects) {
        const writes = row.writes
          .map((/** @type {any} */ write) => write.name.split(".").at(-1))
          .filter((/** @type {string} */ name) => actualBindings.has(name));
        // The conservative inventory retains local builder assignments for
        // review. They are not persistent render outcomes and add no identity.
        if (effect === "page state" && !writes.length) continue;
        projections.push({
          effect,
          source: r4xKey(row),
          projection: r4xProjection(file, effect, row.fn),
          writes,
        });
      }
    const slotFunctions = [
      "start",
      "follow",
      ...[...source.src.matchAll(/\b(?:start|follow)\s+as\s+(\w+)/g)].map(
        (match) => match[1],
      ),
    ];
    const hasSlot = ranges.some(([from, to]) =>
      slotFunctions.some((name) =>
        new RegExp(`\\b${name}\\s*\\(`).test(code.slice(from, to + 1)),
      ),
    );
    if (hasSlot)
      projections.push({
        effect: "slot outcome",
        source: `${file} · ${fn.name} · extracted slot creation`,
        projection: r4xProjection(file, "slot outcome", fn.name),
        writes: [],
      });
    assert.ok(
      projections.length,
      `${kind.name}: no effect inventory row; review its source anchor`,
    );
    for (const identity of Object.keys(R7_IDENTITY_WORDS)) {
      const origins = projections.filter((p) => r8ProjectionAxes(p.projection).includes(identity));
      if (origins.length)
        requirements.push({
          key: `${kind.name} × ${identity}`,
          kind: kind.name,
          identity,
          origins,
          file,
          slots: origins.some((p) => /slot|enable\/disable/.test(p.effect)),
          bindings: [
            ...new Set([...origins.flatMap((p) => p.writes), ...allBindings]),
          ],
          ranges,
        });
    }
  }
  // Event/timer continuations are kinds too: generation owns their feedback
  // and admission, even though they are not HTTP operations in R4_KINDS.
  for (const row of rows.filter((row) => row.file.endsWith("/live.js"))) {
    const origins = row.effects.map((/** @type {string} */ effect) => ({
      source: r4xKey(row),
      projection: r4xProjection(row.file, effect, row.fn),
    }));
    for (const identity of Object.keys(R7_IDENTITY_WORDS))
      if (origins.some((/** @type {any} */ p) => r8ProjectionAxes(p.projection).includes(identity))) {
        const kind = `${row.file} · ${row.fn} · ${row.kind}`;
        requirements.push({
          key: `${kind} × ${identity}`,
          kind,
          identity,
          origins,
        });
      }
  }
  for (const source of files.filter((file) =>
    /web\/js\/(?:pages\/|components\/(?:settings-form|recovery-dialog)\.js)/.test(
      file.file,
    ),
  )) {
    const code = r4xCodeOnly(source.src);
    const fns = r4xFunctions(code);
    for (const call of code.matchAll(/(?<![\w$.])request\s*\(/g)) {
      const fn = fns
        .filter((f) => f.start <= call.index && call.index <= f.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      assert.ok(fn, `${source.file}: request source needs a function owner`);
      const anchor = source.src
        .slice(fn.start, fn.end + 1)
        .replace(/\s+/g, " ");
      assert.ok(
        [...origins.values()].some(
          (origin) => origin.file === source.file && origin.anchor === anchor,
        ),
        `uncovered operation source: ${source.file} · ${fn.name}; add a generated operation kind before accepting this effect`,
      );
    }
  }
  for (const identity of Object.keys(R4_IDENTITIES))
    assert.ok(
      identity in R7_IDENTITY_WORDS,
      `new model identity ${identity}: add its extraction vocabulary and isolation generator`,
    );
  for (const identity of Object.keys(R7_IDENTITY_WORDS))
    assert.ok(
      requirements.some((r) => r.identity === identity),
      `model identity ${identity} has no extracted operation/effect requirement`,
    );
  assert.equal(
    new Set(requirements.map((r) => r.key)).size,
    requirements.length,
    "each inventory combination is unique",
  );
  return requirements;
}

test("r4 harness self-test: r8 isolation audit rejects a removed measured story and every confounded story", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { requirements, stories: all } = await r7RunAudits(t);
  r8RequireStoryIsolation(requirements, all);
  const removed = all.find(
    (/** @type {any} */ pair) => pair.kind === "overlays clear" && pair.measured.length === 1 && pair.measured[0] === "overlay",
  );
  assert.ok(removed, "K1 has an executed identity-only story");
  const remaining = all.filter((/** @type {any} */ pair) => pair.kind !== "overlays clear" || pair.measured[0] !== "overlay");
  assert.throws(
    () => r8RequireStoryIsolation(requirements, remaining),
    /identity isolation gap/,
  );
  const physicalKey = `r7-foreign:${JSON.stringify(removed.b.identities)}`;
  const physical = {
    token: removed.b.identities.token,
    value: removed.a.values,
  };
  r7ValidateForeign(removed, physical, physicalKey);
  assert.throws(
    () =>
      r7ValidateForeign(
        removed,
        { ...physical, token: physical.token + 100 },
        physicalKey,
      ),
    /physical token must match/,
  );
  assert.throws(
    () =>
      r7ValidateForeign(
        removed,
        { ...physical, value: { confounded: true } },
        physicalKey,
      ),
    /preserve the operation's values/,
  );
  for (const field of ["device", "kind", "values", "timing"]) {
    const confounded = structuredClone(removed);
    confounded.b[field] = { confounded: true };
    assert.throws(
      () => r8RequireStoryIsolation(requirements, [...remaining, confounded]),
      /identity isolation gap/,
    );
  }
  for (const confound of ["another identity", "undeclared identity", "observer dependencies"]) {
    const confounded = structuredClone(removed);
    if (confound === "another identity") confounded.b.identities.life = "also replaced";
    if (confound === "undeclared identity") confounded.b.identities.extra = "also replaced";
    if (confound === "observer dependencies") confounded.compared = new Map([["row o2", ["epoch"]]]);
    assert.throws(() => r8RequireStoryIsolation(requirements, [...remaining, confounded]), /identity isolation gap/);
  }
  const ops = await import("../../web/js/ops.js");
  /** @type {any} */ let release;
  const held = new Promise((resolve) => { release = resolve; });
  /** @type {any[]} */ const owners = [];
  const first = r8OwnOperation(ops.follow, "r8-owner-first", async () => { await held; owners.push(r8OperationContext.getStore()); }, { value: "equal" });
  const firstToken = r4State().ops.get("r8-owner-first").token;
  const second = r8OwnOperation(ops.follow, "r8-owner-second", async () => { await held; owners.push(r8OperationContext.getStore()); }, { value: "equal" });
  try {
    release(); await Promise.all([first, second]);
    assert.equal(owners[0].slotKey, "r8-owner-first", "awaited work retains its own slot after a different slot starts");
    assert.equal(owners[0].slotToken, firstToken);
    assert.equal(owners[1].slotKey, "r8-owner-second");
  } finally { release(); ops.drop("r8-owner-first"); ops.drop("r8-owner-second"); }
});

test("r4 harness self-test: r7 matrix superseded failure catches ops #1306 and X9", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const kind = r4KindOf("raw load");
  for (const end of /** @type {R4End[]} */ (["500", "timeout"])) {
    assert.deepEqual(await r4Case(t, kind, "superseded by Reload", end), []);
  for (const [
    name,
    edits,
  ] of /** @type {Array<[string, Array<[string, string]>]>} */ ([
    [
      "#1306",
      [
        [
          "(error) => {\n      if (!current()) return;",
          "(error) => {\n      if (false) return;",
        ],
      ],
    ],
    [
      "X9",
      [
        [
          "if (getState().ops.has(key)) setOp(key, null);",
          "if (getState().ops.has(key) && !busy(key)) setOp(key, null);",
        ],
      ],
    ],
  ])) {
    const ops = await r4Mutant("ops.js", edits);
    const raw = (
      await r5Module("pages/config-raw.js", [], { "../ops.js": ops })
    ).page;
    const differences = await r4Case(t, kind, "superseded by Reload", end, {
      modules: { raw },
    });
    assert.ok(
      differences.some((d) => /outcome line|load and validity/.test(d)),
      `${name}: ${differences.join("\n")}`,
    );
    t_log(`${name}/${end}: ${differences[0]}`);
  }
  }
});

/** @param {string} id @param {any} node @param {any} value @param {(node: any, value: any) => any} write */
function r7WriteOutcome(id, node, value, write) {
  const result = write(node, value);
  const coverage = r7Coverage;
  if (
    !coverage?.ctx ||
    !node?.isConnected ||
    coverage.observed.has(`${id} × foreign`)
  )
    return result;
  const savedIdentity = coverage.crossedIdentity;
  coverage.crossedIdentity = coverage.sites.find((/** @type {any} */ site) => site.id === id)?.identity ?? savedIdentity;
  const frame = r8ForeignOutcomeFrame(coverage.ctx, coverage.crossedIdentity, value, coverage.stories);
  const key = `r7-foreign:${JSON.stringify(frame.b.identities)}`;
  r4State().ops.set(key, {
    token: frame.b.identities.token,
    busy: false,
    label: "",
    value,
    failure: "r7 alien result",
    note: null,
  });
  try {
    const before = r7Pieces(coverage.ctx);
    const alien = r4State().ops.get(key);
    r7ValidateForeign(frame, alien, key);
    write(
      node,
      typeof value === "boolean" ? !value : `${value} ${alien.failure}`,
    );
    const pieces = r7PieceChanges(before, r7Pieces(coverage.ctx));
    if (!pieces.length)
      coverage.gaps.set(
        id,
        `unobserved outcome site: ${id}; direct asynchronous DOM result has no harness piece`,
      );
    coverage.observed.set(`${id} × foreign`, {
      kind: coverage.ctx.kind.name,
      leaves: 1,
      pieces,
      identity: coverage.crossedIdentity,
      dependencies: r8PieceDependencies(coverage.ctx, pieces),
    });

  } finally {
    write(node, value);
    r4State().ops.delete(key);
    coverage.crossedIdentity = savedIdentity;
  }
  return result;
}

/** @param {string} id @param {any} form */
function r7ResetOutcome(id, form) {
  if (!form) return;
  form.reset();
  const coverage = r7Coverage;
  if (!coverage?.ctx || coverage.observed.has(`${id} × foreign`)) return;
  for (const input of r4Fields(form)) {
    coverage.observed.delete(`${id} × foreign`);
    const value = input.value;
    if (input instanceof FakeSelect) {
      const next = input.options
        .map(
          (/** @type {any} */ option) =>
            option.getAttribute("value") ?? option.textContent,
        )
        .find((/** @type {string} */ candidate) => candidate !== value);
      if (next !== undefined)
        r7WriteOutcome(
          id,
          input,
          value,
          (node, candidate) =>
            (node.value = candidate === value ? value : next),
        );
    } else
      r7WriteOutcome(id, input, value, (node, value) => (node.value = value));
  }
}

test("r4 inventory self-test: r7 arbitrary named, computed and Map outcome caches become observation obligations", () => {
  for (const [declaration, write, read] of [
    [
      "let unexpectedState = { answer: null };",
      'unexpectedState.answer = "old outcome";',
      "unexpectedState.answer",
    ],
    [
      "let computedState = {};",
      'computedState["answer"] = "old outcome";',
      'computedState["answer"]',
    ],
    [
      "const mappedState = new Map();",
      'mappedState.set("answer", "old outcome");',
      'mappedState.get("answer")',
    ],
  ]) {
    const files = r4WebFiles().map((file) =>
      file.file.endsWith("/pages/device.js")
        ? {
            ...file,
            src:
              file.src
                .replace(
                  "let previewFailure = null;",
                  `let previewFailure = null; ${declaration}`,
                )
                .replace(
                  "const frozen = state.live.state",
                  `setHtml(root.querySelector(".unobserved-cache"), ${read} ?? ""); const frozen = state.live.state`,
                ) +
              `\nasync function cacheAnOutcome() { await Promise.resolve(); ${write} render(getState()); }\n`,
          }
        : file,
    );
    assert.ok(
      r7OutcomeSites(files).some(
        (site) => site.type === "state" && site.text === read,
      ),
      `${read}: a new persistent render outcome requires an observing piece`,
    );
  }
  const helper = "web/js/view/r7-pure-outcome.js";
  const files = r4WebFiles().map((file) =>
    file.file.endsWith("/pages/device.js")
      ? {
          ...file,
          src:
            'import { phaseBFailure } from "../view/r7-pure-outcome.js";\n' +
            file.src.replace(
              "const frozen = state.live.state",
              'setHtml(root.querySelector(".new-result"), phaseBFailure(state)); const frozen = state.live.state',
            ),
        }
      : file,
  );
  files.push({
    file: helper,
    src: 'import { op } from "../ops.js"; export const phaseBFailure = (view) => op("arbitrary", view)?.failure;',
  });
  assert.ok(
    r7OutcomeSites(files).some(
      (site) => site.file === helper && site.type === "slot",
    ),
    "an imported pure outcome reader needs coverage even without its own async row",
  );
});

test("r4 harness self-test: r7 a repaired case cannot remain hidden as a known todo", () => {
  assert.throws(
    () => r7RequireKnownLiveness(new Set(["a repaired product case"])),
    /remove it from R4_KNOWN/,
  );
});

/** Replace the slot function body, so epoch-prefixed correct keys remain
 * compatible with the same identity-confounding mutants. @param {string} body */
async function r7OverlaySlotMutant(body) {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../../web/js/pages/overlays.js", import.meta.url),
    "utf8",
  );
  const fn = r4xFunctions(r4xCodeOnly(source)).find(
    (fn) => fn.params.length === 1 && /overlay:/.test(source.slice(fn.start, fn.end + 1)),
  );
  assert.ok(fn, "re-anchor overlays.js's single-id operation-slot key builder for X1/X1c/J; replace that builder's body only, preserving the same id argument and all Clear assertions");
  return r5Module("pages/overlays.js", [
    [source.slice(fn.at, fn.end + 1), `const ${fn.name} = (id) => { ${body} }`],
  ]);
}

/** Resolve source dependencies, so completed page/operation obligations can
 * skip repeated probes without omitting any extracted source or requirement.
 * @param {Array<{file: string, src: string}>} files @param {any[]} sites */
function r7PageSources(files, sites) {
  const byFile = new Map(files.map((file) => [file.file, file.src]));
  /** @param {string} file @param {Set<string>} seen */
  const dependencies = (file, seen) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of (byFile.get(file) ?? "").matchAll(
      /from\s+["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      const parts = file.split("/");
      parts.pop();
      for (const part of match[1].split("/")) {
        if (part === "..") parts.pop();
        else if (part !== ".") parts.push(part);
      }
      const target = parts.join("/");
      if (byFile.has(target)) dependencies(target, seen);
    }
  };
  return new Map(
    Object.keys(R4_PAGES).map((page) => {
      const seen = new Set();
      dependencies(
        `web/js/pages/${page === "raw" ? "config-raw" : page}.js`,
        seen,
      );
      return [page, sites.filter((site) => seen.has(site.file))];
    }),
  );
}
/** @param {string} page @param {string} _kind */
function r7NeedsAudit(page, _kind) {
  const coverage = r7Coverage;
  if (!coverage) return false;
  return (
    (coverage.pageSources.get(page) ?? []).some((/** @type {any} */ site) =>
      site.variants.some(
        (/** @type {string} */ variant) =>
          !coverage.observed.has(`${site.id} × ${variant}`),
      ),
    )
  );
}

/** The physical foreign slot must agree with the audited owner frame. This
 * also prevents sorting sentinels or changed control values from confounding
 * an identity-isolation witness. @param {any} pair @param {any} slot @param {string} key */
function r7ValidateForeign(pair, slot, key) {
  assert.deepEqual(
    JSON.parse(key.slice("r7-foreign:".length)),
    pair.b.identities,
    "identity isolation: the physical slot has exactly the declared owner frame",
  );
  assert.equal(
    slot.token,
    pair.b.identities.token,
    "identity isolation: the physical token must match the frame",
  );
  assert.deepEqual(
    slot.value,
    Object.hasOwn(pair, "slotValue") ? pair.slotValue : pair.a.values,
    "identity isolation: preserve the operation's values in the physical slot",
  );
}

/** Projections carry machine-readable identities alongside the review prose.
 * The requirements are derived from these tags, never a regex vocabulary.
 * @param {string[]} identities @param {string} text */
function r8Project(identities, text) {
  return `${text} [identities: ${[...new Set(identities)].join(",")}]`;
}

/** @param {any} run @param {string} key @param {any} work @param {any} options */
function r8OwnOperation(run, key, work, options) {
  return run(key, (/** @type {any[]} */ ...args) => {
    const slot = r4State().ops.get(key);
    return r8OperationContext.run({ slotKey: key, slotToken: slot?.token, slotValue: slot?.value }, () => work(...args));
  }, options);
}

/** @param {any} origin @param {any} send @param {any[]} args */
function r8CaptureRequest(origin, send, ...args) {
  const before = r7RequestSource, owner = r8OperationContext.getStore();
  r7RequestSource = { ...origin, slotKey: owner?.slotKey, slotToken: owner?.slotToken, slotValue: owner?.slotValue, resource: args[2]?.resource };
  try { return send(...args); }
  finally { r7RequestSource = before; }
}

async function r8MeasurementModules() {
  const global = /** @type {any} */ (globalThis);
  global.__r7ReadOutcome = r7ReadOutcome;
  global.__r7WriteOutcome = r7WriteOutcome;
  global.__r7ResetOutcome = r7ResetOutcome;
  global.__r7Request = r8CaptureRequest;
  global.__r8Operation = r8OwnOperation;
  if (!r8MeasuredModules) {
    r8MeasuredModules = r7ObservedModules(r7OutcomeSites(r4WebFiles()));
  }
  return r8MeasuredModules;
}
/** @param {string} projection @param {Record<string, RegExp>} [vocabulary] */
function r8ProjectionAxes(projection, vocabulary = R7_IDENTITY_WORDS) {
  const tag = /\[identities: ([^\]]*)\]$/.exec(projection);
  assert.ok(tag, `unextractable identity projection: ${projection}; declare its identity tags`);
  const axes = tag[1] ? tag[1].split(",") : [];
  for (const axis of axes) assert.ok(axis in vocabulary, `identity vocabulary lacks ${axis}; add its measurement and vocabulary`);
  return axes;
}

/** Main's bootstrap and first-frame pipeline have their own contract/generation
 * tests. Canvas pixels are outside this text/value/disabled/class matrix.
 * Every other imported request, including aliases, needs an executed kind.
 * @param {Array<{file: string, src: string}>} files @param {Map<string, any>} origins */
function r8RequireRequestKinds(files, origins) {
  for (const site of r8RequestSites(files)) {
    const excluded = site.file === "web/js/main.js" && (site.frame || site.call === 'request("GET", "/api/v2/bootstrap", { resource: "bootstrap" })');
    assert.ok(excluded || [...origins.values()].some((origin) => origin.file === site.file && origin.site === site.site), `uncovered request kind: ${site.site}; add an executed R4_KINDS kind (or document an explicit extraction scope reason)`);
  }
}

/** A data change can erase an action before its request starts (for example
 * reincarnation makes a failed preview-end Retry moot). Reject the missing
 * executed kind with guaranteed inventory axes, not a generic click error.
 * These diagnostics never create a source receipt or discharge an obligation.
 * @param {R4Kind} kind @param {Array<{file: string, src: string}>} files @param {Error} error */
function r8UnexecutableKind(kind, files, error) {
  const file = kind.site.split(":", 1)[0];
  const source = files.find((source) => source.file === file);
  assert.ok(source, `identity isolation gap: ${kind.name}; missing source inventory ${file}; ${error.message}`);
  const fns = r4xFunctions(r4xCodeOnly(source.src));
  const scopes = r8RequestSites([source]).map((call) => {
    const fn = fns.filter((fn) => fn.start <= call.at && call.at <= fn.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    return r8ProjectionAxes(r4xProjection(file, "request start", fn?.name));
  });
  const guaranteed = (scopes[0] ?? []).filter((axis) => scopes.every((scope) => scope.includes(axis)));
  assert.ok(guaranteed.length, `identity isolation gap: ${kind.name}; cannot extract its request-scope axes; ${error.message}`);
  assert.fail(`identity isolation gap: ${guaranteed.map((axis) => `${kind.name} × ${axis}`).join("; ")}; operation kind could not execute: ${error.message}`);
}

/** @param {any} t @param {R4Kind} kind @param {Record<string, any>} modules @param {Array<{file: string, src: string}>} files */
async function r8SourceReceipt(t, kind, modules, files) {
  try { return await r4Run(t, kind, null, r4Ends(kind)[0], "source", modules); }
  catch (error) {
    if (error instanceof R4Unreachable || error instanceof Error && /nothing to click|is disabled/.test(error.message)) r8UnexecutableKind(kind, files, error);
    throw error;
  }
}

/** @param {string} file @param {string} fragment */
function r8AnchorHint(file, fragment) {
  let target = "the reviewed guard/write in this exact fragment; preserve the mutant's semantic change and assertion";
  if (file === "pages/device.js" && fragment.includes("let previewFailure")) target = "X10/O7's preview-failure declaration; keep the independent stale-failure cache injection";
  if (file === "pages/device.js" && fragment.includes("start(key, async")) target = "X10/observation's act request-work callback passed to start; keep send, await, applyAnswer and the injected outcome writer";
  if (file === "pages/device.js" && fragment.includes('opOf("return"')) target = "X10/X10b's rendered Return operation read; inject only the stale failure, preserving busy/value/note";
  if (file === "ops.js" && fragment.includes("(error) =>")) target = "#1306's current-token early return in run's rejection branch; remove only that rejection guard";
  if (file === "ops.js" && fragment.includes("ops.has(key)")) target = "X9's drop slot-deletion guard; add !busy(key), preserving the actual slot deletion";
  const guards = R5_STORIES.filter((story) => story.file === file && story.edits.some(([from]) => from === fragment));
  return `re-anchor ${file}: ${target}${guards.length ? `; A5 guard stories: ${guards.map((story) => story.name).join("; ")}` : ""}. Reviewed anchor-only phase-B edit; retain every detector.`;
}

/** @param {string} source */
function r8DeviceWorkAnchor(source) {
  /** @type {any[]} */ const work = [];
  r8Walk(r8Syntax(source), (node) => {
    if (node.type === "CallExpression" && node.callee.name === "start" && node.arguments[1]?.async && /\bsend\s*\(/.test(source.slice(node.arguments[1].start, node.arguments[1].end))) work.push(node.arguments[1]);
  });
  assert.equal(work.length, 1, "re-anchor observation self-test to Device act's async request-work callback passed to start; insert the unread result after await send and keep applyAnswer");
  return source.slice(work[0].start, work[0].end);
}

/** Actual before/after state. Definition identity spans all scenes, rather
 * than following the selected scene and silently confounding scene/schema.
 * Slot removal is an outcome, not a new operation token: retain its last
 * issued token until a successor actually appears in that same slot.
 * @param {any} ctx
 * @returns {{device: string[], kind: string, values: any, timing: {sent: number, changed: number}, identities: Record<string, any>}} */
function r8Frame(ctx) {
  const state = r4State(), world = ctx.world;
  /** @type {string[]} */ const devices = world.spec.devices.map((/** @type {any} */ d) => d.name).sort();
  const entries = (/** @type {Map<any, any>} */ map) => [...map].sort(([a], [b]) => String(a).localeCompare(String(b)));
  const slot = state.ops.get(ctx.slotKey);
  if (slot) ctx.lastSlotToken = slot.token;
  /** @type {any[]} */ const overlays = state.overlays ?? [];
  return {
    device: devices,
    kind: ctx.kind.name,
    values: {
      request: ctx.kind.request,
      body: (ctx.op ?? ctx.issuedOp)?.body ?? null,
      overlays: overlays.map(({ id: _id, ...value }) => value),
      overlayKinds: overlays.map((row) => row.kind),
    },
    timing: { sent: (ctx.op ?? ctx.issuedOp)?.storyTime ?? 0, changed: ctx.clock ?? 0 },
    identities: {
      epoch: [world.epoch, state.epoch],
      life: devices.map((name) => [name, world.lives.get(name), state.devices.get(name)?.incarnation]),
      scene: world.spec.devices.map((/** @type {any} */ d) => [d.name, d.o.scene ?? "clock", state.devices.get(d.name)?.desired?.scene?.scene]),
      schema: entries(world.schemas),
      membership: world.spec.devices.map((/** @type {any} */ d) => [d.name, d.o.origin ?? "config", state.devices.get(d.name)?.origin]),
      overlay: overlays.map((row) => row.id),
      opening: ctx.opening,
      visit: ctx.visit ?? 0,
      revision: ctx.revision ?? 0,
      draft: [...(ctx.edits ?? new Map())].map(([key, edit]) => [key, edit.identity]),
      token: ctx.lastSlotToken ?? 0,
      owner: ctx.controlIntent ?? 0,
      resource: world.configVersion,
      stream: world.stream,
    },
  };
}

// Story isolation measures changes made by the world or the person. Native
// tokens/owners (the operation and control slots) are product outcomes; a
// required replacement operation may change them along with one input axis.
// Keep every extracted axis classified: no default class for a new identity.
/** @type {Readonly<Record<string, "world"|"input"|"internal">>} */
const R8_IDENTITY_CLASS = Object.freeze({
  epoch: "world", life: "world", scene: "world", schema: "world",
  membership: "world", overlay: "world", resource: "world", stream: "world",
  opening: "input", visit: "input", revision: "input", draft: "input",
  token: "internal", owner: "internal",
});

/** @param {string} axis */
function r8IdentityClass(axis) {
  assert.ok(Object.hasOwn(R8_IDENTITY_CLASS, axis), `identity isolation gap: unclassified identity ${axis}; classify its measured world/input axis or product-internal outcome`);
  return R8_IDENTITY_CLASS[axis];
}

/** Recompute from both frames, including new/removed and unchanged axes, so
 * an unknown identity cannot hide behind a receipt's declared measurements.
 * Full frames and measured axes remain evidence; outcomes are never inputs.
 * @param {Record<string, any>} a @param {Record<string, any>} b */
function r8StoryChanges(a, b) {
  /** @type {string[]} */ const inputs = [];
  /** @type {string[]} */ const outcomes = [];
  for (const axis of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const group = r8IdentityClass(axis);
    if (JSON.stringify(a[axis]) !== JSON.stringify(b[axis]))
      (group === "internal" ? outcomes : inputs).push(axis);
  }
  return { inputs, outcomes };
}

/** @param {any} ctx @param {any} before @param {any} after @param {string} story */
function r8RecordStory(ctx, before, after, story) {
  const receipt = {
    kind: ctx.kind.name, story, a: structuredClone(before), b: structuredClone(after),
    measured: Object.keys(before.identities).filter((axis) => JSON.stringify(before.identities[axis]) !== JSON.stringify(after.identities[axis])), completed: true,
    ...r8StoryChanges(before.identities, after.identities),
    compared: new Map(), points: ctx.points, executions: 1,
  };
  r8Stories.push(receipt);
  return receipt;
}
/** @param {any[]} requirements @param {any[]} stories */
function r8RequireStoryIsolation(requirements, stories) {
  const changes = new Map(stories.map((story) => [story, r8StoryChanges(story.a.identities, story.b.identities)]));
  const gaps = requirements.filter((requirement) => {
    const group = r8IdentityClass(requirement.identity);
    return !stories.some((story) => {
      if (story.kind !== requirement.kind || !story.executions || story.completed === false) return false;
      const { identities: a, ...first } = story.a, { identities: b, ...second } = story.b;
      if (JSON.stringify(first) !== JSON.stringify(second)) return false;
      // Internal outcomes retain their original witness checks, also used by
      // observation fault injection. Only world/input story measurement changes.
      const changed = group === "internal"
        ? [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((axis) => JSON.stringify(a[axis]) !== JSON.stringify(b[axis]))
        : changes.get(story)?.inputs ?? [];
      return changed.length === 1 && changed[0] === requirement.identity &&
        [...story.compared.values()].some((deps) => deps.includes(requirement.identity));
    });
  }).map((r) => r.key);
  assert.deepEqual(gaps, [], "identity isolation gap: missing measured story identity × kind (same device, values, kinds and timing; a compared piece must depend on the identity)");
}

test("r4 harness self-test: r8 story changes count world and input axes while retaining internal outcomes", () => {
  const inventory = new Set([...Object.keys(R4_IDENTITIES), ...Object.keys(R7_IDENTITY_WORDS), ...Object.values(R4_CHANGES).flat(), ...Object.values(R4_STEPS).flat()]);
  assert.deepEqual(Object.keys(R8_IDENTITY_CLASS).sort(), [...inventory].sort(), "every inventoried/extracted identity has an explicit class");
  const frame = (/** @type {Record<string, any>} */ identities) => ({ device: ["d1"], kind: "raw load", values: { request: ["GET", "/api/v2/config/raw"] }, timing: { sent: 0, changed: 0 }, identities });
  const a = frame({ epoch: "old", opening: 1, token: 62, owner: 1 });
  const b = frame({ ...a.identities, epoch: "new", token: 63, owner: 2 });
  const requirement = { kind: "raw load", identity: "epoch", key: "raw load × epoch" };
  const story = { kind: "raw load", a, b, completed: true, executions: 1, compared: new Map([["load state", ["epoch", "token"]]]) };
  assert.deepEqual(r8StoryChanges(a.identities, b.identities), { inputs: ["epoch"], outcomes: ["token", "owner"] });
  r8RequireStoryIsolation([requirement], [story]);
  for (const identity of inventory) {
    const group = r8IdentityClass(identity);
    assert.ok(["world", "input", "internal"].includes(group));
    const changed = r8StoryChanges({ [identity]: 1 }, { [identity]: 2 });
    assert.deepEqual(changed, group === "internal" ? { inputs: [], outcomes: [identity] } : { inputs: [identity], outcomes: [] });
  }
  for (const identities of [a.identities, { ...a.identities, token: 63, owner: 2 }, { ...b.identities, opening: 2 }, { ...b.identities, life: 2 }])
    assert.throws(() => r8RequireStoryIsolation([requirement], [{ ...story, b: frame(identities) }]), /identity isolation gap/);
  const input = { ...requirement, identity: "opening", key: "raw load × opening" };
  r8RequireStoryIsolation([input], [{ ...story, b: frame({ ...a.identities, opening: 2, token: 63 }), compared: new Map([["load state", ["opening", "token"]]]) }]);
  assert.throws(() => r8RequireStoryIsolation([input], [{ ...story, b: frame({ ...a.identities, opening: 2, revision: 2 }) }]), /identity isolation gap/);
  const internal = { ...requirement, identity: "token", key: "raw load × token" };
  r8RequireStoryIsolation([internal], [{ ...story, b: frame({ ...a.identities, token: 63 }) }]);
  assert.throws(() => r8RequireStoryIsolation([internal], [story]), /identity isolation gap/, "internal outcome witnesses retain their original isolation checks");
  const [unknown] = r8ProjectionAxes(r8Project(["new_identity"], "newly extracted identity"), { ...R7_IDENTITY_WORDS, new_identity: /new/ });
  assert.throws(() => r8RequireStoryIsolation([{ ...requirement, identity: unknown }], [story]), /unclassified identity new_identity/);
  assert.throws(() => r8StoryChanges({ ...a.identities, new_identity: 1 }, { ...b.identities, new_identity: 1 }), /unclassified identity new_identity/);
  assert.throws(() => r8StoryChanges(a.identities, { ...b.identities, new_identity: 1 }), /unclassified identity new_identity/);
});

/** Only observation fault injection constructs a foreign read frame. Its
 * replacement value comes from a measured, unconfounded executed transition;
 * the isolation audit accepts solely those original story receipts.
 * @param {any} ctx @param {string} identity @param {any} slotValue @param {any[]} stories */
function r8ForeignOutcomeFrame(ctx, identity, slotValue, stories) {
  const a = r8Frame(ctx);
  const exemplar = stories.find((story) => story.completed !== false && story.measured.length === 1 && story.measured[0] === identity && JSON.stringify(story.a.values) === JSON.stringify(story.b.values) && [...story.compared.values()].some((deps) => deps.includes(identity)));
  assert.ok(exemplar, `identity isolation gap: no measured ${identity} transition available to plant an outcome`);
  r8RequireStoryIsolation([{ kind: exemplar.kind, identity, key: `${exemplar.kind} × ${identity}` }], [exemplar]);
  const replacement = [exemplar.b.identities[identity], exemplar.a.identities[identity]].find((value) => JSON.stringify(value) !== JSON.stringify(a.identities[identity]));
  assert.notEqual(replacement, undefined, `the measured ${identity} transition has a foreign owner`);
  const b = structuredClone(a);
  b.identities[identity] = structuredClone(replacement);
  const changed = Object.keys(a.identities).filter((axis) => JSON.stringify(a.identities[axis]) !== JSON.stringify(b.identities[axis]));
  assert.deepEqual(changed, [identity], "an observation plant crosses only its declared identity");
  return { a, b, slotValue };
}

/** Execute the same generator changes with equal-valued controls. Requirements
 * select histories through the generator's identity declarations; only the
 * measured before/after frames can discharge them.
 * @param {any} t @param {any[]} requirements @param {Record<string, any>} modules */
async function r8RunStoryAudit(t, requirements, modules) {
  const firstReceipt = r8Stories.length;
  const http = requirements.filter((r) => !r.kind.startsWith("web/js/live.js"));
  const changes = [...Object.entries(R4_STEPS), ...Object.entries(R4_CHANGES)].filter(([name]) => name in R4_CHANGE || name in R4_STEP);
  for (const original of R4_KINDS) {
    const kind = /** @type {R4Kind} */ ({ ...original, isolation: true });
    // Keep equal retained data when changing epoch; the ordinary matrix
    // retains its deliberately distinguishable server payloads.
    if (kind.world.overlays) {
      const overlays = kind.world.overlays(A, 0);
      kind.world = { ...kind.world, overlays: () => overlays };
    }
    for (const requirement of http.filter((r) => r.kind === kind.name && r.identity !== "overlay")) {
      for (const [change] of changes.filter(([, axes]) => axes.length === 1 && axes[0] === requirement.identity)) {
        const start = r8Stories.length;
        try {
          const experiment = requirement.identity === "owner" ? { ...kind, completeBeforeChange: true, world: { ...kind.world, devices: kind.world.devices.map((/** @type {any} */ d) => ({ ...d, o: { ...d.o, override: 30 } })) } } : kind;
          await r4Case(t, experiment, change, r4Ends(kind)[0], { modules });
        } catch (error) {
          if (!(error instanceof R4Unreachable) && !(error instanceof Error && /nothing to click|is disabled/.test(error.message))) throw error;
        }
        if (r8Stories.slice(start).some((story) => story.kind === kind.name && story.measured.length === 1 && story.measured[0] === requirement.identity && JSON.stringify(story.a.values) === JSON.stringify(story.b.values) && [...story.compared.values()].some((deps) => deps.includes(requirement.identity)))) break;
      }
    }
  }
  // Replay registered focused stories, not an independently constructed K1
  // pair. Removing their data must remove the overlay-id witness.
  for (const story of R6_FOCUSED.filter((s) => s.name.startsWith("overlays clear"))) await story.run(t);
  const live = requirements.filter((r) => r.kind.startsWith("web/js/live.js"));
  for (const requirement of live) await r5Live(t, await r5Module("live.js"), ({ sources, timers, events }) => {
    sources[0].onopen();
    const first = sources[0];
    first.emit("device", `${A}-10`, view("d1"));
    first.onerror();
    timers.findLast((/** @type {any} */ timer) => timer.ms === 5000).callback();
    sources[1].onopen();
    const second = sources[1], before = events.length, payload = view("d1");
    first.emit("device", `${A}-10`, payload);
    assert.equal(events.length, before);
    second.emit("device", `${A}-10`, payload);
    assert.equal(events.length, before + 1);
    // The two objects are the actual source instances used for delivery.
    const frame = (/** @type {any} */ source) => ({ device: "d1", kind: requirement.kind, values: payload, timing: { delivered: 5000 }, identities: { stream: sources.indexOf(source) } });
    r8Stories.push({ kind: requirement.kind, story: "retired/current EventSource", a: frame(first), b: frame(second), measured: ["stream"], executions: 1, compared: new Map([["event admission", ["stream"]]]) });
  });
  if (process.env.R8_STORY_REPORT) r4Append(process.env.R8_STORY_REPORT, JSON.stringify({ requirements: requirements.map((r) => r.key), stories: r8Stories.map(({ points: _points, compared, ...s }) => ({ ...s, compared: [...compared] })) }) + "\n");
  const stories = r8Stories.slice(firstReceipt);
  r8RequireStoryIsolation(requirements, stories);
  return stories;
}

/** A failed preview is already on both page lines before the owner changes.
 * An independent Mode operation stays out across that change and all 3 ends.
 * @param {any} t @param {string} change @param {R4End} end @param {any} [device] */
async function r8ShownPreviewFailure(t, change, end, device) {
  const kind = {
    ...r4KindOf("device mode"),
    setup: async (/** @type {any} */ ctx) => {
      await r4Unverified(ctx);
      assert.match(r4Text(ctx.root.querySelector(".why .v-disp")), /Settings not previewed:/, "the failure is shown on Display before the identity changes");
    },
  };
  const run = await r4Run(t, kind, change, end, "case", device ? { device } : undefined);
  for (const [point, pieces] of run.points.entries()) {
    const line = pieces.get("device: Display line");
    assert.ok(line, "Display has its own observation piece");
    assert.doesNotMatch(line.value, /Settings not previewed:/, `${R4_POINTS[point]}: Display line [scene, epoch, life, owner] retains the previous preview failure across ${change}`);
  }
}

/** @type {Array<{name: string, edits: Array<[string, string]>}>} */
const R8_PREVIEW_MUTANTS = [
  {
    name: "O7",
    edits: [
      ["let previewFailure = null;", "let previewFailure = null; let r8OldPreviewFailure = null;"],
      ["previewFailure = message;", "previewFailure = message; if (message) r8OldPreviewFailure = message;"],
      ["const now = showingNow(state, view, { previewFailure });", "const now = showingNow(state, view, { previewFailure: r8OldPreviewFailure ?? previewFailure });"],
    ],
  },
  {
    name: "O7b",
    edits: [["const disp = /** @type {any} */ (now.display);", 'const disp = /** @type {any} */ (now.display); if (q(".why .v-disp").textContent.includes("Settings not previewed:")) disp.text = q(".why .v-disp").textContent;']],
  },
  {
    name: "O7c",
    edits: [["const disp = /** @type {any} */ (now.display);", 'const disp = /** @type {any} */ (now.display); if (view.desired.scene.scene !== "clock" && q(".why .v-disp").textContent.includes("Settings not previewed:")) disp.text = q(".why .v-disp").textContent;']],
  },
];
for (const mutant of R8_PREVIEW_MUTANTS)
  test(`r4 harness self-test: r8 callback Display ${mutant.name} cannot keep old preview feedback`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const change of mutant.name === "O7c" ? ["scene"] : ["scene", "epoch", "reincarnate"])
      for (const end of R4_ENDS) {
        await r8ShownPreviewFailure(t, change, end, (await r5Module("pages/device.js")).page);
        const device = (await r5Module("pages/device.js", mutant.edits)).page;
        await assert.rejects(r8ShownPreviewFailure(t, change, end, device), (/** @type {any} */ error) => {
          assert.match(error.message, /Display line .*retains the previous preview failure/);
          t_log(`${mutant.name}/${change}/${end}: ${error.message.split("\n")[0]}`);
          return true;
        });
      }
  });

/** Change the generator, never its declared identity labels. @param {string} name @param {() => Promise<any>} run */
async function r8WithDataMutant(name, run) {
  const reincarnate = R4_CHANGE.reincarnate, scene = R4_CHANGE.scene;
  const focused = [...R6_FOCUSED];
  const overlayKinds = R8_EQUAL_OVERLAY_RECORDS.map((row) => row.kind);
  try {
    if (name === "H1") {
      R6_FOCUSED.splice(0, R6_FOCUSED.length, ...focused.filter((story) => !R7_OVERLAY_CASES.includes(story)));
      R8_EQUAL_OVERLAY_RECORDS.forEach((row, i) => { row.kind = ["scene", "mode", "brightness"][i]; });
    }
    if (name === "H2") R4_CHANGE.reincarnate = (ctx) => { reincarnate(ctx); r4NewEpoch(ctx.world); };
    if (name === "H3") R4_CHANGE.scene = async (ctx) => { await scene(ctx); reincarnate(ctx); await settle(); };
    return await run();
  } finally {
    R4_CHANGE.reincarnate = reincarnate;
    R4_CHANGE.scene = scene;
    R6_FOCUSED.splice(0, R6_FOCUSED.length, ...focused);
    R8_EQUAL_OVERLAY_RECORDS.forEach((row, i) => { row.kind = overlayKinds[i]; });
  }
}

for (const [name, missing] of [["H1", "overlays clear × overlay"], ["H2", "device mode × life"], ["H3", "settings save × scene"]])
  test(`r4 harness self-test: r8 ${name} must fail measured isolation and name ${missing}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { requirements, stories } = await r7RunAudits(t);
    r8RequireStoryIsolation(requirements, stories);
    if (name === "H3") assert.throws(() => r8UnexecutableKind(r4KindOf("settings end retry"), r4WebFiles(), new R4Unreachable("nothing to click")), /identity isolation gap: .*settings end retry × scene/);
    await r8WithDataMutant(name, () => assert.rejects(r8RunStoryAudit(t, requirements, {}), (/** @type {any} */ error) => {
      assert.match(error.message, /identity isolation gap/);
      assert.ok(error.actual.includes(missing), error.message);
      t_log(`${name}: identity isolation gap: ${error.actual.join("; ")}`);
      return true;
    }));
    r8RequireStoryIsolation(requirements, stories);
  });

test("r4 harness self-test: r8 X3 under H2 and X4 under H3 fail the audit even when their cases pass", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { requirements } = await r7RunAudits(t);
  const opsSource = r4ReadFile(new URL("../../web/js/ops.js", import.meta.url), "utf8");
  const slot = r4xFunctions(r4xCodeOnly(opsSource)).find((fn) => fn.name === "deviceSlot");
  assert.ok(slot, "re-anchor X3 to ops.js's device-slot key builder; preserve only its life omission");
  const ops = await r4Mutant("ops.js", [[opsSource.slice(slot.start, slot.end + 1), '{ return `${control}:${view.name}@${view.epoch ?? ""}`; }']]);
  const x3 = (await r5Module("pages/device.js", [], { "../ops.js": ops })).page;
  const x4 = await r4DeviceWithForm([['`${device}/${of.scene}@${of.epoch ?? ""}/${of.incarnation}`', '`${device}@${of.epoch ?? ""}/${of.incarnation}`']]);
  for (const [name, data, kindName, change, device, missing] of [
    ["X3", "H2", "device mode", "reincarnate", x3, "device mode × life"],
    ["X4", "H3", "settings save", "scene", x4, "settings save × scene"],
  ]) {
    const kind = { ...r4KindOf(kindName), isolation: true };
    assert.deepEqual(await r4Case(t, kind, change, "500"), []);
    assert.ok((await r4Case(t, kind, change, "500", { modules: { device } })).length, `${name} is caught by its unconfounded story`);
    await r8WithDataMutant(data, async () => {
      assert.deepEqual(await r4Case(t, kind, change, "500", { modules: { device } }), [], `${name} survives the confounded case`);
      await assert.rejects(r8RunStoryAudit(t, requirements, { device }), (/** @type {any} */ error) => {
        assert.match(error.message, /identity isolation gap/);
        assert.ok(error.actual.includes(missing), error.message);
        t_log(`${name}/${data}: cases pass; identity isolation gap: ${missing}`);
        return true;
      });
    });
  }
});

test("r4 inventory self-test: r8 identity vocabulary and request kinds cannot silently drift", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { requirements, requestOrigins: origins } = await r7RunAudits(t);
  assert.ok(requirements.length);
  assert.throws(() => r8ProjectionAxes(r8Project(["new_identity_word"], "a new effect identity")), /identity vocabulary lacks new_identity_word/);
  const files = r4WebFiles();
  const extra = { file: "web/js/pages/r8-new-operation.js", src: 'import { request as send } from "../api.js"; export async function paint() { return send("POST", "/api/v2/new-kind", {resource:"config"}); }' };
  r8RequireRequestKinds(files, origins);
  assert.throws(() => r8RequireRequestKinds([...files, extra], origins), /uncovered request kind: .*new-kind/);
  const sameFunction = files.map((file) => file.file.endsWith("/pages/device.js") ? { ...file, src: file.src.replace(r8DeviceWorkAnchor(file.src), 'async () => { if (false) await request("POST", "/api/v2/new-kind", {resource:"config"}); return applyAnswer(await send(key)); }') } : file);
  assert.throws(() => r8RequireRequestKinds(sameFunction, origins), /uncovered request kind: .*new-kind/);
  assert.equal(r8RequestSites([extra]).length, 1, "an imported request alias is an operation source");
  const namespaced = { ...extra, src: 'import * as transport from "../api.js"; const api = transport; export async function work() { return api.request("POST", "/api/v2/new-kind", {resource:"config"}); }' };
  assert.equal(r8RequestSites([namespaced]).length, 1);
  assert.throws(() => r8RequireRequestKinds([namespaced], new Map()), /uncovered request kind: .*new-kind/);
  const repeated = { ...extra, src: extra.src.replace('return send(', 'if (false) send("POST", "/api/v2/new-kind", {resource:"config"}); return send(') };
  const occurrences = r8RequestSites([repeated]);
  assert.equal(occurrences.length, 2);
  assert.throws(() => r8RequireRequestKinds([repeated], new Map([["only the first call", occurrences[0]]])), /uncovered request kind: .*occurrence 1/);
});

test("r4 inventory self-test: r8 callback aliases, registry destructuring and arbitrary render roots are extracted", () => {
  for (const read of ["const registry = getState().ops; const aliased = registry; return aliased;", "const s = getState(); const {ops: registry} = s; return registry;"]) {
    const files = [{ file: "web/js/pages/reader.js", src: `import {getState} from "../store.js"; const project = input => { ${read} }; const paintAnything = state => setHtml(root, project());` }];
    const sites = r7OutcomeSites(files);
    assert.ok(sites.some((site) => site.type === "registry"), `registry read is extracted: ${read}`);
  }
  for (const callback of ["key => op(key)", "project"]) {
    const files = [{ file: "web/js/pages/mapped.js", src: `import {op} from "../ops.js"; const project = key => op(key); const paintAnything = state => { const outcomes = keys.map(${callback}); setHtml(root, outcomes); };` }];
    assert.ok(r7OutcomeSites(files).some((site) => site.type === "slot"), "synchronous render mapping retains its operation reader");
  }
  const files = [
    { file: "web/js/pages/callback.js", src: 'import {create} from "../components/outcome.js"; let feedback = null; function paintAnything() { setHtml(root, feedback); } function mount() { create({ completed(message) { feedback = message; paintAnything(); } }); }' },
    { file: "web/js/components/outcome.js", src: 'export function create(options) { async function work() { await Promise.resolve(); const {completed: notify} = options; notify("failed"); } return {work}; }' },
  ];
  assert.ok(r7OutcomeSites(files).some((site) => site.file.endsWith("callback.js") && site.binding === "feedback"), "an arbitrary callback option called asynchronously in another module carries render state");
  const imported = [
    { file: "web/js/pages/callback.js", src: 'import {create} from "../components/outcome.js"; import {receive, readFeedback as currentFeedback} from "../view/callback-cache.js"; const paintAnything = state => setHtml(root, currentFeedback()); function mount() { create({completed: receive}); }' },
    files[1],
    { file: "web/js/view/callback-cache.js", src: 'let feedback = null; export function receive(message) { feedback = message; } export const readFeedback = () => feedback;' },
  ];
  assert.ok(r7OutcomeSites(imported).some((site) => site.file.endsWith("callback-cache.js") && site.binding === "feedback"), "imported callback writers and imported render readers retain their cross-module outcome obligation");
});

test("r4 harness self-test: r8 a changed piece without the crossed identity is no observer", () => {
  const root = pageRoot();
  root.innerHTML = '<div class="why"><div class="v-disp">before</div></div>';
  const ctx = { page: "device", root };
  try {
    const before = r7Pieces(ctx);
    root.querySelector(".v-disp").textContent = "after";
    assert.ok(r7PieceChanges(before, r7Pieces(ctx), "scene", ctx).includes("Display line"));
    assert.deepEqual(r7PieceChanges(before, r7Pieces(ctx), "membership", ctx), [], "Display changes but does not declare membership");
  } finally { root.remove(); }
});

test("r4 harness self-test: r8 every A5 anchor gives a mechanical phase-B re-anchor instruction", () => {
  for (const story of R5_STORIES)
    for (const [fragment] of story.edits)
      assert.throws(() => r8SourceAnchor("", fragment, r8AnchorHint(story.file, fragment)), (/** @type {any} */ error) => {
        assert.match(error.message, /re-anchor/);
        assert.ok(error.message.includes(story.name), error.message);
        assert.ok(error.message.includes(fragment), "the exact reviewed predicate/write is reported");
        return true;
      });
  assert.equal(r8SourceAnchor("if /* formatting only */ (!current()) return;", "if (!current()) return;", "re-anchor token guard"), "if /* formatting only */ (!current()) return;");
});

r8HarnessLoaded = true;
r8ResolveHarness();
