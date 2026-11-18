/**
 * One-shot edge seed: the real migration CLI, filesystem and exit status.
 * Each named contract also runs against a source mutant that must fail the
 * same observation. Mutants and fixture copies live only in test/.out/.
 * Owner: W5 (fixtures + edge lane).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sharedPaths } from "../../src/scenes/v1-shared.js";
import { requireNetGuard } from "../helpers/harness.js";

const CLI = fileURLToPath(
  new URL("../../src/config/migrate-v1.js", import.meta.url),
);
const OUT = fileURLToPath(new URL("../.out/seed-v1/", import.meta.url));
const EDGE = "home/hsb1/pixdcon2-edge";
const SHARED = "home/hsb1/pixdcon";
const EDGE_FLAGS = ["--status-base-topic", EDGE];

async function fixture() {
  requireNetGuard();
  await mkdir(OUT, { recursive: true });
  const root = await mkdtemp(join(OUT, "case-"));
  const input = join(root, "v1-config-copy.json");
  const devices = [
    { name: "enabled-drive", enabled: true, output: "drive" },
    { name: "enabled-legacy", enabled: "true", output: "legacy-value" },
    { name: "disabled-drive", enabled: false, output: "drive" },
    { name: "disabled-shadow", enabled: "false", output: "shadow" },
    { name: "enabled-missing", enabled: true },
    { name: "enabled-object", enabled: true, output: { default: "drive" } },
  ].map((device, index) => ({
    ...device,
    type: index % 2 ? "ulanzi" : "pixoo",
    ip: "127.0.0.1",
    scenes: ["clock"],
  }));
  // Deliberate whitespace/Unicode: rewriting equivalent JSON still changes bytes.
  const source = Buffer.from(
    ` \n${JSON.stringify(
      {
        devices,
        scenes: { clock: { path: "scenes/pixoo/clock.js" } },
        mqtt: { baseTopic: SHARED, statusBaseTopic: SHARED },
        output: { default: "drive" },
        extra: { note: "seed copy · untouched" },
      },
      null,
      2,
    )}\n\n`,
  );
  // Keep this copy writable: the source-write mutant must really change it.
  await writeFile(input, source);
  return { input, data: join(root, "edge-data"), source, devices };
}

/** @param {string} command @param {string} input @param {string} data @param {string[]} [flags] */
function seed(command, input, data, flags = EDGE_FLAGS) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [command, input, data, ...flags],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

/** @param {string} command */
async function existingConfig(command) {
  const { input, data } = await fixture();
  await mkdir(data);
  const output = join(data, "config.json");
  const before = Buffer.from(
    '{\r\n  "existing": "keep these exact bytes"\r\n}\r\n',
  );
  await writeFile(output, before);
  const result = await seed(command, input, data);
  assert.equal(
    result.code,
    1,
    "existing config is refused with a non-zero exit",
  );
  assert.match(result.stderr, /already exists; refusing to overwrite/);
  assert.deepEqual(
    await readFile(output),
    before,
    "existing config stays byte-identical",
  );
}

/** @param {string} command */
async function allShadow(command) {
  const { input, data, devices } = await fixture();
  const result = await seed(command, input, data);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(await readFile(join(data, "config.json"), "utf8"));
  assert.deepEqual(
    config.devices.map((/** @type {any} */ device) => device.output),
    devices.map(() => "shadow"),
    "every device is seeded in shadow",
  );
  assert.deepEqual(
    config.devices.map((/** @type {any} */ device) => device.enabled),
    [true, true, false, false, true, true],
  );
  assert.equal(config.output.default, "shadow", "default output is shadow");
}

/** @param {string} command */
async function statusNamespace(command) {
  const { input, data } = await fixture();
  const refused = await seed(command, input, data, []);
  assert.equal(
    refused.code,
    1,
    "shared v1 namespace needs explicit acknowledgement",
  );
  assert.match(
    refused.stderr,
    /shadow controller status shares v1's base topic/,
  );
  await assert.rejects(access(data), { code: "ENOENT" });
  const isolated = await seed(command, input, data);
  assert.equal(isolated.code, 0, isolated.stderr);
  const config = JSON.parse(await readFile(join(data, "config.json"), "utf8"));
  assert.equal(
    config.mqtt.statusBaseTopic,
    EDGE,
    "edge status namespace is selected",
  );
  const acknowledged = await seed(command, input, `${data}-acknowledged`, [
    "--status-base-topic",
    SHARED,
  ]);
  assert.equal(
    acknowledged.code,
    0,
    "explicit shared namespace acknowledgement is accepted",
  );
  const shared = JSON.parse(
    await readFile(join(`${data}-acknowledged`, "config.json"), "utf8"),
  );
  assert.equal(shared.mqtt.statusBaseTopic, SHARED);
  assert.ok(
    JSON.parse(acknowledged.stdout).warnings.some(
      (/** @type {string} */ warning) =>
        /Controller status shares v1/.test(warning),
    ),
  );
}

/** @param {string} command */
async function sharedLinks(command) {
  const { input, data } = await fixture();
  const result = await seed(command, input, data);
  assert.equal(result.code, 0, result.stderr);
  const paths = sharedPaths();
  assert.equal(
    await readlink(join(data, "lib")).catch(() => null),
    paths.libDir,
    "lib link targets shared lib",
  );
  assert.equal(
    await readlink(join(data, "assets")).catch(() => null),
    paths.assetsDir,
    "assets link targets shared assets",
  );
}

