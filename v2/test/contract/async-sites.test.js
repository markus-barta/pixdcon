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
 * The last tests check the checker: one made-up site per kind must be
 * found, and a made-up difference must be reported.
 *
 * Owner: core/state worker. Each worker edits its own W<n>.json.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import {
  V2_ROOT,
  blank,
  compare,
  extractSites,
  loadInventory,
  parseSite,
  scan,
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

test("async sites: every row says what arrives, what it carries, which fence it goes through and which test proves it; the test exists, and the row is in the file of its site's owner", () => {
  /** @type {Map<string, string[]>} */
  const titles = new Map();
  /** @type {string[]} */
  const problems = [];
  for (const { owner, rows, none } of loadInventory()) {
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
  ["const module = await import(url);", "import:import#1"],
  ['server.route("GET", "/api/x", handler);', "route:server.route#1"],
  ["await scenes.sync(change);", "work:scenes.sync#1"],
  [
    "const result = await this.deps.mqtt.publish(topic, payload);",
    "work:this.deps.mqtt.publish#1",
  ],
  ["const { complete } = await mqtt.settle();", "work:mqtt.settle#1"],
  ['return todo("Fake.method", argument);', "contract:Fake.method"],
]);

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
    "listener",
    "route",
    "stream",
    "subscribe",
    "timer",
    "watch",
    "work",
  ]);

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
