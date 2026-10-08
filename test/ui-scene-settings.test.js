import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { SceneSettingsService } from "../lib/scene-settings-service.js";
import { WebServer } from "../lib/web-server.js";

const metadata = {
  clock: {
    settingsSchema: {
      enabled: { type: "boolean", label: "Enabled", default: true },
      level: { type: "int", label: "Level", default: 10, min: 0, max: 100 },
      text: { type: "string", label: "Text", default: "hello" },
      layout: { type: "json", label: "Layout", default: { rows: [1] } },
    },
  },
};

function fixture() {
  const config = {
    devices: [
      { name: "panel-a", type: "pixoo", ip: "127.0.0.1", scene: "clock",
        sceneSettings: { clock: { enabled: false, level: 0, text: "" }, other: { keep: true } } },
      { name: "panel-b", type: "pixoo", ip: "127.0.0.2", scene: "clock" },
    ],
    scenes: { clock: { path: "./clock.js" } },
  };
  const service = new SceneSettingsService({
    getConfig: () => config,
    getSceneMetadata: () => metadata,
  });
  const server = new WebServer({
    getEffectiveConfig: () => config,
    getSceneMetadata: () => metadata,
    getSceneSettingsState: () => service.getUiState(),
    logger: { error() {} },
  });
  return { config, service, server };
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

const plain = (value) => JSON.parse(JSON.stringify(value));

async function loadUi(server, globals = {}) {
  const res = await request(server, "/");
  assert.equal(res.status, 200);
  const script = res.body.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ui = runInNewContext(script + "; app();", {
    setTimeout: () => 1,
    clearTimeout() {},
    ...globals,
  });
  ui.config = server.getEffectiveConfig();
  ui.sceneMeta = server.getSceneMetadata();
  ui.sceneSettingsState = server.getSceneSettingsState();
  return { ui, html: res.body };
}

test("settings HTML binds provenance, per-field reset, and accessible controls", async () => {
  const { html } = await loadUi(fixture().server);
  const form = html.slice(html.indexOf("<!-- Scene settings modal -->"), html.indexOf("  <script>"));
  assert.match(form, /isSceneSettingDefault\(field.key\).*?0\.8/);
  assert.match(form, /x-show="isSceneSettingDefault\(field.key\)"[^>]*>default<\/span>/);
  assert.match(form, /x-show="isSceneSettingOverridden\(field.key\)"[^>]*>MQTT overlay<\/span>/);
  assert.match(form, /@click="resetSceneSetting\(field.key\)"/);
  assert.match(form, /@input="editSceneSetting\(field.key\)" @change="editSceneSetting\(field.key\)"/);
  assert.match(form, /:for="sceneFieldId\(field.key\)"/);
  const controls = [...form.matchAll(/<(?:input|select|textarea)\b[^>]*x-model="sceneSettings(?:Form|Json)\[field.key\]"[^>]*>/g)];
  assert.equal(controls.length, 7);
  for (const [control] of controls) {
    assert.match(control, /:id="sceneFieldId\(field.key\)"/);
    assert.match(control, /:aria-describedby=/);
  }
  assert.match(form, /:aria-label="'Reset ' \+ field.label \+ ' to default'"/);
  assert.match(form, /focus-visible:outline/);
  assert.match(form, /Reset to default takes effect on Save; MQTT overlays keep priority/);
});

test("scene settings API exposes separate saved, overlay, and effective maps per device", async () => {
  const { server, service } = fixture();
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/level", "25");
  service._handleOverlayMessage("pixdcon/panel-b/clock/settings/enabled", "false");
  const res = await request(server, "/api/scene-settings");
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(res.body), {
    "panel-a": { clock: {
      saved: { enabled: false, level: 0, text: "" },
      overlay: { level: 25 },
      effective: { enabled: false, level: 25, text: "", layout: { rows: [1] } },
    } },
    "panel-b": { clock: {
      saved: {},
      overlay: { enabled: false },
      effective: { enabled: false, level: 10, text: "hello", layout: { rows: [1] } },
    } },
  });
});

