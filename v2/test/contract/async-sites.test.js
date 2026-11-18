/**
 * Test kind 2 of 3 (API and MQTT contract): the inventory of asynchronous
 * input, and who owns which file.
 *
 * The ordering rule (src/core/ordering.js) holds only where it is applied.
 * dev/async-sites.js extracts every place in src/ and web/ that consumes
 * asynchronous input; the workers keep, per site, what arrives there, what
 * it carries, which fence it goes through and which test proves it
 * (test/contract/async-sites/W1.json … W5.json). This file fails when the
 * two differ, in either direction:
 *   - a site in the code that no row names (somebody added a listener, a
 *     timer, a fetch),
 *   - a row whose site is gone (a skeleton body was written: its marker
 *     vanished, and the rows for the real sites are due),
 *   - a row without a fence or without a test that exists.
 * It also fails when the inventory could lose a site without anybody
 * noticing:
 *   - the code uses a tracked name in a form the extraction cannot follow
 *     (an alias, a value, a destructuring, a member chosen at run time),
 *   - a skeleton body that was said to consume asynchronous input was
 *     written, and no row says what took the place of its marker
 *     (test/contract/async-sites/promised.json).
 * The last tests check the checker: one made-up site per kind and per form
 * must be found, every unsupported form must be reported, and a made-up
 * difference must be reported.
 *
 * Owner: core/state worker. Each worker edits its own W<n>.json.
 */

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import {
  V2_ROOT,
  blank,
  compare,
  extractSites,
  inspect,
  loadInventory,
  loadPromised,
  parseSite,
  promise,
  scan,
  survey,
  unpromised,
} from "../../dev/async-sites.js";

/** @type {Record<string, string[]|string>} */
const OWNERS = JSON.parse(
  readFileSync(resolve(V2_ROOT, "test/contract/owners.json"), "utf8"),
);
const WORKERS = Object.keys(OWNERS).filter((key) => /^W\d$/.test(key));

/**
 * @param {string} file path below v2/
 * @returns {string[]} the workers whose longest matching pattern is the longest of all; one entry when ownership is clear
 */
function ownersOf(file) {
  let longest = 0;
  /** @type {string[]} */
  let owners = [];
  for (const worker of WORKERS) {
    for (const pattern of /** @type {string[]} */ (OWNERS[worker])) {
      const matches = pattern.endsWith("/")
        ? file.startsWith(pattern)
        : file === pattern;
      if (!matches || pattern.length < longest) continue;
      if (pattern.length > longest) owners = [];
      longest = pattern.length;
      owners.push(worker);
    }
  }
  return owners;
}

/**
 * @param {string} dir absolute
 * @returns {string[]} every file below it, as a path below v2/; node_modules and the scratch folders (.out) are not part of the tree
 */
function filesBelow(dir) {
  /** @type {string[]} */
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === ".out") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...filesBelow(path));
    else files.push(relative(V2_ROOT, path).split("\\").join("/"));
  }
  return files;
}

/**
 * The titles of the tests of a file, real ones and todo entries. A title
 * written as a template is taken as written, `${…}` included.
 *
 * @param {string} file path below v2/
 * @returns {string[]}
 */
function testTitles(file) {
  const text = readFileSync(resolve(V2_ROOT, file), "utf8");
  const titles = [];
  const pattern = /\btest(?:\.todo)?\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) break;
    titles.push(match[2].replace(/\\(.)/g, "$1"));
  }
  return titles;
}

test("async sites: every place in src/ and web/ that consumes asynchronous input is in the inventory, and every row of the inventory still has its site", () => {
  const sites = scan();
  const inventory = loadInventory();
  const { missing, vanished, moved, twice } = compare(sites, inventory);
  assert.deepEqual(
    missing.map((site) => `${site.file}:${site.line} ${site.id}`),
    [],
    "a site in the code that the inventory does not name. Add a row to the W<n>.json of the file's owner: what arrives, what it carries, the fence, the test. (A skeleton marker that will consume no asynchronous input goes into `none`.)",
  );
  assert.deepEqual(
    vanished.map(({ owner, what }) => `${owner}: ${what}`),
    [],
    "a row, or a name in `none`, whose site is gone. A skeleton body that was written loses its marker: replace its row by rows for the real sites.",
  );
  assert.deepEqual(twice, [], "a site with more than one row");
  assert.deepEqual(
    moved.map(({ row, line }) => `${row.site} → line ${line}: ${row.id}`),
    [],
    "the code moved. Run `npm run sites:update`: it rewrites the line numbers of the rows and nothing else.",
  );
  // The inventory really covers the tree: sites in code, and skeleton
  // markers that are either a row or named as consuming nothing.
  const code = sites.filter((site) => site.kind !== "contract");
  assert.ok(code.length >= 30, `${code.length} sites in code`);
  assert.equal(inventory.length, WORKERS.length, "one file per worker");
});

