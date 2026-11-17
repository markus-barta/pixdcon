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
  commit: ["draft"],
  "newer draft": ["draft"],
  "other field": ["draft"],
  schema: ["schema"],
  revisit: ["visit"],
  membership: ["membership"],
  reconnect: [],
};
/** @typedef {keyof typeof R4_CHANGES} R4Change */
const R4_ENDS = /** @type {const} */ (["success", "500", "timeout"]);
/** @typedef {(typeof R4_ENDS)[number] | "refused"} R4End */
const R4_POINTS = ["after the change", "after the end", "after everything was answered"];
/** config.json as pixdcon gives it: distinguishable per run, so a text of another run shows. @param {string} epoch */
const R4_RAW = (epoch) => `{"devices": [], "run": "${epoch}"}`;
/** The scene definition of Clock: two fields, so a Save of one with an edit of the other typed meanwhile is a story. */
const R4_SCHEMA = {
  n: { type: "int", label: "N", group: "General", description: "", default: 1, placeholder: "" },
  m: { type: "int", label: "M", group: "General", description: "", default: 1, placeholder: "" },
};
/** The definition after pixdcon took a changed scene file (same run, life, scene and draft): n relabelled, a field more. */
const R4_SCHEMA_2 = {
  ...R4_SCHEMA,
  n: { ...R4_SCHEMA.n, label: "N (new)" },
  k: { type: "int", label: "K", group: "General", description: "", default: 5, placeholder: "" },
};

/** A change that cannot happen in the story: the stand-in DOM offers no way to do it. */
class R4Unreachable extends Error {}

/**
 * The world pixdcon holds in one story: its run (epoch), positions,
 * revisions, the lives and config membership of its devices, the scene
 * definition, the saved settings, and the previews it was sent.
 *
 * @param {{devices?: Array<{name: string, o?: any}>, overlays?: (epoch: string) => any[], settingsOverlay?: boolean}} spec
 */
function r4World(spec) {
  /** @type {any} */
  const world = {
    epoch: "",
    seq: 100,
    rev: 100,
    stream: 0,
    epochs: [],
    lives: new Map(),
    schema: R4_SCHEMA,
    saved: {},
    previews: new Set(),
    spec: { ...spec, devices: (spec.devices ?? []).map((d) => ({ ...d, o: { ...d.o } })) },
  };
  for (const device of spec.devices ?? []) world.lives.set(device.name, 1);
  return world;
}

/** What pixdcon holds now, as a request it processes now would see it. @param {any} world */
const r4Now = (world) => ({
  epoch: world.epoch,
  rev: world.rev,
  lives: new Map(world.lives),
  schema: world.schema,
  saved: { ...world.saved },
  devices: world.spec.devices.map((/** @type {any} */ d) => ({ ...d, o: { ...d.o } })),
});