test("untouched defaults and overlays are omitted from saves, including false and zero values", async () => {
  const { server, service } = fixture();
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/level", "25");
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/layout", '{"rows":[2]}');
  const { ui } = await loadUi(server);
  ui.openSceneSettings("panel-a", "clock");
  assert.deepEqual(plain(ui.sceneSavedPayload()), { enabled: false, level: 0, text: "" });
  assert.equal(ui.isSceneSettingsDirty(), false);
  for (const key of ["enabled", "level", "text"]) assert.equal(ui.isSceneSettingDefault(key), false);
  assert.equal(ui.isSceneSettingDefault("layout"), true);
  assert.equal(ui.isSceneSettingOverridden("layout"), true);
  assert.equal(ui.isSceneSettingOverridden("level"), true);
  ui.openSceneSettings("panel-b", "clock");
  assert.deepEqual(plain(ui.sceneSavedPayload()), {});
  assert.equal(ui.isSceneSettingsDirty(), false);
  assert.equal(ui.isSceneSettingDefault("level"), true);
  assert.equal(ui.isSceneSettingOverridden("level"), false);
  ui.sceneSettingsState["panel-b"].clock.saved = { level: 10 };
  ui.openSceneSettings("panel-b", "clock");
  assert.equal(ui.isSceneSettingDefault("level"), false);
  assert.equal(ui.isSceneSettingsDirty(), false);
});

test("editing a default explicitly saves it even when it equals the default", async () => {
  const { ui } = await loadUi(fixture().server);
  ui.openSceneSettings("panel-b", "clock");
  ui.editSceneSetting("level");
  assert.equal(ui.isSceneSettingDefault("level"), false);
  assert.equal(ui.isSceneSettingsDirty(), true);
  assert.deepEqual(plain(ui.sceneSavedPayload()), { level: 10 });
  ui.sceneSettingsForm.enabled = false;
  ui.editSceneSetting("enabled");
  ui.sceneSettingsJson.layout = '{"rows":[3]}';
  ui.editSceneSetting("layout");
  assert.deepEqual(plain(ui.sceneSavedPayload()), { level: 10, enabled: false, layout: { rows: [3] } });
  ui.resetSceneSetting("layout");
  assert.deepEqual(JSON.parse(ui.sceneSettingsJson.layout), { rows: [1] });
  assert.equal(Object.hasOwn(ui.sceneSavedPayload(), "layout"), false);
});

test("per-field reset omits only that saved key and keeps an MQTT override visible", async () => {
  const { server, service } = fixture();
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/level", "25");
  const { ui } = await loadUi(server);
  ui.openSceneSettings("panel-a", "clock");
  ui.resetSceneSetting("enabled");
  assert.equal(ui.sceneSettingsForm.enabled, true);
  assert.equal(ui.isSceneSettingDefault("enabled"), true);
  ui.resetSceneSetting("level");
  assert.equal(ui.sceneSettingsForm.level, 25);
  assert.equal(ui.isSceneSettingDefault("level"), true);
  assert.equal(ui.isSceneSettingOverridden("level"), true);
  assert.deepEqual(plain(ui.sceneSavedPayload()), { text: "" });
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), { level: 25 });
  assert.equal(ui.isSceneSettingsDirty(), true);
  ui.sceneSettingsForm.level = 0;
  ui.editSceneSetting("level");
  assert.deepEqual(plain(ui.sceneSavedPayload()), { text: "", level: 0 });
  ui.openSceneSettings("panel-b", "clock");
  assert.equal(ui.isSceneSettingsDirty(), false);
  assert.deepEqual(plain(ui.sceneSavedPayload()), {});
});

test("automatic MQTT preview publishes edited fields without overlaying untouched defaults", async () => {
  const calls = [];
  const cancelled = [];
  const { ui } = await loadUi(fixture().server, {
    fetch: async (url, options) => { calls.push({ url, ...JSON.parse(options.body) }); },
    clearTimeout: (timer) => cancelled.push(timer),
  });
  ui.reloadUiState = async () => {};
  ui.mqttConnected = true;
  ui.openSceneSettings("panel-b", "clock");
  await ui._doAutoOverlay();
  assert.equal(calls.length, 0);
  ui.sceneSettingsForm.level = 15;
  ui.editSceneSetting("level");
  await ui._doAutoOverlay();
  assert.deepEqual(calls, [{ url: "/api/scene-settings/overlay", deviceName: "panel-b", sceneName: "clock", values: { level: 15 } }]);
  ui.resetSceneSetting("level");
  await ui._doAutoOverlay();
  assert.equal(calls.length, 1);
  ui._scheduleAutoOverlay();
  ui.openSceneSettings("panel-a", "clock");
  assert.equal(cancelled.at(-1), 1);
  ui._scheduleAutoOverlay();
  ui.closeSceneSettings();
  assert.equal(cancelled.at(-1), 1);
});