test("async sites: the code uses only forms the inventory can follow, and the inventory did not shrink: a skeleton body that was said to consume asynchronous input keeps its row, or has rows that took its place", () => {
  const { sites, unsupported } = survey();
  const inventory = loadInventory();
  const promised = loadPromised();
  assert.deepEqual(
    unsupported.map(
      ({ file, line, what, why }) => `${file}:${line} ${what}: ${why}`,
    ),
    [],
    "a tracked name in a form the inventory cannot follow (dev/async-sites.js SUPPORTED SYNTAX). Call it directly, under its own name, on its object.",
  );
  assert.deepEqual(
    compare(sites, inventory, promised).shrunk.map(
      ({ owner, name, file, why }) => `${owner}: ${name} in ${file}: ${why}`,
    ),
    [],
    'a skeleton marker that had a row is gone, and nothing took its place (dev/async-sites.js NO SHRINKING). Give at least one row of a real site in that file "was": "<marker>", or name the marker under "resolved" in your W<n>.json with the reason why its body consumes no asynchronous input after all.',
  );
  assert.deepEqual(
    unpromised(sites, inventory, promised).map(
      ({ owner, name, file }) => `${owner}: ${name} in ${file}`,
    ),
    [],
    "a skeleton marker has a row and is not in promised.json yet. Run `node dev/async-sites.js --promise` (owner of the file: W1).",
  );
  assert.ok(promised.length >= 70, `${promised.length} promised markers`);
});

test("async sites: every row says what arrives, what it carries, which fence it goes through and which test proves it; the test exists, and the row is in the file of its site's owner", () => {
  /** @type {Map<string, string[]>} */
  const titles = new Map();
  /** @type {string[]} */
  const problems = [];
  const promised = loadPromised();
  const markers = new Set(
    scan()
      .filter((site) => site.kind === "contract")
      .map((site) => `${site.file}\u0000${site.id.slice("contract:".length)}`),
  );
  for (const { owner, rows, none, resolved } of loadInventory()) {
    assert.ok(WORKERS.includes(owner), `owner ${owner}`);
    for (const row of rows) {
      const where = `${owner} ${row.site} ${row.id}`;
      const { file } = parseSite(row.site);
      for (const field of /** @type {const} */ ([
        "input",
        "metadata",
        "fence",
        "test",
      ]))
        if (typeof row[field] !== "string" || row[field].trim() === "")
          problems.push(`${where}: no ${field}`);
      if (row.fence === "none" && !row.why)
        problems.push(
          `${where}: fence "none" needs a why: the reason this consumes no asynchronous input`,
        );
      if (row.fence !== "none" && row.why)
        problems.push(`${where}: a why belongs to fence "none" only`);
      if (row.was !== undefined) {
        // "was" names the skeleton marker whose place this site took.
        if (row.id.startsWith("contract:"))
          problems.push(`${where}: a skeleton marker cannot have a "was"`);
        if (
          !promised.some(
            (entry) => entry.file === file && entry.name === row.was,
          )
        )
          problems.push(
            `${where}: "was": "${row.was}" names no promised marker of ${file}`,
          );
        if (markers.has(`${file}\u0000${row.was}`))
          problems.push(
            `${where}: "was": "${row.was}" is still a skeleton marker in ${file}`,
          );
      }
      const owners = ownersOf(file);
      if (owners.length !== 1 || owners[0] !== owner)
        problems.push(
          `${where}: ${file} belongs to ${owners.join(" and ") || "nobody"}, the row is in ${owner}.json`,
        );
      const at = String(row.test).indexOf(": ");
      const testFile = String(row.test).slice(0, at);
      const title = String(row.test).slice(at + 2);
      if (at < 0 || title === "") {
        problems.push(`${where}: test must be "<file>: <start of the title>"`);
        continue;
      }
      if (!titles.has(testFile)) {
        try {
          titles.set(testFile, testTitles(testFile));
        } catch {
          titles.set(testFile, []);
        }
      }
      if (!titles.get(testFile)?.some((known) => known.startsWith(title)))
        problems.push(
          `${where}: no test in ${testFile} starts with "${title}"`,
        );
    }
    assert.deepEqual(
      [...none].sort(),
      [...new Set(none)].sort(),
      `${owner}: a name twice in none`,
    );
    for (const [name, why] of Object.entries(resolved ?? {})) {
      const entries = promised.filter(
        (entry) => entry.owner === owner && entry.name === name,
      );
      if (entries.length === 0)
        problems.push(
          `${owner} resolved: "${name}" is no promised marker of ${owner}`,
        );
      if (typeof why !== "string" || why.trim() === "")
        problems.push(
          `${owner} resolved: "${name}" needs the reason why its body consumes no asynchronous input`,
        );
      if (
        entries.length > 0 &&
        entries.every((entry) => markers.has(`${entry.file}\u0000${name}`))
      )
        problems.push(
          `${owner} resolved: "${name}" is still a skeleton marker`,
        );
    }
  }
  assert.deepEqual(problems, []);
});

