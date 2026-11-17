/**
 * What the pages say, computed from what the store holds. Pure: no DOM, so
 * test/contract/client.test.js runs it in Node; the pages render exactly
 * these texts into their reserved slots.
 *
 * Sources of the wording:
 *  - the approved mockups and spec (PIXD-81, -v1-approved-2026-11-16), and
 *    Tick's build rules of 19:05 (build-rules-tick-1905.md)
 *  - Tick's decisions on the four states without a mockup
 *    (tick-states-0030.md), word for word: a device in shadow, a device that
 *    exists only in the MQTT config overlay, restart required, the Health
 *    rule text
 *  - the defaults of the interfaces entry, section 13, items 11 and 12, for
 *    an overlay record that the broker has not delivered again since the
 *    last reconnect, a held display, and the config overlay row while this
 *    instance is not its writer
 *
 * Owner: UI worker.
 */

import { ago, clock, clockShort, duration, percent } from "../format.js";

/** @typedef {import("../store.js").ClientState} ClientState */

/** A line of text with the style and icon of its slot. */
/**
 * @typedef {object} Line
 * @property {string} text
 * @property {string} [cls] "", "ovr", "warn", "bad", "mine"
 * @property {string|null} [icon] sprite id without "i-": "user", "layers", "alert", "spinner", "info", "undo"
 * @property {string|null} [dot] "ok", "warn", "bad", "idle", "shadow"
 * @property {string} [title]
 */

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** @param {any} view DeviceView @returns {string} what the page calls the display */
export function deviceTitle(view) {
  return view?.displayName || view?.name || "";
}

/** @param {string} type @returns {string} */
export function typeLabel(type) {
  return type === "pixoo" ? "Pixoo64" : type === "ulanzi" ? "Ulanzi TC001" : type;
}

/** @param {any} view @returns {{width: number, height: number}} */
export function sizeOf(view) {
  if (view?.size?.width && view?.size?.height) return view.size;
  return view?.type === "pixoo"
    ? { width: 64, height: 64 }
    : { width: 32, height: 8 };
}

/**
 * The name of a scene as the page shows it.
 *
 * @param {ClientState} state
 * @param {string|null|undefined} key scene key, "builtin:<mode>", or null
 * @param {string} [type] device type, for the built-in modes
 * @returns {string}
 */
export function sceneName(state, key, type) {
  if (key === null || key === undefined || key === "") return "None";
  if (key.startsWith("builtin:")) {
    const lists = type
      ? [state.builtins?.[/** @type {"ulanzi"|"pixoo"} */ (type)] ?? []]
      : [state.builtins?.ulanzi ?? [], state.builtins?.pixoo ?? []];
    for (const list of lists) {
      const mode = list.find((/** @type {any} */ m) => m.key === key);
      if (mode) return mode.label;
    }
    return key.slice("builtin:".length);
  }
  const scene = (state.scenes ?? []).find((/** @type {any} */ s) => s.key === key);
  return scene?.pretty_name || scene?.name || key;
}

/** @param {ClientState} state @param {string|null|undefined} key @returns {any} SceneMeta or undefined */
export function sceneMeta(state, key) {
  return (state.scenes ?? []).find((/** @type {any} */ s) => s.key === key);
}

// ---------------------------------------------------------------------------
// Overlay records that hold something back (section 13, item 11)
// ---------------------------------------------------------------------------

/**
 * The record that holds this device's address back, when the device is held
 * (its address rests on an overlay the broker has not delivered again).
 *
 * @param {any} view DeviceView
 * @param {any[]} overlays
 * @returns {any|null} the OverlayRecord
 */
export function heldBy(view, overlays) {
  if (!view || view.desired?.enabled !== false) return null;
  const list = overlays ?? [];
  const own = list.find(
    (record) =>
      record.kind === "device-ip" &&
      record.device === view.name &&
      record.restricts === "held",
  );
  if (own) return own;
  if (view.desired?.address?.source === "blob") {
    const blob = list.find(
      (record) => record.kind === "blob" && record.restricts === "held",
    );
    if (blob) return blob;
  }
  return null;
}

/**
 * The record that switches this device off, when one does.
 *
 * @param {any} view
 * @param {any[]} overlays
 * @returns {any|null}
 */
