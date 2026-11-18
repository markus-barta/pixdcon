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
 *   node dev/async-sites.js --check    exit 1 when code and inventory differ,
 *                                      when the code uses a form the inventory
 *                                      cannot follow, or when the inventory shrank
 *   node dev/async-sites.js --update   rewrite the line numbers of the rows
 *                                      (and nothing else) after code moved
 *   node dev/async-sites.js --promise  add the skeleton markers that have a row
 *                                      to promised.json (never removes one)
 *   node dev/async-sites.js --json     the extracted sites as JSON
 *
 * EXTRACTION RULES. Comments, and the contents of strings, templates and
 * regular expressions, are blanked first, so only code matches. What is
 * left is read as tokens: names, punctuation, and brackets with their
 * partners. A call is found by the name that is called, whatever it is
 * called on and however the lines are broken: a chain of names, the result
 * of a call, an element of an array, an expression in parentheses. A site
 * is:
 *
 *   kind       what matches                                         why it is asynchronous input
 *   ---------  ---------------------------------------------------  -----------------------------------------------
 *   subscribe  a call of subscribe( or subscribeWildcard(           MQTT messages (retained replays and live), settings and store subscribers
 *   listener   a call of on( once( addListener( prependListener(    events of another module, of the broker client, of a socket,
 *              prependOnceListener( addEventListener(, and an       of the process, of the browser; connect and reconnect handlers
 *              assignment to a member .on<name> (onmessage,
 *              onerror; not the words once, one, online, only)
 *   timer      a call of setTimeout( setInterval( setImmediate(     everything that happens later by time: settle and
 *              queueMicrotask( requestAnimationFrame(               acknowledgement timeouts, retries, debounce, grace
 *              requestIdleCallback( nextTick(, and .sleep( or       times, watchdogs, polls, ticks
 *              .every( on something named …clock
 *   watch      a call of watch( or watchFile(                       file events
 *   fetch      a call of fetch(                                     an HTTP answer: a display's, or pixdcon's in the browser
 *   stream     new EventSource( WebSocket( Worker( SharedWorker(    something that keeps delivering: the live stream in the
 *              BroadcastChannel( MessageChannel( XMLHttpRequest(    browser, a worker, an observer
 *              FileReader( and the four …Observer(
 *   iterate    for await (                                          a stream that is read piece by piece
 *   import     a dynamic import(                                    a module that finishes loading later (scene files)
 *   route      a call of .route(                                    an HTTP request: a command or a question of a page
 *   work       a call of .load( .sync( .refresh( .invalidate(       results that are applied after other input may have
 *              .reload( .settle( .publish( .acquire(                arrived: registry work, the settle hint, a publish
 *                                                                   acknowledgement, a scene instance that finished loading
 *   then       a call of .then( .catch( .finally(                   a callback on a promise: it runs when the result is there
 *   contract   a todo("Class.method") marker                        a body that phase 3 writes; the inventory says for each
 *                                                                   whether it will consume asynchronous input, and how
 *
 * subscribe, listener, timer, watch and fetch match bare (setTimeout(…),
 * the helpers once(…) and on(…) of node:events, the browser's global
 * addEventListener(…)) and as a member of anything (window.setInterval(…),
 * globalThis.fetch(…), getEmitter().on(…)), also as an optional call
 * (target.addEventListener?.(…)). route, work and then match as a member.
 * A member that is reached through a string in brackets counts like the
 * member: emitter["on"](…). The definition of a method or a function that
 * has one of these names is not a call.
 *
 * An awaited call is not a site by itself: its result reaches the module
 * through one of the kinds above, and that is where it is fenced.
 *
 * A site is identified by its file and by what matched, not by its line:
 *   <kind>:<receiver>.<method>("<first argument, when it is a string>")#<n>
 * with n counting equal matches in the file from the top. The line is kept
 * in the row for the reader and checked by the test; `--update` refreshes it.
 * The receiver is written as it stands when it is a chain of names that
 * ends directly at the dot: this.deps.mqtt.on("connect"). In every other
 * case (the result of a call, an element, parentheses, a line break before
 * the dot) the whole receiver is taken, without white space and without
 * what stands inside its brackets: getEmitter().on("message"),
 * this.clients[].on("close"), ().on("ready").
 *
 * SUPPORTED SYNTAX. The inventory follows names. A tracked name that is
 * used in any other way than being called directly can produce a listener
 * or a timer under another name, and that one would not be found. So these
 * forms are not allowed in src/ and web/, and the same script reports them
 * (`unsupported`; --check and the test fail on each):
 *   - a tracked name imported or exported under another name:
 *     import { watch as observe } from "node:fs"
 *   - a timer function, fetch, watch or watchFile used as a value:
 *     assigned, passed as an argument, put into an object, bound
 *     (typeof fetch is fine)
 *   - a tracked member read without being called: emitter.on.bind(emitter),
 *     const then = promise.then, x.addEventListener.call(…). An assignment
 *     to such a member defines it and is fine; so is typeof x.then
 *   - a tracked name taken out of an object by destructuring:
 *     const { on } = emitter, const { setTimeout: later } = globalThis
 *   - a member that is chosen at run time and called: target[name](…)
 * What the script does not see, stated plainly:
 *   - a callback that an API of Node or of the browser takes by position or
 *     inside an object: createServer(handler), readFile(path, callback).
 *     The ones in the tree are the HTTP server's (api/http-server.js): what
 *     its request handler receives is covered by the `route` sites. A
 *     callback that one module of src/ hands to another is called from a
 *     site of that other module.
 *   - a member that is looked up by its text: Reflect.get(target, "on").
 *   - a timer under another name: scheduler.wait() of node:timers/promises,
 *     AbortSignal.timeout(). Modules take time from the injected clock
 *     (core/clock.js), whose sleep() and every() are sites.
 *
 * NO SHRINKING. When a skeleton body is written, its `contract` site
 * vanishes and the real sites appear: the worker replaces the one row by
 * rows for those. That the row is replaced and not just dropped is checked:
 * test/contract/async-sites/promised.json lists every marker that has a
 * row, that is, every body that was said to consume asynchronous input
 * (`--promise` adds to it and never removes). A promised marker that is no
 * longer in the code needs, in its owner's W<n>.json, either
 *   - at least one row with "was": "<marker>" for a site in the same file:
 *     this is what the body turned out to consume, or
 *   - an entry "resolved": {"<marker>": "<why the body that was written
 *     consumes no asynchronous input after all>"}.
 * A promised marker that is still in the code keeps its row.
 *
 * Owner: core/state worker.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const V2_ROOT = resolve(here, "..");
export const INVENTORY_DIR = resolve(V2_ROOT, "test/contract/async-sites");
export const PROMISED_PATH = resolve(INVENTORY_DIR, "promised.json");
export const SCANNED = /** @type {const} */ (["src", "web"]);

/** @typedef {"subscribe"|"listener"|"timer"|"watch"|"fetch"|"stream"|"iterate"|"import"|"route"|"work"|"then"|"contract"} SiteKind */

/**
 * @typedef {object} Site
 * @property {string} file path below v2/, with forward slashes
 * @property {number} line
 * @property {SiteKind} kind
 * @property {string} id `<kind>:<what>#<n>`; for a contract site `contract:<Class.method>`
 */

/**
 * @typedef {object} Unsupported A use of a tracked name that the inventory cannot follow.
 * @property {string} file path below v2/, with forward slashes
 * @property {number} line
 * @property {string} what the text in question: "watch as observe", ".on", "setTimeout", "{ on }", "[…]("
 * @property {string} why what is wrong with it, and how to write it instead
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
 * @property {string} [was] the skeleton marker ("Class.method") of the same file whose body this site is part of, once that body is written and the marker is gone (see NO SHRINKING)
 */

/**
 * @typedef {object} Promised A skeleton marker that had a row: a body that was said to consume asynchronous input.
 * @property {string} name the marker, "Class.method"
 * @property {string} file path below v2/
 * @property {string} owner "W1" … "W5"
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
// Tokens
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Token
 * @property {"name"|"number"|"string"|"punct"} type name: an identifier, a keyword, `this`, a `#private` name. string: a quoted literal, or a template without `${}`
 * @property {string} value the text; for a string its quote character
 * @property {number} start offset in the source
 * @property {number} end offset after its last character
 */

/** Punctuation of more than one character, longest first. */
const OPERATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];

const isNameStart = (/** @type {string|undefined} */ char) =>
  char !== undefined && /[A-Za-z_$\u0080-\uffff]/.test(char);
const isNamePart = (/** @type {string|undefined} */ char) =>
  char !== undefined && /[\w$\u0080-\uffff]/.test(char);
const isDigit = (/** @type {string|undefined} */ char) =>
  char !== undefined && /[0-9]/.test(char);

/**
 * The tokens of blanked code (see blank()). A template with `${…}` gives a
 * backtick, the code of each `${…}` between a "${" and a "}", and a
 * backtick; its text is blank already.
 *
 * @param {string} code
 * @returns {Token[]}
 */
export function tokenize(code) {
  /** @type {Token[]} */
  const tokens = [];
  const length = code.length;
  /** @type {number[]} brace depth at which each open template's `${` ends */
  const templates = [];
  let depth = 0;
  let i = 0;
  const push = (
    /** @type {Token["type"]} */ type,
    /** @type {string} */ value,
    /** @type {number} */ start,
    /** @type {number} */ end,
  ) => {
    tokens.push({ type, value, start, end });
  };
  /** In the text of a template at i: go on to its next `${`, or to its end. */
  const templateText = () => {
    let j = i;
    while (
      j < length &&
      code[j] !== "`" &&
      !(code[j] === "$" && code[j + 1] === "{")
    )
      j += 1;
    if (j >= length) {
      i = length;
    } else if (code[j] === "`") {
      push("punct", "`", j, j + 1);
      i = j + 1;
    } else {
      push("punct", "${", j, j + 2);
      templates.push(depth);
      depth += 1;
      i = j + 2;
    }
  };

  if (code.startsWith("#!")) while (i < length && code[i] !== "\n") i += 1;
  while (i < length) {
    const char = code[i];
    if (/\s/.test(char)) {
      i += 1;
    } else if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < length && code[j] !== char) j += 1;
      push("string", char, i, Math.min(j + 1, length));
      i = j + 1;
    } else if (char === "`") {
      let j = i + 1;
      while (j < length && /\s/.test(code[j])) j += 1;
      if (code[j] === "`") {
        // No `${}` inside: one string.
        push("string", "`", i, j + 1);
        i = j + 1;
      } else {
        push("punct", "`", i, i + 1);
        i += 1;
        templateText();
      }
    } else if (
      isNameStart(char) ||
      (char === "#" && isNameStart(code[i + 1]))
    ) {
      let j = i + 1;
      while (isNamePart(code[j])) j += 1;
      push("name", code.slice(i, j), i, j);
      i = j;
    } else if (isDigit(char) || (char === "." && isDigit(code[i + 1]))) {
      let j = i + 1;
      while (isNamePart(code[j])) j += 1;
      if (code[j] === "." && isDigit(code[j + 1])) {
        j += 1;
        while (isNamePart(code[j])) j += 1;
      }
      push("number", code.slice(i, j), i, j);
      i = j;
    } else {
      let value =
        OPERATORS.find((operator) => code.startsWith(operator, i)) ?? char;
      // `a ?.5 : b` is a conditional, not an optional chain.
      if (value === "?." && isDigit(code[i + 2])) value = "?";
      if (value === "{") depth += 1;
      push("punct", value, i, i + value.length);
      i += value.length;
      if (value === "}") {
        depth -= 1;
        if (templates.length > 0 && templates[templates.length - 1] === depth) {
          templates.pop();
          templateText();
        }
      }
    }
  }
  return tokens;
}

const OPENERS = new Set(["(", "[", "{", "${"]);
const CLOSERS = new Set([")", "]", "}"]);

/**
 * Brackets and their partners.
 *
 * @param {Token[]} tokens
 * @returns {{match: number[], around: number[]}} match: for a bracket the index of its partner, else -1. around: for every token the index of the innermost bracket that is open around it, else -1
 */
function pair(tokens) {
  const match = new Array(tokens.length).fill(-1);
  const around = new Array(tokens.length).fill(-1);
  /** @type {number[]} */
  const open = [];
  tokens.forEach((token, index) => {
    if (token.type === "punct" && CLOSERS.has(token.value)) {
      const partner = open.pop();
      if (partner !== undefined) {
        match[partner] = index;
        match[index] = partner;
      }
    }
    around[index] = open.length > 0 ? open[open.length - 1] : -1;
    if (token.type === "punct" && OPENERS.has(token.value)) open.push(index);
  });
  return { match, around };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const TIMERS = [
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
  "requestIdleCallback",
];
const LISTENERS = [
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
  "addEventListener",
];
const SUBSCRIBERS = ["subscribe", "subscribeWildcard"];
const WATCHERS = ["watch", "watchFile"];
const WORK = [
  "load",
  "sync",
  "refresh",
  "invalidate",
  "reload",
  "settle",
  "publish",
  "acquire",
];
const CONTINUATIONS = ["then", "catch", "finally"];

/** @type {Map<string, SiteKind>} what a call of a member with this name is */
const MEMBER = new Map([
  ...SUBSCRIBERS.map((name) => /** @type {const} */ ([name, "subscribe"])),
  ...LISTENERS.map((name) => /** @type {const} */ ([name, "listener"])),
  ...TIMERS.map((name) => /** @type {const} */ ([name, "timer"])),
  /** @type {const} */ (["nextTick", "timer"]),
  ...WATCHERS.map((name) => /** @type {const} */ ([name, "watch"])),
  /** @type {const} */ (["fetch", "fetch"]),
  /** @type {const} */ (["route", "route"]),
  ...WORK.map((name) => /** @type {const} */ ([name, "work"])),
  ...CONTINUATIONS.map((name) => /** @type {const} */ ([name, "then"])),
]);

/** @type {Map<string, SiteKind>} what a bare call of this name is */
const BARE = new Map([
  ...SUBSCRIBERS.map((name) => /** @type {const} */ ([name, "subscribe"])),
  ...LISTENERS.map((name) => /** @type {const} */ ([name, "listener"])),
  ...TIMERS.map((name) => /** @type {const} */ ([name, "timer"])),
  /** @type {const} */ (["nextTick", "timer"]),
  ...WATCHERS.map((name) => /** @type {const} */ ([name, "watch"])),
  /** @type {const} */ (["fetch", "fetch"]),
  /** @type {const} */ (["todo", "contract"]),
]);

const STREAMS = new Set([
  "EventSource",
  "WebSocket",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "MessageChannel",
  "XMLHttpRequest",
  "FileReader",
  "MutationObserver",
  "IntersectionObserver",
  "ResizeObserver",
  "PerformanceObserver",
]);

/** Bare names that may not be used as a value. */
const VALUES = new Set([...TIMERS, "fetch", ...WATCHERS]);
/** Bare names that may not be imported or exported under another name. */
const ALIASES = new Set([
  ...TIMERS,
  "nextTick",
  "fetch",
  ...WATCHERS,
  ...LISTENERS,
  ...SUBSCRIBERS,
]);
/** Names that may not be taken out of an object by destructuring. */
const PATTERNS = new Set([
  ...TIMERS,
  "nextTick",
  "fetch",
  ...WATCHERS,
  ...LISTENERS,
  ...SUBSCRIBERS,
]);
/** Member names that may not be read without being called. */
const READS = new Set([
  ...LISTENERS,
  ...SUBSCRIBERS,
  ...CONTINUATIONS,
  ...TIMERS,
  "nextTick",
  ...WATCHERS,
  "fetch",
]);

/** Keywords after which a name is being declared, or only asked about. */
const DECLARERS = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "import",
  "as",
  "typeof",
]);
/** What may stand before the name of a method or function that is being defined. */
const DEFINERS = new Set(["async", "static", "get", "set", "function"]);
/** Keywords whose parentheses are not a parameter list. */
const CONTROLS = new Set(["if", "for", "while", "switch", "with"]);
/** Keywords that end a receiver: what stands before them is not part of it. */
const STOPS = new Set([
  "await",
  "return",
  "typeof",
  "new",
  "void",
  "delete",
  "yield",
  "throw",
  "case",
  "in",
  "of",
  "instanceof",
  "else",
  "do",
  "if",
  "for",
  "while",
  "const",
  "let",
  "var",
  "export",
  "default",
  "async",
  "function",
  "class",
  "extends",
]);
/** Members of a function that hand it on under another form. */
const REBINDERS = new Set(["bind", "call", "apply"]);
/** A member `.on<name>` that is assigned is a handler: onmessage, onerror, onclick. These only start like one: they are words. */
const NO_HANDLERS = new Set([
  "once",
  "one",
  "ongoing",
  "online",
  "only",
  "onto",
]);
/** Assignments that give a member a value. */
const ASSIGNMENTS = new Set(["=", "??=", "||=", "&&="]);

/** Is this the name of a handler member: on, then the name of an event in lower case? */
const isHandler = (/** @type {string} */ name) =>
  /^on[a-z]+$/.test(name) && !NO_HANDLERS.has(name);

const WHY = {
  alias:
    "a tracked name under another name: calls of the other name are not found. Import it under its own name",
  value:
    "used as a value (assigned, passed, put into an object, bound) instead of being called: what it starts later is not found. Call it where it is needed",
  read: "read without being called (bound, stored, passed on): the callback it registers later is not found. Call it directly on its object",
  destructured:
    "taken out of an object by destructuring: its calls cannot be told from those of any other function. Call it as a member of its object",
  computed:
    "a member that is chosen at run time is called: the inventory cannot see which. Call the member by its name",
};

const STRING_ARGUMENT = /\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/y;

/**
 * The first argument of a call when it is a string literal on one line
 * (quoted, or a template taken as written), read from the original text.
 *
 * @param {string} text the original source
 * @param {number} at index right after the opening parenthesis
 * @returns {string|null}
 */
function stringArgument(text, at) {
  STRING_ARGUMENT.lastIndex = at;
  const match = STRING_ARGUMENT.exec(text);
  return match ? match[2] : null;
}

/**
 * Every site of one source file, and every use of a tracked name that the
 * inventory cannot follow, both in the order of the file.
 *
 * @param {string} text the source
 * @param {string} file path below v2/, for the result
 * @returns {{sites: Site[], unsupported: Unsupported[]}}
 */
export function inspect(text, file) {
  const tokens = tokenize(blank(text));
  const { match, around } = pair(tokens);
  /** @type {Array<{index: number, kind: SiteKind, what: string}>} */
  const found = [];
  /** @type {Array<{index: number, what: string, why: string}>} */
  const refused = [];
  /** Names that are called or defined: the syntax check leaves them alone. @type {Set<number>} */
  const settled = new Set();

  const is = (/** @type {number} */ index, /** @type {string} */ value) =>
    tokens[index]?.type === "punct" && tokens[index].value === value;
  const isDot = (/** @type {number} */ index) =>
    is(index, ".") || is(index, "?.");
  const isName = (
    /** @type {number} */ index,
    /** @type {string} */ value = "",
  ) =>
    tokens[index]?.type === "name" &&
    (value === "" || tokens[index].value === value);
  /** The `(` of a call that starts right after the token, also of an optional call `?.(`; else -1. */
  const callAfter = (/** @type {number} */ index) => {
    if (is(index + 1, "(")) return index + 1;
    return is(index + 1, "?.") && is(index + 2, "(") ? index + 2 : -1;
  };
  const assignedAfter = (/** @type {number} */ index) =>
    tokens[index + 1]?.type === "punct" &&
    ASSIGNMENTS.has(tokens[index + 1].value);
  const add = (
    /** @type {SiteKind} */ kind,
    /** @type {string} */ what,
    /** @type {number} */ index,
  ) => {
    found.push({ index, kind, what });
  };

  /**
   * The receiver of a member.
   *
   * @param {number} end index of the receiver's last token
   * @param {boolean} plain a name stands directly before the dot, and the member directly after it
   * @returns {{text: string, start: number, last: string}} start: index of its first token. last: the name it ends in; for the result of a call the name that was called
   */
  const receiver = (end, plain) => {
    if (plain) {
      // The chain of names that ends directly at the dot, as it stands.
      let start = end;
      while (
        isDot(start - 1) &&
        isName(start - 2) &&
        tokens[start - 2].end === tokens[start - 1].start &&
        tokens[start - 1].end === tokens[start].start
      )
        start -= 2;
      return {
        text: text.slice(tokens[start].start, tokens[end].end),
        start,
        last: tokens[end].value,
      };
    }
    /** @type {string[]} */
    const parts = [];
    let start = end + 1;
    let last = "";
    for (let at = end; at >= 0; ) {
      const token = tokens[at];
      if (is(at, ")") || is(at, "]")) {
        const open = match[at];
        if (open < 0) break;
        parts.push(token.value === ")" ? "()" : "[]");
        start = open;
        if (at === end && token.value === ")" && isName(open - 1))
          last = tokens[open - 1].value;
        // What was called, or indexed, belongs to the receiver.
        at = open - 1;
        if (
          (isName(at) && !STOPS.has(tokens[at].value)) ||
          is(at, ")") ||
          is(at, "]")
        )
          continue;
        break;
      }
      if (token.type === "string") {
        parts.push('""');
        start = at;
        break;
      }
      if (token.type !== "name" || STOPS.has(token.value)) break;
      parts.push(token.value);
      start = at;
      if (at === end) last = token.value;
      if (!isDot(at - 1)) break;
      parts.push(tokens[at - 1].value);
      at -= 2;
    }
    return { text: parts.reverse().join(""), start, last };
  };

  /** Is the expression that starts at this index only asked about: `typeof x.then`, `typeof (new Target().on)`? */
  const isAsked = (/** @type {number} */ start) => {
    let at = start - 1;
    while (isName(at, "new") || is(at, "(")) at -= 1;
    return isName(at, "typeof");
  };

  /** Is the `(` at this index the start of a parameter list? */
  const isParameters = (/** @type {number} */ paren) => {
    const close = match[paren];
    if (close < 0) return false;
    if (is(close + 1, "=>")) return true;
    return (
      is(close + 1, "{") &&
      !(isName(paren - 1) && CONTROLS.has(tokens[paren - 1].value))
    );
  };

  /** Is the name at this index, with its `(`, the head of a method or function that is being defined? */
  const isDefinition = (
    /** @type {number} */ name,
    /** @type {number} */ paren,
  ) => {
    const close = match[paren];
    if (close < 0 || !is(close + 1, "{")) return false;
    if (name === 0) return true;
    const before = tokens[name - 1];
    if (before.type === "name") return DEFINERS.has(before.value);
    return (
      before.type === "punct" &&
      ["{", "}", ";", ",", "*"].includes(before.value)
    );
  };

  /**
   * What the braces, or the square brackets, that start at this index are:
   * the names of an import or export, a destructuring pattern, or anything
   * else (an object, an array, a block, a class body).
   *
   * @param {number} brace
   * @returns {"module"|"pattern"|"other"}
   */
  const bracesKind = (brace) => {
    // A pattern inside a pattern: `{ net: { fetch } } = deps`, `[{ on }] = list`.
    let outer = brace;
    for (;;) {
      const next = around[outer];
      if (next < 0) break;
      if ((is(outer - 1, ":") && is(next, "{")) || is(next, "[")) outer = next;
      else break;
    }
    const close = match[outer];
    if (
      isName(outer - 1, "import") ||
      isName(outer - 1, "export") ||
      (close >= 0 && isName(close + 1, "from"))
    )
      return "module";
    if (
      close >= 0 &&
      (is(close + 1, "=") || isName(close + 1, "of") || isName(close + 1, "in"))
    )
      return "pattern";
    const paren = around[outer];
    return paren >= 0 &&
      is(paren, "(") &&
      isParameters(paren) &&
      (is(outer - 1, "(") || is(outer - 1, ","))
      ? "pattern"
      : "other";
  };

  /**
   * A call of a member.
   *
   * @param {string} name
   * @param {number} index offset of the name, for the order of the sites
   * @param {{text: string, start: number, last: string}} from the receiver
   * @param {number} paren index of the call's `(`
   */
  const member = (name, index, from, paren) => {
    if (isName(from.start - 1, "new") && !from.text.includes("()")) {
      // `new scope.Name(…)`: a constructor, not a call of a member.
      if (STREAMS.has(name))
        add("stream", `new ${from.text}.${name}`, tokens[from.start - 1].start);
      return;
    }
    let kind = MEMBER.get(name);
    if (
      kind === undefined &&
      (name === "sleep" || name === "every") &&
      /[cC]lock$/.test(from.last)
    )
      kind = "timer";
    if (kind === undefined) return;
    const what = `${from.text}.${name}`;
    const argument =
      kind === "listener" ? stringArgument(text, tokens[paren].end) : null;
    add(kind, argument === null ? what : `${what}("${argument}")`, index);
  };

  /** Is the member at this index written the plain way: name, dot, member, with nothing between them? */
  const isPlain = (/** @type {number} */ index) =>
    isName(index - 2) &&
    tokens[index - 2].end === tokens[index - 1].start &&
    tokens[index - 1].end === tokens[index].start;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // --- a call -------------------------------------------------------------
    if (is(i, "(")) {
      const callee = is(i - 1, "?.") ? i - 2 : i - 1;
      if (!isName(callee)) continue;
      const name = tokens[callee].value;
      const at = tokens[callee].start;
      if (isDot(callee - 1)) {
        settled.add(callee);
        member(name, at, receiver(callee - 2, isPlain(callee)), i);
      } else if (name === "import") {
        if (!isDefinition(callee, i)) add("import", "import", at);
      } else if (name === "await") {
        if (isName(callee - 1, "for"))
          add("iterate", "for await", tokens[callee - 1].start);
      } else if (isName(callee - 1, "new")) {
        settled.add(callee);
        if (STREAMS.has(name))
          add("stream", `new ${name}`, tokens[callee - 1].start);
      } else {
        settled.add(callee);
        const kind = isDefinition(callee, i) ? undefined : BARE.get(name);
        if (kind === undefined) continue;
        const argument =
          kind === "contract" || kind === "listener"
            ? stringArgument(text, token.end)
            : null;
        if (kind === "contract") add(kind, argument ?? "(computed)", at);
        else add(kind, argument === null ? name : `${name}("${argument}")`, at);
      }
      continue;
    }

    // --- an assignment to a member .on<name> ----------------------------------
    if (
      token.type === "name" &&
      isHandler(token.value) &&
      isDot(i - 1) &&
      assignedAfter(i)
    ) {
      settled.add(i);
      add(
        "listener",
        `${receiver(i - 2, isPlain(i)).text}.${token.value}=`,
        token.start,
      );
      continue;
    }

    // --- a member reached through brackets ------------------------------------
    if (is(i, "]")) {
      const open = match[i];
      if (open < 0) continue;
      const only = i - open === 2 ? tokens[open + 1] : undefined;
      // What the brackets are applied to ends here, also in `target?.[key]`.
      const end = is(open - 1, "?.") ? open - 2 : open - 1;
      const from = receiver(end, false);
      // Parentheses around the element do not change what is called:
      // `(handlers[type])(event)`.
      let last = i;
      for (
        let first = from.start;
        is(last + 1, ")") && match[last + 1] === first - 1;
        first -= 1
      )
        last += 1;
      const paren = callAfter(last);
      // Not a method that is defined under a computed name:
      // `get [Symbol.species]() {`.
      const called = paren >= 0 && !(last === i && isDefinition(open, paren));
      // An element of something, not an array that is written out.
      const element =
        called ||
        (paren < 0 &&
          end >= 0 &&
          ((isName(end) && !STOPS.has(tokens[end].value)) ||
            is(end, ")") ||
            is(end, "]") ||
            is(end, "`") ||
            tokens[end].type === "string"));
      if (!element) continue;
      if (only?.type === "string") {
        const key = text.slice(only.start + 1, only.end - 1);
        if (called) member(key, only.start, from, paren);
        else if (isHandler(key) && assignedAfter(i))
          add("listener", `${from.text}.${key}=`, only.start);
        else if (READS.has(key) && !assignedAfter(i) && !isAsked(from.start))
          refused.push({
            index: only.start,
            what: `["${key}"]`,
            why: WHY.read,
          });
      } else if (called && only?.type !== "number") {
        refused.push({
          index: tokens[open].start,
          what: "[…](",
          why: WHY.computed,
        });
      }
    }
  }

  // --- names that are used in a way the inventory cannot follow -------------
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "name" || settled.has(i)) continue;
    const name = token.value;
    const refuse = (/** @type {string} */ what, /** @type {string} */ why) =>
      refused.push({ index: token.start, what, why });

    if (isDot(i - 1)) {
      if (!READS.has(name) || assignedAfter(i)) continue;
      if (isAsked(receiver(i - 2, false).start)) continue;
      refuse(`.${name}`, WHY.read);
      continue;
    }
    if (ALIASES.has(name) && isName(i + 1, "as") && isName(i + 2)) {
      refuse(`${name} as ${tokens[i + 2].value}`, WHY.alias);
      continue;
    }
    if (!PATTERNS.has(name)) continue;
    // Declared here, or only asked about: `const fetch`, `typeof fetch`, `(fetch) =>`.
    if (isName(i - 1) && DECLARERS.has(tokens[i - 1].value)) continue;
    if (is(i + 1, "=>")) continue;
    const outer = around[i];
    if (outer >= 0 && is(outer, "{")) {
      const kind = bracesKind(outer);
      if (is(i - 1, "{") || is(i - 1, ",")) {
        // A key, or a name that stands for key and value.
        if (kind === "module") continue;
        if (kind === "pattern") {
          refuse(`{ ${name} }`, WHY.destructured);
          continue;
        }
        if (is(i + 1, ":")) continue;
        if (is(i + 1, ",") || is(i + 1, "}")) {
          if (VALUES.has(name)) refuse(name, WHY.value);
          continue;
        }
      } else if ((is(i - 1, ":") || is(i - 1, "...")) && kind === "pattern") {
        continue; // `{ request: fetch } = deps` declares fetch
      }
    }
    if (
      outer >= 0 &&
      is(outer, "[") &&
      (is(i - 1, "[") || is(i - 1, ",") || is(i - 1, "...")) &&
      bracesKind(outer) === "pattern"
    )
      continue; // `[fetch] = clients` declares fetch
    if (is(i + 1, "=")) continue; // a binding of that name gets its value
    if (
      outer >= 0 &&
      is(outer, "(") &&
      isParameters(outer) &&
      (is(i - 1, "(") || is(i - 1, ",") || is(i - 1, "...")) &&
      (is(i + 1, ",") || is(i + 1, ")"))
    )
      continue; // a parameter
    // Something of that name that is used as an object: `watch.close()`.
    if (isDot(i + 1) && !(isName(i + 2) && REBINDERS.has(tokens[i + 2].value)))
      continue;
    if (VALUES.has(name)) refuse(name, WHY.value);
  }

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

  found.sort((a, b) => a.index - b.index);
  refused.sort((a, b) => a.index - b.index);
  /** @type {Map<string, number>} */
  const counts = new Map();
  return {
    sites: found.map(({ index, kind, what }) => {
      const base = `${kind}:${what}`;
      if (kind === "contract")
        return { file, line: lineOf(index), kind, id: base };
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      return { file, line: lineOf(index), kind, id: `${base}#${n}` };
    }),
    unsupported: refused.map(({ index, what, why }) => ({
      file,
      line: lineOf(index),
      what,
      why,
    })),
  };
}

/**
 * Every site of one source file, in the order of the file.
 *
 * @param {string} text the source
 * @param {string} file path below v2/, for the result
 * @returns {Site[]}
 */
export function extractSites(text, file) {
  return inspect(text, file).sites;
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
 * @returns {{sites: Site[], unsupported: Unsupported[]}} every site of src/ and web/, and every use of a tracked name there that the inventory cannot follow
 */
export function survey(root = V2_ROOT) {
  /** @type {Site[]} */
  const sites = [];
  /** @type {Unsupported[]} */
  const unsupported = [];
  for (const part of SCANNED) {
    for (const path of jsFiles(resolve(root, part))) {
      const result = inspect(
        readFileSync(path, "utf8"),
        relative(root, path).split("\\").join("/"),
      );
      sites.push(...result.sites);
      unsupported.push(...result.unsupported);
    }
  }
  return { sites, unsupported };
}

/**
 * @param {string} [root] v2/
 * @returns {Site[]} every site of src/ and web/
 */
export function scan(root = V2_ROOT) {
  return survey(root).sites;
}

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Inventory One worker's file.
 * @property {string} owner "W1" … "W5"
 * @property {Row[]} rows sites that consume asynchronous input (or are named with the reason why they do not)
 * @property {string[]} none skeleton markers ("Class.method") whose body will consume no asynchronous input: pure, or synchronous, or a command's own flow
 * @property {Record<string, string>} [resolved] promised markers ("Class.method") whose body was written and consumes no asynchronous input after all, each with the reason (see NO SHRINKING)
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
 * @param {string} [path]
 * @returns {Promised[]} the markers that had a row; empty when the file does not exist
 */
export function loadPromised(path = PROMISED_PATH) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).promised ?? [];
}

/**
 * @param {string} site `<file>:<line>`
 * @returns {{file: string, line: number}}
 */
export function parseSite(site) {
  const at = site.lastIndexOf(":");
  return { file: site.slice(0, at), line: Number(site.slice(at + 1)) };
}

const siteKey = (/** @type {string} */ file, /** @type {string} */ id) =>
  `${file}\u0000${id}`;

/**
 * Code against inventory, both ways, and the inventory against what it
 * promised.
 *
 * @param {Site[]} sites
 * @param {Array<Pick<Inventory, "owner"|"rows"|"none"|"resolved">>} inventory
 * @param {Promised[]} [promised] the markers that had a row (promised.json)
 * @returns {{missing: Site[], vanished: Array<{owner: string, what: string}>, moved: Array<{owner: string, row: Row, line: number}>, twice: string[], shrunk: Array<Promised & {why: string}>}}
 * missing: a site without a row. vanished: a row, or a name in `none`, without a site. moved: a row whose line is not the site's. twice: a site with more than one row or name. shrunk: a promised marker whose row went without a row that takes its place.
 */
export function compare(sites, inventory, promised = []) {
  const byKey = new Map(
    sites.map((site) => [siteKey(site.file, site.id), site]),
  );
  /** Contract sites by name, for `none`. */
  const contracts = new Map(
    sites
      .filter((site) => site.kind === "contract")
      .map((site) => [site.id.slice("contract:".length), site]),
  );
  /** @type {Set<Site>} */
  const covered = new Set();
  /** @type {ReturnType<typeof compare>} */
  const result = {
    missing: [],
    vanished: [],
    moved: [],
    twice: [],
    shrunk: [],
  };
  const cover = (/** @type {Site} */ site) => {
    if (covered.has(site))
      result.twice.push(`${site.file}:${site.line} ${site.id}`);
    covered.add(site);
  };
  /** Sites that a row names. @type {Set<string>} */
  const rowed = new Set();
  /** `<file>\0<marker>` of every row that says which marker it took the place of, and whose site is there. @type {Set<string>} */
  const successors = new Set();
  for (const { owner, rows, none } of inventory) {
    for (const row of rows) {
      const { file, line } = parseSite(row.site);
      const site = byKey.get(siteKey(file, row.id));
      if (!site) {
        result.vanished.push({ owner, what: `${row.site} ${row.id}` });
        continue;
      }
      cover(site);
      rowed.add(siteKey(file, row.id));
      if (row.was) successors.add(siteKey(file, row.was));
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

  for (const entry of promised) {
    const reason = inventory.find(({ owner }) => owner === entry.owner)
      ?.resolved?.[entry.name];
    if (typeof reason === "string" && reason.trim() !== "") continue;
    const marker = siteKey(entry.file, `contract:${entry.name}`);
    if (byKey.has(marker)) {
      if (!rowed.has(marker))
        result.shrunk.push({
          ...entry,
          why: "the marker is still in the code and its row is gone",
        });
    } else if (!successors.has(siteKey(entry.file, entry.name))) {
      result.shrunk.push({
        ...entry,
        why: "the marker was replaced by a body, and no row says what took its place",
      });
    }
  }
  return result;
}

/**
 * The skeleton markers that have a row and are not in promised.json yet.
 *
 * @param {Site[]} sites
 * @param {Array<Pick<Inventory, "owner"|"rows">>} inventory
 * @param {Promised[]} promised
 * @returns {Promised[]}
 */
export function unpromised(sites, inventory, promised) {
  const present = new Set(sites.map((site) => siteKey(site.file, site.id)));
  const known = new Set(
    promised.map((entry) => siteKey(entry.file, entry.name)),
  );
  /** @type {Promised[]} */
  const fresh = [];
  for (const { owner, rows } of inventory) {
    for (const row of rows) {
      if (!row.id.startsWith("contract:")) continue;
      const { file } = parseSite(row.site);
      const name = row.id.slice("contract:".length);
      if (!present.has(siteKey(file, row.id))) continue;
      if (known.has(siteKey(file, name))) continue;
      known.add(siteKey(file, name));
      fresh.push({ name, file, owner });
    }
  }
  return fresh;
}

const PROMISED_NOTE =
  'Skeleton markers that have a row in the inventory: bodies that were said to consume asynchronous input. Written by `node dev/async-sites.js --promise`, which adds and never removes. When such a marker is replaced by a body, its owner\'s W<n>.json needs a row with "was": "<name>" for a site in the same file, or an entry in "resolved" that says why the body consumes none after all (dev/async-sites.js NO SHRINKING; test/contract/async-sites.test.js). Owner: core/state worker.';

/**
 * Add the skeleton markers that have a row to promised.json. Nothing is
 * ever removed from it.
 *
 * @param {Site[]} sites
 * @param {Array<Pick<Inventory, "owner"|"rows">>} inventory
 * @param {string} [path]
 * @returns {number} markers added
 */
export function promise(sites, inventory, path = PROMISED_PATH) {
  const known = loadPromised(path);
  const fresh = unpromised(sites, inventory, known);
  const all = [...known, ...fresh]
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        a.entry.owner.localeCompare(b.entry.owner) ||
        a.entry.file.localeCompare(b.entry.file) ||
        a.index - b.index,
    )
    .map(({ entry: { name, file, owner } }) => ({ name, file, owner }));
  writeFileSync(
    path,
    `${JSON.stringify({ "//": PROMISED_NOTE, promised: all }, null, 2)}\n`,
  );
  return fresh.length;
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
  const { sites, unsupported } = survey();
  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify(sites, null, 2)}\n`);
    return;
  }
  if (flags.has("--update")) {
    const changed = updateLines(sites);
    process.stdout.write(`${changed} line number(s) updated\n`);
  }
  if (flags.has("--promise")) {
    const added = promise(sites, loadInventory());
    process.stdout.write(`${added} marker(s) added to promised.json\n`);
  }
  const inventory = loadInventory();
  const promised = loadPromised();
  const difference = compare(sites, inventory, promised);
  const rows = new Map(
    inventory.flatMap(({ owner, rows: list }) =>
      list.map((row) => [
        siteKey(parseSite(row.site).file, row.id),
        { owner, row },
      ]),
    ),
  );
  if (!flags.has("--check")) {
    for (const site of sites) {
      if (site.kind === "contract" && !rows.has(siteKey(site.file, site.id)))
        continue; // a body that consumes no asynchronous input
      const entry = rows.get(siteKey(site.file, site.id));
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
  const others = [
    ...unsupported.map(
      ({ file, line, what, why }) =>
        `not supported: ${file}:${line} ${what}: ${why}`,
    ),
    ...difference.shrunk.map(
      ({ owner, name, file, why }) =>
        `${owner}: the inventory shrank: ${name} in ${file}: ${why}`,
    ),
    ...unpromised(sites, inventory, promised).map(
      ({ owner, name, file }) =>
        `${owner}: ${name} in ${file} has a row and is not in promised.json (node dev/async-sites.js --promise)`,
    ),
  ];
  const code = sites.filter((site) => site.kind !== "contract").length;
  process.stderr.write(
    `${sites.length} sites (${code} in code, ${sites.length - code} skeleton markers), ${rows.size} rows, ${problems.length} difference(s), ${unsupported.length} unsupported, ${difference.shrunk.length} shrunk\n`,
  );
  for (const problem of [...problems, ...others])
    process.stderr.write(`${problem}\n`);
  if (problems.length + others.length > 0) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