test("ownership: every file under v2/ has exactly one owner, and every pattern of the ownership map still matches a file", () => {
  const files = filesBelow(V2_ROOT);
  assert.ok(files.length > 90, `${files.length} files`);
  /** @type {string[]} */
  const unclear = [];
  for (const file of files) {
    const owners = ownersOf(file);
    if (owners.length !== 1)
      unclear.push(
        `${file}: ${owners.length === 0 ? "no owner" : owners.join(" and ")}`,
      );
  }
  assert.deepEqual(unclear, []);
  /** @type {string[]} */
  const unused = [];
  for (const worker of WORKERS)
    for (const pattern of /** @type {string[]} */ (OWNERS[worker]))
      if (
        !files.some((file) =>
          pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern,
        )
      )
        unused.push(`${worker}: ${pattern}`);
  assert.deepEqual(unused, [], "a pattern that matches no file");
});

// ---------------------------------------------------------------------------
// The checker is checked
// ---------------------------------------------------------------------------

/** One made-up site per kind, each on its own line, with what the extraction must answer. */
const FAKES = /** @type {const} */ ([
  [
    'this.deps.mqtt.subscribe("owner", filter, (message) => this.accept(message));',
    "subscribe:this.deps.mqtt.subscribe#1",
  ],
  [
    "ctx.mqtt?.subscribeWildcard(pattern, callback);",
    "subscribe:ctx.mqtt.subscribeWildcard#1",
  ],
  ['runtime.on("changed", onChanged);', 'listener:runtime.on("changed")#1'],
  ['client.once("connect", onConnect);', 'listener:client.once("connect")#1'],
  [
    'window.addEventListener("hashchange", go);',
    'listener:window.addEventListener("hashchange")#1',
  ],
  [
    "source.onmessage = (event) => handle(event);",
    "listener:source.onmessage=#1",
  ],
  ["const timer = setTimeout(() => retry(), 1000);", "timer:setTimeout#1"],
  ["setInterval(tick, 1000);", "timer:setInterval#1"],
  [
    "await this.deps.clock.sleep(500, signal);",
    "timer:this.deps.clock.sleep#1",
  ],
  ["ticker = clock.every(tick, 1000);", "timer:clock.every#1"],
  ["process.nextTick(flush);", "timer:process.nextTick#1"],
  ["const watcher = watch(dir, onEvent);", "watch:watch#1"],
  ["fs.watchFile(path, onStat);", "watch:fs.watchFile#1"],
  ['const response = await fetch("/api/v2/bootstrap");', "fetch:fetch#1"],
  [
    'const source = new EventSource("/api/v2/events");',
    "stream:new EventSource#1",
  ],
  [
    "for await (const chunk of request) chunks.push(chunk);",
    "iterate:for await#1",
  ],
  ["const module = await import(url);", "import:import#1"],
  ['server.route("GET", "/api/x", handler);', "route:server.route#1"],
  ["await scenes.sync(change);", "work:scenes.sync#1"],
  [
    "const result = await this.deps.mqtt.publish(topic, payload);",
    "work:this.deps.mqtt.publish#1",
  ],
  ["const { complete } = await mqtt.settle();", "work:mqtt.settle#1"],
  ["tail = tail.then(run);", "then:tail.then#1"],
  ['return todo("Fake.method", argument);', "contract:Fake.method"],
]);

