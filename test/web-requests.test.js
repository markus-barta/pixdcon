import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { WebServer } from "../lib/web-server.js";
import { ConfigLoader } from "../lib/config-loader.js";

const logger = { error() {} };

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pixd47-web-requests-"));
  const config = {
    devices: [{ name: "pixoo-01", type: "pixoo", ip: "127.0.0.1", scene: "home" }],
    scenes: { home: { path: "./scenes/pixoo/home.js" } },
  };
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const server = new WebServer({ configPath, getEffectiveConfig: () => config, logger, ...options });
  return { root, config, configPath, server };
}

async function request(server, path, body, method = "POST") {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  const req = Readable.from([payload]);
  req.url = path;
  req.method = method;
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(data) { this.body = data; },
  };
  await server._handle(req, res);
  return res;
}

test("every JSON POST route returns 400 for malformed JSON and non-object bodies", async () => {
  const { configPath, server } = await fixture();
  const original = await readFile(configPath, "utf-8");
  for (const path of [
    "/api/config/file", "/api/device", "/api/scene-settings/save",
    "/api/scene-settings/overlay", "/api/scene-settings/overlay/clear",
    "/api/scene/clone", "/api/overlay", "/api/overlay/clear", "/api/scene",
    "/api/mode", "/api/brightness",
  ]) {
    for (const body of ["{", "", "null", "[]", "42", '"string"']) {
      const res = await request(server, path, body);
      assert.equal(res.status, 400, `${path}: ${body}`);
      assert.equal(res.headers["Content-Type"], "application/json");
      assert.ok(JSON.parse(res.body).error);
    }
  }
  assert.equal(await readFile(configPath, "utf-8"), original);
});

test("request body ceiling counts bytes and rejects oversized requests with 413", async () => {
  const { configPath, server } = await fixture();
  const original = await readFile(configPath, "utf-8");
  const oversized = Buffer.from(JSON.stringify({ text: "é".repeat(600000) }));
  assert.ok(oversized.length > 1024 * 1024);
  const res = await request(server, "/api/config/file", oversized);
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error, /too large/);
  assert.equal(await readFile(configPath, "utf-8"), original);
  const exact = await server._body(Readable.from([Buffer.alloc(1024 * 1024, "x")]));
  assert.equal(Buffer.byteLength(exact), 1024 * 1024);
  assert.equal((await request(server, "/api/previews", null, "GET")).status, 200);
});

test("aborted and errored request streams reject instead of hanging", async () => {
  const server = new WebServer();
  const aborted = new EventEmitter();
  const abortedBody = server._body(aborted);
  const checkedAbort = assert.rejects(abortedBody, { statusCode: 400, message: "Request aborted" });
  aborted.emit("data", Buffer.from("partial"));
  aborted.emit("aborted");
  await checkedAbort;
  const errored = new EventEmitter();
  const erroredBody = server._body(errored);
  const checkedError = assert.rejects(erroredBody, /stream failed/);
  errored.emit("error", new Error("stream failed"));
  await checkedError;
});

test("invalid URL, unknown routes and unsupported methods have controlled responses", async () => {
  const { configPath, server } = await fixture();
  const original = await readFile(configPath, "utf-8");
  assert.equal((await request(server, "http://[", null, "GET")).status, 400);
  for (const [path, method] of [["/missing", "GET"], ["/api/previews", "POST"], ["/api/device", "GET"], ["/api/config/file", "PUT"]]) {
    const res = await request(server, path, "{}", method);
    assert.equal(res.status, 404);
    assert.equal(res.body, "Not found");
  }
  assert.equal(await readFile(configPath, "utf-8"), original);
});

test("a device without a frame is omitted from previews without failing the endpoint", async () => {
  const previews = { "pixoo-01": { width: 64, height: 64, data: "AA==", updatedAt: "2026-10-08T18:00:00Z" } };
  const { server } = await fixture({ getFramePreviews: () => previews });
  const res = await request(server, "/api/previews", null, "GET");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), previews);
  assert.equal(JSON.parse(res.body)["no-frame-device"], undefined);
  const emptyServer = new WebServer({ logger });
  assert.deepEqual(JSON.parse((await request(emptyServer, "/api/previews", null, "GET")).body), {});
});

