import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebServer } from "../lib/web-server.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(scene = "home") {
  const root = await mkdtemp(join(tmpdir(), "pixd47-web-clone-"));
  await mkdir(join(root, "scenes/pixoo"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  for (const name of ["lib", "assets", "node_modules"]) {
    await symlink(join(repo, name), join(root, name));
  }
  await copyFile(join(repo, `scenes/pixoo/${scene}.js`), join(root, `scenes/pixoo/${scene}.js`));
  const config = {
    devices: [{ name: "pixoo-01", type: "pixoo", ip: "127.0.0.1", scene }],
    scenes: { [scene]: { path: `./scenes/pixoo/${scene}.js` } },
  };
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const server = new WebServer({ configPath, getEffectiveConfig: () => config });
  return { root, config, configPath, server };
}

test("cloned home imports at /data depth with its new metadata and original assets", async () => {
  const { root, config, configPath, server } = await fixture();
  const result = await server._cloneScene({
    sceneName: "home", targetSceneKey: "home_copy", targetPrettyName: 'Home "$&" copy',
  });
  assert.deepEqual(result, {
    ok: true, sceneKey: "home_copy", path: "./generated-scenes/pixoo/home_copy.js",
  });
  const clonePath = resolve(root, result.path);
  const clone = await import(pathToFileURL(clonePath));
  assert.equal(clone.default.name, "home_copy");
  assert.equal(clone.default.pretty_name, 'Home "$&" copy');
  assert.equal(typeof clone.default.render, "function");
  assert.equal(config.devices[0].scene, "home");
  const saved = JSON.parse(await readFile(configPath, "utf-8"));
  assert.equal(saved.scenes.home_copy.path, result.path);
  assert.equal(saved.devices[0].scene, "home");
  const backups = await readdir(join(root, "generated-scenes/_backups"));
  assert.equal(backups.length, 1);
  assert.equal(
    await readFile(join(root, "generated-scenes/_backups", backups[0]), "utf-8"),
    await readFile(join(root, "scenes/pixoo/home.js"), "utf-8"),
  );
});

test("metadata edits target the default export without altering nested names", async () => {
  const { root, server } = await fixture();
  await writeFile(join(root, "scenes/pixoo/home.js"), `
const helper = { name: "keep-name", pretty_name: "keep-label" };
export default {
  helper,
  settingsSchema: { nested: { name: "keep-nested" } },
  name: "home",
  pretty_name: "old label",
  render() {},
};
`);
  const result = await server._cloneScene({
    sceneName: "home", targetSceneKey: "separate", targetPrettyName: "New label",
  });
  const clone = await import(pathToFileURL(resolve(root, result.path)));
  assert.equal(clone.default.name, "separate");
  assert.equal(clone.default.pretty_name, "New label");
  assert.deepEqual(clone.default.helper, { name: "keep-name", pretty_name: "keep-label" });
  assert.equal(clone.default.settingsSchema.nested.name, "keep-nested");
});

test("health clone keeps collector labels while renaming the scene", async () => {
  const { root, server } = await fixture("health");
  const result = await server._cloneScene({ sceneName: "health", targetSceneKey: "health_copy" });
  const clonePath = resolve(root, result.path);
  const clone = await import(pathToFileURL(clonePath));
  assert.equal(clone.default.name, "health_copy");
  assert.match(await readFile(clonePath, "utf-8"), /name: "Boiler Shelly"/);
});

test("clone rejects unsafe keys and invalid field types before creating files", async () => {
  const { root, configPath, server } = await fixture();
  const original = await readFile(configPath, "utf-8");
  for (const key of ["../escape", "../../escape", "/tmp/escape", "a/b", "a\\b", "", "__proto__", "constructor", null, 42, {}]) {
    await assert.rejects(
      server._cloneScene({ sceneName: "home", targetSceneKey: key }),
      { statusCode: 400 },
    );
  }
  await assert.rejects(server._cloneScene({ sceneName: "../home", overwrite: true }), { statusCode: 400 });
  await assert.rejects(server._cloneScene({ sceneName: "home", overwrite: "false" }), { statusCode: 400 });
  await assert.rejects(server._cloneScene({ sceneName: "home", targetSceneKey: "copy", targetPrettyName: {} }), { statusCode: 400 });
  await assert.rejects(readdir(join(root, "generated-scenes")), { code: "ENOENT" });
  assert.equal(await readFile(configPath, "utf-8"), original);
});

test("clone rejects existing keys and files without destroying either", async () => {
  const { root, configPath, server } = await fixture();
  await assert.rejects(server._cloneScene({ sceneName: "home", targetSceneKey: "home" }), { statusCode: 409 });
  await mkdir(join(root, "generated-scenes/pixoo"), { recursive: true });
  const orphan = join(root, "generated-scenes/pixoo/orphan.js");
  await writeFile(orphan, "keep this file");
  await assert.rejects(server._cloneScene({ sceneName: "home", targetSceneKey: "orphan" }), { statusCode: 409 });
  assert.equal(await readFile(orphan, "utf-8"), "keep this file");
  assert.equal(JSON.parse(await readFile(configPath, "utf-8")).scenes.orphan, undefined);
});

test("concurrent clones preserve both registrations and collide safely", async () => {
  const { configPath, server } = await fixture();
  await Promise.all([
    server._cloneScene({ sceneName: "home", targetSceneKey: "copy_a" }),
    server._cloneScene({ sceneName: "home", targetSceneKey: "copy_b" }),
  ]);
  const saved = JSON.parse(await readFile(configPath, "utf-8"));
  assert.ok(saved.scenes.copy_a);
  assert.ok(saved.scenes.copy_b);
  const collisions = await Promise.allSettled([
    server._cloneScene({ sceneName: "home", targetSceneKey: "shared" }),
    server._cloneScene({ sceneName: "home", targetSceneKey: "shared" }),
  ]);
  assert.equal(collisions.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(collisions.find((r) => r.status === "rejected").reason.statusCode, 409);
});

test("overwrite retains source scene identity and re-cloning a clone imports", async () => {
  const { root, configPath, server } = await fixture();
  const overwritten = await server._cloneScene({ sceneName: "home", overwrite: true, targetPrettyName: "Detached" });
  const first = await import(pathToFileURL(resolve(root, overwritten.path)));
  assert.equal(first.default.name, "home");
  assert.equal(first.default.pretty_name, "Detached");
  const fromOriginal = await server._cloneScene({ sceneName: "home", targetSceneKey: "copy_a" });
  assert.equal(fromOriginal.path, "./generated-scenes/pixoo/copy_a.js");
  assert.equal((await import(pathToFileURL(resolve(root, fromOriginal.path)))).default.pretty_name, "Detached");
  const again = await server._cloneScene({ sceneName: "copy_a", targetSceneKey: "copy_b" });
  const clone = await import(pathToFileURL(resolve(root, again.path)));
  assert.equal(clone.default.name, "copy_b");
  assert.ok(JSON.parse(await readFile(configPath, "utf-8")).scenes.copy_b);
});

test("clone uses the active overlay source and honors later overlay changes", async () => {
  const { root, config, server } = await fixture();
  const effective = JSON.parse(JSON.stringify(config));
  const activePath = "./scenes/pixoo/active.js";
  await writeFile(resolve(root, activePath), 'export default { name: "home", marker: "active", render() {} };\n');
  effective.scenes.home.path = activePath;
  server.getEffectiveConfig = () => effective;
  const first = await server._cloneScene({ sceneName: "home", overwrite: true });
  assert.equal((await import(pathToFileURL(resolve(root, first.path)))).default.marker, "active");
  const nextPath = "./scenes/pixoo/next.js";
  await writeFile(resolve(root, nextPath), 'export default { name: "home", marker: "next", render() {} };\n');
  effective.scenes.home.path = nextPath;
  const next = await server._cloneScene({ sceneName: "home", targetSceneKey: "from_overlay" });
  assert.equal((await import(pathToFileURL(resolve(root, next.path)))).default.marker, "next");
});