/**
 * The forms a call can take, each a source of its own, with every site it
 * must give as [line, id]. The first three are the ones the third
 * cross-read (finding N5) showed to escape.
 */
const FORMS = /** @type {const} */ ([
  [
    'globalThis.fetch("/api").then(apply);',
    [
      [1, "fetch:globalThis.fetch#1"],
      [1, "then:globalThis.fetch().then#1"],
    ],
  ],
  ["window.setInterval(poll, 1000);", [[1, "timer:window.setInterval#1"]]],
  [
    'getEmitter().on("message", apply);',
    [[1, 'listener:getEmitter().on("message")#1']],
  ],
  // A member of anything: the global object, a module, an injected object.
  ["self.setTimeout(retry, 1000);", [[1, "timer:self.setTimeout#1"]]],
  ["window.fetch(url);", [[1, "fetch:window.fetch#1"]]],
  ["this.deps.http.fetch(url);", [[1, "fetch:this.deps.http.fetch#1"]]],
  ["timers.setImmediate(flush);", [[1, "timer:timers.setImmediate#1"]]],
  ["const watcher = fsPromises.watch(dir);", [[1, "watch:fsPromises.watch#1"]]],
  [
    "requestIdleCallback(sweep); window.requestAnimationFrame(draw);",
    [
      [1, "timer:requestIdleCallback#1"],
      [1, "timer:window.requestAnimationFrame#1"],
    ],
  ],
  ["systemClock().sleep(5);", [[1, "timer:systemClock().sleep#1"]]],
  // The receiver is the result of a call, an element, an expression in parentheses.
  [
    'this.clients[0].on("close", forget);',
    [[1, 'listener:this.clients[].on("close")#1']],
  ],
  ['(await connect()).on("ready", go);', [[1, 'listener:().on("ready")#1']]],
  [
    'document.querySelector("#save").addEventListener("click", save);',
    [[1, 'listener:document.querySelector().addEventListener("click")#1']],
  ],
  [
    'new Worker(file).on("message", take);',
    [
      [1, "stream:new Worker#1"],
      [1, 'listener:Worker().on("message")#1'],
    ],
  ],
  [
    'chokidar.watch(dir).on("change", reload);',
    [
      [1, "watch:chokidar.watch#1"],
      [1, 'listener:chokidar.watch().on("change")#1'],
    ],
  ],
  // A chain that is broken across lines.
  [
    "promise\n  .then(apply)\n  .catch(report)\n  .finally(done);",
    [
      [2, "then:promise.then#1"],
      [3, "then:promise.then().catch#1"],
      [4, "then:promise.then().catch().finally#1"],
    ],
  ],
  [
    'emitter\n  .on("message", apply);',
    [[2, 'listener:emitter.on("message")#1']],
  ],
  [
    'document\n  .querySelector("#save")\n  .addEventListener("click", save);',
    [[3, 'listener:document.querySelector().addEventListener("click")#1']],
  ],
  // A chain of names that ends directly at the dot is written as it stands.
  [
    'this.deps\n  .mqtt.on("connect", resubscribe);',
    [[2, 'listener:mqtt.on("connect")#1']],
  ],
  // An optional call, and a member reached through a string in brackets.
  [
    'target.addEventListener?.("abort", stop);',
    [[1, 'listener:target.addEventListener("abort")#1']],
  ],
  [
    'emitter["on"]("message", apply);',
    [[1, 'listener:emitter.on("message")#1']],
  ],
  [
    "emitter[`once`]('close', done);",
    [[1, 'listener:emitter.once("close")#1']],
  ],
  [
    'emitter?.["on"]?.("message", apply);',
    [[1, 'listener:emitter.on("message")#1']],
  ],
  [
    '(emitter["on"])("message", apply);',
    [[1, 'listener:emitter.on("message")#1']],
  ],
  // Bare: the helpers of node:events, the browser's global, a store's own function.
  ['await once(emitter, "ready");', [[1, "listener:once#1"]]],
  [
    'for await (const [value] of on(emitter, "data")) use(value);',
    [
      [1, "iterate:for await#1"],
      [1, "listener:on#1"],
    ],
  ],
  [
    'addEventListener("hashchange", go);',
    [[1, 'listener:addEventListener("hashchange")#1']],
  ],
  ["const stop = subscribe(render);", [[1, "subscribe:subscribe#1"]]],
  [
    'import { nextTick } from "node:process";\nnextTick(flush);',
    [[2, "timer:nextTick#1"]],
  ],
  // Callbacks on a promise.
  [
    "work.catch(report).finally(done);",
    [
      [1, "then:work.catch#1"],
      [1, "then:work.catch().finally#1"],
    ],
  ],
  ["loadThing().then(apply);", [[1, "then:loadThing().then#1"]]],
  // Constructors that keep delivering.
  ["new window.EventSource(url);", [[1, "stream:new window.EventSource#1"]]],
  [
    "new MutationObserver(redraw).observe(node);",
    [[1, "stream:new MutationObserver#1"]],
  ],
  [
    'new BroadcastChannel("pixdcon").onmessage = take;',
    [
      [1, "stream:new BroadcastChannel#1"],
      [1, "listener:BroadcastChannel().onmessage=#1"],
    ],
  ],
  // An assignment to a member .on<name>, however it is reached.
  [
    'document.querySelector("#x").onclick = go;',
    [[1, "listener:document.querySelector().onclick=#1"]],
  ],
  ["source.onmessage ??= handle;", [[1, "listener:source.onmessage=#1"]]],
  ['source["onerror"] = report;', [[1, "listener:source.onerror=#1"]]],
  // …but not to a member that only starts like one: these are words, not handlers.
  ["entry.online = number;\nstate.once = true;\nrow.only = 1;", []],
]);

