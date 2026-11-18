/** Test-only source structure. No product modules are modified on disk. */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

// Reuse the parser shipped in the required Node >=24 runtime. A v2-only
// install has no Acorn package; test-only work must not add a dependency.
const bundled = /** @type {any} */ (process).binding("natives")[
  "internal/deps/acorn/acorn/dist/acorn"
];
assert.equal(
  typeof bundled,
  "string",
  "re-anchor the Node-bundled Acorn loader after a Node runtime upgrade; preserve the AST and token audit checks",
);
const parserModule = { exports: /** @type {any} */ ({}) };
runInNewContext(
  bundled,
  { module: parserModule, exports: parserModule.exports },
  { filename: "node:bundled-acorn", timeout: 1000 },
);
const { parse, tokenizer } = parserModule.exports;
assert.equal(
  typeof parse,
  "function",
  "the Node-bundled source audit parser exports parse",
);

/** @param {any} node @param {(node: any, parent: any) => void} visit @param {any} [parent] */
export function walk(node, visit, parent = null) {
  if (!node?.type) return;
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      for (const child of value) walk(child, visit, node);
    else if (value && typeof value === "object") walk(value, visit, node);
  }
}

/** @param {string} source */
export const syntax = (source) =>
  parse(source, { ecmaVersion: "latest", sourceType: "module" });

/** Named and inline functions, including single-parameter arrows and methods.
 * @param {string} source */