test("invalid config cannot overwrite the working file, but a valid save repairs bad disk JSON", async () => {
  const { config, configPath, server } = await fixture();
  const original = await readFile(configPath, "utf-8");
  for (const invalid of [{}, { devices: [], scenes: null }, { devices: [{ name: "bad", type: "other", ip: "127.0.0.1" }], scenes: {} }]) {
    const res = await request(server, "/api/config/file", JSON.stringify(invalid));
    assert.equal(res.status, 400);
    assert.equal(await readFile(configPath, "utf-8"), original);
  }
  await writeFile(configPath, "{");
  const valid = await request(server, "/api/config/file", JSON.stringify(config));
  assert.equal(valid.status, 200);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf-8")), config);
});

test("concurrent device additions use latest persisted state and preserve the watched inode", async () => {
  const { configPath, server } = await fixture();
  const before = await stat(configPath);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    request(server, "/api/device", JSON.stringify({ name: `new-${i}`, type: "ulanzi", ip: "127.0.0.1" })),
  ));
  assert.ok(responses.every((res) => res.status === 200));
  const saved = JSON.parse(await readFile(configPath, "utf-8"));
  assert.equal(saved.devices.length, 9);
  assert.equal(new Set(saved.devices.map((d) => d.name)).size, 9);
  assert.equal((await stat(configPath)).ino, before.ino);
  const collisions = await Promise.all([
    request(server, "/api/device", JSON.stringify({ name: "same", type: "pixoo", ip: "127.0.0.1" })),
    request(server, "/api/device", JSON.stringify({ name: "same", type: "pixoo", ip: "127.0.0.1" })),
  ]);
  assert.deepEqual(collisions.map((res) => res.status).sort(), [200, 409]);
  assert.equal((await request(server, "/api/device", JSON.stringify({ name: "after-conflict", type: "pixoo", ip: "127.0.0.1" }))).status, 200);
});

test("device fields reject non-string names and addresses without persisting them", async () => {
  const { configPath, server } = await fixture();
  const original = await readFile(configPath, "utf-8");
  for (const fields of [{ name: {}, ip: "127.0.0.1" }, { name: " ", ip: "127.0.0.1" }, { name: "new", ip: [] }]) {
    assert.equal((await request(server, "/api/device", JSON.stringify({ type: "pixoo", ...fields }))).status, 400);
  }
  assert.equal(await readFile(configPath, "utf-8"), original);
});

test("concurrent settings saves preserve independent scenes before the effective config reloads", async () => {
  const { configPath, server } = await fixture({
    getSceneMetadata: () => ({ home: { settingsSchema: { level: { type: "int", min: 0, max: 100 } } }, other: { settingsSchema: { enabled: { type: "boolean" } } } }),
  });
  const responses = await Promise.all([
    request(server, "/api/scene-settings/save", JSON.stringify({ deviceName: "pixoo-01", sceneName: "home", values: { level: "150" } })),
    request(server, "/api/scene-settings/save", JSON.stringify({ deviceName: "pixoo-01", sceneName: "other", values: { enabled: "true" } })),
  ]);
  assert.ok(responses.every((res) => res.status === 200));
  const saved = JSON.parse(await readFile(configPath, "utf-8"));
  assert.deepEqual(saved.devices[0].sceneSettings, { home: { level: 100 }, other: { enabled: true } });
  assert.equal((await request(server, "/api/scene-settings/save", JSON.stringify({ deviceName: "missing", sceneName: "home", values: {} }))).status, 404);
});

test("failed scene persistence leaves the live loop and effective config unchanged", async () => {
  let changed = false;
  const { root, config, server } = await fixture({
    getRenderLoops: () => [{ device: { name: "pixoo-01" }, loop: { setScene() { changed = true; } } }],
  });
  server.configPath = root;
  const res = await request(server, "/api/scene", JSON.stringify({ deviceName: "pixoo-01", scene: "other" }));
  assert.equal(res.status, 500);
  assert.equal(changed, false);
  assert.equal(config.devices[0].scene, "home");
});

test("successful scene selection persists and updates the live loop and config", async () => {
  let selected;
  const { config, configPath, server } = await fixture({
    getRenderLoops: () => [{ device: { name: "pixoo-01" }, loop: { setScene(scene) { selected = scene; } } }],
  });
  const res = await request(server, "/api/scene", JSON.stringify({ deviceName: "pixoo-01", scene: null }));
  assert.equal(res.status, 200);
  assert.equal(selected, null);
  assert.equal(config.devices[0].scene, null);
  assert.equal(JSON.parse(await readFile(configPath, "utf-8")).devices[0].scene, null);
});

