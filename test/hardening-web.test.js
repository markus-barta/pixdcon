import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { WebServer } from "../lib/web-server.js";

const logger = { info() {}, error() {}, warn() {} };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pixd49-hardening-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scenes/pixoo"), { recursive: true });
  await writeFile(join(root, "scenes/pixoo/home.js"), 'export default { name: "home", render() {} };\n');
  const config = {
    devices: [{ name: "screen", type: "pixoo", ip: "127.0.0.1", scene: "home" }],
    scenes: { home: { path: "./scenes/pixoo/home.js" } },
  };
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const server = new WebServer({ configPath, getEffectiveConfig: () => config, logger });
  return { root, config, configPath, server };
}

async function request(server, path, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  req.url = path;
  const res = {
    writeHead(status) { this.status = status; },
    end(data) { this.body = JSON.parse(data); },
  };
  await server._handle(req, res);
  return res;
}

for (const overwrite of [false, true]) {
  test(`${overwrite ? "detach" : "clone"} validates config before creating files and can retry`, async (t) => {
    const { root, config, configPath, server } = await fixture(t);
    const bad = JSON.parse(JSON.stringify(config));
    bad.devices[0].type = "unsupported";
    const before = JSON.stringify(bad);
    await writeFile(configPath, before);
    const body = { sceneName: "home", targetSceneKey: "copy", overwrite, targetPrettyName: "Detached" };
    const rejected = await request(server, "/api/scene/clone", body);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /Config would be invalid/);
    assert.equal(await readFile(configPath, "utf-8"), before);
    await assert.rejects(readdir(join(root, "generated-scenes")), { code: "ENOENT" });
    await writeFile(configPath, JSON.stringify(config));
    const retried = await request(server, "/api/scene/clone", body);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.sceneKey, overwrite ? "home" : "copy");
    assert.match(await readFile(join(root, retried.body.path), "utf-8"), /Detached/);
    assert.equal(JSON.parse(await readFile(configPath, "utf-8")).scenes[retried.body.sceneKey].path, retried.body.path);
  });
}

test("rejected detach leaves an existing generated scene unchanged", async (t) => {
  const { root, config, configPath, server } = await fixture(t);
  const detached = await server._cloneScene({ sceneName: "home", overwrite: true });
  const original = await readFile(join(root, detached.path), "utf-8");
  const bad = JSON.parse(await readFile(configPath, "utf-8"));
  config.scenes.home.path = detached.path;
  bad.devices[0].ip = "";
  await writeFile(configPath, JSON.stringify(bad));
  await assert.rejects(server._cloneScene({ sceneName: "home", overwrite: true, targetPrettyName: "Must not appear" }), { statusCode: 400 });
  assert.equal(await readFile(join(root, detached.path), "utf-8"), original);
  assert.equal((await readdir(join(root, "generated-scenes/_backups"))).length, 1);
});

test("unparseable config permits live scene changes and reports persisted false", async (t) => {
  const { config, configPath, server } = await fixture(t);
  const warnings = [];
  const selected = [];
  server.logger = { ...logger, warn: (message) => warnings.push(message) };
  server.getRenderLoops = () => [{ device: config.devices[0], loop: { setScene: (scene) => selected.push(scene) } }];
  await writeFile(configPath, "{");
  for (const scene of ["other", null]) {
    const res = await request(server, "/api/scene", { deviceName: "screen", scene });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, persisted: false });
    assert.equal(config.devices[0].scene, scene);
  }
  assert.deepEqual(selected, ["other", null]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /without persistence/);
  assert.equal(await readFile(configPath, "utf-8"), "{");
  await writeFile(configPath, JSON.stringify(config));
  const repaired = await request(server, "/api/scene", { deviceName: "screen", scene: "home" });
  assert.deepEqual(repaired.body, { ok: true });
  assert.equal(JSON.parse(await readFile(configPath, "utf-8")).devices[0].scene, "home");
});

test("malformed config does not let invalid scene inputs reach the live loop", async (t) => {
  const { config, configPath, server } = await fixture(t);
  const selected = [];
  server.getRenderLoops = () => [{ device: config.devices[0], loop: { setScene: (scene) => selected.push(scene) } }];
  await writeFile(configPath, "{");
  for (const scene of [123, {}, []]) {
    const res = await request(server, "/api/scene", { deviceName: "screen", scene });
    assert.equal(res.status, 400);
  }
  assert.deepEqual(selected, []);
  assert.equal(config.devices[0].scene, "home");
});

function fakeHttp(t, failures = 0, synchronous = false) {
  const fake = new EventEmitter();
  const errors = [];
  const logs = [];
  const scheduled = new Set();
  fake.calls = 0;
  fake.listening = false;
  fake.listen = (_port, _host) => {
    fake.calls++;
    if (fake.calls <= failures) {
      const error = Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
      if (synchronous) throw error;
      fake.emit("error", error);
    } else {
      fake.listening = true;
      fake.emit("listening");
    }
    return fake;
  };
  fake.close = () => { fake.listening = false; };
  t.mock.method(http, "createServer", () => fake);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, "setTimeout", (cb, delay) => {
    const timer = { delay, cb: () => { scheduled.delete(timer); cb(); }, unref() {} };
    scheduled.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => scheduled.delete(timer));
  const server = new WebServer({ logger: {
    info: (message) => logs.push(message), error: (message) => errors.push(message),
  } });
  t.after(() => server.stop());
  return { server, fake, scheduled, errors, logs };
}

test("listen failures retry every 30 seconds until the HTTP server binds", (t) => {
  const { server, fake, scheduled, errors, logs } = fakeHttp(t, 2);
  server.start();
  server.start();
  assert.equal(fake.calls, 1);
  fake.emit("error", new Error("same failed listener"));
  assert.equal(scheduled.size, 1);
  for (let retry = 0; retry < 2; retry++) {
    const timer = [...scheduled][0];
    assert.equal(timer.delay, 30000);
    timer.cb();
  }
  assert.equal(fake.calls, 3);
  assert.equal(fake.listening, true);
  assert.equal(scheduled.size, 0);
  assert.equal(server._listenRetryTimer, null);
  assert.equal(errors.length, 3);
  assert.equal(logs.length, 1);
  assert.equal(fake.listenerCount("listening"), 1);
  fake.emit("error", new Error("request socket error"));
  assert.equal(scheduled.size, 0);
});

test("stop cancels a pending retry and a late callback cannot restart listening", (t) => {
  const { server, fake, scheduled } = fakeHttp(t, 1);
  server.start();
  const timer = [...scheduled][0];
  server.stop();
  assert.equal(scheduled.size, 0);
  timer.cb();
  assert.equal(fake.calls, 1);
  assert.equal(server._server, null);
});

test("synchronous listen failures follow the same retry path", (t) => {
  const { server, fake, scheduled } = fakeHttp(t, 1, true);
  assert.doesNotThrow(() => server.start());
  [...scheduled][0].cb();
  assert.equal(fake.calls, 2);
  assert.equal(fake.listening, true);
  assert.equal(scheduled.size, 0);
});
