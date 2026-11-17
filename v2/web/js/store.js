/**
 * Client store: what the page knows, fed by the snapshot and the live events.
 *
 * One rule decides everything that arrives, whether as a snapshot, a live
 * event or the answer to a request: the decision functions of ordering.js
 * (finished code). The store holds one fence (`createClientFence`) and asks
 * it before it changes anything; what is not answered with "apply" changes
 * nothing.
 *   - a device view or settings state is applied only when its `epoch` is
 *     the epoch of the snapshot the page holds and its `rev` is higher than
 *     the one on screen (build rule 3). A late answer can therefore never
 *     put an older scene, mode or brightness back.
 *   - the epoch is the identity of one run of pixdcon; `rev` and the live
 *     channel's `seq` start again with every run. A page that stayed open
 *     across a restart would otherwise hold rev 57 and drop every fresh
 *     view with rev 3 as "older" (B-177).
 *   - a snapshot with another epoch replaces everything the page holds,
 *     previews and settings included, but only when it comes from the
 *     newest stream or bootstrap request the page has started. The answer
 *     of a bootstrap request that was sent to the earlier run and arrives
 *     after the new run's snapshot is dropped.
 *   - a snapshot of the page's epoch with a lower seq than the page's is
 *     dropped; so is an event with a seq that is not higher than the last
 *     one, an event of a stream that was replaced, and an event or view of
 *     another epoch.
 *   - a device that was removed comes back only through something newer
 *     than its removal. The position of the removal is kept for the rest of
 *     the epoch (`forgetDevice`), so the late answer of a write to the old
 *     device is not taken for the device of the same name that came back,
 *     although that one counts its revs from 1 again.
 *   - a device's life has a name: every DeviceView and SettingsState
 *     carries the `incarnation` of its device, and the store hands it to
 *     `decideView`. A view of an older life is dropped also when the page
 *     never saw the removal (it was disconnected). When `decideView`
 *     answers "apply" with reason "new_incarnation", the store first throws
 *     away what it holds of that device, its view and its settings states,
 *     and then takes the view.
 *   - a view inside a snapshot is passed with `snapshot: true`: it is taken
 *     by where it stands, not by its rev, so a device that left and came
 *     back while the page was away shows at once. No view replaces a copy
 *     that stands after it.
 *   - every copy has a position. A snapshot is a copy of every resource at
 *     its seq: an answer that was asked for before it and stands before it
 *     changes nothing afterwards, and where the page already holds a newer
 *     copy (the answer of a request that stood after the snapshot), the
 *     page keeps it (`decideSnapshot` answers `keep` and `gone`). An event
 *     always moves the page's position, and brings its content only when
 *     the page does not hold a newer copy of that resource.
 *   - a preview (the last frame of a display) is a measurement, not state
 *     with a rev: it arrives with live events, which the fence orders, and
 *     goes with its device. The one frame a page asks for over HTTP when it
 *     opens fills an empty slot only, and only while nothing has changed
 *     the page's epoch or the device's life since the request was sent
 *     (`decideFrameAnswer`): the stream's frames are never replaced by it.
 *
 * Views subscribe to a slice and re-render only their reserved slots; nothing
 * inserts or removes rows while they are on screen (approved spec section 8).
 * A timer never changes what the store holds; `tick` only moves the clock
 * that ages ("frame 2 s ago") are computed against, and `setLive` only the
 * connection state that is shown.
 *
 * Pure apart from the subscribers it calls: no DOM, no network, no timers.
 * test/contract/client.test.js runs it in Node.
 *
 * Owner: UI worker.
 */

import {
  SNAPSHOT_RESOURCES,
  createClientFence,
  decideAnswer,
  decideEvent,
  decideSnapshot,
  decideView,
  deviceOf,
  forgetDevice,
} from "./ordering.js";

/** @typedef {import("./ordering.js").Decision} Decision */

