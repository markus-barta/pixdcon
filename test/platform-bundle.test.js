import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PIN, verifyVersioningBundle } from "../scripts/verify-versioning-bundle.mjs";

const source = fileURLToPath(new URL("../vendor/inspr-versioning/", import.meta.url));

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pixd-platform-bundle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundle = join(dir, "bundle");
  await cp(source, bundle, { recursive: true });
  return { dir, bundle };
}

test("the offline bundle verifies its complete manifest and independent source/config pins", async () => {
  const manifest = await verifyVersioningBundle();
  assert.equal(manifest.revision, PIN.revision);
  assert.equal(manifest.expectedConfigSha256, PIN.configSha256);
  assert.ok(manifest.files.some((file) => file.outputPath === "version-interaction.js"));
  assert.ok(manifest.files.some((file) => file.outputPath === "schemes.json"));
  assert.ok(manifest.files.some((file) => file.outputPath === "LICENSE" && file.sourcePath === "LICENSE"));
});

test("bundle verification rejects same-size config edits and altered payload sizes", async (t) => {
  const { bundle } = await fixture(t);
  const config = join(bundle, "display.json");
  const original = await readFile(config, "utf-8");
  const altered = original.replace("#d69b31", "#d69b32");
  assert.notEqual(altered, original);
  assert.equal(Buffer.byteLength(altered), Buffer.byteLength(original));
  await writeFile(config, altered);
  await assert.rejects(verifyVersioningBundle(bundle), /payload mismatch/);
  await writeFile(config, original);
  await writeFile(join(bundle, "version.js"), "// extra bytes\n", { flag: "a" });
  await assert.rejects(verifyVersioningBundle(bundle), /payload mismatch/);
});

test("bundle verification rejects missing files, hidden extras and extra directories", async (t) => {
  for (const change of [
    (bundle) => rm(join(bundle, "presentation.js")),
    (bundle) => writeFile(join(bundle, ".untracked"), "extra"),
    (bundle) => mkdir(join(bundle, "extra")),
  ]) {
    const { bundle } = await fixture(t);
    await change(bundle);
    await assert.rejects(verifyVersioningBundle(bundle), /missing or extra files/);
  }
});

test("a rehashed candidate manifest cannot bless modified bundle bytes", async (t) => {
  const { bundle } = await fixture(t);
  const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf-8"));
  manifest.files[0].sha256 = "0".repeat(64);
  await writeFile(join(bundle, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyVersioningBundle(bundle), /manifest digest mismatch/);
});

test("bundle verification refuses symlinked roots, manifests and payloads", async (t) => {
  const { dir } = await fixture(t);
  const linkedRoot = join(dir, "linked-bundle");
  await symlink(source, linkedRoot);
  await assert.rejects(verifyVersioningBundle(linkedRoot), /regular directory/);
  for (const file of ["manifest.json", "version.js"]) {
    const { bundle } = await fixture(t);
    await rm(join(bundle, file));
    await symlink(join(source, file), join(bundle, file));
    await assert.rejects(verifyVersioningBundle(bundle), /regular file/);
  }
});
