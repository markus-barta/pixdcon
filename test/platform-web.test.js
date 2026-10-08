import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { WebServer } from "../lib/web-server.js";
import { scheme, version } from "../lib/version.js";
import { renderVersion } from "../vendor/inspr-versioning/version.js";
import { attachVersionInteraction } from "../vendor/inspr-versioning/version-interaction.js";
import { validPresentation } from "../vendor/inspr-versioning/presentation.js";

async function request(path, method = "GET") {
  const server = new WebServer({ logger: { error() {} } });
  const req = { url: path, method };
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  await server._handle(req, res);
  return res;
}

test("status preserves existing fields and explicitly identifies the calendar version", async () => {
  const response = await request("/api/status");
  assert.equal(response.status, 200);
  const status = JSON.parse(response.body);
  assert.equal(status.version, version);
  assert.equal(status.version_scheme, scheme);
  assert.equal(status.mqttConnected, false);
  assert.deepEqual(status.deviceModes, {});
});

test("the read-only presentation route serves the exact pinned bytes with correct MIME types", async () => {
  for (const file of ["version.js", "presentation.js", "version-interaction.js", "display.json", "schemes.json", "LICENSE"]) {
    const response = await request(`/vendor/inspr-versioning/${file}`);
    assert.equal(response.status, 200, file);
    assert.deepEqual(response.body, await readFile(new URL(`../vendor/inspr-versioning/${file}`, import.meta.url)));
    const mime = file === "LICENSE" ? /text\/plain/ : file.endsWith(".js") ? /javascript/ : /application\/json/;
    assert.match(response.headers["Content-Type"], mime);
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(response.headers["Cache-Control"], "no-cache");
  }
});

test("presentation assets cannot expose arbitrary files or accept mutations", async () => {
  for (const path of [
    "/vendor/inspr-versioning/", "/vendor/inspr-versioning/package.json",
    "/vendor/inspr-versioning/manifest.json", "/vendor/inspr-versioning/../package.json",
    "/vendor/inspr-versioning/%2e%2e/package.json", "/vendor/inspr-versioning/%2e%2e%2fpackage.json",
    "/vendor/inspr-versioning/%76ersion.js", "/vendor/inspr-versioning/version.js/extra",
  ]) {
    assert.equal((await request(path)).status, 404, path);
  }
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    assert.equal((await request("/vendor/inspr-versioning/version.js", method)).status, 404);
  }
});

test("the header exposes the canonical fallback and one shared Pretty/SemVer adapter", async () => {
  const response = await request("/");
  assert.equal(response.status, 200);
  assert.ok(response.body.includes(`<span id="pixdcon-version">${version}</span>`));
  assert.match(response.body, /<option value="pretty">Pretty<\/option>/);
  assert.match(response.body, /<option value="reduced">SemVer<\/option>/);
  assert.match(response.body, /aria-label="Version display"/);
});

// DOM contract double for the actual inline adapter and vendored renderer.
// Browser layout and visual review remain coordinator checks.
function browserFixture() {
  class Target {
    constructor() { this.handlers = new Map(); }
    addEventListener(type, callback) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.handlers.get(type)?.delete(callback); }
    fire(type, fields = {}) {
      for (const callback of this.handlers.get(type) || []) callback({ type, target: this, preventDefault() {}, ...fields });
    }
  }
  const document = new Target();
  class Element extends Target {
    constructor() {
      super();
      this.ownerDocument = document;
      this.style = {};
      this.dataset = {};
      this.attributes = {};
      this.children = [];
      this.classList = { add: (value) => { this.className = value; } };
      this._text = "";
      this.scrollWidth = 20;
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
    set innerHTML(_value) { throw new Error("Unsafe HTML insertion"); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) {
      for (const child of children) { child.remove(); child.parent = this; this.children.push(child); }
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
    replaceChildren(...children) { this._text = ""; this.children = []; this.append(...children); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  }
  const host = new Element();
  const display = new Element();
  display.value = "pretty";
  display.disabled = true;
  document.createElement = () => new Element();
  document.getElementById = (id) => id === "pixdcon-version" ? host : display;
  document.getSelection = () => ({ isCollapsed: true });
  const copies = [];
  const view = {
    navigator: { clipboard: { writeText: async (value) => { copies.push(value); } } },
    setTimeout: () => 1,
    clearTimeout() {},
    matchMedia: () => ({ matches: true }),
  };
  return { document, host, display, copies, view };
}

test("the actual header adapter renders Pretty, switches to SemVer and copies canonical text in both modes", async (t) => {
  const fixture = browserFixture();
  const originalDocument = globalThis.document;
  globalThis.document = fixture.document;
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const html = (await request("/")).body;
  const module = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const adapter = module.replace(/^\s*import .*;$/gm, "");
  const config = JSON.parse(await readFile(new URL("../vendor/inspr-versioning/display.json", import.meta.url), "utf-8"));
  await runInNewContext(`(async () => { ${adapter} })()`, {
    document: fixture.document,
    fetch: async (path) => {
      assert.equal(path, "/vendor/inspr-versioning/display.json");
      return { ok: true, json: async () => config };
    },
    renderVersion, validPresentation,
    attachVersionInteraction: (host, canonical, options) => attachVersionInteraction(host, canonical, { ...options, view: fixture.view }),
    console: { error(message) { assert.fail(message); } },
  });
  const { host, display, copies } = fixture;
  assert.equal(display.disabled, false);
  assert.equal(host.dataset.canonical, version);
  assert.equal(host.getAttribute("role"), "button");
  assert.doesNotMatch(host.textContent, /\.0\.0/);
  const seconds = host.children.find((child) => child.className === "ss");
  assert.equal(seconds.style.opacity, "0");
  host.fire("pointerenter", { pointerType: "mouse" });
  assert.equal(seconds.style.opacity, "0.7");
  assert.equal(seconds.style.transition, "none");
  host.fire("pointerleave");
  assert.equal(seconds.style.opacity, "0");
  host.fire("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copies, [version]);
  assert.equal(host.dataset.copyState, "copied");
  display.value = "reduced";
  display.fire("change");
  assert.equal(host.textContent, version);
  assert.equal(host.getAttribute("role"), "button");
  host.fire("keydown", { key: "Enter" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copies, [version, version]);
  display.value = "pretty";
  display.fire("change");
  host.fire("keydown", { key: " " });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copies, [version, version, version]);
});