/** Uses of a tracked name that the inventory cannot follow, one per line, with what must be reported for the line. */
const UNSUPPORTED = /** @type {const} */ ([
  ['import { watch as observe } from "node:fs";', ["watch as observe"]],
  [
    'import { setTimeout as later } from "node:timers";',
    ["setTimeout as later"],
  ],
  ['import { once as waitFor } from "node:events";', ["once as waitFor"]],
  ["export { fetch as request };", ["fetch as request"]],
  ["const defer = setTimeout;", ["setTimeout"]],
  ["run(fetch);", ["fetch"]],
  ["const deps = { fetch, clock };", ["fetch"]],
  [
    "const pick = ready ? setTimeout : setImmediate;",
    ["setTimeout", "setImmediate"],
  ],
  ["const bound = emitter.on.bind(emitter);", [".on"]],
  ["const then = promise.then;", [".then"]],
  ['target.addEventListener.call(target, "x", f);', [".addEventListener"]],
  ["const request = globalThis.fetch;", [".fetch"]],
  ['emitter["on"].call(emitter, "x", f);', ['["on"]']],
  ["const { on } = emitter;", ["{ on }"]],
  ["const { setTimeout: sooner } = globalThis;", ["{ setTimeout }"]],
  ["function make({ fetch }) {}", ["{ fetch }"]],
  ['const { watch } = await import("node:fs");', ["{ watch }"]],
  ["handlers[type](event);", ["[…]("]],
  ["(handlers[type])(event);", ["[…]("]],
  ["const result = { play, pause }[mode](device);", ["[…]("]],
  ["for (const { once } of emitters) wait(once);", ["{ once }"]],
]);