export function switchedOffBy(view, overlays) {
  if (!view || view.desired?.enabled !== false) return null;
  return (
    (overlays ?? []).find(
      (record) =>
        record.kind === "device-enabled" &&
        record.device === view.name &&
        record.restricts === "off",
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Status of a display: the Status column, the device page head, Health
// ---------------------------------------------------------------------------

/**
 * Why a device is in shadow, in Tick's words (tick-states-0030.md, item 7).
 *
 * @param {any} view
 * @returns {string}
 */
export function shadowReason(view) {
  const problem = view?.desired?.outputProblem;
  if (typeof problem === "string" && problem) return problem;
  return "set to shadow in config.json";
}

/**
 * @typedef {object} Status
 * @property {string} kind "ok", "warn", "bad", "idle", "shadow", "off", "held"
 * @property {string} dot "ok", "warn", "bad", "idle", "shadow"
 * @property {string} label "Online", "Stale", …
 * @property {Line[]} meta the lines under it in the Devices table
 */

/**
 * @param {any} view DeviceView
 * @param {ClientState} state
 * @returns {Status}
 */
export function deviceStatus(view, state) {
  const now = state.now;
  const health = view?.health ?? {};
  if (view?.desired?.output === "shadow" || health.state === "shadow")
    return {
      kind: "shadow",
      dot: "shadow",
      label: "Shadow · not driving the display",
      meta: [{ text: shadowReason(view) }],
    };
  if (heldBy(view, state.overlays))
    return {
      kind: "held",
      dot: "idle",
      label: "On hold",
      meta: [{ text: "address not confirmed by the broker" }],
    };
  if (view?.desired?.enabled === false)
    return {
      kind: "off",
      dot: "idle",
      label: "Off",
      meta: [
        {
          text: switchedOffBy(view, state.overlays)
            ? "switched off by an MQTT overlay"
            : "disabled in config.json",
        },
      ],
    };
  const errors = Number(health.consecutiveErrors ?? 0);
  switch (health.state) {
    case "online":
      return {
        kind: "ok",
        dot: "ok",
        label: "Online",
        meta: [
          health.lastFrameAt
            ? { text: `frame ${ago(health.lastFrameAt, now)}` }
            : { text: `last contact ${ago(health.lastContactAt, now)}` },
        ],
      };
    case "stale":
      return {
        kind: "warn",
        dot: "warn",
        label: "Stale",
        meta: [
          health.lastFrameAt
            ? { text: `frame ${ago(health.lastFrameAt, now)}` }
            : { text: `last contact ${ago(health.lastContactAt, now)}` },
          ...(errors > 0
            ? [
                {
                  text: `${errors} render ${errors === 1 ? "error" : "errors"} in a row`,
                  cls: "warn",
                },
              ]
            : []),
        ],
      };
    case "offline":
      return {
        kind: "bad",
        dot: "bad",
        label: "Offline",
        meta: [
          {
            text: health.lastContactAt
              ? `last contact ${ago(health.lastContactAt, now)}`
              : "no contact yet",
          },
        ],
      };
    case "idle":
      return { kind: "idle", dot: "idle", label: "Idle · no scene", meta: [] };
    case "starting":
    default:
      return {
        kind: "idle",
        dot: "idle",
        label: "Starting",
        meta: [{ text: "waiting for the first frame" }],
      };
  }
}

// ---------------------------------------------------------------------------
// Header and title lines
// ---------------------------------------------------------------------------

/**
 * @param {ClientState} state
 * @returns {{overlayCount: number, mqtt: {dot: string, text: string, cls: string}, restart: {shown: boolean, title: string}, version: {pretty: string, canonical: string, utc: string}|null}}
 */
export function header(state) {
  const mqtt = state.mqtt;
  /** @type {{dot: string, text: string, cls: string}} */
  let line = { dot: "idle", text: "MQTT status unknown", cls: "" };
  if (state.loaded && state.live.state !== "lost" && mqtt) {
    if (mqtt.state === "connected")
      line = { dot: "ok", text: "MQTT connected", cls: "" };
    else if (mqtt.state === "offline")
      line = { dot: "bad", text: "MQTT offline", cls: "bad" };
    else if (mqtt.state === "connecting")
      line = { dot: "idle", text: "MQTT connecting", cls: "" };
    else if (mqtt.state === "disabled")
      line = { dot: "idle", text: "MQTT not configured", cls: "" };
  }
  const restart = state.controller?.restartRequired ?? null;
  return {
    overlayCount:
      state.loaded && state.live.state !== "lost"
        ? overlaysInEffect(state.overlays)
        : 0,
    mqtt: line,
    restart: {
      shown: Boolean(restart),
      title: restart
        ? "The MQTT settings in config.json changed. Restart pixdcon to apply them."
        : "",
    },
    version: null,
  };
}

/** @param {any[]} overlays @returns {number} records whose command is in effect */
export function overlaysInEffect(overlays) {
  return (overlays ?? []).filter((record) => record.inEffect === true).length;
}

/**
 * Page-level conditions every page writes into its title line first, in
 * the approved wording: pixdcon unreachable (pixd-devices-disconnected),
 * the first load failed, MQTT offline (pixd-devices-error).
 *
 * @param {ClientState} state
 * @returns {{text: string, cls: string, icon: string|null, title?: string}|null}
 */
export function pageCondition(state) {
  if (state.live.state === "lost" && state.loaded) {
    const since = clock(state.live.lostSince ?? state.dataAt);
    const from = clock(state.dataAt);
    return {
      text: `No answer from pixdcon since ${since} · retrying every 5 s · values below are from ${from}`,
      cls: "bad",
      icon: "alert",
    };
  }
  if (!state.loaded && state.loadError)
    return {
      text: `No answer from pixdcon since ${clock(state.loadError.at)} · retrying every 5 s`,
      cls: "bad",
      icon: "alert",
    };
  if (state.loaded && state.mqtt?.state === "offline")
    return {
      text: `MQTT offline since ${clock(state.mqtt.since)} · scenes still switch; mode, brightness and overlays wait for MQTT`,
      cls: "warn",
      icon: "alert",
      title: `MQTT broker unreachable since ${clock(state.mqtt.since)}. Scenes still switch and render. Mode, brightness and overlays need MQTT and wait for it.`,
    };
  return null;
}

/**
 * The Devices title line: "4 devices · all online · 2 MQTT overlays in
 * effect"; shadow devices are counted separately (Tick, item 7).
 *
 * @param {ClientState} state
 * @returns {{parts: Line[], text: string}}
 */
export function devicesSummary(state) {
  const views = [...state.devices.values()];
  if (views.length === 0) return { parts: [], text: "No devices yet" };
  /** @type {Line[]} */
  const parts = [
    { text: `${views.length} ${views.length === 1 ? "device" : "devices"}` },
  ];
  const statuses = views.map((view) => deviceStatus(view, state));
  const count = (/** @type {string} */ kind) =>
    statuses.filter((status) => status.kind === kind).length;
  const online = count("ok");
  const stale = count("warn");
  const offline = count("bad");
  const shadow = count("shadow");
  const problems = [];
  if (stale) problems.push({ text: `${stale} stale`, cls: "warn" });
  if (offline) problems.push({ text: `${offline} offline`, cls: "bad" });
  if (shadow > 0) {
    if (online > 0) parts.push({ text: `${online} online` });
    parts.push(...problems);
    parts.push({ text: `${shadow} shadow` });
  } else if (problems.length) parts.push(...problems);
  else if (online === views.length) parts.push({ text: "all online" });
  else if (online > 0) parts.push({ text: `${online} online` });
  const inEffect = overlaysInEffect(state.overlays);
  if (inEffect > 0)
    parts.push({
      text: `${inEffect} MQTT ${inEffect === 1 ? "overlay" : "overlays"} in effect`,
    });
  return { parts, text: parts.map((part) => part.text).join(" · ") };
}

// ---------------------------------------------------------------------------
// Devices table: the Showing column
// ---------------------------------------------------------------------------

/**
 * The scene select: groups as v1 (Scenes for the device type, Built-in
 * modes, None). An active scene that is not registered, or not for this
 * type, is listed as such instead of falling back to another entry (B-069).
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {{groups: Array<{label: string, options: Array<{value: string, label: string}>}>, value: string}}
 */
export function sceneChoices(state, view) {
  const type = view.type;
  const showing = view.desired?.scene?.scene ?? "";
  const scenes = (state.scenes ?? []).filter(
    (/** @type {any} */ s) => !s.deviceType || s.deviceType === type,
  );
  const sceneOptions = scenes.map((/** @type {any} */ s) => ({
    value: s.key,
    label: s.status === "broken" ? `${s.pretty_name || s.key} (broken)` : s.pretty_name || s.name || s.key,
  }));
  const builtins = (state.builtins?.[/** @type {"ulanzi"|"pixoo"} */ (type)] ?? []).map(
    (/** @type {any} */ m) => ({ value: m.key, label: m.label }),
  );
  const known = new Set([
    ...sceneOptions.map((o) => o.value),
    ...builtins.map((o) => o.value),
    "",
  ]);
  if (showing && !known.has(showing)) {
    const registered = sceneMeta(state, showing);
    sceneOptions.push({
      value: showing,
      label: registered
        ? `${sceneName(state, showing, type)} (for another display type)`
        : `${showing} (not registered)`,
    });
  }
  return {
    groups: [
      { label: "Scenes", options: sceneOptions },
      { label: "Built-in modes", options: builtins },
      { label: "Nothing", options: [{ value: "", label: "None (idle)" }] },
    ],
    value: showing,
  };
}

/**
 * The two reserved source lines under the select.
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {{first: Line, second: {text: string, cls?: string, icon?: string|null, restore?: {disabled: boolean, title: string}}}}
 */
export function sourceLines(state, view) {
  const scene = view.desired?.scene ?? {};
  const choice = view.desired?.choice ?? {};
  const type = view.type;
  /** @type {Line} */
  let first;
  if (view.pending?.op === "scene")
    first = {
      icon: "spinner",
      text: `Switching to ${sceneName(state, view.pending.target, type)}…`,
    };
  else if (scene.source === "overlay")
    first = {
      cls: "ovr",
      icon: "layers",
      text: `MQTT overlay since ${clockShort(scene.since)}`,
    };
  else if (scene.source === "blob")
    first = {
      cls: "ovr",
      icon: "layers",
      text: `Config overlay since ${clockShort(scene.since)}`,
    };
  else if (scene.source === "ui" && choice.persisted === false)
    first = { cls: "warn", icon: "alert", text: "Switched, not saved" };
  else if (scene.source === "fallback")
    first = { icon: "user", text: "No scene chosen" };
  else first = { icon: "user", text: "Your choice" };

  if (
    (scene.source === "overlay" || scene.source === "blob") &&
    view.desired?.output !== "shadow" &&
    (choice.scene ?? null) !== null
  ) {
    const mqttOff = state.mqtt?.state !== "connected";
    const notWriter =
      scene.source === "blob" && state.controller?.blobWriter?.writer === false;
    return {
      first,
      second: {
        text: `Your choice: ${sceneName(state, choice.scene, type)}`,
        restore: notWriter
          ? undefined
          : {
              disabled: mqttOff || state.live.state === "lost",
              title: mqttOff ? "Clearing an overlay needs MQTT" : "",
            },
      },
    };
  }
  const count = Number(view.settingOverlayCount ?? 0);
  if (count > 0)
    return {
      first,
      second: {
        cls: "ovr",
        icon: "layers",
        text:
          count === 1
            ? "1 setting from an MQTT overlay"
            : `${count} settings from MQTT overlays`,
      },
    };
  return { first, second: { text: "" } };
}

/**
 * The Brightness column of the Devices table.
 *
 * @param {any} view
 * @returns {{big: string, muted: boolean, meta: Line}}
 */
export function brightnessCell(view) {
  const brightness = view.desired?.brightness ?? {};
  if (brightness.override !== null && brightness.override !== undefined)
    return {
      big: percent(brightness.override),
      muted: false,
      meta: { text: "Override", cls: "ovr" },
    };
  const last = view.effective?.lastBrightness;
  if (last === null || last === undefined)
    return {
      big: "—",
      muted: true,
      meta: {
        text: view.desired?.scene?.scene
          ? "Auto · not set by scene"
          : "Auto · no scene",
      },
    };
  return { big: percent(last), muted: false, meta: { text: "Auto · from scene" } };
}

/** @param {any} view @returns {{icon: string, label: string, cls: string}} */
export function modeCell(view) {
  switch (view.desired?.mode?.value) {
    case "pause":
      return { icon: "pause", label: "Paused", cls: "" };
    case "stop":
      return { icon: "stop", label: "Stopped", cls: "stop" };
    default:
      return { icon: "play", label: "Playing", cls: "" };
  }
}

/**
 * The Device column: name, and the lines under it.
 *
 * @param {any} view
 * @returns {{title: string, lines: Array<{text: string, mono?: boolean, cls?: string, icon?: string, name?: string}>}}
 */
export function deviceCell(view) {
  const size = sizeOf(view);
  /** @type {Array<{text: string, mono?: boolean, cls?: string, icon?: string, name?: string}>} */
  const lines = [];
  // Tick, item 8: the second line under the name of an overlay-only device.
  if (view.origin === "blob")
    lines.push({
      text: "from the MQTT config overlay · not saved",
      cls: "ovr",
      icon: "layers",
    });
  lines.push({
    text: `${typeLabel(view.type)} · ${size.width}×${size.height}`,
    name: view.displayName && view.displayName !== view.name ? view.name : undefined,
  });
  if (view.desired?.address?.value)
    lines.push({ text: view.desired.address.value, mono: true });
  if (view.comment) lines.push({ text: view.comment });
  return { title: deviceTitle(view), lines };
}

// ---------------------------------------------------------------------------
// Device page
// ---------------------------------------------------------------------------

/**
 * The device page's title status line: the slot next to the title that
 * page-level conditions use (Tick, item 8; section 13, item 11).
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {{text: string, cls: string, icon: string|null, dot?: string|null, action?: {label: string, kind: string}, title?: string}|null}
 */
export function deviceCondition(state, view) {
  const page = pageCondition(state);
  if (page && page.cls === "bad") return page;
  if (view.origin === "blob")
    return {
      text: "This device comes from the MQTT config overlay and is not in config.json. Changes are applied but not saved.",
      cls: "ovr",
      icon: "layers",
      action: { label: "Add to config.json", kind: "adopt" },
    };
  const held = heldBy(view, state.overlays);
  if (held) {
    const address =
      held.kind === "device-ip"
        ? String(held.value ?? held.raw ?? "")
        : String(view.desired?.address?.value ?? "");
    return {
      text: `On hold: its address comes from an MQTT overlay (${address}) that the broker has not confirmed since the reconnect at ${reconnectAt(state)}. Clear the overlay to use the address in config.json.`,
      cls: "",
      icon: null,
      dot: "idle",
    };
  }
  if (switchedOffBy(view, state.overlays))
    return { text: "Switched off by an MQTT overlay", cls: "", icon: null, dot: "idle" };
  return page;
}

/**
 * When the current MQTT connection began: the reconnect after which a record
 * has not been delivered again.
 *
 * @param {ClientState} state
 * @returns {string} "18:42"
 */
export function reconnectAt(state) {
  return clockShort(state.mqtt?.since);
}

/**
 * The five fixed rows of "Showing now" (approved spec 5).
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {{tint: string, label: string, showing: {name: string, key: string|null}, source: Line & {sub?: string, html?: boolean}, display: Line & {sub?: string}, choice: {text: string, note: string, cls: string, noteTitle?: string}, action: {kind: string, label: string, disabled?: boolean, title?: string}|null}}
 */
export function showingNow(state, view) {
  const type = view.type;
  const scene = view.desired?.scene ?? {};
  const choice = view.desired?.choice ?? {};
  const health = view.health ?? {};
  const status = deviceStatus(view, state);
  const shadow = status.kind === "shadow";
  const offline = health.state === "offline" && !shadow;
  const showingKey = scene.scene ?? null;
  const overlayRecord = (state.overlays ?? []).find(
    (record) => record.id === scene.overlayId,
  );

  // Source
  /** @type {Line & {sub?: string, topic?: string}} */
  let source;
  if (shadow)
    source = {
      icon: "info",
      text: "Shadow: changes here don't reach the display",
    };
  else if (scene.source === "overlay")
    source = {
      cls: "ovr",
      icon: "layers",
      text: `MQTT overlay since ${clock(scene.since)} · retained on `,
      topic: overlayRecord?.topic ?? `${state.controller?.mqttNamespace?.baseTopic ?? "…"}/overlay/device/${view.name}/scene`,
    };
  else if (scene.source === "blob")
    source = {
      cls: "ovr",
      icon: "layers",
      text: `Config overlay since ${clock(scene.since)} · retained on `,
      topic: overlayRecord?.topic ?? `${state.controller?.mqttNamespace?.baseTopic ?? "…"}/overlay/blob`,
    };
  else if (scene.source === "ui" && choice.persisted === false) {
    const reason =
      choice.notSavedReason === "config_invalid"
        ? ": config.json is not valid JSON"
        : "";
    source = {
      cls: choice.notSavedReason === "config_invalid" ? "warn" : "",
      icon: choice.notSavedReason === "config_invalid" ? "alert" : "user",
      text: `Switched here at ${clock(choice.chosenAt)}, but not saved${reason}`,
    };
  } else if (scene.source === "ui")
    source = {
      icon: "user",
      text: choice.chosenAt
        ? `Your choice, saved in config.json at ${clock(choice.chosenAt)}`
        : "Your choice, saved in config.json",
    };
  else if (scene.source === "fallback")
    source = { icon: "user", text: "No scene chosen yet" };
  else source = { icon: "user", text: "Your choice, saved in config.json" };

  // A scene overlay that waits for the broker (item 11): the source shows
  // what decides now; one line under it says what waits.
  const waiting = waitingSceneOverlay(state, view);
  if (waiting && !shadow) source.sub = waiting;

  // Display
  /** @type {Line & {sub?: string}} */
  let display;
  const now = state.now;
  if (state.live.state === "lost" && state.loaded)
    display = {
      cls: "warn",
      icon: "alert",
      text: `Live updates paused · retrying · values from ${clock(state.dataAt)}`,
    };
  else if (shadow)
    display = {
      dot: "shadow",
      text: "Shadow · not driving the display",
      sub: shadowReason(view),
    };
  else if (status.kind === "held")
    display = { dot: "idle", text: "On hold · not started" };
  else if (status.kind === "off")
    display = {
      dot: "idle",
      text: switchedOffBy(view, state.overlays)
        ? "Off · switched off by an MQTT overlay"
        : "Off · disabled in config.json",
    };
  else if (scene.problem)
    display = { cls: "bad", icon: "alert", text: `Cannot run: ${scene.problem}` };
  else if (health.state === "offline")
    display = {
      cls: "bad",
      dot: "bad",
      text: `Offline since ${clock(health.since)} · ${ago(health.since, now)}`,
    };
  else if (health.state === "stale") {
    const errors = Number(health.consecutiveErrors ?? 0);
    const retry = view.effective?.nextRetryAt
      ? ` · next try in ${duration(Math.max(0, Date.parse(view.effective.nextRetryAt) - now))}`
      : "";
    display = {
      cls: "warn",
      icon: "alert",
      text:
        errors > 0
          ? `Stale · last ${errors} ${errors === 1 ? "render" : "renders"} failed${retry}`
          : `Stale · no good frame for ${duration(now - Date.parse(health.lastFrameAt ?? health.since))}`,
      title: "Stale after 30 s, offline after 2 min without a good frame",
    };
  } else if (health.state === "starting" || (showingKey && !health.lastFrameAt && health.state !== "online" && health.state !== "idle"))
    display = { icon: "spinner", text: "Starting · waiting for the first frame" };
  else if (health.state === "idle" || !showingKey)
    display = { dot: "idle", text: "Idle · nothing is drawn until you choose a scene" };
  else {
    const parts = ["Online"];
    if (health.lastFrameAt) parts.push(`frame ${ago(health.lastFrameAt, now)}`);
    const previewing = previewCount(state, view);
    if (previewing > 0)
      parts.push(`previewing ${previewing} ${previewing === 1 ? "change" : "changes"}`);
    else if (view.effective?.showingSince && sceneSince(view))
      parts.push(`showing since ${clock(view.effective.showingSince)}`);
    display = { dot: "ok", text: parts.join(" · ") };
  }

  // Your choice
  /** @type {{text: string, note: string, cls: string, noteTitle?: string}} */
  let choiceRow;
  const choiceName = sceneName(state, choice.scene ?? null, type);
  if (scene.source === "fallback" || (choice.scene ?? null) === null)
    choiceRow = { text: "None", note: "", cls: "mine" };
  else if (scene.source === "ui" && choice.persisted === false)
    choiceRow = {
      text: choiceName,
      note:
        choice.notSavedReason === "config_invalid"
          ? "· lost at the next reload or restart"
          : "· not saved",
      cls: choice.notSavedReason === "config_invalid" ? "warn" : "mine",
    };
  else if (choice.overridden || (showingKey ?? null) !== (choice.scene ?? null))
    choiceRow = {
      text: choiceName,
      note: "· overridden",
      cls: "mine",
      noteTitle: "A retained overlay survives restarts until it is cleared",
    };
  else if (offline || health.state === "starting" || scene.source === "ui")
    choiceRow = { text: choiceName, note: "", cls: "mine" };
  else choiceRow = { text: choiceName, note: "· the same as showing", cls: "mine" };

  // Action row: always present, empty when there is nothing to do.
  /** @type {{kind: string, label: string, disabled?: boolean, title?: string}|null} */
  let action = null;
  if (shadow) action = null;
  else if (state.live.state === "lost") action = null;
  else if (
    (choice.scene ?? null) !== null &&
    (scene.source === "overlay" ||
      (scene.source === "blob" && state.controller?.blobWriter?.writer !== false))
  ) {
    const mqttOff = state.mqtt?.state !== "connected";
    action = {
      kind: "return",
      label: `Return to ${choiceName}`,
      disabled: mqttOff,
      title: mqttOff ? "Clearing an overlay needs MQTT" : "",
    };
  } else if (offline) action = { kind: "recovery", label: "Recovery steps" };
  else if (scene.source === "ui" && choice.notSavedReason === "config_invalid")
    action = { kind: "fixconfig", label: "Fix config.json" };

  return {
    tint: scene.source === "overlay" || scene.source === "blob" ? (shadow ? "" : "ovr") : "",
    label: offline ? "Last shown" : "Showing now",
    showing: {
      name: showingKey ? sceneName(state, showingKey, type) : "Nothing",
      key: showingKey && !String(showingKey).startsWith("builtin:") ? showingKey : null,
    },
    source,
    display,
    choice: choiceRow,
    action,
  };
}

/** @param {any} view @returns {boolean} the scene started within this view's life, so "showing since" says something */
function sceneSince(view) {
  return Boolean(view.effective?.showingSince);
}

/**
 * How many settings of the showing scene this page is trying on the display.
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {number}
 */
export function previewCount(state, view) {
  const key = view.desired?.scene?.scene;
  if (!key) return 0;
  const settings = state.settings.get(`${view.name}/${key}`);
  if (!settings?.preview) return 0;
  return Object.values(settings.values ?? {}).filter(
    (/** @type {any} */ value) => value && "preview" in value,
  ).length;
}

/**
 * Item 11 default, device page, scene: one line under the source while the
 * device's scene overlay waits for the broker.
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {string|undefined}
 */
export function waitingSceneOverlay(state, view) {
  const record = (state.overlays ?? []).find(
    (r) =>
      r.kind === "device-scene" && r.device === view.name && r.confirmed === false,
  );
  if (!record) return undefined;
  const value = String(record.value ?? record.raw ?? "");
  return `MQTT overlay '${value}' is not confirmed since the reconnect at ${reconnectAt(state)} · Overlays`;
}

/**
 * Item 11 default, device page, settings: the count line while setting
 * overlays of the showing scene wait for the broker.
 *
 * @param {ClientState} state
 * @param {string} device
 * @param {string} scene
 * @returns {string|null}
 */
export function waitingSettingsLine(state, device, scene) {
  const waiting = (state.overlays ?? []).filter(
    (r) =>
      r.kind === "setting" &&
      r.device === device &&
      r.scene === scene &&
      r.confirmed === false,
  ).length;
  if (waiting === 0) return null;
  return waiting === 1
    ? "1 setting overlay is waiting for the broker · Overlays"
    : `${waiting} setting overlays are waiting for the broker · Overlays`;
}

/**
 * The facts strip of the device page.
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {Array<{label: string, value: string, cls?: string, mono?: boolean, muted?: boolean}>}
 */
export function facts(state, view) {
  const now = state.now;
  const health = view.health ?? {};
  const shadow = view.desired?.output === "shadow";
  /** @type {Array<{label: string, value: string, cls?: string, mono?: boolean, muted?: boolean}>} */
  const list = [];
  const at = (/** @type {string|null} */ time) =>
    `${clock(time)} · ${ago(time, now)}`;
  if (shadow) {
    list.push({ label: "Last frame", value: "not measured in shadow", muted: true });
    list.push({ label: "Last contact", value: "not measured in shadow", muted: true });
  } else {
    list.push(
      health.lastFrameAt
        ? { label: "Last frame", value: at(health.lastFrameAt) }
        : { label: "Last frame", value: "none yet", muted: true },
    );
    list.push(
      health.lastContactAt
        ? { label: "Last contact", value: at(health.lastContactAt) }
        : { label: "Last contact", value: "none yet", muted: true },
    );
  }
  const errors = Number(health.consecutiveErrors ?? 0);
  list.push({
    label: "Render errors",
    value: `${errors} in a row`,
    cls:
      errors > 0 && health.state === "offline"
        ? "bad"
        : errors > 0
          ? "warn"
          : undefined,
  });
  if (health.lastError?.message)
    list.push({ label: "Last error", value: health.lastError.message, mono: true });
  if (Number(health.powerCycles?.count ?? 0) > 0)
    list.push({
      label: "Power cycles",
      value: `${health.powerCycles.count} of ${health.powerCycles.max}`,
    });
  list.push({ label: "Frame floor", value: `${view.facts?.minFrameMs ?? 500} ms` });
  if (view.type === "pixoo")
    list.push(
      view.facts?.powerCyclePlugTopic
        ? { label: "Power-cycle plug", value: view.facts.powerCyclePlugTopic, mono: true }
        : { label: "Power-cycle plug", value: "not configured", muted: true },
    );
  else list.push({ label: "Preview poll", value: `${view.preview?.pollMs ?? 2000} ms` });
  return list;
}

/**
 * The caption under the device page's preview.
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {string}
 */
export function previewCaption(state, view) {
  const size = sizeOf(view);
  const frame = state.previews.get(view.name);
  const received = frame?.receivedAt ?? null;
  const dims = `${size.width} × ${size.height}`;
  if (view.desired?.output === "shadow")
    return `${dims} · Would show · not on the display`;
  if (!received) return `${dims} · no frame yet`;
  if (view.health?.state === "offline")
    return `Last frame ${clock(received)} · ${ago(received, state.now)}`;
  if (view.health?.state === "stale")
    return `${dims} · frame ${clock(received)}, ${ago(received, state.now)}`;
  return `${dims} · frame ${clock(received)}`;
}

/**
 * What the preview box draws: the frame, a veil, or the reason there is none.
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {{frame: import("../store.js").Preview|null, veil: boolean, reason: string|null, spinner: boolean}}
 */
export function previewState(state, view) {
  const frame = state.previews.get(view.name) ?? null;
  const offline =
    view.health?.state === "offline" && view.desired?.output !== "shadow";
  if (frame && frame.rgb === null)
    return { frame: null, veil: false, reason: "bad frame", spinner: false };
  if (frame) return { frame, veil: offline, reason: null, spinner: false };
  if (!view.desired?.scene?.scene)
    return { frame: null, veil: false, reason: "No scene chosen", spinner: false };
  if (offline)
    return { frame: null, veil: false, reason: "No frame received", spinner: false };
  return {
    frame: null,
    veil: false,
    reason: "Waiting for the first frame",
    spinner: true,
  };
}

// ---------------------------------------------------------------------------
// Overlays page (section 13, items 11 and 12)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} OverlayRow
 * @property {string} id
 * @property {string} section "device" | "setting" | "control" | "config"
 * @property {string|null} device
 * @property {string} what "Scene", "IP address", "Clock + Home Stats · Night Start Hour", …
 * @property {string} topic
 * @property {{text: string, key?: string|null, cls: string}} value the value; cls "ovr" while in effect, "" while it waits or holds back
 * @property {string} status the line under the value: what it replaces, or what it does now
 * @property {string} statusCls
 * @property {{time: string, sub: string}} received
 * @property {{disabled: boolean, reason: string}|null} clear null: no Clear (a cleared row)
 * @property {string|null} cleared "Cleared 18:43:10" for a row that left the list while the page showed it
 */

/**
 * @param {ClientState} state
 * @param {any} record OverlayRecord
 * @returns {OverlayRow}
 */
export function overlayRow(state, record) {
  const view = record.device ? state.devices.get(record.device) : undefined;
  const type = view?.type;
  const now = state.now;
  const section =
    record.kind === "setting"
      ? "setting"
      : record.kind === "mode" || record.kind === "brightness"
        ? "control"
        : record.kind === "blob" || record.kind === "scene-path"
          ? "config"
          : "device";
  const what = overlayWhat(state, record, type);
  const waiting = record.confirmed === false;
  const reconnect = reconnectAt(state);
  const receivedTime =
    record.origin === "replay" && !waiting ? "at startup" : clock(record.receivedAt);
  const receivedSub =
    record.origin === "replay" && !waiting
      ? `received ${clock(record.receivedAt)}, set earlier`
      : ago(record.receivedAt, now);

  /** @type {OverlayRow["value"]} */
  let value = {
    text: overlayValueText(state, record, type),
    key:
      record.kind === "device-scene" && typeof record.value === "string" && !record.value.startsWith("builtin:")
        ? record.value
        : null,
    cls: "ovr",
  };
  let status = overlayReplaces(state, record, view);
  let statusCls = "";
  /** @type {{time: string, sub: string}} */
  let received = { time: receivedTime, sub: receivedSub };

  if (record.restricts === "off") {
    value = { text: "Switched off", cls: "" };
    status = `Switched off by an MQTT overlay since ${clockShort(record.receivedAt)}`;
    if (waiting)
      received = {
        time: clock(record.receivedAt),
        sub: `not confirmed since the reconnect at ${reconnect} · still off`,
      };
  } else if (record.restricts === "held") {
    value = { ...value, cls: "" };
    status = "Waiting for the broker · display on hold";
    received = {
      time: clock(record.receivedAt),
      sub: `received ${clockShort(record.receivedAt)} · not confirmed since the reconnect at ${reconnect}`,
    };
  } else if (waiting) {
    value = { ...value, cls: "" };
    status = "Waiting for the broker · not in effect";
    received = {
      time: clock(record.receivedAt),
      sub: `received ${clockShort(record.receivedAt)} · not confirmed since the reconnect at ${reconnect}`,
    };
  } else if (!record.valid) {
    value = { ...value, cls: "" };
    status = `Not used: ${record.problem ?? "invalid value"}`;
    statusCls = "warn";
  } else if (record.supersededBy) {
    value = { ...value, cls: "" };
    status = "Replaced by your choice";
  } else if (record.inEffect === false && record.problem) {
    value = { ...value, cls: "" };
    status = `Not in effect: ${record.problem}`;
  }

  /** @type {{disabled: boolean, reason: string}} */
  let clear = { disabled: false, reason: "" };
  if (record.kind === "blob" && state.controller?.blobWriter?.writer === false) {
    const reason = state.controller.blobWriter.reason;
    clear = {
      disabled: true,
      reason:
        reason === "v1_writes"
          ? "written by pixdcon v1 during the switch-over"
          : "this instance never writes the config overlay",
    };
  } else if (state.mqtt?.state !== "connected")
    clear = { disabled: true, reason: "Clearing an overlay needs MQTT" };
  else if (view?.desired?.output === "shadow" && record.kind !== "setting" && section !== "config")
    clear = { disabled: true, reason: "This display is in shadow: pixdcon does not write its topics" };
  return {
    id: record.id,
    section,
    device: record.device ?? null,
    what,
    topic: record.topic,
    value,
    status,
    statusCls,
    received,
    clear,
    cleared: null,
  };
}

/**
 * @param {ClientState} state
 * @param {any} record
 * @param {string} [type]
 * @returns {string}
 */
function overlayWhat(state, record, type) {
  switch (record.kind) {
    case "device-scene":
      return "Scene";
    case "device-ip":
      return "IP address";
    case "device-enabled":
      return "Enabled";
    case "setting": {
      const meta = sceneMeta(state, record.scene);
      const field = meta?.settingsSchema?.[record.key];
      return `${sceneName(state, record.scene, type)} · ${field?.label ?? record.key}`;
    }
    case "mode":
      return "Mode";
    case "brightness":
      return "Brightness override";
    case "scene-path":
      return `Scene file path · ${record.scene ?? ""}`;
    case "blob":
      return "Whole config";
    default:
      return record.kind;
  }
}

/**
 * @param {ClientState} state
 * @param {any} record
 * @param {string} [type]
 * @returns {string}
 */
function overlayValueText(state, record, type) {
  const value = record.value;
  if (record.kind === "device-scene" && typeof value === "string")
    return sceneName(state, value, type);
  if (record.kind === "brightness") {
    const level = /** @type {any} */ (value)?.value ?? value;
    return typeof level === "number" ? percent(level) : String(record.raw ?? "");
  }
  if (record.kind === "mode" && typeof value === "string")
    return value === "pause" ? "Pause" : value === "stop" ? "Stop" : "Play";
  if (record.kind === "blob") {
    const devices = /** @type {any} */ (value)?.devices?.length ?? 0;
    const scenes = Object.keys(/** @type {any} */ (value)?.scenes ?? {}).length;
    return `${devices} ${devices === 1 ? "device" : "devices"} · ${scenes} ${scenes === 1 ? "scene" : "scenes"}`;
  }
  if (value === null || value === undefined) return String(record.raw ?? "");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * What an overlay in effect replaces, as the mockup writes it.
 *
 * @param {ClientState} state
 * @param {any} record
 * @param {any} view
 * @returns {string}
 */
function overlayReplaces(state, record, view) {
  const type = view?.type;
  switch (record.kind) {
    case "device-scene":
      return view
        ? `instead of your choice ${sceneName(state, view.desired?.choice?.scene ?? null, type)}`
        : "for a device pixdcon does not know";
    case "setting": {
      const settings = state.settings.get(`${record.device}/${record.scene}`);
      const layer = settings?.values?.[record.key];
      if (layer && "saved" in layer) return `instead of the saved ${String(layer.saved)}`;
      if (layer && "default" in layer) return `instead of the default ${String(layer.default)}`;
      return "instead of the saved value";
    }
    case "device-ip":
      return "instead of the address in config.json";
    case "mode":
      return "instead of Play";
    case "brightness":
      return "instead of the scene's own brightness";
    case "scene-path":
      return "instead of the path in config.json";
    case "blob":
      return "patches devices and scenes of config.json";
    default:
      return "";
  }
}

/**
 * The rows of the Overlays page, with the rows that left the list while the
 * page showed them kept in place, greyed (approved spec 8).
 *
 * @param {ClientState} state
 * @param {{shown: string[], since: number}} page ids the page has shown, in order, and when it was opened
 * @returns {OverlayRow[]}
 */
export function overlayRows(state, page) {
  /** @type {Map<string, OverlayRow>} */
  const rows = new Map();
  for (const record of state.overlays ?? []) rows.set(record.id, overlayRow(state, record));
  /** @type {OverlayRow[]} */
  const out = [];
  for (const id of page.shown) {
    const row = rows.get(id);
    if (row) {
      out.push(row);
      rows.delete(id);
      continue;
    }
    const gone = state.gone.get(id);
    if (gone && gone.at >= page.since) {
      const old = overlayRow(state, gone.record);
      out.push({
        ...old,
        value: { ...old.value, cls: "" },
        clear: null,
        cleared: `Cleared ${clock(gone.at)}`,
      });
    }
  }
  out.push(...rows.values());
  return out;
}

// ---------------------------------------------------------------------------
// Health page
// ---------------------------------------------------------------------------

/** Tick, item 10: exactly this, above the Displays table. */
export const HEALTH_RULE = "Stale after 30 s, offline after 2 min without a good frame";

/** Tick, item 9: the Health title line while a restart is required. */
export const RESTART_SENTENCE =
  "The MQTT settings in config.json changed. Restart pixdcon to apply them.";

/**
 * @param {ClientState} state
 * @returns {{text: string, cls: string, icon: string|null}}
 */
export function healthTitle(state) {
  const page = pageCondition(state);
  if (page && page.cls === "bad") return page;
  if (state.controller?.restartRequired)
    return { text: RESTART_SENTENCE, cls: "warn", icon: "alert" };
  if (state.mqtt?.state === "offline")
    return {
      text: `MQTT offline since ${clock(state.mqtt.since)} · displays keep rendering; mode, brightness and overlays wait for MQTT`,
      cls: "warn",
      icon: "alert",
    };
  const views = [...state.devices.values()];
  const driven = views.filter((view) => view.desired?.output !== "shadow");
  const online = driven.filter((view) => view.health?.state === "online").length;
  const parts = [`Running since ${clock(state.controller?.startedAt)}`];
  if (state.mqtt?.state === "connected") parts.push("MQTT connected");
  else if (state.mqtt?.state === "disabled") parts.push("MQTT not configured");
  if (driven.length > 0) parts.push(`${online} of ${driven.length} displays online`);
  const shadow = views.length - driven.length;
  if (shadow > 0) parts.push(`${shadow} shadow`);
  return { text: parts.join(" · "), cls: "", icon: null };
}

/**
 * Item 12: one line under the MQTT block while the config overlay is
 * written by pixdcon v1.
 *
 * @param {ClientState} state
 * @returns {string|null}
 */
export function blobWriterLine(state) {
  const writer = state.controller?.blobWriter;
  if (writer?.writer === false && writer.reason === "v1_writes")
    return "Config overlay: written by pixdcon v1 during the switch-over";
  return null;
}

/**
 * One row of the Displays table on Health.
 *
 * @param {ClientState} state
 * @param {any} view
 * @returns {{name: string, title: string, sub: string|null, status: Status, lastFrame: string, errors: string, errorsCls: string, lastError: string|null, powerCycles: string, powerCyclesMuted: boolean, mqttHealth: string}}
 */
export function healthRow(state, view) {
  const health = view.health ?? {};
  const status = deviceStatus(view, state);
  const errors = Number(health.consecutiveErrors ?? 0);
  const plug = view.facts?.powerCyclePlugTopic;
  const shadow = status.kind === "shadow";
  return {
    name: view.name,
    title: deviceTitle(view),
    sub: view.displayName && view.displayName !== view.name ? view.name : null,
    status,
    lastFrame: shadow
      ? "not measured"
      : health.lastFrameAt
        ? ago(health.lastFrameAt, state.now)
        : "none yet",
    errors: String(errors),
    errorsCls: errors > 0 ? (health.state === "offline" ? "bad" : "warn") : "",
    lastError: health.lastError?.message ?? null,
    powerCycles: plug
      ? `${health.powerCycles?.count ?? 0} of ${health.powerCycles?.max ?? 0}`
      : "no plug",
    powerCyclesMuted: !plug,
    mqttHealth: shadow
      ? "not published"
      : health.state === "online"
        ? "ok"
        : health.state === "offline"
          ? "offline"
          : health.state === "stale"
            ? "stale"
            : String(health.state ?? "—"),
  };
}
