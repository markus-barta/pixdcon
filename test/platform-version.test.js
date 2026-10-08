import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadVersion, scheme, validateReleaseTag, validateVersion, version } from "../lib/version.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const record = (value, versionScheme = "inspr-calver-3") => ({ version: value, version_scheme: versionScheme });

test("the authoritative coordinate and explicit scheme are loaded from version.json", async () => {
  const source = JSON.parse(await readFile(new URL("../version.json", import.meta.url), "utf-8"));
  assert.deepEqual(loadVersion(), { version: source.version, scheme: source.version_scheme });
  assert.equal(scheme, "inspr-calver-3");
  assert.ok(Object.isFrozen(loadVersion()));
});

test("v2 validation accepts real Gregorian dates across the supported century", () => {
  for (const value of ["100101000000.0.0", "260909113550.0.0", "261231235959.0.0", "280229120000.0.0", "991231235959.0.0"]) {
    assert.equal(validateVersion(record(value)).version, value);
  }
});

test("v2 rejects invalid dates, legacy schemes, suffixes and non-canonical strings", () => {
  for (const value of [
    "1.1.1", "26.09.09", "26.09.09.11.35.50", "20260909113550.0.0",
    "2609091135.0.0", "260909113550", "260909113550.0.1", "260909113550.1.0",
    "260909113550.0.0-rc1", "260909113550.0.0+sha", "260909240000.0.0",
    "260909116000.0.0", "260909113560.0.0", "260229120000.0.0", "260431120000.0.0",
    "260200120000.0.0", "261301120000.0.0", "090909113550.0.0", "000101000000.0.0",
    "v260909113550.0.0", " 260909113550.0.0", "260909113550.0.0\n", "２６0909113550.0.0",
    null, 260909113550, {},
  ]) {
    assert.throws(() => validateVersion(record(value)), /Invalid version.json/);
  }
  for (const value of [undefined, null, "", "legacy", "inspr-calendar-v1", "inspr-calendar-v2", "semver"]) {
    assert.throws(() => validateVersion({ version, version_scheme: value }), /version_scheme/);
  }
  for (const value of [null, [], version, {}]) assert.throws(() => validateVersion(value), /Invalid version.json/);
});

test("startup fails closed when the version record is missing, invalid or ambiguous", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pixd-platform-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "lib"));
  await copyFile(new URL("../lib/version.js", import.meta.url), join(dir, "lib/version.js"));
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  const run = () => spawnSync(process.execPath, ["--input-type=module", "--eval",
    `await import(${JSON.stringify(pathToFileURL(join(dir, "lib/version.js")).href)})`], { encoding: "utf-8" });
  let result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid version.json: cannot read/);
  for (const source of ["{", JSON.stringify({ version }), JSON.stringify(record(version, "legacy")), JSON.stringify(record("260229120000.0.0"))]) {
    await writeFile(join(dir, "version.json"), source);
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid version.json/);
  }
  await writeFile(join(dir, "version.json"), JSON.stringify(record(version)));
  assert.equal(run().status, 0);
});

test("release tags must exactly match the validated authoritative coordinate", () => {
  assert.deepEqual(validateReleaseTag(`v${version}`, record(version)), { version, scheme });
  for (const tag of [version, "v1.1.1", "v260909113550.0.0", `vv${version}`, `v${version}\n`, `refs/tags/v${version}`, `v${version}-rc1`]) {
    assert.throws(() => validateReleaseTag(tag, record(version)), /Release tag must match version.json/);
  }
  assert.throws(() => validateReleaseTag("v1.1.1", record("1.1.1")), /Invalid version.json/);
});

test("release consistency CLI rejects mismatches before publishing", () => {
  const run = (...args) => spawnSync(process.execPath, ["scripts/verify-versioning.mjs", ...args], { cwd: root, encoding: "utf-8" });
  for (const args of [[], ["--tag", `v${version}`]]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
  }
  const mismatch = run("--tag", "v1.1.1");
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /Release tag must match version.json/);
  assert.equal(run("--tag").status, 1);
  assert.equal(run("--unknown").status, 1);
});

test("local build publishes the exact version and OCI metadata, rejecting arbitrary tags", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pixd-platform-build-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const docker = join(dir, "docker");
  await writeFile(docker, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.PIXDCON_DOCKER_TEST_LOG, JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  let i = 0;
  for (const args of [[], [version], [`v${version}`], ["latest"], ["v1.1.1"], [version, "extra"]]) {
    const log = join(dir, `args-${i++}.json`);
    const result = spawnSync("bash", ["scripts/build-and-push.sh", ...args], {
      cwd: root, encoding: "utf-8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PIXDCON_DOCKER_TEST_LOG: log },
    });
    if (args.length <= 1 && (!args.length || args[0] === version || args[0] === `v${version}`)) {
      assert.equal(result.status, 0, result.stderr);
      const command = JSON.parse(await readFile(log, "utf-8"));
      assert.ok(command.includes(`ghcr.io/markus-barta/pixdcon:${version}`));
      assert.ok(command.includes(`org.opencontainers.image.version=${version}`));
      assert.ok(command.includes("org.opencontainers.image.version_scheme=inspr-calver-3"));
      assert.ok(command.includes("linux/amd64,linux/arm64"));
    } else {
      assert.notEqual(result.status, 0);
      await assert.rejects(readFile(log), { code: "ENOENT" });
    }
  }
});