/** The same names used in ways that are fine: nothing is reported. */
const SUPPORTED = [
  'import { watch } from "node:fs";',
  'import * as timers from "node:timers";',
  'import fetch from "./fetch.js";',
  "export { subscribe };",
  'if (typeof fetch === "function" && typeof value.then === "function") go();',
  "const wrap = (fetch) => fetch(url);",
  "function start(setTimeout, clock) {\n  setTimeout(tick, 1);\n}",
  "const deps = { fetch: (url) => stub(url), on: handler, then: null };",
  "view.on = handler;\nvalue.then = undefined;",
  "class Stub {\n  on = (event) => event;\n  fetch = stub;\n  watch() {}\n}",
  "handlers[0](event);\nhandlers.get(type)(event);",
  "const { clock, logger } = this.deps;",
  "for (const watch of watchers) watch.close();",
  "const total = on + once;",
  "class Sorted extends Set {\n  static get [Symbol.species]() {\n    return Set;\n  }\n  async [name]() {}\n}",
  'const can = typeof (new Target().addEventListener) === "function";',
  'const names = ["on", "once"];\nconst first = list[0];',
  "entry.online = number;\nstate.once = true;\nrow.only = 1;",
  "const [fetch, ...watch] = clients;\nconst { request: setTimeout, ...on } = stubs;",
];

test("async sites, self-test: one made-up site of every kind is found, on its line; comments, strings, templates and regular expressions are not code", () => {
  const source = FAKES.map(([line]) => line).join("\n");
  assert.deepEqual(
    extractSites(source, "fake.js").map((site) => [site.line, site.id]),
    FAKES.map(([, id], index) => [index + 1, id]),
  );
  const kinds = new Set(
    extractSites(source, "fake.js").map((site) => site.kind),
  );
  assert.deepEqual([...kinds].sort(), [
    "contract",
    "fetch",
    "import",
    "iterate",
    "listener",
    "route",
    "stream",
    "subscribe",
    "then",
    "timer",
    "watch",
    "work",
  ]);
  assert.deepEqual(
    inspect(source, "fake.js").unsupported,
    [],
    "every one of them is written in a form the inventory can follow",
  );

  // The same calls where they are not code: nothing is found.
  const notCode = [
    '// runtime.on("changed", x); setTimeout(y, 1); fetch("/x")',
    "/* mqtt.subscribe(a, b, c);",
    '   import("./x.js") */',
    '/** @typedef {import("../types.js").Clock} Clock */',
    'const text = "setTimeout(() => {}, 1); server.route(1)";',
    "const other = 'client.on(\"message\", cb)';",
    'const shown = `fetch(${url}) and todo("x")`;',
    "const pattern = /setInterval\\(|\\.on\\(/g;",
    "function todo(what) { throw new Error(what); }",
    "const half = total / setTimeoutCount / 2;",
    "values.every((value) => value.on);",
  ].join("\n");
  assert.deepEqual(extractSites(notCode, "fake.js"), []);
  // …and code inside a template's ${} is code again.
  assert.deepEqual(
    extractSites(
      "const x = `${await fetch(url)} ${`${setTimeout(f, 1)}`}`;",
      "fake.js",
    ).map((site) => site.id),
    ["fetch:fetch#1", "timer:setTimeout#1"],
  );
  assert.equal(
    blank("a // b\nc").length,
    "a // b\nc".length,
    "blanking keeps every offset",
  );

  // Equal sites in one file are told apart by their order.
  assert.deepEqual(
    extractSites('a.on("x", f);\nb.on("x", g);\na.on("x", h);', "fake.js").map(
      (site) => site.id,
    ),
    ['listener:a.on("x")#1', 'listener:b.on("x")#1', 'listener:a.on("x")#2'],
  );
});

test("async sites, self-test: a call is found whatever it is called on and however its lines are broken: the global object, the result of a call, an element, a broken chain, an optional call, a string in brackets, a bare helper, a callback on a promise", () => {
  for (const [source, expected] of FORMS) {
    const { sites, unsupported } = inspect(source, "fake.js");
    assert.deepEqual(
      sites.map((site) => [site.line, site.id]),
      expected,
      source,
    );
    assert.deepEqual(unsupported, [], source);
  }

  // The definition of a method or function with one of the names is not a
  // call; the calls inside it are.
  const definitions = [
    "class Driver {",
    "  async fetch(path) {",
    "    return fetch(`http://${this.address}${path}`);",
    "  }",
    "  watch() {}",
    "  on(event, handler) {",
    "    this.emitter.on(event, handler);",
    "  }",
    "  static async *subscribe() {}",
    "  get then() {",
    "    return undefined;",
    "  }",
    "}",
    "function setTimeout(callback) {",
    "  callback();",
    "}",
    "const api = { once(event) {}, import(name) {}, load() {} };",
    "try {",
    "  go();",
    "} catch (error) {",
    "  report(error);",
    "} finally {",
    "  done();",
    "}",
  ].join("\n");
  assert.deepEqual(
    inspect(definitions, "fake.js").sites.map((site) => [site.line, site.id]),
    [
      [3, "fetch:fetch#1"],
      [7, "listener:this.emitter.on#1"],
    ],
  );
  assert.deepEqual(inspect(definitions, "fake.js").unsupported, []);
});

