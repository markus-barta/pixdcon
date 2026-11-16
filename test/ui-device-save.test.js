import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs, { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { ConfigLoader } from "../lib/config-loader.js";
import { ConfigOverlay } from "../lib/config-overlay.js";
import { ConfigWatcher } from "../lib/config-watcher.js";
import { WebServer } from "../lib/web-server.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const plain = (value) => JSON.parse(JSON.stringify(value));
const alpineSource = await readFile(createRequire(import.meta.url).resolve("alpinejs/dist/cdn.js"), "utf8");

async function request(server, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.url = url;
  req.method = body === undefined ? "GET" : "POST";
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
  await server._handle(req, res);
  return res;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pixd75-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  const file = {
    devices: [
      { name: "panel-a", type: "pixoo", ip: "file-a", scene: "home", comment: "original" },
      { name: "panel-b", type: "pixoo", ip: "file-b", scene: "home" },
      { name: "disabled", type: "ulanzi", ip: "file-c", enabled: false },
      { name: "filtered", type: "pixoo", ip: "file-d", scene: "home" },
    ],
    scenes: { home: { path: "./home.js" }, funkeykid: { path: "./funkeykid.js" } },
  };
  await writeFile(configPath, JSON.stringify(file));
  const published = [];
  const mqtt = {
    connected: true, client: new EventEmitter(),
    subscribeWildcard() {}, unsubscribeWildcard() {},
    publish(...args) { published.push(args.slice(0, 3)); args[3]?.(); return true; },
  };
  const overlay = new ConfigOverlay(mqtt, "base", () => {}, { logger, settleMs: 0 });
  await overlay.subscribe();
  t.after(() => overlay.unsubscribe());
  for (const [name, field, payload] of [
    ["panel-a", "scene", "builtin:clock"], ["panel-a", "ip", "overlay-a"],
    ["panel-b", "scene", "builtin:clock"], ["filtered", "enabled", "false"],
  ]) overlay._handleGranular(`base/overlay/device/${name}/${field}`, payload, { retain: true });
  overlay._handleBlob(JSON.stringify({ devices: [
    { name: "panel-a", scene: "builtin:clock", comment: "overlay comment", sceneSettings: { home: { level: 42 } } },
    { name: "panel-b", scene: "home", comment: "sibling" },
  ], scenes: { home: { path: "./overlaid.js" } } }), { retain: true });
  const loader = new ConfigLoader(configPath);
  let effective = loader.parse(JSON.stringify(overlay.merge(file)));
  const loops = () => effective.devices.map((device) => ({ device, loop: {
    scene: device.scene,
    setScene(scene) { this.scene = scene; },
    getStatus() { return { scene: this.scene, consecutiveErrors: 0 }; },
  } }));
  const server = new WebServer({ configPath, configOverlay: overlay, mqttService: mqtt,
    getEffectiveConfig: () => effective, getRenderLoops: loops, logger });
  return { root, file, configPath, server, overlay, mqtt, published,
    reload(content) { effective = loader.parse(JSON.stringify(overlay.merge(loader.parse(content)))); },
  };
}

async function loadUi(server, globals = {}) {
  const page = await request(server, "/");
  const ui = runInNewContext(page.body.match(/<script>([\s\S]*?)<\/script>/)[1] + "; app();", {
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => {
      const res = await request(server, url, options ? JSON.parse(options.body) : undefined);
      return { ok: res.status === 200, json: async () => JSON.parse(res.body) };
    },
    ...globals,
  });
  ui.fetchPreviews = async () => {};
  await ui.reloadUiState();
  return { ui, html: page.body };
}

test("PIXD-75: UI scene selection survives the file-triggered overlay reload", async (t) => {
  const { configPath, server, overlay, published, reload } = await fixture(t);
  let reloaded;
  const completed = new Promise((resolve) => { reloaded = resolve; });
  const watcher = new ConfigWatcher(configPath, (content) => { reload(content); reloaded(); }, { logger });
  await watcher.start();
  t.after(() => watcher.stop());
  const result = await request(server, "/api/scene", { deviceName: "panel-a", scene: "funkeykid" });
  assert.equal(result.status, 200);
  await Promise.race([completed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("config reload did not arrive")), 2500);
    timer.unref();
  })]);
  assert.equal(server.getRenderLoops().find((e) => e.device.name === "panel-a").loop.scene, "funkeykid");
  assert.deepEqual(overlay.getOverlay().devicePatches.get("panel-a"), { ip: "overlay-a" });
  assert.equal(overlay.getOverlay().devicePatches.get("panel-b").scene, "builtin:clock");
  assert.deepEqual(overlay.getOverlay().blob.devices[0], { name: "panel-a", comment: "overlay comment", sceneSettings: { home: { level: 42 } } });
  assert.deepEqual(overlay.getOverlay().blob.devices[1], { name: "panel-b", scene: "home", comment: "sibling" });
  assert.ok(published.some(([topic, payload, retain]) => topic === "overlay/device/panel-a/scene" && payload === "" && retain));
  assert.ok(!published.some(([topic]) => topic === "overlay/device/panel-b/scene"));
});