/** @param {any} world @param {string} name @param {string} epoch @param {number} life @param {number} rev @param {any[]} [devices] the devices as pixdcon held them */
function r4View(world, name, epoch, life, rev, devices = world.spec.devices ?? []) {
  const entry = devices.find((/** @type {any} */ d) => d.name === name);
  const v = view(name, { ...(entry?.o ?? {}), epoch, incarnation: life, rev });
  // Distinguishable per run: what an answer of another run brings shows.
  v.displayName = `${name} of ${epoch}`;
  if (entry?.o?.override !== undefined) v.desired.brightness = { override: entry.o.override, source: "web", since: v.desired.brightness.since };
  return v;
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
  world.epochs.push(world.epoch);
  for (const name of world.lives.keys()) world.lives.set(name, 1);
  r4Snapshot(world);
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
  const state = sceneSettings(device, scene, { epoch: at.epoch, incarnation: at.lives.get(device) ?? 1, rev: at.rev, effective: o.effective, preview: o.preview ?? null, schema: at.schema ?? world.schema });
  const saved = at.saved ?? {};
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
    if (m[3] === "/preview" && method === "PUT")
      return { state: r4Settings(world, call, device, scene, { effective: call.body?.values, preview: { session: "s1", draft: call.body?.draft } }), rejected: {}, applied: true };
    if (m[3] === "/overlays") return { state: r4Settings(world, call, device, scene), failed: [] };
    if (!m[3] && method === "PUT") return { state: r4Settings(world, call, device, scene), overlaysNotCleared: [] };
    return r4Settings(world, call, device, scene);
  }
  if (path === "/api/v2/config/raw")
    return method === "GET" ? { text: R4_RAW(call.epoch), state: { ...CONFIG_STATE, rev: call.rev } } : { state: { ...CONFIG_STATE, rev: call.rev }, diff: {} };
  if (path === "/api/v2/config/reload") return { state: { ...CONFIG_STATE, rev: call.rev } };
  if (path === "/api/v2/log") return [];
  if (/^\/api\/v2\/overlays\/[^/]+$/.test(path)) return { overlays: world.spec.overlays?.(call.epoch) ?? [], pending: false, confirmed: true };
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
        if (settings) {
          const device = decodeURIComponent(settings[1]);
          const scene = decodeURIComponent(settings[2]);
          const life = world.lives.get(device) ?? 1;
          const held = `${world.epoch}/${device}@${life}/${scene}`;
          if (settings[3] && method === "PUT") world.previews.add(held);
          if (settings[3] && method === "DELETE" && !world.previews.has(held))
            stray = `DELETE …/settings/${scene}/preview in run ${world.epoch}, life ${life} of ${device}: pixdcon was sent no preview of it in this run and life`;
          if (!settings[3] && method === "PUT") {
            world.saved = { ...world.saved, ...(body?.set ?? {}) };
            for (const key of body?.reset ?? []) delete world.saved[key];
          }
        }
        /** @type {any} */
        const call = {
          method,
          url: String(url),
          path,
          body,
          ...r4Now(world),
          seq: world.seq,
          stray,
          answered: false,
          /** @param {number} status @param {unknown} [answer] */
          answer(status, answer) {
            if (call.answered) return;
            call.answered = true;
            resolve(new Response(answer === undefined ? null : JSON.stringify(answer), { status, headers: { "X-Pixdcon-Position": `${call.epoch}-${call.seq}` } }));
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
/** The kind of a row's marker (default, saved, previewing, not previewed, …), without the values it names. @param {any} root @param {string} key */
const r4Marker = (root, key) => r4Text(root.querySelector(`.set-body [data-row="${key}"] .mk`)).split("·")[0].trim() || "∅";
/** The edits the next Save sends: the rows whose marker says an edit (previewing, not previewed). @param {any} root */
const r4Unsaved = (root) =>
  root.querySelectorAll(".set-body [data-row]").filter((/** @type {any} */ row) => /^(previewing|not previewed)/.test(r4Text(row.querySelector(".mk")))).map((/** @type {any} */ row) => row.getAttribute("data-row")).join(" ") || "none";
/**
 * What a row marker depends on, by what it says: "not previewed" is preview
 * feedback (its draft, newest and above the committed one, in its scope and
 * scene definition); the rest (saved, previewing, default) is Save
 * bookkeeping (each submitted edit, and config membership).
 *
 * @param {string} said
 */
const r4MarkerDeps = (said) => (/^not previewed/.test(said) ? ["opening", "epoch", "life", "draft", "schema"] : ["draft", "membership"]);
/**
 * What the settings status line depends on, by what it says: an outcome of
 * the action slot (Save, Revert, Clear) depends on the slot identities, and
 * a Save outcome also on config membership (gate r4 §1); preview feedback on
 * its draft, scope and scene definition; the count of unsaved edits on the
 * drafts and membership.
 *
 * @param {string} said
 */
function r4StatusDeps(said) {
  if (/^(Not saved|Saved)/.test(said)) return ["epoch", "life", "membership"];
  if (/^(Not reverted|Not cleared|\d+ could not be cleared)/.test(said)) return ["epoch", "life"];
  if (/^Not previewed/.test(said)) return ["opening", "epoch", "life", "draft", "schema"];
  if (/^(Previewing|No unsaved|Changes are applied)/.test(said)) return ["draft", "membership"];
  return ["draft", "schema"];
}
const r4Dialog = () => {
  const dialog = fakeDocument.body.querySelector(".scrim .dlg");
  return dialog ? `open · ${r4Button(dialog.querySelector('[data-act="retry"]'))} · ${r4Text(dialog.querySelector(".retry-note"))}` : "closed";
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
  if (!click(el)) throw new Error(`${r4Text(el)} is disabled`);
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
      ["editor text", ["opening", "revision", "epoch"], r4Value(root.querySelector("textarea"))],
      ["load and validity state", ["opening", "revision", "epoch"], r4Text(root.querySelector(".edbar .state"))],
      ["gutter marks", ["opening", "revision", "epoch"], root.querySelectorAll(".gut b.err").map(r4Text).join(" ") || "none"],
      ["focus", ["opening", "revision"], r4Focus(root)],
      ["Save", ["epoch"], r4Button(root.querySelector('[data-act="save"]'))],
      ["Reload", ["epoch"], r4Button(root.querySelector('[data-act="reload"]'))],
      ["outcome line", ["epoch"], r4Text(root.querySelector(".errline"))],
    ],
    type: (ctx) => r4Type(ctx.root.querySelector("textarea"), '{"devices": [],\n "typed": 2}'),
  },
  config: {
    module: () => configPage,
    pieces: (root) => {
      const row = root.querySelector(".ct-edit");
      return [
        ["edit row", ["opening", "visit", "life", "revision", "membership"], row ? `open for ${row.querySelector("form")?.getAttribute("data-device")}` : "closed"],
        ["edit row fields", ["opening", "visit", "life", "revision", "membership"], row ? `${r4Value(row.querySelector('[name="displayName"]'))} | ${r4Value(row.querySelector('[name="comment"]'))}` : "∅"],
        ["Add device fields", ["opening", "revision"], `${r4Value(root.querySelector('form.addf [name="name"]'))} | ${r4Value(root.querySelector('form.addf [name="ip"]'))}`],
        ["focus", ["opening", "visit", "revision"], r4Focus(root)],
        // A slot (busy label, outcome) outlives the visit and the opening (rule 5): it depends on the slot identities only.
        ["edit row Save and outcome", ["epoch", "life"], row ? `${r4Button(row.querySelector('[data-act="patch"]'))} | ${r4Text(row.querySelector(".ef-f .slot"))}` : "∅"],
        ["Add to config.json", ["epoch", "life", "membership"], `${r4Button(root.querySelector('[data-act="adopt"]'))} | ${root.querySelectorAll(".ct-body .slot").filter((/** @type {any} */ el) => !el.closest(".ct-edit")).map(r4Text).join(" ") || "∅"}`],
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
        ["preview feedback", ["opening", "epoch", "life", "draft", "schema"], r4PreviewFeedback(root)],
        // What a field shows is an edit (its draft) or the store's value (data): compared when the draft or the membership changed.
        ["field n", ["draft", "membership"], r4Value(field(root, "n"))],
        ["field m", ["draft", "membership"], r4Value(field(root, "m"))],
        ["row marker of n", r4MarkerDeps, r4Marker(root, "n")],
        ["row marker of m", r4MarkerDeps, r4Marker(root, "m")],
        ["edits the next Save sends", ["draft", "membership"], r4Unsaved(root)],
        ["Create copy fields", ["opening", "revision"], `${r4Value(root.querySelector('.copyf [name="targetKey"]'))} | ${r4Value(root.querySelector('.copyf [name="name"]'))}`],
        ["focus", ["opening", "revision", "draft"], r4Focus(root)],
        ["recovery dialog", ["opening", "epoch", "life"], r4Dialog()],
        // Slot labels and outcomes (busy, failure, note) depend on the slot identities; preview feedback is the piece above.
        ["title status line", ["epoch", "life"], r4Text(root.querySelector(".dev-head .sub"))],
        ["settings status line", r4StatusDeps, r4Text(root.querySelector(".set-status"))],
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
 *    comes after the end;
 *  - `ends`: ends beyond success, 500 and timeout;
 *  - `invariant`: what must hold while the request runs.
 *
 * @typedef {{name: string, site: string, page: string, world: any, request: [string, string], setup?: (ctx: any) => Promise<void>|void, begin?: (ctx: any) => Promise<void>|void, atOpen?: boolean, early?: boolean, commutes?: R4Change[], ends?: R4End[], invariant?: (ctx: any) => string|null}} R4Kind
 * @type {R4Kind[]}
 */
const R4_KINDS = [
  { name: "raw load", site: "web/js/pages/config-raw.js:175", page: "raw", world: r4d1(), request: ["GET", "/api/v2/config/raw"], atOpen: true },
  {
    name: "raw save", site: "web/js/pages/config-raw.js:227", page: "raw", world: r4d1(), request: ["PUT", "/api/v2/config/raw"],
    setup: (ctx) => r4Type(ctx.root.querySelector("textarea"), '{"devices": [], "saved": 1}'),
    begin: (ctx) => r4Click(ctx.root.querySelector('[data-act="save"]')),
    ends: ["refused"],
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
  { name: "settings preview", site: "web/js/components/settings-form.js:443", page: "device", world: r4d1(), request: ["PUT", "/settings/clock/preview"], early: true, begin: (ctx) => r4Type(field(ctx.root, "n"), "2"), commutes: ["membership"] },
  {
    name: "settings save", site: "web/js/components/settings-form.js:474", page: "device", world: r4d1(), request: ["PUT", "/settings/clock"],
    setup: r4Previewed, begin: (ctx) => r4Click(saveButton(ctx.root)),
    // Save's bookkeeping acknowledges each submitted edit: a newer draft, of n or of another field, is outside its projection.
    // Pixdcon wrote what was submitted: a changed scene definition does not take that back (remaining edits are revalidated).
    commutes: ["newer draft", "other field", "schema"],
  },
  {
    name: "settings revert", site: "web/js/components/settings-form.js:517", page: "device", world: r4d1(), request: ["DELETE", "/settings/clock/preview"],
    // The click clears the edits (before any answer): its reference clicks too, and ends the Revert at once.
    early: true, setup: r4Previewed, begin: (ctx) => r4Click(ctx.root.querySelector('.set-h [data-act="revert"]')),
    // Its outcome (the end of the preview, the slot's line) is outside a newer draft, membership and the scene definition: a failed Revert keeps the store's values.
    commutes: ["newer draft", "other field", "membership", "schema"],
  },
  {
    name: "settings clear overlays", site: "web/js/components/settings-form.js:545", page: "device", world: { ...r4d1(), settingsOverlay: true }, request: ["DELETE", "/settings/clock/overlays"],
    begin: (ctx) => r4Click(ctx.root.querySelector('.set-h [data-act="clear"]')),
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
  if (change === "commit" && ["settings save", "settings revert", "settings clear overlays"].includes(kind.name))
    return "Save, Revert and Clear are one busy slot: Save stays disabled while the operation runs";
  if (change === "revisit" && kind.page !== "config") return `the ${kind.page} page has no edit row`;
  if (change === "revisit" && kind.world.devices?.[0]?.o?.origin === "blob") return "a device that is not in config.json has no edit row";
  return null;
}

/** The page that a person leaves to (and types on there): Config, or Raw when the story is on Config. @param {any} ctx */
const r4Away = (ctx) => (ctx.kind.page === "config" ? "raw" : "config");

/** @param {any} ctx @param {string} page */
function r4Open(ctx, page) {
  ctx.page = page;
  ctx.root = pageRoot();
  (ctx.modules?.[page] ?? R4_PAGES[page].module()).mount(ctx.root, R4_PAGES[page].params ?? {});
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
    r4Live(world, "settings", r4Settings(world, r4Now(world), entry.name, entry.o.scene ?? "clock"));
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
      r4Type(field(ctx.root, "n"), "7");
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
  },
  async "newer draft"(ctx) {
    await r4FormReady(ctx);
    r4Type(field(ctx.root, "n"), "3");
  },
  async "other field"(ctx) {
    await r4FormReady(ctx);
    r4Type(field(ctx.root, "m"), "3");
  },
  schema(ctx) {
    // pixdcon took a changed scene file: a newer SettingsState with another
    // definition, in the same run, life, scene, and with the same draft.
    const { world } = ctx;
    const name = r4StoryDevice(ctx);
    const entry = world.spec.devices.find((/** @type {any} */ d) => d.name === name);
    world.schema = R4_SCHEMA_2;
    world.rev += 1;
    r4Live(world, "settings", r4Settings(world, r4Now(world), name, entry.o.scene ?? "clock"));
  },
  revisit(ctx) {
    // Cancel, and the same device's row opens again, in the same opening: a new visit of the editor.
    const cancel = ctx.root.querySelector('.ct-edit [data-act="cancel"]');
    if (cancel) r4Click(cancel);
    const edit = ctx.root.querySelector(`[data-act="edit"][data-device="${ctx.world.spec.devices[0]?.name}"]`);
    if (!edit) throw new R4Unreachable(ctx.page === "config" ? "a device that is not in config.json has no edit row" : `the ${ctx.page} page has no edit row`);
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

/**
 * One run of a story.
 *
 * @param {any} t the test (its manual clock)
 * @param {R4Kind} kind
 * @param {R4Change|null} change null: no change (the reference of a reconnect)
 * @param {R4End} end
 * @param {"case"|"without"|"early"|"after"|"probe"} mode after: the change comes after the end (the commuted story); probe: only whether the change can be made
 * @param {Record<string, any>} [modules] pages to mount instead of the real ones (the self-tests' mutants)
 * @returns {Promise<{points: Array<Map<string, {deps: R4Deps, value: string}>>, changed: Set<string>, absolute: string[], unreachable?: string}>}
 */
async function r4Run(t, kind, change, end, mode, modules) {
  for (const key of [...r4State().ops.keys()]) r4SetOp(key, null);
  fakeDocument.activeElement = null;
  const world = r4World(kind.world);
  /** @type {any} */
  const ctx = { world, calls: r4Server(world), kind, page: null, root: null, op: null, modules, changed: new Set(change ? R4_CHANGES[change] : []) };
  r4NewEpoch(world);
  /** @type {Array<Map<string, {deps: R4Deps, value: string}>>} */
  const points = [];
  /** What must hold in the case whatever the reference shows. @type {string[]} */
  const absolute = [];
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
    }
    if (mode === "early") {
      ctx.op.ok();
      ctx.op = null;
      await settle();
    }
    if (mode === "without" && kind.atOpen) throw new Error("an operation that opens with the page has an early reference");
    t.mock.timers.tick(10_000);
    const observe = () => new Map(R4_PAGES[ctx.page].pieces(ctx.root).map(([name, deps, value]) => [`${ctx.page}: ${name}`, { deps, value: r4InStory(world, value) }]));
    ctx.changeAt = ctx.calls.length;
    if (mode === "probe") {
      try {
        if (change) await R4_CHANGE[change](ctx);
      } catch (error) {
        if (error instanceof R4Unreachable) return { points, changed: ctx.changed, absolute, unreachable: error.message };
        throw error;
      }
      return { points, changed: ctx.changed, absolute };
    }
    if (change && mode !== "after") await R4_CHANGE[change](ctx);
    await settle();
    if (!ctx.changed.has("epoch") && !ctx.changed.has("life")) held();
    points.push(observe());
    ctx.endAt = ctx.calls.length;
    if (end === "timeout") {
      ctx.op?.abandon();
      t.mock.timers.tick(5_000);
    } else if (ctx.op) {
      if (end === "success") ctx.op.ok();
      else if (end === "refused") ctx.op.answer(422, { code: "invalid_config", error: "config.json is not valid", message: "Line 2: a value is missing.", line: 2 });
      else ctx.op.answer(500, {});
    }
    await settle();
    points.push(observe());
    if (change && mode === "after") {
      ctx.changeAt = ctx.calls.length;
      await R4_CHANGE[change](ctx);
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
    for (const d of world.spec.devices) {
      world.rev += 1;
      r4Live(world, "device", r4View(world, d.name, world.epoch, world.lives.get(d.name), world.rev));
    }
    await r4AnswerAll(ctx);
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
    return { points, changed: ctx.changed, absolute };
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
 * @param {{points: Array<Map<string, {deps: R4Deps, value: string}>>, changed: Set<string>, absolute: string[]}} got
 * @param {{points: Array<Map<string, {deps: R4Deps, value: string}>>}} want
 * @param {"early"|"without"|"after"|"none"} reference how the reference ran
 * @param {boolean} atOpen the operation is the load the page's opening sent
 * @returns {string[]}
 */
function r4Differences(change, got, want, reference, atOpen) {
  const changed = got.changed;
  /** @type {string[]} */
  const out = [...got.absolute];
  got.points.forEach((pieces, i) => {
    // A reference that ended its operation at once differs from the case
    // while the case's operation still runs; a reconnect is compared where
    // everything was answered (the fence may ask again meanwhile), and so is
    // a commuted story (its change came later). A load that opens with the
    // page is compared where everything was answered: until then the
    // reference holds data the case still waits for.
    if ((reference === "early" && i === 0) || (atOpen && i < 2) || ((reference === "none" || reference === "after") && i < 2)) return;
    for (const [name, piece] of pieces) {
      const value = want.points[i]?.get(name)?.value;
      // A piece whose identities follow what it says is judged by what the case says: a slot outcome there is not draft feedback.
      const deps = typeof piece.deps === "function" ? piece.deps(piece.value) : piece.deps;
      if (reference !== "none" && !deps.some((d) => changed.has(d))) continue;
      if (piece.value !== value)
        out.push(
          `${R4_POINTS[i]}, ${name} [${deps.join(", ")}]: "${piece.value}" — the story ${reference === "none" ? "without the reconnect" : reference === "after" ? "with the change after the end" : "without the old operation"} reads "${value}"`,
        );
    }
  });
  return out;
}

/** The ends a kind runs. @param {R4Kind} kind @returns {R4End[]} */
const r4Ends = (kind) => [...R4_ENDS, ...(kind.ends ?? [])];

/**
 * A case: the story and its reference, compared.
 *
 * @param {any} t @param {R4Kind} kind @param {R4Change} change @param {R4End} end
 * @param {{modules?: Record<string, any>, references?: Map<string, any>}} [o] modules: mutants instead of the pages (self-tests)
 */
async function r4Case(t, kind, change, end, o = {}) {
  const references = o.references ?? new Map();
  const early = Boolean(kind.early || kind.atOpen);
  /** @type {"early"|"without"|"after"|"none"} */
  const reference = change === "reconnect" ? "none" : kind.commutes?.includes(change) ? "after" : early ? "early" : "without";
  const key = reference === "none" ? `${kind.name}|none|${end}` : reference === "after" ? `${kind.name}|${change}|after|${end}` : `${kind.name}|${change}`;
  if (!references.has(key))
    references.set(
      key,
      reference === "none" ? await r4Run(t, kind, null, end, "case", o.modules) : reference === "after" ? await r4Run(t, kind, change, end, "after", o.modules) : await r4Run(t, kind, change, end, reference, o.modules),
    );
  const got = await r4Run(t, kind, change, end, "case", o.modules);
  return r4Differences(change, got, references.get(key), reference, Boolean(kind.atOpen) && change !== "reconnect");
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
  "raw load × epoch × success": "gate r4 §4, a replacement load",
  "raw save × type × refused": "gate r4 §4, the gutter",
  "settings load × commit × success": "gate r4 §4, Save while the load is out",
  "settings load × newer draft × success": "gate r4 §4, an edit while the load is out",
  "device adopt × commit × success": "gate r4 §4, membership changes while the adoption is out",
  "device brightness range × reopen × success": "gate r4 §5, the range is disabled throughout its request",
};

/** Cases that fail at fbf3f61: phase B makes each one pass and takes it off this list. */
/** @type {Set<string>} */
const R4_KNOWN = new Set([
  "config add device × epoch × 500",
  "config add device × epoch × success",
  "config add device × epoch × timeout",
  "config add device × type × success",
  "config patch × epoch × success",
  "config patch × leave × success",
  "config patch × membership × success",
  "config patch × reincarnate × success",
  "config patch × revisit × success",
  "config patch × type × success",
  "device copy × epoch × 500",
  "device copy × epoch × success",
  "device copy × epoch × timeout",
  "devices add device × epoch × 500",
  "devices add device × epoch × success",
  "devices add device × epoch × timeout",
  "health log × epoch × 500",
  "health log × epoch × success",
  "health log × epoch × timeout",
  "overlays clear × epoch × 500",
  "overlays clear × epoch × success",
  "overlays clear × epoch × timeout",
  "raw load × epoch × 500",
  "raw load × epoch × success",
  "raw load × epoch × timeout",
  "raw reload × epoch × 500",
  "raw reload × epoch × success",
  "raw reload × epoch × timeout",
  "raw reload × reopen × success",
  "raw save × epoch × 500",
  "raw save × epoch × refused",
  "raw save × epoch × success",
  "raw save × epoch × timeout",
  "raw save × type × refused",
  "settings preview × commit × 500",
  "settings preview × commit × timeout",
  "settings preview × epoch × 500",
  "settings preview × epoch × success",
  "settings preview × epoch × timeout",
  "settings preview × newer draft × 500",
  "settings preview × newer draft × timeout",
  "settings preview × other field × 500",
  "settings preview × other field × timeout",
  "settings preview × reincarnate × 500",
  "settings preview × reincarnate × success",
  "settings preview × reincarnate × timeout",
  "settings preview × schema × 500",
  "settings preview × schema × timeout",
  "settings revert × epoch × 500",
  "settings revert × epoch × success",
  "settings revert × epoch × timeout",
  "settings revert × reincarnate × 500",
  "settings revert × reincarnate × success",
  "settings revert × reincarnate × timeout",
  "settings save × epoch × 500",
  "settings save × epoch × success",
  "settings save × epoch × timeout",
  "settings save × membership × 500",
  "settings save × membership × success",
  "settings save × membership × timeout",
  "settings save × reincarnate × 500",
  "settings save × reincarnate × success",
  "settings save × reincarnate × timeout",
]);

const R4_STRICT = process.env.R4_HARNESS_STRICT === "1";
/** The reference runs, by kind and change (and end, for a reconnect's and a commuted story's). @type {Map<string, any>} */
const r4References = new Map();
let r4Count = 0;
/** @type {string[]} */
const r4Probes = [];
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
      const todo = !R4_STRICT && R4_KNOWN.has(name) ? `fails at fbf3f61: ${name}` : undefined;
      test(label, { todo }, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const differences = await r4Case(t, kind, change, end, { references: r4References });
        assert.deepEqual(differences, [], `${kind.site}: the old operation changed UI state that depends on an identity the change changed`);
      });
    }
  }

test("r4 harness: the matrix covers every operation kind, change and end; every exclusion is a probe that runs", () => {
  const combinations = R4_KINDS.reduce((sum, kind) => sum + Object.keys(R4_CHANGES).length * r4Ends(kind).length, 0);
  const excluded = r4Probes.reduce((sum, line) => sum + r4Ends(/** @type {R4Kind} */ (R4_KINDS.find((k) => line.startsWith(`${k.name} ×`)))).length, 0);
  assert.equal(r4Count + excluded, combinations);
  for (const name of Object.keys(R4_GATE)) assert.ok(R4_KINDS.some((k) => name.startsWith(`${k.name} ×`)) && !r4Probes.some((p) => name.startsWith(p.split(":")[0])), `${name} is a case of the matrix`);
  t_log(`r4 harness: ${R4_KINDS.length} kinds × ${Object.keys(R4_CHANGES).length} changes × ends (${R4_ENDS.join(", ")}; raw save also refused): ${combinations} combinations, ${r4Count} cases run, ${r4Probes.length} combinations (${excluded} with their ends) unreachable, each a probe that runs:\n  ${r4Probes.join("\n  ")}`);
});

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
    assert.ok(src.includes(from), `the mutation finds its place in ${file}: ${from}`);
    src = src.replace(from, to);
  }
  src = src.replace(/from\s+"(\.{1,2}\/[^"]+)"/g, (_, spec) => `from "${replace[spec] ?? new URL(spec, url).href}"`);
  return `data:text/javascript;base64,${Buffer.from(src).toString("base64")}`;
}

test("r4 harness self-test: an epoch guard on Raw's load without a replacement load is caught (gate r4 §4)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mutant = await r4Mutant("pages/config-raw.js", [
    ["function load(base = { opened, revision }, tries = 0) {", "function load(base = { opened, revision, epoch: getState().epoch }, tries = 0) {"],
    ["if (base.opened !== opened || !root) return;\n        if (decision", "if (base.opened !== opened || !root || /** @type {any} */ (base).epoch !== getState().epoch) return;\n        if (decision"],
  ]);
  const raw = (await import(mutant)).page;
  const kind = /** @type {R4Kind} */ (R4_KINDS.find((k) => k.name === "raw load"));
  const differences = await r4Case(t, kind, "epoch", "success", { modules: { raw } });
  assert.ok(differences.some((d) => /editor text/.test(d)), `the harness reports the empty editor: ${differences.join("\n")}`);
  assert.ok(differences.some((d) => /replacement load/.test(d)), "and the missing replacement load");
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
  ["reset", /\.reset\(|\bbook\.(saved|clear|rejected)\(/],
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
 * The effects of the code in `range`, and of what it calls.
 *
 * @param {string} code @param {any[]} fns @param {[number, number]} range
 * @param {Map<string, Array<[number, number]>>} bound parameters bound to the callbacks a call passed
 * @param {Set<string>} seen @param {Set<string>} via the helpers and callbacks followed
 * @returns {Set<string>}
 */
function r4xFollow(code, fns, range, bound, seen, via) {
  const body = code.slice(range[0], range[1] + 1);
  const effects = new Set(R4X_EFFECTS.filter(([, re]) => re.test(body)).map(([name]) => name));
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
      for (const effect of r4xFollow(code, fns, target.range, target.bind, seen, via)) effects.add(effect);
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
      const effects = new Set([...r4xFollow(code, fns, range, new Map(), new Set(), via), ...extra]);
      mine.push([Math.min(at, range[0]), range[1]], [at, at + 60]);
      rows.push({ site: `${file}:${r4xLineOf(code, at)}`, file, line: r4xLineOf(code, at), kind, fn: holder(at), what, effects: [...effects].sort(), via: [...via].sort() });
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
  const settings = /settings-form/.test(file);
  const raw = /config-raw/.test(file);
  const config = /pages\/config\.js/.test(file);
  // The live channel's continuations belong to one EventSource: its generation owns connection feedback and event admission.
  if (/live\.js/.test(file) && effect !== "store") return "stream generation (it owns connection feedback and event admission)";
  const device = /device\.js|devices\.js|config\.js|recovery-dialog|settings-form/.test(file) && !/addDevice|copyScene/.test(fn);
  const member = (settings && fn === "save") || (config && /patch|adopt/.test(fn));
  const slot = `slot token · epoch${device ? " · life" : ""}${settings ? " · scene" : ""}`;
  switch (effect) {
    case "slot note":
    case "slot failure text":
    case "slot outcome":
      return `${slot}${member ? " · config membership" : ""}`;
    case "slot drop":
      return "the dropped slot still holds the operation this one superseded (its token) · opening";
    case "close":
    case "blur":
    case "focus":
      return `opening · ${config ? "edit-row visit · " : ""}editor revision · epoch · life${member ? " · config membership" : ""}; blur and focus only inside the opening's root`;
    case "reset":
      return settings ? "each submitted edit's draft (monotonic acknowledgement) · scope (scene, epoch, life) · config membership" : "opening · editor revision (the form's)";
    case "request start":
      return `the identities captured when the operation began, inherited and never re-read (scope: ${settings ? "scene, epoch, life" : raw ? "opening, epoch" : "epoch, life"}), checked before the request starts`;
    case "page state":
    case "preview feedback":
    case "page callback":
      return settings ? "opening · scope (scene, epoch, life) · scene-definition generation · newest draft and > committed" : raw ? "opening · load token · editor revision · epoch" : config ? "opening · edit-row visit" : "opening · slot token";
    case "DOM write":
      return raw ? "opening · editor revision · epoch (a replacement load writes the new run's text)" : "none beyond render's reading of the current state";
    case "enable/disable":
      return slot;
    case "connection feedback":
    case "timer start":
      return "stream generation (it owns connection feedback and event admission)";
    case "render":
      return "none: render reads the current state";
    case "store":
      return "none: the store's fence decides (ordering.js)";
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
  "web/js/components/settings-form.js · save · ops done · page callback, page state, preview feedback, render, request start, reset, slot drop, slot note, store",
  "web/js/components/settings-form.js · save · ops describe · slot failure text",
  "web/js/components/settings-form.js · save · ops failed · page callback, page state, preview feedback, render, request start, reset, slot drop, store",
  "web/js/components/settings-form.js · revert · ops done · page callback, page state, preview feedback",
  "web/js/components/settings-form.js · revert · ops describe · slot failure text",
  "web/js/components/settings-form.js · clearOverlays · ops done · slot note",
  "web/js/components/settings-form.js · clearOverlays · ops describe · slot failure text",
  "web/js/components/settings-form.js · enqueue · await · page callback, page state, preview feedback, render, request start, reset, slot drop, store",
  "web/js/components/settings-form.js · enqueue · await · none",
  "web/js/components/settings-form.js · retryEnd · await · store",
  "web/js/components/settings-form.js · leave · await · none",
  "web/js/components/settings-form.js · leave · await · store",
  "web/js/components/settings-form.js · load · await · store",
  "web/js/components/settings-form.js · sendPreview · await · page callback, page state, preview feedback, render, reset, slot drop, store",
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

test("r4 inventory self-test: one fake site of each kind is reported as unlisted, a removed file's rows as vanished", () => {
  const fake = `import { request } from "../api.js";
import { follow, start } from "../ops.js";
let open = null;
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
  ];
  for (const [what, pattern] of expected) assert.ok(reported.some((u) => pattern.test(u)), `${what} is reported:\n${reported.join("\n")}`);
  // A file the list holds rows of, gone: its rows are reported as vanished.
  const without = r4xExtract(r4WebFiles().filter((f) => f.file !== "web/js/pages/overlays.js"));
  assert.ok(r4InventoryDiff(without.rows).vanished.some((v) => v.startsWith("web/js/pages/overlays.js")), "the rows of a removed file are reported as vanished");
});