/**
 * The last frame of a display, as the page holds it.
 *
 * @typedef {object} Preview
 * @property {number} width
 * @property {number} height
 * @property {string} source "runtime" | "device" | "simulated"
 * @property {string|null} receivedAt when pixdcon last received a frame (build rule 5)
 * @property {number} frameSeq
 * @property {Uint8Array|null} rgb null: the frame did not have width × height × 3 bytes ("bad frame", B-180)
 */

/**
 * @typedef {object} ClientState
 * @property {string|null} epoch epoch of the snapshot the page holds; null before the first one
 * @property {number} seq
 * @property {boolean} loaded a snapshot was applied
 * @property {any} controller ControllerStatus
 * @property {any} mqtt MqttStatus
 * @property {any} config ConfigFileState with the last reload result
 * @property {Map<string, any>} devices name → DeviceView, in config order
 * @property {Map<string, Preview>} previews device name → last frame; keyed by the exact name, so two names that differ only in punctuation never share one (B-178)
 * @property {any[]} scenes SceneMeta[]
 * @property {{ulanzi: any[], pixoo: any[]}} builtins
 * @property {any[]} overlays OverlayRecord[] as pixdcon lists them now
 * @property {Map<string, {record: any, at: number}>} gone overlay records that left the list in this epoch, with the time the page learned it: a page that showed the row keeps it in place, greyed, "Cleared 18:43:10"
 * @property {Map<string, any>} settings "<device>/<scene>" → SettingsState
 * @property {any[]} log LogLine[], oldest first, at most 200
 * @property {import("./live.js").LiveState} live
 * @property {number|null} dataAt epoch ms of the last data that was applied ("values below are from 18:41:52")
 * @property {{message: string, at: number}|null} loadError the first load failed (no snapshot yet)
 * @property {number} now epoch ms the ages on screen are computed against; moved by `tick`
 */

/** Live event types that carry a whole resource (decideEvent's `type`). @type {Set<string>} */
const EVENT_RESOURCES = new Set(
  SNAPSHOT_RESOURCES.filter((resource) => resource !== "builtins"),
);

const LOG_LINES = 200;

/** @returns {ClientState} */
function initialState() {
  return {
    epoch: null,
    seq: 0,
    loaded: false,
    controller: null,
    mqtt: null,
    config: null,
    devices: new Map(),
    previews: new Map(),
    scenes: [],
    builtins: { ulanzi: [], pixoo: [] },
    overlays: [],
    gone: new Map(),
    settings: new Map(),
    log: [],
    live: {
      state: "connecting",
      lastEventAt: null,
      lostSince: null,
      retryEveryMs: 5000,
    },
    dataAt: null,
    loadError: null,
    now: Date.now(),
  };
}

/** @type {(reason: string) => Decision} */
const drop = (reason) => ({ action: "drop", reason });

/**
 * base64 → bytes; null when the text is not base64.
 *
 * @param {string} text
 * @returns {Uint8Array|null}
 */