/** @param {string} command */
async function inputUnchanged(command) {
  const { input, data, source } = await fixture();
  const result = await seed(command, input, data);
  assert.equal(result.code, 0, result.stderr);
  // Prove the migration ran and wrote a different config, then compare the copy.
  assert.notDeepEqual(await readFile(join(data, "config.json")), source);
  assert.deepEqual(
    await readFile(input),
    source,
    "input copy stays byte-identical",
  );
}

test("seed (a): an existing config.json is refused and stays byte-identical", () =>
  existingConfig(CLI));
test("seed (b): every device is shadow, including enabled devices and conflicting v1 outputs", () =>
  allShadow(CLI));
test("seed (c): the edge status topic is accepted; the shared v1 topic needs acknowledgement", () =>
  statusNamespace(CLI));
test("seed (d): lib and assets links point to the shared image resources", () =>
  sharedLinks(CLI));
test("seed (e): the input config copy stays byte-identical", () =>
  inputUnchanged(CLI));

/**
 * Materialize the actual CLI with a small behavior mutation, keeping its real
 * dependencies. An absent/ambiguous anchor fails outside the expected failure.
 * @param {string} name @param {[string, string][]} edits
 */
async function mutant(name, edits) {
  await mkdir(OUT, { recursive: true });
  const root = await mkdtemp(join(OUT, "mutant-"));
  let source = await readFile(CLI, "utf8");
  for (const [before, after] of edits) {
    assert.equal(
      source.split(before).length,
      2,
      `unique mutant anchor: ${name}`,
    );
    source = source.replace(before, after);
  }
  for (const specifier of ["../core/errors.js", "../scenes/v1-shared.js"]) {
    source = source.replaceAll(
      JSON.stringify(specifier),
      JSON.stringify(
        new URL(
          specifier,
          new URL("../../src/config/migrate-v1.js", import.meta.url),
        ).href,
      ),
    );
  }
  // An extensionless Node entrypoint keeps generated mutants out of lint/typecheck.
  const command = join(root, name);
  await writeFile(command, source);
  return command;
}

/** @type {{name: string, run: (command: string) => Promise<void>, edits: [string, string][], observation: string}[]} */
const MUTANTS = [
  {
    name: "a-truncate-before-refusing",
    run: existingConfig,
    edits: [
      [
        "await lstat(output);",
        'await open(output, "w").then((file) => file.close());',
      ],
    ],
    observation: "existing config stays byte-identical",
  },
  {
    name: "a-overwrite-existing",
    run: existingConfig,
    edits: [
      [
        'await lstat(output);\n    throw new ConfigError(\n      "Output config.json already exists; refusing to overwrite",\n    );',
        "await unlink(output);",
      ],
    ],
    observation: "existing config is refused with a non-zero exit",
  },
  {
    name: "b-preserve-v1-output",
    run: allShadow,
    edits: [["entry.output = requested;", "entry.output ??= requested;"]],
    observation: "every device is seeded in shadow",
  },
  {
    name: "b-leave-enabled-driving",
    run: allShadow,
    edits: [
      [
        "if (entry.output !== requested)",
        "if (!entry.enabled && entry.output !== requested)",
      ],
    ],
    observation: "every device is seeded in shadow",
  },
  {
    name: "b-default-to-drive",
    run: allShadow,
    edits: [
      [
        'const requested = options?.output ?? "shadow";',
        'const requested = options?.output ?? "drive";',
      ],
    ],
    observation: "every device is seeded in shadow",
  },
  {
    name: "c-allow-shared-without-acknowledgement",
    run: statusNamespace,
    edits: [
      [
        'requested === "shadow" && options?.statusBaseTopic === undefined',
        "false",
      ],
    ],
    observation: "shared v1 namespace needs explicit acknowledgement",
  },
  {
    name: "c-ignore-edge-topic",
    run: statusNamespace,
    edits: [
      [
        "mqtt.statusBaseTopic = options.statusBaseTopic;",
        `mqtt.statusBaseTopic = "${SHARED}";`,
      ],
    ],
    observation: "edge status namespace is selected",
  },
  {
    name: "c-refuse-explicit-acknowledgement",
    run: statusNamespace,
    edits: [
      [
        'requested === "shadow" && options?.statusBaseTopic === undefined',
        'requested === "shadow"',
      ],
    ],
    observation: "explicit shared namespace acknowledgement is accepted",
  },
  ...["lib", "assets"].map((name) => ({
    name: `d-missing-${name}-link`,
    run: sharedLinks,
    edits: /** @type {[string, string][]} */ ([
      [
        "  const temporary = join(dataDir, `.migrate-${randomUUID()}.tmp`);",
        `  await unlink(join(dataDir, "${name}"));\n  const temporary = join(dataDir, \`.migrate-\${randomUUID()}.tmp\`);`,
      ],
    ]),
    observation: `${name} link targets shared ${name}`,
  })),
  {
    name: "e-write-migrated-config-back-to-input",
    run: inputUnchanged,
    edits: [
      [
        '  const migrated = migrateV1Config(await readFile(input, "utf8"), options);',
        '  const migrated = migrateV1Config(await readFile(input, "utf8"), options);\n  const sourceFile = await open(input, "w");\n  await sourceFile.writeFile(migrated.text);\n  await sourceFile.close();',
      ],
    ],
    observation: "input copy stays byte-identical",
  },
];

for (const mutation of MUTANTS) {
  test(`seed must-fail mutant: ${mutation.name}`, async () => {
    const command = await mutant(mutation.name, mutation.edits);
    await assert.rejects(
      mutation.run(command),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.includes(mutation.observation),
      `the mutant must fail the same seed observation: ${mutation.observation}`,
    );
  });
}