for (const dialog of [false, true]) {
  test(`PIXD-75: ${dialog ? "dialog" : "card"} Save patches only edited file fields with overlays and hidden devices`, async (t) => {
    const { file, configPath, server } = await fixture(t);
    const { ui } = await loadUi(server);
    ui.config.devices[1].displayName = "unsaved sibling edit";
    if (dialog) {
      ui.openDeviceSettings("panel-a");
      ui.deviceSettingsForm.displayName = "My Panel";
      await ui.saveDeviceSettings();
    } else {
      ui.config.devices[0].displayName = "My Panel";
      await ui.saveToFile("panel-a");
    }
    const expected = plain(file);
    expected.devices[0].displayName = "My Panel";
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), expected);
  });
}

test("card dropdowns select late optgroup options on load, refreshScenes and status updates", async (t) => {
  const { server, overlay, reload, configPath } = await fixture(t);
  overlay._handleGranular("base/overlay/device/panel-a/scene", "funkeykid", { retain: false });
  reload(await readFile(configPath, "utf8"));
  // The card initially has custom scenes, but built-ins arrive via refreshScenes.
  const { ui, html } = await loadUi(server);
  ui.init = () => {};
  const dom = new JSDOM('<main x-data="app()"></main>', { runScripts: "outside-only" });
  t.after(() => {
    dom.window.Alpine?.stopObservingMutations();
    dom.window.Alpine?.destroyTree(root);
    dom.window.close();
  });
  const page = new JSDOM(html);
  t.after(() => page.window.close());
  const template = page.window.document.querySelector('template[x-for="device in config?.devices"]');
  const card = page.window.document.createElement("section");
  card.setAttribute(":data-device", "device.name");
  card.append(template.content.querySelector('select[x-model="device.scene"]').cloneNode(true));
  template.content.replaceChildren(card);
  const root = dom.window.document.querySelector("main");
  root.append(dom.window.document.importNode(template, true));
  dom.window.app = () => ui;
  dom.window.eval(alpineSource);
  await delay(0); // Alpine auto-start, x-model, then nested x-for options.
  const app = dom.window.Alpine.$data(root);
  const selected = () => [...root.querySelectorAll("section")].map((el) => [el.dataset.device, el.querySelector("select").value]);
  assert.equal(selected()[0][1], "funkeykid");
  await app.refreshScenes();
  await dom.window.Alpine.nextTick();
  assert.deepEqual(selected(), [["panel-a", "funkeykid"], ["panel-b", "builtin:clock"]]);
  // Re-create options beneath the existing optgroups without changing scenes.
  app.builtins = { pixoo: [], ulanzi: [] };
  await dom.window.Alpine.nextTick();
  await app.refreshScenes();
  await dom.window.Alpine.nextTick();
  assert.deepEqual(selected(), [["panel-a", "funkeykid"], ["panel-b", "builtin:clock"]]);
  app.config.devices.reverse();
  app._syncDeviceScenes({ "panel-a": "builtin:clock", "panel-b": "home" });
  await dom.window.Alpine.nextTick();
  assert.deepEqual(selected(), [["panel-b", "home"], ["panel-a", "builtin:clock"]]);
});