test("async sites, self-test: a tracked name that is not called directly is reported: an alias, a value, a member that is read, a destructuring, a member chosen at run time; the plain uses are not", () => {
  const source = UNSUPPORTED.map(([line]) => line).join("\n");
  const { sites, unsupported } = inspect(source, "src/fake.js");
  assert.deepEqual(
    unsupported.map(({ file, line, what }) => [file, line, what]),
    UNSUPPORTED.flatMap(([, whats], index) =>
      whats.map((what) => ["src/fake.js", index + 1, what]),
    ),
  );
  for (const { why } of unsupported)
    assert.ok(why.length > 20, "each says what is wrong and what to write");
  assert.deepEqual(
    sites.map((site) => site.id),
    ["import:import#1"],
    "none of these lines is a site of its own; the dynamic import is",
  );

  for (const line of SUPPORTED)
    assert.deepEqual(inspect(line, "src/fake.js").unsupported, [], line);
});

test("async sites, self-test: a site that is added, a row whose site is gone, a moved line and a double row are each reported", () => {
  const before = extractSites(
    [
      'mqtt.subscribe("o", f, h);',
      "",
      'return todo("Fake.start");',
      'return todo("Fake.get");',
    ].join("\n"),
    "src/fake.js",
  );
  /** @param {import("../../dev/async-sites.js").Site} site */
  const rowOf = (site) => ({
    site: `${site.file}:${site.line}`,
    id: site.id,
    input: "i",
    metadata: "m",
    fence: "f",
    test: "t: t",
  });
  const inventory = [
    {
      owner: "W1",
      rows: [rowOf(before[0]), rowOf(before[1])],
      none: ["Fake.get"],
    },
  ];
  assert.deepEqual(compare(before, inventory), {
    missing: [],
    vanished: [],
    moved: [],
    twice: [],
    shrunk: [],
  });

  // Somebody adds a timer and writes the body of Fake.start.
  const after = extractSites(
    [
      "// a new line above",
      'mqtt.subscribe("o", f, h);',
      "setTimeout(retry, 1000);",
      'return todo("Fake.get");',
    ].join("\n"),
    "src/fake.js",
  );
  const difference = compare(after, inventory);
  assert.deepEqual(
    difference.missing.map((site) => `${site.line} ${site.id}`),
    ["3 timer:setTimeout#1"],
  );
  assert.deepEqual(difference.vanished, [
    { owner: "W1", what: "src/fake.js:3 contract:Fake.start" },
  ]);
  assert.deepEqual(
    difference.moved.map(({ row, line }) => [row.id, line]),
    [["subscribe:mqtt.subscribe#1", 2]],
  );
  assert.deepEqual(difference.twice, []);

  // A name in `none` whose marker is gone, and a site named twice.
  const gone = compare(before.slice(0, 2), inventory);
  assert.deepEqual(gone.vanished, [{ owner: "W1", what: "none: Fake.get" }]);
  const twice = compare(before, [
    ...inventory,
    { owner: "W2", rows: [rowOf(before[0])], none: [] },
  ]);
  assert.deepEqual(twice.twice, ["src/fake.js:1 subscribe:mqtt.subscribe#1"]);

  // The same id in another file is another site.
  const elsewhere = extractSites('mqtt.subscribe("o", f, h);', "src/other.js");
  assert.deepEqual(
    compare([...before, ...elsewhere], inventory).missing.map(
      (site) => site.file,
    ),
    ["src/other.js"],
  );
});

