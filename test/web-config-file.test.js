import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { WebServer } from "../lib/web-server.js";

async function get(server, path) {
  const req = Readable.from([Buffer.alloc(0)]);
  req.url = path;
  req.method = "GET";
  const res = {
    writeHead(status) { this.status = status; },
    end(data) { this.body = data; },
  };
  await server._handle(req, res);
  return { status: res.status, json: JSON.parse(res.body) };
}

test("GET /api/config/file returns the persisted config normalized, without overlays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pixd-web-config-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    devices: [{ name: "pixoo-01", type: "pixoo", ip: "192.168.1.10", scenes: ["home"] }],
    scenes: { home: { path: "./scenes/pixoo/home.js" } },
  }));
  const effective = {
    devices: [{ name: "pixoo-01", type: "pixoo", ip: "192.168.1.99", scene: "home" }],
    scenes: { home: { path: "./scenes/pixoo/home.js" } },
  };
  const server = new WebServer({ configPath, getEffectiveConfig: () => effective, logger: { error() {} } });
  const res = await get(server, "/api/config/file");
  assert.equal(res.status, 200);
  assert.equal(res.json.devices[0].ip, "192.168.1.10"); // the file, not the overlay
  assert.equal(res.json.devices[0].scene, "home"); // normalized like the effective config
});

test("GET /api/config/file answers 409 when config.json is unparseable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pixd-web-config-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  await writeFile(configPath, "{ not json");
  const server = new WebServer({ configPath, getEffectiveConfig: () => ({ devices: [], scenes: {} }), logger: { error() {} } });
  const res = await get(server, "/api/config/file");
  assert.equal(res.status, 409);
  assert.match(res.json.error, /config\.json unreadable/);
});