test("status polling maps current scenes by device name across reorder and partial reloads", async (t) => {
  const { server } = await fixture(t);
  const { ui } = await loadUi(server);
  ui.config.devices.reverse();
  const entry = (name, scene) => ({ device: { name }, loop: { scene, getStatus: () => ({ consecutiveErrors: 0 }) } });
  server.getRenderLoops = () => [entry("panel-a", "funkeykid"), entry("panel-b", "builtin:clock")];
  await ui.fetchStatus();
  assert.deepEqual(plain(ui.config.devices.map((d) => [d.name, d.scene])), [["panel-b", "builtin:clock"], ["panel-a", "funkeykid"]]);
  assert.equal(ui.isDeviceDirty("panel-a"), false); // a runtime update is not a file edit
  server.getRenderLoops = () => [entry("panel-b", null)];
  await ui.fetchStatus();
  assert.equal(ui.config.devices.find((d) => d.name === "panel-a").scene, "funkeykid");
  assert.equal(ui.config.devices.find((d) => d.name === "panel-b").scene, null);
});

test("a status response issued before a scene choice cannot revert that choice", async (t) => {
  const { server } = await fixture(t);
  let release;
  const { ui } = await loadUi(server, {
    fetch: async (url, options) => {
      const res = await request(server, url, options ? JSON.parse(options.body) : undefined);
      const response = { ok: res.status === 200, json: async () => JSON.parse(res.body) };
      if (url === "/api/status") return new Promise((resolve) => { release = () => resolve(response); });
      return response;
    },
  });
  const polling = ui.fetchStatus();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await ui.changeScene("panel-a", "funkeykid");
  release();
  await polling;
  assert.equal(ui.config.devices.find((d) => d.name === "panel-a").scene, "funkeykid");
  assert.equal(ui.config.devices.find((d) => d.name === "panel-b").scene, "builtin:clock");
});

test("device patches merge against the latest file and preserve sibling preview fields", async (t) => {
  const { file, server, configPath } = await fixture(t);
  file.devices[0].comment = "changed outside this browser";
  file.devices[0].preview = { showGrid: false, pollMs: 5000, extra: "keep" };
  await writeFile(configPath, JSON.stringify(file));
  const replies = await Promise.all([
    request(server, "/api/device/save", { deviceName: "panel-a", patch: { preview: { showGrid: true } } }),
    request(server, "/api/device/save", { deviceName: "panel-a", patch: { displayName: "My Panel" } }),
  ]);
  assert.ok(replies.every((r) => r.status === 200));
  file.devices[0].displayName = "My Panel";
  file.devices[0].preview.showGrid = true;
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), file);
});

test("scene patches through device Save also clear just that device's scene overlay", async (t) => {
  const { server, overlay, configPath, reload } = await fixture(t);
  const res = await request(server, "/api/device/save", { deviceName: "panel-a", patch: { scene: null } });
  assert.equal(res.status, 200);
  reload(await readFile(configPath, "utf8"));
  assert.equal(server.getEffectiveConfig().devices[0].scene, null);
  assert.deepEqual(overlay.getOverlay().devicePatches.get("panel-a"), { ip: "overlay-a" });
  assert.equal(overlay.getOverlay().devicePatches.get("panel-b").scene, "builtin:clock");
});

test("clearing a scene also removes its legacy blob scenes array", async (t) => {
  const { server, overlay, configPath, reload } = await fixture(t);
  overlay._blobPatch.devices[0].scenes = ["builtin:clock"];
  const res = await request(server, "/api/scene", { deviceName: "panel-a", scene: null });
  assert.equal(res.status, 200);
  reload(await readFile(configPath, "utf8"));
  assert.equal(server.getEffectiveConfig().devices[0].scene, null);
  assert.equal(overlay.getOverlay().blob.devices[0].scenes, undefined);
});