test("async sites, self-test: the inventory cannot shrink. A skeleton marker that had a row and was replaced by a body needs a row that says it took its place, or a reason; dropping the row, or moving the marker to `none`, is reported", (t) => {
  const promised = [{ name: "Fake.start", file: "src/fake.js", owner: "W1" }];
  /** @param {import("../../dev/async-sites.js").Site} site */
  const rowOf = (site) => ({
    site: `${site.file}:${site.line}`,
    id: site.id,
    input: "i",
    metadata: "m",
    fence: "f",
    test: "t: t",
  });
  const shrunk = (
    /** @type {import("../../dev/async-sites.js").Site[]} */ sites,
    /** @type {Parameters<typeof compare>[1]} */ inventory,
  ) =>
    compare(sites, inventory, promised).shrunk.map(
      ({ name, why }) => `${name}: ${why}`,
    );

  // The skeleton: the marker with its row.
  const skeleton = extractSites('return todo("Fake.start");', "src/fake.js");
  assert.deepEqual(
    shrunk(skeleton, [{ owner: "W1", rows: [rowOf(skeleton[0])], none: [] }]),
    [],
  );
  // Its row is dropped and the marker declared to consume nothing.
  assert.deepEqual(
    shrunk(skeleton, [{ owner: "W1", rows: [], none: ["Fake.start"] }]),
    ["Fake.start: the marker is still in the code and its row is gone"],
  );

  // The body is written: a subscription and a timer take the marker's place.
  const built = extractSites(
    'mqtt.subscribe("o", f, h);\nclock.every(tick, 1000);',
    "src/fake.js",
  );
  const replaced =
    "Fake.start: the marker was replaced by a body, and no row says what took its place";
  // The worker removes the old row and adds nothing, or adds rows without the link.
  assert.deepEqual(shrunk(built, [{ owner: "W1", rows: [], none: [] }]), [
    replaced,
  ]);
  assert.deepEqual(
    shrunk(built, [{ owner: "W1", rows: built.map(rowOf), none: [] }]),
    [replaced],
  );
  // One row that says so is enough.
  assert.deepEqual(
    shrunk(built, [
      {
        owner: "W1",
        rows: [{ ...rowOf(built[0]), was: "Fake.start" }, rowOf(built[1])],
        none: [],
      },
    ]),
    [],
  );
  // Or the reason why the body consumes nothing after all.
  assert.deepEqual(
    shrunk(
      [],
      [
        {
          owner: "W1",
          rows: [],
          none: [],
          resolved: { "Fake.start": "start() only stores its options" },
        },
      ],
    ),
    [],
  );
  assert.deepEqual(
    shrunk(
      [],
      [{ owner: "W1", rows: [], none: [], resolved: { "Fake.start": " " } }],
    ),
    [replaced],
    "an empty reason is none",
  );
  // A link from a site in another file, or from a row whose site is gone, does not count.
  const elsewhere = extractSites('mqtt.subscribe("o", f, h);', "src/other.js");
  assert.deepEqual(
    shrunk(elsewhere, [
      {
        owner: "W1",
        rows: [{ ...rowOf(elsewhere[0]), was: "Fake.start" }],
        none: [],
      },
    ]),
    [replaced],
  );
  assert.deepEqual(
    shrunk(
      [],
      [
        {
          owner: "W1",
          rows: [{ ...rowOf(built[0]), was: "Fake.start" }],
          none: [],
        },
      ],
    ),
    [replaced],
  );

  // promised.json only grows: a marker with a row is added, nothing is removed.
  const inventory = [{ owner: "W1", rows: [rowOf(skeleton[0])], none: [] }];
  assert.deepEqual(unpromised(skeleton, inventory, []), promised);
  assert.deepEqual(unpromised(skeleton, inventory, promised), []);
  const dir = mkdtempSync(join(tmpdir(), "pixdcon2-promised-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "promised.json");
  writeFileSync(
    path,
    JSON.stringify({
      promised: [{ name: "Gone.start", file: "src/gone.js", owner: "W3" }],
    }),
  );
  assert.equal(promise(skeleton, inventory, path), 1);
  assert.deepEqual(loadPromised(path), [
    ...promised,
    { name: "Gone.start", file: "src/gone.js", owner: "W3" },
  ]);
  assert.equal(promise(skeleton, inventory, path), 0, "nothing new: unchanged");
  assert.deepEqual(loadPromised(join(dir, "none.json")), []);
});