test("clearing the scene of a legacy scenes-array device does not resurrect the old scene", async () => {
  const { configPath, server } = await fixture({
    getRenderLoops: () => [{ device: { name: "pixoo-01" }, loop: { setScene() {} } }],
  });
  await writeFile(configPath, JSON.stringify({
    devices: [{ name: "pixoo-01", type: "pixoo", ip: "127.0.0.1", scenes: ["home"] }],
    scenes: { home: { path: "./scenes/pixoo/home.js" } },
  }));
  const res = await request(server, "/api/scene", JSON.stringify({ deviceName: "pixoo-01", scene: null }));
  assert.equal(res.status, 200);
  const raw = await readFile(configPath, "utf-8");
  assert.equal(JSON.parse(raw).devices[0].scenes, undefined);
  assert.equal(new ConfigLoader(configPath).parse(raw).devices[0].scene, null);
});

test("an API write the loader would reject is refused and leaves the file untouched", async () => {
  const { configPath, server } = await fixture({
    getRenderLoops: () => [{ device: { name: "pixoo-01" }, loop: { setScene() {} } }],
  });
  const before = await readFile(configPath, "utf-8");
  const res = await request(server, "/api/scene", JSON.stringify({ deviceName: "pixoo-01", scene: 123 }));
  assert.equal(res.status, 400);
  assert.equal(await readFile(configPath, "utf-8"), before);
});

test("explicit saves still persist devices introduced by the effective overlay", async () => {
  const { config, configPath, server } = await fixture({
    getSceneMetadata: () => ({ home: { settingsSchema: { level: { type: "int" } } } }),
  });
  const effective = JSON.parse(JSON.stringify(config));
  const device = { name: "overlay-device", type: "pixoo", ip: "127.0.0.1", scene: "home" };
  effective.devices.push(device);
  server.getEffectiveConfig = () => effective;
  server.getRenderLoops = () => [{ device, loop: { setScene() {} } }];
  const duplicate = await request(server, "/api/device", JSON.stringify(device));
  assert.equal(duplicate.status, 409);
  const responses = await Promise.all([
    request(server, "/api/scene-settings/save", JSON.stringify({ deviceName: device.name, sceneName: "home", values: { level: 10 } })),
    request(server, "/api/scene", JSON.stringify({ deviceName: device.name, scene: "other" })),
  ]);
  assert.ok(responses.every((res) => res.status === 200));
  const saved = JSON.parse(await readFile(configPath, "utf-8"));
  const persisted = saved.devices.find((d) => d.name === device.name);
  assert.equal(persisted.scene, "other");
  assert.deepEqual(persisted.sceneSettings, { home: { level: 10 } });
});

test("clone errors preserve 400, 404 and 409 response codes", async () => {
  const { server } = await fixture();
  for (const [body, status] of [
    [{ sceneName: "home", targetSceneKey: "../escape" }, 400],
    [{ sceneName: "missing", targetSceneKey: "copy" }, 404],
    [{ sceneName: "home", targetSceneKey: "home" }, 409],
  ]) {
    const res = await request(server, "/api/scene/clone", JSON.stringify(body));
    assert.equal(res.status, status);
    assert.ok(JSON.parse(res.body).error);
  }
});

test("offline MQTT and missing settings service return 503 without crashing", async () => {
  const { server } = await fixture();
  for (const [path, body] of [
    ["/api/overlay", { deviceName: "pixoo-01", scene: "home" }],
    ["/api/overlay/clear", { deviceName: "pixoo-01" }],
    ["/api/mode", { deviceName: "pixoo-01", mode: "play" }],
    ["/api/brightness", { deviceName: "pixoo-01", enabled: false }],
    ["/api/scene-settings/overlay", { deviceName: "pixoo-01", sceneName: "home", values: {} }],
    ["/api/scene-settings/overlay/clear", { deviceName: "pixoo-01", sceneName: "home" }],
  ]) {
    assert.equal((await request(server, path, JSON.stringify(body))).status, 503);
  }
});

test("HTTP server errors are logged without becoming unhandled events", async (t) => {
  const errors = [];
  const server = new WebServer({ logger: { info() {}, error(message) { errors.push(message); } } });
  server.port = 0;
  t.after(() => server.stop());
  server.start();
  server._server.emit("error", new Error("simulated listen failure"));
  assert.ok(errors.some((message) => message.includes("simulated listen failure")));
  await new Promise((resolve) => setImmediate(resolve));
});