test("a delayed self-echo of a blob cannot resurrect another device's later-cleared scene", async (t) => {
  const { overlay, published } = await fixture(t);
  overlay.clearDeviceScene("panel-a", "funkeykid");
  const firstBlob = published.find(([topic]) => topic === "overlay/blob")[1];
  overlay.clearDeviceScene("panel-b", "funkeykid");
  overlay._handleBlob(firstBlob, { retain: false });
  assert.equal(overlay.getOverlay().blob.devices[0].scene, undefined);
  assert.equal(overlay.getOverlay().blob.devices[1].scene, undefined);
  assert.equal(overlay.getOverlay().blob.devices[1].comment, "sibling");
});

test("synchronous publish echoes do not recursively resend the clear", async (t) => {
  const { overlay, mqtt } = await fixture(t);
  let sends = 0;
  mqtt.publish = (topic, payload, _retain, onComplete) => {
    assert.ok(++sends <= 2);
    if (topic === "overlay/blob") overlay._handleBlob(payload, { retain: false });
    else overlay._handleGranular(`base/${topic}`, payload, { retain: false });
    onComplete();
    return true;
  };
  overlay.clearDeviceScene("panel-a", "funkeykid");
  assert.equal(sends, 2);
  assert.equal(overlay.getOverlay().blob.devices[0].scene, undefined);
  assert.equal(overlay._pendingSceneClears.size, 0);
});

test("empty retained clears and unchanged blob echoes cause no overlay reload", async (t) => {
  const { overlay, mqtt } = await fixture(t);
  await delay(350); // Finish the initial retained burst's debounce.
  let reloads = 0;
  overlay._onChange = () => { reloads++; };
  overlay._debounceMs = 5;
  mqtt.publish = (topic, payload, _retain, onComplete) => {
    if (topic === "overlay/blob") overlay._handleBlob(payload, { retain: false });
    else overlay._handleGranular(`base/${topic}`, payload, { retain: false });
    onComplete();
    return true;
  };
  overlay.clearDeviceScene("panel-a", "funkeykid");
  overlay._handleGranular("base/overlay/device/unknown/scene", "", { retain: true });
  overlay._handleGranular("base/overlay/scene/unknown/path", "", { retain: true });
  await delay(25);
  assert.equal(reloads, 0);
  // A real clear still reloads, once. Its repeated delivery removes nothing.
  overlay._handleGranular("base/overlay/device/panel-b/scene", "", { retain: false });
  await delay(25);
  assert.equal(reloads, 1);
  overlay._handleGranular("base/overlay/device/panel-b/scene", "", { retain: false });
  await delay(25);
  assert.equal(reloads, 1);
  overlay._handleBlob("", { retain: false });
  await delay(25);
  assert.equal(reloads, 2);
  overlay._handleBlob("", { retain: true });
  await delay(25);
  assert.equal(reloads, 2);
});

test("the granular clear echo releases its guard while a pending blob clear still blocks stale replay", async (t) => {
  const { overlay, published } = await fixture(t);
  overlay.clearDeviceScene("panel-a", "funkeykid");
  overlay._handleGranular("base/overlay/device/panel-a/scene", "builtin:clock", { retain: true });
  assert.equal(overlay.getOverlay().devicePatches.get("panel-a").scene, undefined);
  overlay._handleGranular("base/overlay/device/panel-a/scene", "", { retain: false });
  overlay._handleGranular("base/overlay/device/panel-a/scene", "home", { retain: true });
  assert.equal(overlay.getOverlay().devicePatches.get("panel-a").scene, "home");
  overlay._handleBlob(JSON.stringify({ devices: [{ name: "panel-a", scene: "builtin:clock" }] }), { retain: true });
  assert.equal(overlay.getOverlay().blob.devices[0].scene, undefined);
  const lastBlob = published.filter(([topic]) => topic === "overlay/blob").at(-1)[1];
  overlay._handleBlob(lastBlob, { retain: false });
  overlay._handleBlob(JSON.stringify({ devices: [{ name: "panel-a", scene: "home" }] }), { retain: true });
  assert.equal(overlay.getOverlay().blob.devices[0].scene, "home");
});