export function functions(source) {
  /** @type {any[]} */ const out = [];
  walk(syntax(source), (node, parent) => {
    if (
      ![
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(node.type)
    )
      return;
    const name =
      node.id?.name ??
      (parent?.type === "VariableDeclarator"
        ? parent.id.name
        : parent?.type === "Property"
          ? (parent.key.name ?? parent.key.value)
          : null) ??
      `(callback@${node.start})`;
    out.push({
      name,
      at:
        parent?.type === "VariableDeclarator" || parent?.type === "Property"
          ? parent.start
          : node.start,
      params: node.params.map((/** @type {any} */ p) => p.name).filter(Boolean),
      start: node.body.start,
      end: node.body.end - 1,
      caller:
        parent?.type === "CallExpression"
          ? (parent.callee.property?.name ?? parent.callee.name)
          : null,
    });
  });
  return out;
}

/** A unique token anchor survives formatting/comments; changed semantics
 * require the precise reviewed re-anchor described by the caller.
 * @param {string} source @param {string} fragment @param {string} hint */
export function sourceAnchor(source, fragment, hint) {
  if (source.includes(fragment)) return fragment;
  const tokens = (/** @type {string} */ text) => [
    ...tokenizer(text, { ecmaVersion: "latest", sourceType: "module" }),
  ];
  const same = (/** @type {any} */ token) =>
    JSON.stringify([token.type.label, token.value]);
  let all, needle;
  try {
    all = tokens(source);
    needle = tokens(fragment).map(same);
  } catch {
    assert.fail(
      `${hint}\nCannot tokenize the reviewed source fragment:\n${fragment}`,
    );
  }
  const matches = all.filter(
    (_, at) =>
      needle.length &&
      needle.every((token, i) => all[at + i] && same(all[at + i]) === token),
  );
  assert.equal(
    matches.length,
    1,
    `${hint}\nReviewed source fragment:\n${fragment}`,
  );
  const first = matches[0],
    at = all.indexOf(first);
  return source.slice(first.start, all[at + needle.length - 1].end);
}

/** Every imported HTTP/frame request expression, including aliases. A new
 * call in an already-covered function is still a new operation source.
 * @param {Array<{file: string, src: string}>} files */
export function requestSites(files) {
  /** @type {any[]} */ const sites = [];
  for (const { file, src } of files) {
    const ast = syntax(src),
      requests = new Set(),
      frames = new Set(),
      namespaces = new Set();
    const isMethod = (/** @type {any} */ node, /** @type {string} */ name) =>
      member(node) === name && namespaces.has(node.object?.name);
    walk(ast, (node) => {
      if (
        node.type === "ImportDeclaration" &&
        /(?:^|\/)api\.js$/.test(node.source.value)
      )
        for (const spec of node.specifiers) {
          if (spec.imported?.name === "request") requests.add(spec.local.name);
          if (spec.imported?.name === "requestFrame")
            frames.add(spec.local.name);
          if (spec.type === "ImportNamespaceSpecifier")
            namespaces.add(spec.local.name);
        }
    });
    for (let changed = true; changed; ) {
      changed = false;
      walk(ast, (node) => {
        if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier")
          return;
        for (const [
          set,
          method,
        ] of /** @type {Array<[Set<string>, string]>} */ ([
          [requests, "request"],
          [frames, "requestFrame"],
          [namespaces, ""],
        ]))
          if (
            (set.has(node.init?.name) ||
              (method && isMethod(node.init, method))) &&
            !set.has(node.id.name)
          ) {
            set.add(node.id.name);
            changed = true;
          }
      });
    }
    walk(ast, (node) => {
      if (
        node.type !== "CallExpression" ||
        (!requests.has(node.callee.name) &&
          !frames.has(node.callee.name) &&
          !isMethod(node.callee, "request") &&
          !isMethod(node.callee, "requestFrame"))
      )
        return;
      const call = src.slice(node.start, node.end).replace(/\s+/g, " ");
      const ordinal = sites.filter(
        (site) => site.file === file && site.call === call,
      ).length;
      sites.push({
        file,
        at: node.start,
        end: node.end,
        callee: src.slice(node.callee.start, node.callee.end),
        frame:
          frames.has(node.callee.name) || isMethod(node.callee, "requestFrame"),
        call,
        site: `${file} · ${call} · occurrence ${ordinal}`,
      });
    });
  }
  return sites;
}
/** @param {any} node */
const member = (node) =>
  node?.type === "MemberExpression"
    ? node.computed
      ? node.property.value
      : node.property.name
    : null;
/** @param {string} file @param {string} spec */
function resolve(file, spec) {
  const parts = file.split("/");
  parts.pop();
  for (const part of spec.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** Follow state/registry aliases (including destructuring) and cross-module
 * function-valued options. The callback must be called in an extracted async
 * continuation or one of its followed helper spans; spelling on* is irrelevant.
 * @param {Array<{file: string, src: string}>} files @param {any[]} inventory */
export function structure(files, inventory) {
  const modules = files.map((file) => ({
    ...file,
    ast: syntax(file.src),
    nodes: /** @type {any[]} */ ([]),
    imports: new Map(),
    bindings: new Map(),
    registry: /** @type {any[]} */ ([]),
    callbacks: /** @type {any[]} */ ([]),
  }));
  for (const m of modules) {
    walk(m.ast, (node, parent) => {
      m.nodes.push({ node, parent });
      if (node.type === "ImportDeclaration")
        for (const spec of node.specifiers) {
          m.imports.set(spec.local.name, resolve(m.file, node.source.value));
          m.bindings.set(spec.local.name, {
            file: resolve(m.file, node.source.value),
            imported: spec.imported?.name ?? "*",
          });
        }
    });
    for (let changed = true; changed; ) {
      changed = false;
      for (const { node } of m.nodes)
        if (
          node.type === "VariableDeclarator" &&
          node.id.type === "Identifier" &&
          m.imports.has(node.init?.name) &&
          !m.imports.has(node.id.name)
        ) {
          m.imports.set(node.id.name, m.imports.get(node.init.name));
          m.bindings.set(node.id.name, m.bindings.get(node.init.name));
          changed = true;
        }
    }
    const states = new Set(["state"]),
      registries = new Set();
    const stateFactories = new Set([
      "getState",
      ...[...m.bindings]
        .filter(
          ([, binding]) =>
            binding.imported === "getState" &&
            binding.file.endsWith("/store.js"),
        )
        .map(([name]) => name),
    ]);
    const isState = (/** @type {any} */ node) =>
      states.has(node?.name) ||
      (node?.type === "CallExpression" &&
        (stateFactories.has(node.callee.name) ||
          (member(node.callee) === "getState" &&
            m.imports.get(node.callee.object?.name)?.endsWith("/store.js"))));
    const isRegistry = (/** @type {any} */ node) =>
      registries.has(node?.name) ||
      (member(node) === "ops" && isState(node.object));
    for (let changed = true; changed; ) {
      changed = false;
      for (const { node } of m.nodes) {
        if (node.type !== "VariableDeclarator") continue;
        const add = (
          /** @type {Set<string>} */ set,
          /** @type {string} */ name,
        ) => {
          if (name && !set.has(name)) {
            set.add(name);
            changed = true;
          }
        };
        if (node.id.type === "Identifier") {
          if (isState(node.init)) add(states, node.id.name);
          if (isRegistry(node.init)) add(registries, node.id.name);
        } else if (node.id.type === "ObjectPattern" && isState(node.init))
          for (const property of node.id.properties)
            if ((property.key?.name ?? property.key?.value) === "ops")
              add(registries, property.value.name);
      }
    }
    for (const { node, parent } of m.nodes) {
      if (!isRegistry(node)) continue;
      if (
        m.nodes.some(
          ({ node: declaration }) =>
            declaration.type === "VariableDeclarator" &&
            declaration.id.start <= node.start &&
            node.end <= declaration.id.end,
        )
      )
        continue;
      if (
        (parent?.type === "VariableDeclarator" && parent.init === node) ||
        (parent?.type === "MemberExpression" && parent.property === node) ||
        (parent?.type === "Property" && parent.key === node)
      )
        continue;
      if (parent?.type === "MemberExpression" && isRegistry(parent)) continue;
      m.registry.push({ at: node.start, end: node.end });
    }
  }
  for (const m of modules)
    for (const { node } of m.nodes) {
      if (node.type !== "CallExpression") continue;
      const target = modules.find(
        (other) =>
          other.file ===
          m.imports.get(node.callee.name ?? node.callee.object?.name),
      );
      if (!target) continue;
      for (let arg of node.arguments) {
        if (arg.type === "Identifier")
          arg =
            m.nodes
              .filter(
                ({ node: declaration }) =>
                  declaration.type === "VariableDeclarator" &&
                  declaration.id.name === arg.name &&
                  declaration.start < node.start,
              )
              .at(-1)?.node.init ?? arg;
        if (arg.type !== "ObjectExpression") continue;
        for (const property of arg.properties) {
          let fn = property.value;
          let writer = m;
          if (fn?.type === "Identifier") {
            const binding = m.bindings.get(fn.name);
            if (binding && binding.imported !== "*")
              writer =
                modules.find((other) => other.file === binding.file) ?? m;
            const name = binding && writer !== m ? binding.imported : fn.name;
            fn = writer.nodes.find(
              ({ node: candidate }) =>
                (candidate.type === "FunctionDeclaration" &&
                  candidate.id?.name === name) ||
                (candidate.type === "VariableDeclarator" &&
                  candidate.id?.name === name),
            )?.node;
          }
          if (fn?.type === "VariableDeclarator") fn = fn.init;
          if (
            !fn ||
            ![
              "FunctionExpression",
              "ArrowFunctionExpression",
              "FunctionDeclaration",
            ].includes(fn.type)
          )
            continue;
          const name = property.key.name ?? property.key.value;
          const aliases = new Set([name]);
          for (let changed = true; changed; ) {
            changed = false;
            for (const { node: declaration } of target.nodes) {
              if (declaration.type !== "VariableDeclarator") continue;
              const add = (/** @type {string} */ alias) => {
                if (alias && !aliases.has(alias)) {
                  aliases.add(alias);
                  changed = true;
                }
              };
              if (
                declaration.id.type === "Identifier" &&
                (member(declaration.init) === name ||
                  aliases.has(declaration.init?.name))
              )
                add(declaration.id.name);
              if (declaration.id.type === "ObjectPattern")
                for (const p of declaration.id.properties)
                  if ((p.key?.name ?? p.key?.value) === name) add(p.value.name);
            }
          }
          const calls = target.nodes.filter(
            ({ node: call }) =>
              call.type === "CallExpression" &&
              (member(call.callee) === name || aliases.has(call.callee.name)) &&
              inventory.some(
                (row) =>
                  row.file === target.file &&
                  [row.range, ...row.spans].some(
                    ([from, to]) => from <= call.start && call.end - 1 <= to,
                  ),
              ),
          );
          if (calls.length)
            writer.callbacks.push({
              name,
              at: fn.body.start,
              end: fn.body.end - 1,
              target: target.file,
            });
        }
      }
    }
  return modules;
}
