import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { SceneSettingsService } from "../lib/scene-settings-service.js";
import { WebServer } from "../lib/web-server.js";

const schema = {
  enabled: { type: "boolean", default: true },
  level: { type: "int", default: 10, min: 0, max: 100 },
  temperature: { type: "float", default: 20 },
  text: { type: "string", default: "hello" },
  layout: { type: "json", default: { rows: [1] } },
  color: { type: "color", default: "#ffffff" },
  mode: { type: "enum", default: "auto", options: ["auto", "manual"] },
  start: { type: "time", default: "09:00" },
  spare: { type: "int", default: 9 },
};
const input = {
  enabled: "false", level: "150", temperature: "21.5", text: " live ",
  layout: { rows: [2], columns: 3 }, color: " #ff0000 ", mode: "manual",
  start: " 10:30 ", spare: 0,
};
const normalized = {
  enabled: false, level: 100, temperature: 21.5, text: "live",
  layout: { rows: [2], columns: 3 }, color: "#ff0000", mode: "manual",
  start: "10:30", spare: 0,
};
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const config = {
    devices: [
      { name: "panel-a", scene: "clock", sceneSettings: { clock: { level: 5, enabled: false } } },
      { name: "panel-b", scene: "clock" },
    ],
    scenes: { clock: { path: "./clock.js" }, other: { path: "./other.js" } },
  };
  const metadata = { clock: { settingsSchema: schema }, other: { settingsSchema: schema } };
  const published = [];
  const mqttService = {
    connected: true,
    publishRaw(topic, payload, retain) { published.push({ topic, payload, retain }); },
  };
  const service = new SceneSettingsService({
    getConfig: () => config,
    getSceneMetadata: () => metadata,
    mqttService,
  });
  const server = new WebServer({
    getEffectiveConfig: () => config,
    getSceneMetadata: () => metadata,
    getSceneSettingsState: () => service.getUiState(),
    sceneSettingsService: service,
    mqttService,
    logger: { error() {} },
  });
  return { config, service, server, published, mqttService };
}

function watch(service, deviceName = "panel-a", sceneName = "clock") {
  const emissions = [];
  const unsubscribe = service.createRuntimeContext(deviceName, sceneName).subscribe((values) => {
    emissions.push(plain(values));
  });
  emissions.length = 0; // Subscription immediately delivers the current values.
  return { emissions, unsubscribe };
}

function echo(service, published) {
  for (const { topic, payload } of published) service._handleOverlayMessage(topic, payload);
}

async function request(server, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.url = url;
  req.method = body === undefined ? "GET" : "POST";
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(data) { this.body = data; },
  };
  await server._handle(req, res);
  return res;
}

async function loadUi(server, globals = {}) {
  const res = await request(server, "/");
  assert.equal(res.status, 200);
  const script = res.body.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ui = runInNewContext(script + "; app();", {
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async (url, options) => {
      const response = await request(server, url, options ? JSON.parse(options.body) : undefined);
      return { ok: response.status === 200, json: async () => JSON.parse(response.body) };
    },
    ...globals,
  });
  ui.config = plain(server.getEffectiveConfig());
  ui.sceneMeta = plain(server.getSceneMetadata());
  ui.sceneSettingsState = plain(server.getSceneSettingsState());
  ui.mqttConnected = true;
  return { ui, html: res.body };
}

test("apply updates the local overlay synchronously and emits one complete normalized snapshot", async (t) => {
  const { config, service, published } = fixture();
  const { emissions, unsubscribe } = watch(service);
  t.after(unsubscribe);
  const applying = service.applyOverlay("panel-a", "clock", input);
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), normalized);
  assert.deepEqual(service.getEffectiveValues("panel-a", "clock"), normalized);
  assert.deepEqual(emissions, [normalized]);
  await applying;
  assert.deepEqual(published, Object.keys(schema).map((key) => ({
    topic: `pixdcon/panel-a/clock/settings/${key}`,
    payload: key === "layout" ? JSON.stringify(normalized[key]) : String(normalized[key]),
    retain: true,
  })));
  echo(service, published);
  assert.deepEqual(emissions, [normalized]);
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), normalized);
  assert.deepEqual(config.devices[0].sceneSettings.clock, { level: 5, enabled: false });
});