function fromBase64(text) {
  try {
    const binary = atob(String(text ?? ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * A frame as the page holds it; checked before it is ever drawn (B-180).
 *
 * @param {{width: number, height: number, source?: string, receivedAt?: string|null, frameSeq?: number}} meta
 * @param {Uint8Array|null} rgb
 * @returns {Preview}
 */
export function toPreview(meta, rgb) {
  const width = Number(meta.width);
  const height = Number(meta.height);
  const fits =
    rgb !== null &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    rgb.length === width * height * 3;
  return {
    width,
    height,
    source: String(meta.source ?? "runtime"),
    receivedAt: meta.receivedAt ?? null,
    frameSeq: Number(meta.frameSeq ?? 0),
    rgb: fits ? rgb : null,
  };
}

/**
 * Whether the frame a page asked for over HTTP may fill its slot. It is a
 * measurement and has no rev; the stream's frames are the order. So it is
 * taken only into an empty slot, only when it belongs to the newest request
 * for that device's frame, and only when neither the page's epoch nor the
 * device's life changed since the request was sent.
 *
 * @param {ClientState} state
 * @param {import("./ordering.js").ClientFence} fence
 * @param {{device: string, generation: number, epoch: string|null, incarnation: number}} request what was true when the request was sent
 * @returns {Decision}
 */
export function decideFrameAnswer(state, fence, request) {
  if (request.generation !== fence.requests.get(`frame:${request.device}`))
    return drop("superseded_source");
  if (fence.epoch === null || request.epoch !== fence.epoch)
    return drop("other_epoch");
  const view = state.devices.get(request.device);
  if (!view) return drop("removed");
  if ((view.incarnation ?? 0) !== request.incarnation)
    return drop("older_incarnation");
  if (state.previews.has(request.device)) return drop("newer_copy");
  return { action: "apply", reason: "current" };
}

/**
 * A store with its own fence. The app uses the one below; tests make their own.
 */
export function createStore() {
  const fenceState = createClientFence();
  /** @type {ClientState} */
  let state = initialState();
  /** @type {Set<{select: (state: ClientState) => any, render: (value: any) => void, last: any}>} */
  const subscribers = new Set();

  /** @param {ClientState} next */
  function commit(next) {
    state = next;
    for (const subscriber of [...subscribers]) {
      if (!subscribers.has(subscriber)) continue;
      const value = subscriber.select(state);
      if (Object.is(value, subscriber.last)) continue;
      subscriber.last = value;
      subscriber.render(value);
    }
  }

  /**
   * Drop what the page holds of one device: its view, its frame and its
   * settings states.
   *
   * @param {{devices: Map<string, any>, previews: Map<string, Preview>, settings: Map<string, any>}} parts changed in place
   * @param {string} name
   */
  function dropDevice(parts, name) {
    parts.devices.delete(name);
    parts.previews.delete(name);
    for (const key of [...parts.settings.keys()])
      if (deviceOf(`settings:${key}`) === name) parts.settings.delete(key);
  }

  /**
   * The overlay list changes: remember what left it, with the time.
   *
   * @param {ClientState} next changed in place
   * @param {any[]} records
   */
  function takeOverlays(next, records) {
    const list = Array.isArray(records) ? records : [];
    const ids = new Set(list.map((record) => record.id));
    const gone = new Map(next.gone);
    for (const record of next.overlays)
      if (!ids.has(record.id)) gone.set(record.id, { record, at: Date.now() });
    for (const id of ids) gone.delete(id);
    next.overlays = list;
    next.gone = gone;
  }

  /**
   * @param {ClientState} next changed in place
   * @param {string} resource
   * @param {any} value
   */
  function takeResource(next, resource, value) {
    switch (resource) {
      case "overlays":
        takeOverlays(next, value);
        break;
      case "controller":
        next.controller = value ?? null;
        break;
      case "mqtt":
        next.mqtt = value ?? null;
        break;
      case "config":
        next.config = value ?? null;
        break;
      case "scenes":
        next.scenes = Array.isArray(value) ? value : [];
        break;
      case "builtins":
        next.builtins = {
          ulanzi: value?.ulanzi ?? [],
          pixoo: value?.pixoo ?? [],
        };
        break;
      case "log": {
        // The answer is the log up to its position; lines that came with
        // the stream after it stay (LogLine.seq orders them).
        const lines = Array.isArray(value) ? value : [];
        const last = lines.reduce((top, line) => Math.max(top, Number(line?.seq ?? 0)), 0);
        const newer = next.log.filter((line) => Number(line?.seq ?? 0) > last);
        next.log = [...lines, ...newer].slice(-LOG_LINES);
        break;
      }
    }
  }

  /**
   * Put a device view or settings state through decideView and take it.
   *
   * @param {ClientState} next changed in place (its maps are copies already)
   * @param {any} view DeviceView or SettingsState
   * @param {"device"|"settings"} kind
   * @param {number} seq position of what carried it
   * @param {boolean} [snapshot]
   * @returns {Decision}
   */
  function takeView(next, view, kind, seq, snapshot = false) {
    if (!view || typeof view !== "object") return drop("no_view");
    const settingsKey = kind === "settings" ? `${view.device}/${view.scene}` : "";
    const key =
      kind === "device" ? `device:${view.name}` : `settings:${settingsKey}`;
    /** @type {{key: string, epoch: string, rev: number, seq: number, incarnation?: number, snapshot?: boolean}} */
    const input = {
      key,
      epoch: view.epoch,
      rev: Number(view.rev),
      seq,
      incarnation: Number(view.incarnation ?? 0),
    };
    if (snapshot) input.snapshot = true;
    const decision = decideView(fenceState, input);
    if (decision.action !== "apply") return decision;
    const name = deviceOf(key);
    if (decision.reason === "new_incarnation") dropDevice(next, name);
    if (kind === "device") next.devices.set(name, view);
    else next.settings.set(settingsKey, view);
    return decision;
  }

  /** @returns {ClientState} a copy of the state whose maps may be changed */
  function draft() {
    return {
      ...state,
      devices: new Map(state.devices),
      previews: new Map(state.previews),
      settings: new Map(state.settings),
    };
  }

  /**
   * @param {any} snapshot Snapshot
   * @param {{generation: number}} source
   * @returns {Decision}
   */
  function applySnapshot(snapshot, source) {
    const views = Array.isArray(snapshot?.devices) ? snapshot.devices : [];
    const decision = decideSnapshot(
      fenceState,
      {
        epoch: snapshot?.epoch,
        seq: Number(snapshot?.seq),
        devices: views.map((/** @type {any} */ view) => view.name),
        incarnations:
          typeof snapshot?.incarnations === "number"
            ? snapshot.incarnations
            : undefined,
      },
      source,
    );
    if (decision.action !== "apply") return decision;
    /** @type {ClientState} */
    let next = draft();
    if (decision.reason === "new_epoch") {
      const fresh = initialState();
      next = {
        ...fresh,
        live: state.live,
        now: state.now,
      };
    }
    next.epoch = fenceState.epoch;
    next.seq = fenceState.seq;
    next.loaded = true;
    next.loadError = null;
    next.dataAt = Date.now();
    const keep = new Set(decision.keep);
    for (const resource of SNAPSHOT_RESOURCES)
      if (!keep.has(resource) && snapshot && resource in snapshot)
        takeResource(next, resource, snapshot[resource]);
    for (const name of decision.gone) dropDevice(next, name);
    for (const view of views)
      takeView(next, view, "device", fenceState.floor, true);
    // Config order: the snapshot's, then what the page holds in a newer copy.
    /** @type {Map<string, any>} */
    const ordered = new Map();
    for (const view of views) {
      const held = next.devices.get(view.name);
      if (held) ordered.set(view.name, held);
    }
    for (const [name, view] of next.devices)
      if (!ordered.has(name)) ordered.set(name, view);
    next.devices = ordered;
    commit(next);
    return decision;
  }

  /**
   * @param {import("./live.js").LiveEnvelope} event
   * @returns {Decision}
   */
  function applyEvent(event) {
    if (event.type === "snapshot") {
      if (event.stream !== fenceState.stream)
        return drop("superseded_source");
      return applySnapshot(
        { ...event.data, epoch: event.epoch, seq: event.seq },
        { generation: event.stream },
      );
    }
    const resource = EVENT_RESOURCES.has(event.type) ? event.type : undefined;
    const before = fenceState.seq;
    const decision = decideEvent(fenceState, {
      epoch: event.epoch,
      seq: event.seq,
      stream: event.stream,
      ...(resource ? { type: resource } : {}),
    });
    if (decision.action !== "apply") {
      if (fenceState.seq !== before) commit({ ...state, seq: fenceState.seq });
      return decision;
    }
    const next = draft();
    next.seq = fenceState.seq;
    next.dataAt = Date.now();
    /** @type {Decision} */
    let result = decision;
    const data = event.data;
    /** What a dropped view changes: the position only, nothing on screen. */
    const positionOnly = () => {
      commit({ ...state, seq: fenceState.seq });
      return result;
    };
    switch (event.type) {
      case "device":
        result = takeView(next, data, "device", event.seq);
        if (result.action !== "apply") return positionOnly();
        break;
      case "settings":
        result = takeView(next, data, "settings", event.seq);
        if (result.action !== "apply") return positionOnly();
        break;
      case "device-removed": {
        const keys = forgetDevice(
          fenceState,
          String(data?.name),
          event.seq,
          Number(data?.incarnation ?? 0),
        );
        for (const key of keys) {
          if (key.startsWith("device:")) {
            next.devices.delete(deviceOf(key));
            next.previews.delete(deviceOf(key));
          } else next.settings.delete(key.slice("settings:".length));
        }
        break;
      }
      case "preview": {
        const name = String(data?.device);
        if (!next.devices.has(name)) {
          result = drop("unknown_device");
          return positionOnly();
        }
        next.previews.set(name, toPreview(data, fromBase64(data?.rgbBase64)));
        break;
      }
      case "log":
        next.log = [...next.log, data].slice(-LOG_LINES);
        break;
      case "ping":
        break;
      default:
        if (resource) takeResource(next, resource, data);
    }
    commit(next);
    return result;
  }

  /**
   * @param {import("./api.js").Answer} answer
   * @returns {Decision}
   */
  function applyAnswer(answer) {
    if (answer.epoch === null) return drop("no_position");
    const body = answer.body;
    const resource = answer.resource;
    if (resource === "bootstrap") {
      // The snapshot says where it stands; the header says the same.
      return applySnapshot(
        { ...body, epoch: body?.epoch ?? answer.epoch, seq: body?.seq ?? answer.seq },
        { generation: answer.generation },
      );
    }
    if (resource.startsWith("device:") || resource.startsWith("settings:")) {
      const kind = resource.startsWith("device:") ? "device" : "settings";
      const view =
        kind === "device" ? (body?.device ?? body) : (body?.state ?? body);
      const next = draft();
      const decision = takeView(next, view, kind, answer.seq);
      if (decision.action === "apply") {
        next.dataAt = Date.now();
        commit(next);
      }
      return decision;
    }
    const decision = decideAnswer(fenceState, {
      resource,
      generation: answer.generation,
      epoch: answer.epoch,
      seq: answer.seq,
    });
    if (decision.action !== "apply") return decision;
    const next = draft();
    next.dataAt = Date.now();
    switch (resource) {
      case "overlays":
        takeResource(next, "overlays", Array.isArray(body) ? body : body?.overlays);
        break;
      case "config":
        takeResource(next, "config", body?.state ?? body);
        break;
      case "scenes":
        takeResource(next, "scenes", body?.scenes ?? body);
        if (body?.builtins) takeResource(next, "builtins", body.builtins);
        break;
      default:
        takeResource(next, resource, body);
    }
    commit(next);
    return decision;
  }

  /**
   * The one frame a page asks for over HTTP when it opens (GET
   * /api/v2/devices/<name>/preview); see decideFrameAnswer.
   *
   * @param {{device: string, generation: number, epoch: string|null, incarnation: number}} request
   * @param {Preview|null} preview null: pixdcon has no frame yet (204)
   * @returns {Decision}
   */
  function applyFrameAnswer(request, preview) {
    const decision = decideFrameAnswer(state, fenceState, request);
    if (decision.action !== "apply" || preview === null) return decision;
    const next = draft();
    next.previews.set(request.device, preview);
    commit(next);
    return decision;
  }

  /**
   * @template T
   * @param {(state: ClientState) => T} select
   * @param {(value: T) => void} render called at once, and again whenever the selected value changed
   * @returns {() => void} unsubscribe
   */
  function subscribe(select, render) {
    const subscriber = { select, render, last: select(state) };
    subscribers.add(subscriber);
    render(subscriber.last);
    return () => {
      subscribers.delete(subscriber);
    };
  }

  return {
    /** @returns {ClientState} */
    getState: () => state,
    /** @returns {import("./ordering.js").ClientFence} */
    fence: () => fenceState,
    applySnapshot,
    applyEvent,
    applyAnswer,
    applyFrameAnswer,
    subscribe,
    /** @param {number} now the clock ages are computed against; changes nothing else */
    tick(now) {
      commit({ ...state, now });
    },
    /** @param {import("./live.js").LiveState} live the connection state that is shown; changes nothing else */
    setLive(live) {
      commit({ ...state, live: { ...live } });
    },
    /** @param {{message: string, at: number}|null} error the first load failed; changes nothing else */
    setLoadError(error) {
      commit({ ...state, loadError: error });
    },
  };
}

/** The page's store. */
const main = createStore();

/** @returns {ClientState} */
export function getState() {
  return main.getState();
}

/** @returns {import("./ordering.js").ClientFence} the store's fence; live.js and api.js take their generations from it */
export function fence() {
  return main.fence();
}

/**
 * Apply a snapshot: ask `decideSnapshot` with the snapshot's epoch, seq and
 * the names of its devices. On "apply": take every whole resource that is
 * not in `keep`, remove the devices in `gone` with their settings states,
 * and put every device view through `decideView` with the snapshot's seq,
 * the view's `incarnation` and `snapshot: true`.
 *
 * @param {any} snapshot Snapshot from GET /api/v2/bootstrap or the first live event
 * @param {{generation: number}} source the stream or bootstrap request it came from (ordering.js openSource)
 * @returns {import("./ordering.js").Decision} decideSnapshot's answer; "apply" with reason "new_epoch" reset the store
 */
export function applySnapshot(snapshot, source) {
  return main.applySnapshot(snapshot, source);
}

/**
 * Apply a live event. `decideEvent` first (it moves the page's position
 * also when it answers "drop" with reason "newer_copy"); an event that
 * carries a view then goes through `decideView` with the event's seq and
 * the view's `incarnation`, and "device-removed" calls `forgetDevice` with
 * the seq and removes exactly the views it names: one that stands after
 * the removal stays.
 *
 * @param {import("./live.js").LiveEnvelope} event
 * @returns {import("./ordering.js").Decision} decideEvent's answer, and for an event that carries a view, decideView's
 */
export function applyEvent(event) {
  return main.applyEvent(event);
}

/**
 * Apply the answer of a request. A DeviceView or SettingsState goes through
 * decideView with the answer's position and the view's `incarnation`; a
 * whole resource (overlay list, config state, scenes) through decideAnswer.
 *
 * @param {import("./api.js").Answer} answer
 * @returns {import("./ordering.js").Decision}
 */
export function applyAnswer(answer) {
  return main.applyAnswer(answer);
}

/**
 * @param {{device: string, generation: number, epoch: string|null, incarnation: number}} request
 * @param {Preview|null} preview
 * @returns {import("./ordering.js").Decision}
 */
export function applyFrameAnswer(request, preview) {
  return main.applyFrameAnswer(request, preview);
}

/**
 * @template T
 * @param {(state: ClientState) => T} select
 * @param {(value: T) => void} render called at once, and again when the selected value changed
 * @returns {() => void} unsubscribe
 */
export function subscribe(select, render) {
  return main.subscribe(select, render);
}

/** @param {number} now */
export function tick(now) {
  main.tick(now);
}

/** @param {import("./live.js").LiveState} live */
export function setLive(live) {
  main.setLive(live);
}

/** @param {{message: string, at: number}|null} error */
export function setLoadError(error) {
  main.setLoadError(error);
}
