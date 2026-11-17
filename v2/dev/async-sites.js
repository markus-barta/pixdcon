#!/usr/bin/env node
/**
 * Async site inventory: every place in v2/src and v2/web that consumes
 * asynchronous input, extracted from the source, and compared with the
 * inventory the workers keep (test/contract/async-sites/W1.json … W5.json).
 *
 * Why. The ordering rule (src/core/ordering.js) is only as good as its
 * coverage: one handler that applies what arrives without the decision is
 * the next stale overlay. A list kept by hand misses exactly the site
 * somebody forgot. So the list of sites comes from the code, and the test
 * (test/contract/async-sites.test.js) fails when code and inventory differ
 * in either direction.
 *
 *   node dev/async-sites.js            print the sites with their rows
 *   node dev/async-sites.js --check    exit 1 when code and inventory differ
 *   node dev/async-sites.js --update   rewrite the line numbers of the rows
 *                                      (and nothing else) after code moved
 *   node dev/async-sites.js --json     the extracted sites as JSON
 *
 * EXTRACTION RULES. Comments, and the contents of strings, templates and
 * regular expressions, are blanked first, so only code matches. A site is:
 *
 *   kind       what matches                                         why it is asynchronous input
 *   ---------  ---------------------------------------------------  -----------------------------------------------
 *   subscribe  a call of .subscribe( or .subscribeWildcard(         MQTT messages (retained replays and live), settings and store subscribers
 *   listener   a call of .on( .once( .addListener( .prependListener(   events of another module, of the broker client, of a socket,
 *              .addEventListener(, and an assignment to .on<name>      of the process, of the browser; connect and reconnect handlers
 *   timer      setTimeout( setInterval( setImmediate( queueMicrotask(  everything that happens later by time: settle and
 *              requestAnimationFrame( process.nextTick(, and           acknowledgement timeouts, retries, debounce, grace
 *              .sleep( or .every( on something named …clock            times, watchdogs, polls, ticks
 *   watch      a call of watch( or watchFile(, bare or on fs        file events
 *   fetch      a call of fetch(                                     an HTTP answer: a display's, or pixdcon's in the browser
 *   stream     new EventSource( or new WebSocket(                   the live stream in the browser
 *   import     a dynamic import(                                    a module that finishes loading later (scene files)
 *   route      a call of .route(                                    an HTTP request: a command or a question of a page
 *   work       a call of .load( .sync( .refresh( .invalidate(       results that are applied after other input may have
 *              .reload( .settle( .publish( .acquire(                arrived: registry work, the settle hint, a publish
 *                                                                   acknowledgement, a scene instance that finished loading
 *   contract   a todo("Class.method") marker                        a body that phase 3 writes; the inventory says for each
 *                                                                   whether it will consume asynchronous input, and how
 *
 * An awaited call is not a site by itself: its result reaches the module
 * through one of the kinds above, and that is where it is fenced.
 *
 * A site is identified by its file and by what matched, not by its line:
 *   <kind>:<receiver>.<method>("<first argument, when it is a string>")#<n>
 * with n counting equal matches in the file from the top. The line is kept
 * in the row for the reader and checked by the test; `--update` refreshes it.
 *
 * When a skeleton body is written, its `contract` site vanishes and the
 * real sites appear: the worker replaces the one row by rows for those.
 *
 * Owner: core/state worker.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const V2_ROOT = resolve(here, "..");
export const INVENTORY_DIR = resolve(V2_ROOT, "test/contract/async-sites");
export const SCANNED = /** @type {const} */ (["src", "web"]);

/** @typedef {"subscribe"|"listener"|"timer"|"watch"|"fetch"|"stream"|"import"|"route"|"work"|"contract"} SiteKind */

/**
 * @typedef {object} Site
 * @property {string} file path below v2/, with forward slashes
 * @property {number} line
 * @property {SiteKind} kind
 * @property {string} id `<kind>:<what>#<n>`; for a contract site `contract:<Class.method>`
 */

/**
 * @typedef {object} Row One row of the inventory.
 * @property {string} site `<file>:<line>`
 * @property {string} id
 * @property {string} input what arrives here, in words
 * @property {string} metadata the identity and position the input carries (core/ordering.js Stamp)
 * @property {string} fence the decision it goes through: a function, or a rule of a module header. "none" for a site that consumes no asynchronous input, with `why`
 * @property {string} test `<test file>: <start of the test's title>`; a todo counts, it is the named case phase 3 turns into a test
 * @property {string} [why] for fence "none": why this is not an input
 */

// ---------------------------------------------------------------------------
// Blanking comments and literals
// ---------------------------------------------------------------------------