test("clear removes all nine schema overlays synchronously and echoes do not emit again", async (t) => {
  const { service, published } = fixture();
  await service.applyOverlay("panel-a", "clock", input);
  echo(service, published);
  published.length = 0;
  const { emissions, unsubscribe } = watch(service);
  t.after(unsubscribe);
  const clearing = service.clearOverlay("panel-a", "clock");
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), {});
  const fallback = {
    enabled: false, level: 5, temperature: 20, text: "hello", layout: { rows: [1] },
    color: "#ffffff", mode: "auto", start: "09:00", spare: 9,
  };
  assert.deepEqual(service.getEffectiveValues("panel-a", "clock"), fallback);
  assert.deepEqual(emissions, [fallback]);
  await clearing;
  assert.deepEqual(published, Object.keys(schema).map((key) => ({
    topic: `pixdcon/panel-a/clock/settings/${key}`, payload: "", retain: true,
  })));
  echo(service, published);
  assert.deepEqual(emissions, [fallback]);
});

test("partial, repeated and invalid applies preserve sibling overlays and skip unchanged emissions", async (t) => {
  const { service, published } = fixture();
  await service.applyOverlay("panel-a", "clock", { enabled: false, level: 30 });
  const { emissions, unsubscribe } = watch(service);
  t.after(unsubscribe);
  await service.applyOverlay("panel-a", "clock", { level: 40, mode: "invalid", start: "25:00", unknown: 1 });
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), { enabled: false, level: 40 });
  assert.equal(emissions.length, 1);
  const before = published.length;
  await service.applyOverlay("panel-a", "clock", { level: "40", enabled: "false" });
  assert.equal(published.length, before + 2); // Retained MQTT publishing is unchanged.
  assert.equal(emissions.length, 1);
  await service.applyOverlay("panel-a", "clock", { level: "40bad", enabled: "maybe", unknown: true });
  await service.applyOverlay("panel-a", "clock", {});
  assert.equal(published.length, before + 2);
  assert.equal(emissions.length, 1);
});

test("local apply uses MQTT payload semantics for empty and null strings", async (t) => {
  const { service, published } = fixture();
  await service.applyOverlay("panel-a", "clock", { text: "before" });
  const { emissions, unsubscribe } = watch(service);
  t.after(unsubscribe);
  for (const value of ["", "null", " null "]) {
    await service.applyOverlay("panel-a", "clock", { text: value });
    assert.deepEqual(service.getOverlayValues("panel-a", "clock"), {});
    echo(service, published.slice(-1));
    assert.equal(emissions.length, 1);
  }
});

test("structurally equal JSON echoes and repeated clears do not emit", async (t) => {
  const { service } = fixture();
  await service.applyOverlay("panel-a", "clock", { layout: { rows: [2], columns: 3 } });
  const { emissions, unsubscribe } = watch(service);
  t.after(unsubscribe);
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/layout", '{"columns":3,"rows":[2]}');
  assert.equal(emissions.length, 0);
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/layout", '{"rows":[3]}');
  assert.equal(emissions.length, 1);
  await service.clearOverlay("panel-a", "clock");
  assert.equal(emissions.length, 2);
  await service.clearOverlay("panel-a", "clock");
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/layout", "null");
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/layout", "invalid JSON");
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/unknown", "42");
  assert.equal(emissions.length, 2);
});

test("clear leaves other devices and scenes unchanged", async (t) => {
  const { service } = fixture();
  await service.applyOverlay("panel-a", "clock", { level: 30 });
  await service.applyOverlay("panel-b", "clock", { level: 40 });
  await service.applyOverlay("panel-a", "other", { level: 50 });
  const otherDevice = watch(service, "panel-b");
  const otherScene = watch(service, "panel-a", "other");
  t.after(otherDevice.unsubscribe);
  t.after(otherScene.unsubscribe);
  await service.clearOverlay("panel-a", "clock");
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), {});
  assert.deepEqual(service.getOverlayValues("panel-b", "clock"), { level: 40 });
  assert.deepEqual(service.getOverlayValues("panel-a", "other"), { level: 50 });
  assert.deepEqual(otherDevice.emissions, []);
  assert.deepEqual(otherScene.emissions, []);
});

test("disconnected apply and clear reject without publishing or changing state", async (t) => {
  const { service, mqttService, published } = fixture();
  await service.applyOverlay("panel-a", "clock", { level: 30 });
  published.length = 0;
  mqttService.connected = false;
  const { emissions, unsubscribe } = watch(service);
  t.after(unsubscribe);
  await assert.rejects(service.applyOverlay("panel-a", "clock", { level: 40 }), /MQTT not connected/);
  await assert.rejects(service.clearOverlay("panel-a", "clock"), /MQTT not connected/);
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), { level: 30 });
  assert.deepEqual(published, []);
  assert.deepEqual(emissions, []);
});