test("saving a field reset through the API preserves sibling settings, other scenes, devices and overlays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pixd-ui-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, server, service } = fixture();
  server.configPath = join(root, "config.json");
  await writeFile(server.configPath, JSON.stringify(config));
  service._handleOverlayMessage("pixdcon/panel-a/clock/settings/level", "25");
  const { ui } = await loadUi(server, {
    fetch: async (url, options) => {
      const res = await request(server, url, options ? JSON.parse(options.body) : undefined);
      return { json: async () => JSON.parse(res.body) };
    },
  });
  ui.openSceneSettings("panel-a", "clock");
  ui.resetSceneSetting("level");
  await ui.saveSceneSettings();
  const persisted = JSON.parse(await readFile(server.configPath, "utf-8"));
  assert.deepEqual(persisted.devices[0].sceneSettings, { clock: { enabled: false, text: "" }, other: { keep: true } });
  assert.deepEqual(persisted.devices[1], config.devices[1]);
  assert.deepEqual(service.getOverlayValues("panel-a", "clock"), { level: 25 });
  // The runtime snapshot deliberately still has the old saved key until hot reload.
  assert.equal(service.getSavedValues("panel-a", "clock").level, 0);
  assert.equal(ui.isSceneSettingDefault("level"), true);
  assert.equal(ui.isSceneSettingOverridden("level"), true);
  assert.equal(ui.sceneSettingsForm.level, 25);
  assert.equal(ui.isSceneSettingsDirty(), false);
  ui.openSceneSettings("panel-a", "clock");
  assert.equal(ui.isSceneSettingDefault("level"), true);
  ui.resetSceneSetting("enabled");
  await ui.saveSceneSettings();
  assert.equal(ui.sceneSettingsForm.enabled, true);
  assert.equal(ui.isSceneSettingDefault("enabled"), true);
  assert.equal(ui.isSceneSettingsDirty(), false);
  assert.deepEqual(JSON.parse(await readFile(server.configPath, "utf-8")).devices[0].sceneSettings.clock, { text: "" });
});

test("failed save retains the pending reset and reports an error", async () => {
  const { ui } = await loadUi(fixture().server, {
    fetch: async () => ({ json: async () => ({ error: "Cannot write config" }) }),
  });
  ui.openSceneSettings("panel-a", "clock");
  ui.resetSceneSetting("level");
  await ui.saveSceneSettings();
  assert.equal(ui.isSceneSettingsDirty(), true);
  assert.equal(Object.hasOwn(ui.sceneSavedPayload(), "level"), false);
  assert.equal(ui.message.type, "error");
  assert.equal(ui.message.text, "Cannot write config");
});

test("a save finishing after switching devices does not replace the new device's draft", async () => {
  let finishSave;
  const { server } = fixture();
  const { ui } = await loadUi(server, {
    fetch: (url) => url === "/api/scene-settings/save"
      ? new Promise((resolve) => { finishSave = resolve; })
      : request(server, url).then((res) => ({ json: async () => JSON.parse(res.body) })),
  });
  ui.openSceneSettings("panel-a", "clock");
  ui.resetSceneSetting("level");
  const saving = ui.saveSceneSettings();
  ui.openSceneSettings("panel-b", "clock");
  ui.sceneSettingsForm.level = 11;
  ui.editSceneSetting("level");
  finishSave({ json: async () => ({ ok: true }) });
  await saving;
  assert.equal(ui.currentSceneSettings.deviceName, "panel-b");
  assert.deepEqual(plain(ui.sceneSavedPayload()), { level: 11 });
  assert.equal(ui.isSceneSettingsDirty(), true);
  assert.equal(ui.sceneSettingsState["panel-a"].clock.effective.level, 10);
  assert.equal(Object.hasOwn(ui.sceneSettingsState["panel-a"].clock.saved, "level"), false);
});