/** Characters after which a slash starts a regular expression, not a division. */
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "await",
  "yield",
]);

/**
 * The source with comments, and the contents of string, template and regex
 * literals, replaced by spaces. Same length, same line breaks, so offsets
 * and line numbers are those of the original. Code inside `${…}` of a
 * template stays code.
 *
 * @param {string} text
 * @returns {string}
 */
export function blank(text) {
  const out = text.split("");
  const length = text.length;
  /** @type {number[]} brace depth at which each open template's `${` ends */
  const templates = [];
  let depth = 0;
  let i = 0;
  /** The last code token before position i, for the regex question. */
  const before = () => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(out[j])) j -= 1;
    if (j < 0) return "";
    if (/[\w$]/.test(out[j])) {
      let start = j;
      while (start > 0 && /[\w$]/.test(out[start - 1])) start -= 1;
      return out.slice(start, j + 1).join("");
    }
    return out[j];
  };
  /** Blank from `from` to `to` (exclusive), keeping line breaks. */
  const wipe = (/** @type {number} */ from, /** @type {number} */ to) => {
    for (let k = from; k < to && k < length; k++)
      if (out[k] !== "\n") out[k] = " ";
  };
  /** Skip a quoted literal that starts at i; returns the index after it. */
  const quoted = (/** @type {string} */ quote) => {
    let j = i + 1;
    while (j < length && text[j] !== quote && text[j] !== "\n") {
      if (text[j] === "\\") j += 1;
      j += 1;
    }
    wipe(i + 1, j);
    return j + 1;
  };
  /** Continue a template literal at i (after the backtick or a closing brace); returns the index to go on at. */
  const template = () => {
    let j = i;
    while (j < length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === "`") {
        wipe(i, j);
        return j + 1;
      }
      if (text[j] === "$" && text[j + 1] === "{") {
        wipe(i, j);
        templates.push(depth);
        depth += 1;
        return j + 2;
      }
      j += 1;
    }
    wipe(i, j);
    return j;
  };

  while (i < length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      let j = i;
      while (j < length && text[j] !== "\n") j += 1;
      wipe(i, j);
      i = j;
    } else if (char === "/" && next === "*") {
      let j = text.indexOf("*/", i + 2);
      j = j === -1 ? length : j + 2;
      wipe(i, j);
      i = j;
    } else if (char === '"' || char === "'") {
      i = quoted(char);
    } else if (char === "`") {
      i += 1;
      i = template();
    } else if (char === "{") {
      depth += 1;
      i += 1;
    } else if (char === "}") {
      depth -= 1;
      i += 1;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        i = template();
      }
    } else if (char === "/") {
      const token = before();
      const regex =
        token === "" || REGEX_AFTER.has(token) || REGEX_AFTER_WORDS.has(token);
      if (!regex) {
        i += 1;
        continue;
      }
      let j = i + 1;
      let inClass = false;
      while (j < length && text[j] !== "\n") {
        if (text[j] === "\\") j += 1;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) break;
        j += 1;
      }
      wipe(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** The expression a method is called on, read backwards from the dot: `this.deps.mqtt`, `socket`, `process`. */
const RECEIVER = "((?:[\\w$#]+\\??\\.)*[\\w$#]+)\\??";

/** @type {Array<{kind: SiteKind, pattern: RegExp, what: (match: RegExpExecArray, argument: string|null) => string}>} */
const RULES = [
  {
    kind: "subscribe",
    pattern: new RegExp(
      `${RECEIVER}\\.(subscribe|subscribeWildcard)\\s*\\(`,
      "g",
    ),
    what: (match) => `${match[1]}.${match[2]}`,
  },
  {
    kind: "listener",
    pattern: new RegExp(
      `${RECEIVER}\\.(on|once|addListener|prependListener|addEventListener)\\s*\\(`,
      "g",
    ),
    what: (match, argument) =>
      `${match[1]}.${match[2]}${argument === null ? "" : `("${argument}")`}`,
  },
  {
    kind: "listener",
    pattern: new RegExp(`${RECEIVER}\\.(on[a-z]+)\\s*=(?!=)`, "g"),
    what: (match) => `${match[1]}.${match[2]}=`,
  },
  {
    kind: "timer",
    pattern:
      /(?<![\w$.])(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame)\s*\(/g,
    what: (match) => match[1],
  },
  {
    kind: "timer",
    pattern: /(?<![\w$])(process\.nextTick)\s*\(/g,
    what: (match) => match[1],
  },
  {
    kind: "timer",
    pattern: /((?:[\w$#]+\??\.)*[\w$#]*[cC]lock)\??\.(sleep|every)\s*\(/g,
    what: (match) => `${match[1]}.${match[2]}`,
  },
  {
    kind: "watch",
    pattern: /(?<![\w$.])((?:fs\.|fsPromises\.)?(?:watch|watchFile))\s*\(/g,
    what: (match) => match[1],
  },
  {
    kind: "fetch",
    pattern: /(?<![\w$.])(fetch)\s*\(/g,
    what: (match) => match[1],
  },
  {
    kind: "stream",
    pattern: /(?<![\w$.])new\s+(EventSource|WebSocket)\s*\(/g,
    what: (match) => `new ${match[1]}`,
  },
  {
    kind: "import",
    pattern: /(?<![\w$.])(import)\s*\(/g,
    what: (match) => match[1],
  },
  {
    kind: "route",
    pattern: new RegExp(`${RECEIVER}\\.(route)\\s*\\(`, "g"),
    what: (match) => `${match[1]}.${match[2]}`,
  },
  {
    kind: "work",
    pattern: new RegExp(
      `${RECEIVER}\\.(load|sync|refresh|invalidate|reload|settle|publish|acquire)\\s*\\(`,
      "g",
    ),
    what: (match) => `${match[1]}.${match[2]}`,
  },
  {
    kind: "contract",
    // A call of the skeleton marker, not its definition.
    pattern: /(?<![\w$.])(?<!function\s+)(todo)\s*\(/g,
    what: (_match, argument) => argument ?? "(computed)",
  },
];

/**
 * The first argument of a call when it is a string literal on one line
 * (quoted, or a template taken as written), read from the original text.
 *
 * @param {string} text the original source
 * @param {number} at index right after the opening parenthesis
 * @returns {string|null}
 */
function stringArgument(text, at) {
  const match = /^\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(text.slice(at));
  return match ? match[2] : null;
}

/**
 * Every site of one source file, in the order of the file.
 *
 * @param {string} text the source
 * @param {string} file path below v2/, for the result
 * @returns {Site[]}
 */
export function extractSites(text, file) {
  const code = blank(text);
  /** @type {Array<{index: number, kind: SiteKind, what: string}>} */
  const found = [];
  for (const { kind, pattern, what } of RULES) {
    pattern.lastIndex = 0;
    for (;;) {
      const match = pattern.exec(code);
      if (!match) break;
      const end = match.index + match[0].length;
      found.push({
        index: match.index,
        kind,
        what: what(match, stringArgument(text, end)),
      });
    }
  }
  found.sort((a, b) => a.index - b.index);
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {number[]} */
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++)
    if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (/** @type {number} */ index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  return found.map(({ index, kind, what }) => {
    const base = `${kind}:${what}`;
    if (kind === "contract")
      return { file, line: lineOf(index), kind, id: base };
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return { file, line: lineOf(index), kind, id: `${base}#${n}` };
  });
}

/**
 * @param {string} dir absolute
 * @returns {string[]} absolute paths of the .js files below it, sorted
 */
function jsFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...jsFiles(path));
    else if (name.endsWith(".js")) files.push(path);
  }
  return files;
}

/**
 * @param {string} [root] v2/
 * @returns {Site[]} every site of src/ and web/
 */
export function scan(root = V2_ROOT) {
  return SCANNED.flatMap((part) =>
    jsFiles(resolve(root, part)).flatMap((path) =>
      extractSites(
        readFileSync(path, "utf8"),
        relative(root, path).split("\\").join("/"),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Inventory One worker's file.
 * @property {string} owner "W1" … "W5"
 * @property {Row[]} rows sites that consume asynchronous input (or are named with the reason why they do not)
 * @property {string[]} none skeleton markers ("Class.method") whose body will consume no asynchronous input: pure, or synchronous, or a command's own flow
 */

/**
 * @param {string} [dir]
 * @returns {Array<Inventory & {path: string}>}
 */
export function loadInventory(dir = INVENTORY_DIR) {
  return readdirSync(dir)
    .filter((name) => /^W\d\.json$/.test(name))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { ...JSON.parse(readFileSync(path, "utf8")), path };
    });
}

/**
 * @param {string} site `<file>:<line>`
 * @returns {{file: string, line: number}}
 */
export function parseSite(site) {
  const at = site.lastIndexOf(":");
  return { file: site.slice(0, at), line: Number(site.slice(at + 1)) };
}

/**
 * Code against inventory, both ways.
 *
 * @param {Site[]} sites
 * @param {Array<Pick<Inventory, "owner"|"rows"|"none">>} inventory
 * @returns {{missing: Site[], vanished: Array<{owner: string, what: string}>, moved: Array<{owner: string, row: Row, line: number}>, twice: string[]}}
 * missing: a site without a row. vanished: a row, or a name in `none`, without a site. moved: a row whose line is not the site's. twice: a site with more than one row or name.
 */
export function compare(sites, inventory) {
  const key = (/** @type {string} */ file, /** @type {string} */ id) =>
    `${file}\u0000${id}`;
  const byKey = new Map(sites.map((site) => [key(site.file, site.id), site]));
  /** Contract sites by name, for `none`. */
  const contracts = new Map(
    sites
      .filter((site) => site.kind === "contract")
      .map((site) => [site.id.slice("contract:".length), site]),
  );
  /** @type {Set<Site>} */
  const covered = new Set();
  /** @type {ReturnType<typeof compare>} */
  const result = { missing: [], vanished: [], moved: [], twice: [] };
  const cover = (/** @type {Site} */ site) => {
    if (covered.has(site))
      result.twice.push(`${site.file}:${site.line} ${site.id}`);
    covered.add(site);
  };
  for (const { owner, rows, none } of inventory) {
    for (const row of rows) {
      const { file, line } = parseSite(row.site);
      const site = byKey.get(key(file, row.id));
      if (!site) {
        result.vanished.push({ owner, what: `${row.site} ${row.id}` });
        continue;
      }
      cover(site);
      if (site.line !== line)
        result.moved.push({ owner, row, line: site.line });
    }
    for (const name of none) {
      const site = contracts.get(name);
      if (!site) result.vanished.push({ owner, what: `none: ${name}` });
      else cover(site);
    }
  }
  result.missing = sites.filter((site) => !covered.has(site));
  return result;
}

/**
 * Rewrite the line numbers of the rows whose site moved. Nothing else is
 * touched, not even the layout of the file: a missing or vanished site
 * needs a person.
 *
 * @param {Site[]} sites
 * @param {string} [dir]
 * @returns {number} rows changed
 */
export function updateLines(sites, dir = INVENTORY_DIR) {
  const literal = (/** @type {string} */ value) =>
    JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let changed = 0;
  for (const { path, ...inventory } of loadInventory(dir)) {
    const { moved } = compare(sites, [inventory]);
    if (moved.length === 0) continue;
    let text = readFileSync(path, "utf8");
    for (const { row, line } of moved) {
      // The row is found by its site followed by its id, as written.
      const pattern = new RegExp(
        `("site":\\s*)${literal(row.site)}(\\s*,\\s*"id":\\s*${literal(row.id)})`,
      );
      const site = JSON.stringify(`${parseSite(row.site).file}:${line}`);
      const next = text.replace(
        pattern,
        (_all, before, after) => `${before}${site}${after}`,
      );
      if (next !== text) changed += 1;
      text = next;
    }
    writeFileSync(path, text);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function main() {
  const flags = new Set(process.argv.slice(2));
  const sites = scan();
  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify(sites, null, 2)}\n`);
    return;
  }
  if (flags.has("--update")) {
    const changed = updateLines(sites);
    process.stdout.write(`${changed} line number(s) updated\n`);
  }
  const inventory = loadInventory();
  const difference = compare(sites, inventory);
  const rows = new Map(
    inventory.flatMap(({ owner, rows: list }) =>
      list.map((row) => [
        `${parseSite(row.site).file}\u0000${row.id}`,
        { owner, row },
      ]),
    ),
  );
  if (!flags.has("--check")) {
    for (const site of sites) {
      if (site.kind === "contract" && !rows.has(`${site.file}\u0000${site.id}`))
        continue; // a body that consumes no asynchronous input
      const entry = rows.get(`${site.file}\u0000${site.id}`);
      process.stdout.write(
        `${site.file}:${site.line}\t${site.id}\t${entry ? `${entry.owner}\t${entry.row.fence}\t${entry.row.test}` : "NOT IN THE INVENTORY"}\n`,
      );
    }
  }
  const problems = [
    ...difference.missing.map(
      (site) => `not in the inventory: ${site.file}:${site.line} ${site.id}`,
    ),
    ...difference.vanished.map(
      ({ owner, what }) => `${owner}: no such site any more: ${what}`,
    ),
    ...difference.moved.map(
      ({ owner, row, line }) =>
        `${owner}: ${row.site} ${row.id} is on line ${line} now (npm run sites:update)`,
    ),
    ...difference.twice.map((what) => `listed twice: ${what}`),
  ];
  const code = sites.filter((site) => site.kind !== "contract").length;
  process.stderr.write(
    `${sites.length} sites (${code} in code, ${sites.length - code} skeleton markers), ${rows.size} rows, ${problems.length} difference(s)\n`,
  );
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  if (problems.length > 0) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
