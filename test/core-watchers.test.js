import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigWatcher } from "../lib/config-watcher.js";
import { ScenesWatcher } from "../lib/scenes-watcher.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const tempDirs = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function waitFor(check) {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("watch event did not arrive");
    await delay(25);
  }
}

test("config watcher observes consecutive atomic replacements once each", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pixd47-core-config-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  await writeFile(path, "one");
  const changes = [];
  const watcher = new ConfigWatcher(path, async (content) => changes.push(content), { logger });
  await watcher.start();
  try {
    for (const content of ["two", "three"]) {
      const temp = join(dir, "save.tmp");
      await writeFile(temp, content);
      await rename(temp, path);
      await waitFor(() => changes.includes(content));
    }
    await writeFile(path, "three");
    await delay(650);
    assert.deepEqual(changes, ["two", "three"]);
  } finally {
    await watcher.stop();
  }
});

test("scene watcher activates directories created after startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pixd47-core-scenes-"));
  tempDirs.push(dir);
  const missing = join(dir, "generated-scenes", "pixoo");
  const changes = [];
  const watcher = new ScenesWatcher([missing], async (filename, directory) => {
    changes.push({ filename, directory });
  }, { logger });
  watcher.start();
  try {
    await mkdir(missing, { recursive: true });
    await writeFile(join(missing, "clock.js"), "one");
    await waitFor(() => changes.length > 0);
    assert.ok(changes.some((change) => change.filename === "clock.js" && change.directory === missing));
    changes.length = 0;
    await writeFile(join(missing, "clock.js"), "two");
    await waitFor(() => changes.length > 0);
    await delay(1300);
    assert.equal(changes.length, 1);
  } finally {
    watcher.stop();
  }
});

test("config watch recovers when the replacement file arrives after debounce", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pixd47-core-config-gap-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  await writeFile(path, "old");
  const changes = [];
  const watcher = new ConfigWatcher(path, async (content) => changes.push(content), { logger });
  await watcher.start();
  try {
    await rename(path, join(dir, "old.json"));
    await delay(700);
    await writeFile(path, "new");
    await waitFor(() => changes.includes("new"));
    await writeFile(path, "last");
    await waitFor(() => changes.includes("last"));
    assert.deepEqual(changes, ["new", "last"]);
  } finally {
    await watcher.stop();
  }
});