test("overlay API returns the changed overlay and immediate GET after clear has none", async () => {
  const { server, config } = fixture();
  const body = { deviceName: "panel-a", sceneName: "clock" };
  const applied = await request(server, "/api/scene-settings/overlay", { ...body, values: input });
  assert.equal(applied.status, 200);
  assert.deepEqual(JSON.parse(applied.body), { ok: true, overlay: normalized });
  const partial = await request(server, "/api/scene-settings/overlay", { ...body, values: { level: 0 } });
  assert.deepEqual(JSON.parse(partial.body), { ok: true, overlay: { ...normalized, level: 0 } });
  const cleared = await request(server, "/api/scene-settings/overlay/clear", body);
  assert.equal(cleared.status, 200);
  assert.deepEqual(JSON.parse(cleared.body), { ok: true, overlay: {} });
  const state = await request(server, "/api/scene-settings");
  assert.equal(state.status, 200);
  const clock = JSON.parse(state.body)["panel-a"].clock;
  assert.deepEqual(clock.overlay, {});
  assert.deepEqual(clock.saved, config.devices[0].sceneSettings.clock);
  assert.equal(clock.effective.level, 5);
  assert.deepEqual(clock.effective.layout, { rows: [1] });
});

test("overlay routes preserve unavailable and disconnected errors", async () => {
  const { server, mqttService } = fixture();
  const body = { deviceName: "panel-a", sceneName: "clock", values: { level: 30 } };
  for (const route of ["/api/scene-settings/overlay", "/api/scene-settings/overlay/clear"]) {
    mqttService.connected = false;
    const disconnected = await request(server, route, body);
    assert.equal(disconnected.status, 500);
    assert.deepEqual(JSON.parse(disconnected.body), { error: "MQTT not connected" });
    const unavailable = await request(new WebServer(), route, body);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(JSON.parse(unavailable.body), { error: "Scene settings service unavailable" });
  }
});

test("modal clear label, title and disabled binding distinguish MQTT overlays from saved resets", async () => {
  const { ui, html } = await loadUi(fixture().server);
  const button = html.match(/<button @click="clearSceneOverlay\(\)"[\s\S]*?<\/button>/)[0];
  assert.match(button, /Clear MQTT overlay/);
  assert.match(button, /title="[^"]*live MQTT overrides[^"]*Saved values and defaults apply again/);
  assert.match(button, /icon\('rotate-ccw', 13\)/);
  assert.match(button, /color:rgba\(245,158,11,0\.6\)/);
  const disabled = button.match(/:disabled="([^"]+)"/)[1];
  const isDisabled = () => runInNewContext(disabled, ui);
  assert.equal(isDisabled(), true);
  ui.openSceneSettings("panel-a", "clock");
  assert.equal(isDisabled(), true);
  ui.sceneSettingsState["panel-a"].clock.overlay = { enabled: false, level: 0 };
  assert.equal(isDisabled(), false);
  ui.mqttConnected = false;
  assert.equal(isDisabled(), true);
  ui.mqttConnected = true;
  ui.openSceneSettings("panel-b", "clock");
  assert.equal(isDisabled(), true);
  assert.match(html, /@click="resetSceneSetting\(field.key\)"[\s\S]*?>Reset to default<\/button>/);
  assert.match(html, /<button @click="clearOverlay\(device.name\)"[\s\S]*?\n\s+Reset\n\s+<\/button>/);
});

test("clearing refreshes all badges and fallback form values without broker echo or polling", async () => {
  const { server, service } = fixture();
  await service.applyOverlay("panel-a", "clock", input);
  const cancelled = [];
  const { ui } = await loadUi(server, { clearTimeout: (timer) => cancelled.push(timer) });
  ui.openSceneSettings("panel-a", "clock");
  ui._scheduleAutoOverlay();
  for (const key of Object.keys(schema)) assert.equal(ui.isSceneSettingOverridden(key), true);
  await ui.clearSceneOverlay();
  for (const key of Object.keys(schema)) assert.equal(ui.isSceneSettingOverridden(key), false);
  assert.deepEqual(plain(ui.sceneSettingsState["panel-a"].clock.overlay), {});
  assert.equal(ui.sceneSettingsForm.level, 5);
  assert.equal(ui.sceneSettingsForm.enabled, false);
  assert.deepEqual(JSON.parse(ui.sceneSettingsJson.layout), { rows: [1] });
  assert.equal(ui.isSceneSettingsDirty(), false);
  assert.ok(cancelled.includes(1));
  assert.equal(ui.message.type, "success");
});

