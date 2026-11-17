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
const devicePage = await loadPage("device");

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
    // Leaving ended the preview; the next one of the scene waits for that end.
    pending(calls, "DELETE", "/settings/clock/preview?session=s1").answer(200, sceneSettings("d1", "clock", { epoch, rev }), `${epoch}-${10 + rev}`);
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