test("invalid or missing-file device saves cannot persist the effective snapshot", async (t) => {
  const { server, configPath, root } = await fixture(t);
  const before = await readFile(configPath, "utf8");
  for (const patch of [{ name: "renamed" }, { scene: 42 }, { ip: "" }, { preview: { pollMs: 10 } }, { enabled: "false" }]) {
    const res = await request(server, "/api/device/save", { deviceName: "panel-a", patch });
    assert.equal(res.status, 400);
    assert.equal(await readFile(configPath, "utf8"), before);
  }
  const unknown = await request(server, "/api/device/save", { deviceName: "not-in-file", patch: { displayName: "New" } });
  assert.equal(unknown.status, 404);
  server.configPath = join(root, "missing.json");
  const missing = await request(server, "/api/device/save", { deviceName: "panel-a", patch: { displayName: "New" } });
  assert.equal(missing.status, 500);
  assert.deepEqual(await readdir(root), ["config.json"]);
});

test("device patches and scene choices preserve the watched inode without staging files", async (t) => {
  const { file, root, configPath, server } = await fixture(t);
  const before = await stat(configPath);
  for (const [route, body] of [
    ["/api/device/save", { deviceName: "panel-a", patch: { displayName: "My Panel" } }],
    ["/api/scene", { deviceName: "panel-a", scene: "funkeykid" }],
  ]) {
    assert.equal((await request(server, route, body)).status, 200);
    const after = await stat(configPath);
    assert.deepEqual([after.ino, after.uid, after.gid, after.mode], [before.ino, before.uid, before.gid, before.mode]);
    assert.deepEqual(await readdir(root), ["config.json"]);
  }
  file.devices[0].displayName = "My Panel";
  file.devices[0].scene = "funkeykid";
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), file);
});

test("in-place saves follow config symlinks and preserve the target's inode, owner, group and mode", async (t) => {
  const { root, configPath, server } = await fixture(t);
  await chmod(configPath, 0o640);
  const originalUmask = process.umask(0o077);
  t.after(() => process.umask(originalUmask));
  const before = await stat(configPath);
  const link = join(root, "config-link.json");
  await symlink("config.json", link);
  server.configPath = link;
  const res = await request(server, "/api/device/save", { deviceName: "panel-a", patch: { displayName: "My Panel" } });
  assert.equal(res.status, 200);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).devices[0].displayName, "My Panel");
  const after = await stat(configPath);
  assert.equal(after.ino, before.ino);
  assert.deepEqual([after.uid, after.gid, after.mode], [before.uid, before.gid, before.mode]);
  assert.deepEqual((await readdir(root)).sort(), ["config-link.json", "config.json"]);
});

test("config saves require no write permission on the containing directory", async (t) => {
  const { root, configPath, server } = await fixture(t);
  const before = await stat(configPath);
  await chmod(root, 0o500);
  try {
    const res = await request(server, "/api/device/save", { deviceName: "panel-a", patch: { displayName: "My Panel" } });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).devices[0].displayName, "My Panel");
    assert.equal((await stat(configPath)).ino, before.ino);
    assert.deepEqual(await readdir(root), ["config.json"]);
  } finally {
    await chmod(root, 0o700);
  }
});

test("a refused config write leaves the file and scene overlay untouched", async (t) => {
  const { root, configPath, server, overlay, published } = await fixture(t);
  const before = await readFile(configPath, "utf8");
  t.mock.method(fs, "writeFile", async () => { throw Object.assign(new Error("write denied"), { code: "EACCES" }); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const res = await request(server, "/api/scene", { deviceName: "panel-a", scene: "funkeykid" });
  assert.equal(res.status, 500);
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal(overlay.getOverlay().devicePatches.get("panel-a").scene, "builtin:clock");
  assert.deepEqual(published, []);
  assert.deepEqual(await readdir(root), ["config.json"]);
});