test("clear failure retains overlay badges and unsaved draft", async () => {
  const { server, service } = fixture();
  await service.applyOverlay("panel-a", "clock", { level: 30 });
  const { ui } = await loadUi(server, {
    fetch: async () => ({ json: async () => ({ error: "MQTT not connected" }) }),
  });
  ui.openSceneSettings("panel-a", "clock");
  ui.sceneSettingsForm.level = 40;
  ui.editSceneSetting("level");
  await ui.clearSceneOverlay();
  assert.equal(ui.isSceneSettingOverridden("level"), true);
  assert.equal(ui.sceneSettingsForm.level, 40);
  assert.equal(ui.isSceneSettingsDirty(), true);
  assert.equal(ui.message.type, "error");
});

test("a clear finishing after a modal switch preserves the new device draft", async () => {
  let finishClear;
  const { server, service } = fixture();
  await service.applyOverlay("panel-a", "clock", { level: 30 });
  const { ui } = await loadUi(server, {
    fetch: (url, options) => {
      const response = () => request(server, url, options ? JSON.parse(options.body) : undefined)
        .then((res) => ({ ok: res.status === 200, json: async () => JSON.parse(res.body) }));
      return url === "/api/scene-settings/overlay/clear"
        ? new Promise((resolve) => { finishClear = () => resolve(response()); })
        : response();
    },
  });
  ui.openSceneSettings("panel-a", "clock");
  const clearing = ui.clearSceneOverlay();
  ui.openSceneSettings("panel-b", "clock");
  ui.sceneSettingsForm.level = 11;
  ui.editSceneSetting("level");
  finishClear();
  await clearing;
  assert.equal(ui.currentSceneSettings.deviceName, "panel-b");
  assert.equal(ui.sceneSettingsForm.level, 11);
  assert.deepEqual(plain(ui.sceneSavedPayload()), { level: 11 });
  assert.equal(ui.isSceneSettingsDirty(), true);
  assert.deepEqual(plain(ui.sceneSettingsState["panel-a"].clock.overlay), {});
});

test("a dropped publish leaves no local overlay and emits nothing", async (t) => {
  const { service, mqttService } = fixture();
  mqttService.publishRaw = () => false;
  const { emissions, unsubscribe } = watch(service);
  t.after(unsubscribe);
  await service.applyOverlay("panel-a", "clock", { level: 42 });
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), {});
  assert.equal(emissions.length, 0);
});

test("clear also removes overlay keys that are no longer in the schema", async () => {
  const { service, published } = fixture();
  service.overlay.set("panel-a::clock", { level: 7, retired_key: 3 });
  await service.clearOverlay("panel-a", "clock");
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), {});
  assert.ok(published.some((p) => p.topic === "pixdcon/panel-a/clock/settings/retired_key" && p.payload === ""));
});

test("opening the modal refreshes overlays that arrived after page load", async () => {
  const { server, service } = fixture();
  const { ui } = await loadUi(server);
  await service.applyOverlay("panel-a", "clock", { level: 42 }); // e.g. Home Assistant via MQTT
  assert.equal(ui.sceneSettingsState["panel-a"].clock.overlay.level, undefined);
  await ui.openSceneSettings("panel-a", "clock");
  assert.equal(ui.isSceneSettingOverridden("level"), true);
  assert.equal(ui.sceneSettingsForm.level, 42);
});

test("the open-time refresh does not clobber edits made meanwhile", async () => {
  const { server, service } = fixture();
  const { ui } = await loadUi(server);
  await service.applyOverlay("panel-a", "clock", { level: 42 });
  const opening = ui.openSceneSettings("panel-a", "clock");
  ui.sceneSettingsForm.level = 77;
  ui.editSceneSetting("level");
  await opening;
  assert.equal(ui.sceneSettingsForm.level, 77);
  assert.equal(ui.isSceneSettingOverridden("level"), true); // badge state is refreshed regardless
});

test("a slow open-time refresh cannot overwrite the state of a clear that finished first", async () => {
  const { server, service } = fixture();
  await service.applyOverlay("panel-a", "clock", { level: 42 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let deferFirst = true;
  const { ui } = await loadUi(server, {
    fetch: async (url, options) => {
      const response = await request(server, url, options ? JSON.parse(options.body) : undefined);
      if (url === "/api/scene-settings" && deferFirst) { deferFirst = false; await gate; }
      return { ok: response.status === 200, json: async () => JSON.parse(response.body) };
    },
  });
  const opening = ui.openSceneSettings("panel-a", "clock"); // its GET captures the overlay, then waits
  await new Promise((resolve) => setImmediate(resolve));
  await ui.clearSceneOverlay(); // clears and reloads with fresh (empty) state
  release();
  await opening;
  assert.deepEqual(plain(ui.sceneSettingsState["panel-a"].clock.overlay), {});
  assert.equal(ui.isSceneSettingOverridden("level"), false);
});

test("a stalled first open cannot overwrite the newer state of a second open", async () => {
  const { server, service } = fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { ui } = await loadUi(server, {
    fetch: async (url, options) => {
      const response = await request(server, url, options ? JSON.parse(options.body) : undefined);
      if (url === "/api/scene-settings" && ++calls === 1) await gate; // first open's GET stalls (no overlay yet)
      return { ok: response.status === 200, json: async () => JSON.parse(response.body) };
    },
  });
  const first = ui.openSceneSettings("panel-a", "clock");
  await new Promise((resolve) => setImmediate(resolve));
  await service.applyOverlay("panel-a", "clock", { level: 55 }); // arrives over MQTT meanwhile
  await ui.openSceneSettings("panel-a", "clock"); // reopen sees it
  assert.equal(ui.isSceneSettingOverridden("level"), true);
  release();
  await first;
  assert.equal(ui.isSceneSettingOverridden("level"), true);
  assert.equal(ui.sceneSettingsState["panel-a"].clock.overlay.level, 55);
});

test("a stalled older reload cannot overwrite the newer state of an open", async () => {
  const { server, service } = fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { ui } = await loadUi(server, {
    fetch: async (url, options) => {
      const response = await request(server, url, options ? JSON.parse(options.body) : undefined);
      if (url === "/api/scene-settings" && ++calls === 1) await gate; // the reload's GET stalls (no overlay)
      return { ok: response.status === 200, json: async () => JSON.parse(response.body) };
    },
  });
  const reload = ui.reloadUiState();
  await new Promise((resolve) => setImmediate(resolve));
  await service.applyOverlay("panel-a", "clock", { level: 55 });
  await ui.openSceneSettings("panel-a", "clock");
  assert.equal(ui.isSceneSettingOverridden("level"), true);
  release();
  await reload;
  assert.equal(ui.isSceneSettingOverridden("level"), true);
  assert.equal(ui.sceneSettingsForm.level, 55);
});

test("clear, close and reopen before the clear returns shows the cleared values", async () => {
  const { server, service } = fixture();
  await service.applyOverlay("panel-a", "clock", { level: 30 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { ui } = await loadUi(server, {
    fetch: async (url, options) => {
      if (url === "/api/scene-settings/overlay/clear") await gate; // clear POST in flight
      const response = await request(server, url, options ? JSON.parse(options.body) : undefined);
      return { ok: response.status === 200, json: async () => JSON.parse(response.body) };
    },
  });
  await ui.openSceneSettings("panel-a", "clock");
  assert.equal(ui.sceneSettingsForm.level, 30);
  const clearing = ui.clearSceneOverlay();
  ui.closeSceneSettings();
  await ui.openSceneSettings("panel-a", "clock"); // still sees the overlay: the clear has not run yet
  release();
  await clearing;
  assert.equal(ui.isSceneSettingOverridden("level"), false);
  assert.equal(ui.sceneSettingsForm.level, 5); // saved value of panel-a, not the stale 30
});

test("a full reload landing inside the save lag leaves the open form and its baseline alone", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "pixd-p55-lag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, server } = fixture();
  for (const d of config.devices) Object.assign(d, { type: "pixoo", ip: "127.0.0.1" });
  server.configPath = join(root, "config.json");
  await writeFile(server.configPath, JSON.stringify(config)); // running config never reloads in this test: the lag
  const { ui } = await loadUi(server);
  await ui.openSceneSettings("panel-a", "clock");
  ui.sceneSettingsForm.level = 7;
  ui.editSceneSetting("level");
  ui.resetSceneSetting("enabled");
  await ui.saveSceneSettings();
  await ui.reloadUiState(); // e.g. a live-preview POST completing now: the server still serves the old saved values
  assert.equal(ui.sceneSettingsForm.level, 7);
  assert.equal(ui.sceneSettingsForm.enabled, true); // the reset (schema default) stays
  assert.equal(ui.isSceneSettingsDirty(), false);
});

test("opening the modal shows the server's normalized values", async () => {
  const { config, server } = fixture();
  config.devices[0].sceneSettings.clock.level = "50"; // persisted as a string
  const { ui } = await loadUi(server);
  await ui.openSceneSettings("panel-a", "clock");
  assert.equal(ui.sceneSettingsForm.level, 50);
});

test("save, clear inside the lag, reopen while the clear reload is pending: the cleared value shows", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "pixd-p55-r11-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, server, service } = fixture();
  for (const d of config.devices) Object.assign(d, { type: "pixoo", ip: "127.0.0.1" });
  server.configPath = join(root, "config.json");
  await writeFile(server.configPath, JSON.stringify(config)); // running config never reloads: the lag
  await service.applyOverlay("panel-a", "clock", { level: 30 });
  let release;
  let holdNextGet = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const { ui } = await loadUi(server, {
    fetch: async (url, options) => {
      const response = await request(server, url, options ? JSON.parse(options.body) : undefined);
      if (url === "/api/scene-settings" && holdNextGet) { holdNextGet = false; await gate; }
      return { ok: response.status === 200, json: async () => JSON.parse(response.body) };
    },
  });
  await ui.openSceneSettings("panel-a", "clock");
  ui.resetSceneSetting("enabled");
  await ui.saveSceneSettings(); // persisted { level: 5 }; the server keeps serving { level: 5, enabled: false }
  holdNextGet = true; // the clear's reload GET stalls
  const clearing = ui.clearSceneOverlay();
  await new Promise((resolve) => setImmediate(resolve));
  ui.closeSceneSettings();
  await ui.openSceneSettings("panel-a", "clock"); // supersedes the stalled reload
  release();
  await clearing;
  assert.equal(ui.isSceneSettingOverridden("level"), false);
  assert.equal(ui.sceneSettingsForm.level, 5);
});

test("after a save the page keeps the server-normalised values, also through clear and a lagging reopen", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "pixd-p55-r12-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, server, service } = fixture();
  for (const d of config.devices) Object.assign(d, { type: "pixoo", ip: "127.0.0.1" });
  config.devices[0].sceneSettings.clock.level = 150; // persisted out of range (max 100)
  server.configPath = join(root, "config.json");
  await writeFile(server.configPath, JSON.stringify(config));
  await service.applyOverlay("panel-a", "clock", { level: 30 });
  let release;
  let holdNextGet = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const { ui } = await loadUi(server, {
    fetch: async (url, options) => {
      const response = await request(server, url, options ? JSON.parse(options.body) : undefined);
      if (url === "/api/scene-settings" && holdNextGet) { holdNextGet = false; await gate; }
      return { ok: response.status === 200, json: async () => JSON.parse(response.body) };
    },
  });
  await ui.openSceneSettings("panel-a", "clock");
  ui.resetSceneSetting("enabled");
  await ui.saveSceneSettings();
  assert.deepEqual(plain(ui._sceneSettingsSaved), { level: 100 }); // the server clamped it
  holdNextGet = true;
  const clearing = ui.clearSceneOverlay();
  await new Promise((resolve) => setImmediate(resolve));
  ui.closeSceneSettings();
  await ui.openSceneSettings("panel-a", "clock");
  release();
  await clearing;
  assert.equal(ui.isSceneSettingOverridden("level"), false);
  assert.equal(ui.sceneSettingsForm.level, 100);
});

test("the save response carries the normalised persisted values", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "pixd-p55-ack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, server } = fixture();
  for (const d of config.devices) Object.assign(d, { type: "pixoo", ip: "127.0.0.1" });
  server.configPath = join(root, "config.json");
  await writeFile(server.configPath, JSON.stringify(config));
  const res = await request(server, "/api/scene-settings/save", { deviceName: "panel-a", sceneName: "clock", values: { level: "150", enabled: "false" } });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, saved: { enabled: false, level: 100 } });
});
