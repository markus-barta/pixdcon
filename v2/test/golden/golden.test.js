/**
 * Test kind 1 of 3: fixed screen images per scene (golden frames).
 *
 * What exists now proves the harness: the comparison is exact, the stored
 * frames are readable, and every shared v1 scene loads inside v2's process.
 * Phase 3 (fixtures + edge lane worker) adds one scenario file per case under
 * fixtures/ and its frame under frames/, and replaces the todo entries below.
 *
 * How a scenario runs (test/helpers/golden.js GoldenScenario): the clock and
 * the timers are frozen at `now` in `timeZone`, the scene is loaded through
 * the v1 adapter with `settings`, the `mqtt` messages are delivered, `http`
 * answers the scene's own requests, `frames` frames are rendered into the
 * scene surface, and the last one is compared: Pixoo as a 64×64 picture,
 * Ulanzi as the AWTRIX payload plus its rasterised 32×8 picture.
 * The reference pictures are produced once with v1's own driver code, so
 * "v2 draws what v1 draws" is what the test says.
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  installSharedResolution,
  sharedPaths,
} from "../../src/scenes/v1-shared.js";
import {
  FIXTURES_DIR,
  decodePng,
  encodePng,
  expectFrame,
  loadScenario,
} from "../helpers/golden.js";
import { requireNetGuard } from "../helpers/harness.js";

/** A picture that exercises every channel and both axes. */
function testCard(width = 64, height = 64) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rgb[i] = Math.round((x / (width - 1)) * 255);
      rgb[i + 1] = Math.round((y / (height - 1)) * 255);
      rgb[i + 2] = (x + y) % 2 === 0 ? 255 : 0;
    }
  }
  return { width, height, rgb };
}

test("harness: a frame survives PNG encoding byte for byte", async () => {
  requireNetGuard();
  const frame = testCard();
  const decoded = await decodePng(await encodePng(frame));
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 64);
  assert.deepEqual(decoded.rgb, frame.rgb);
});

test("harness: the stored golden frame matches, and one changed pixel is caught", async () => {
  const frame = testCard();
  await expectFrame("harness--test-card-64x64", frame);
  if (process.env.UPDATE_GOLDEN === "1") return;

  const changed = { ...frame, rgb: frame.rgb.slice() };
  changed.rgb[(10 * 64 + 3) * 3] ^= 0xff;
  await assert.rejects(
    () => expectFrame("harness--test-card-64x64", changed),
    /1 pixel\(s\) differ, first at x3 y10/,
  );
});

test("harness: every shared v1 scene loads in v2's process", async () => {
  // lib/pixoo-image.js imports `sharp`; in a checkout only v2/node_modules has it.
  installSharedResolution();
  const { scenesDir } = sharedPaths();
  const files = [
    "ulanzi/clock.js",
    "ulanzi/clock_with_homestats.js",
    "ulanzi/test-pattern.js",
    "pixoo/home.js",
    "pixoo/home2.js",
    "pixoo/home3.js",
    "pixoo/funkeykid.js",
    "pixoo/health.js",
  ];
  for (const file of files) {
    const namespace = await import(pathToFileURL(join(scenesDir, file)).href);
    const scene = namespace.default ?? namespace;
    assert.equal(typeof scene.render, "function", `${file}: render()`);
    assert.equal(typeof scene.name, "string", `${file}: name`);
  }
});

test("fixtures: every scenario file names its scene, device type, time and time zone", async () => {
  const files = (await readdir(FIXTURES_DIR)).filter((file) =>
    file.endsWith(".json"),
  );
  assert.ok(files.length > 0, "at least the example scenario exists");
  for (const file of files) {
    const scenario = await loadScenario(file);
    assert.equal(
      file,
      `${scenario.name}.json`,
      `${file}: the file is named after the scenario`,
    );
    assert.match(scenario.scene, /^[a-z0-9_-]+$/, `${file}: scene`);
    assert.ok(
      ["ulanzi", "pixoo"].includes(scenario.deviceType),
      `${file}: deviceType`,
    );
    assert.ok(!Number.isNaN(Date.parse(scenario.now)), `${file}: now`);
    assert.equal(typeof scenario.timeZone, "string", `${file}: timeZone`);
  }
});

// --- Phase 3: one golden frame per line. Names are the scenario and frame file names. -------------
// Ulanzi (payload + 32×8 picture)
test.todo("clock--default-with-seconds");
test.todo("clock--no-seconds-custom-colour");
test.todo("test-pattern--first-frame");
test.todo("test-pattern--frame-17");
test.todo("clock_with_homestats--day-all-closed-battery-charging");
test.todo("clock_with_homestats--night-door-open-lock-unknown");
test.todo("clock_with_homestats--debug-battery-override");
// Pixoo64 (64×64 picture)
test.todo("funkeykid--title-before-first-key");
test.todo("funkeykid--letter-a-with-picture");
test.todo("funkeykid--idle-picture-only");
test.todo("funkeykid--volume-bar-70-percent");
test.todo("health--home-tab-all-green");
test.todo("health--wlan-tab-one-device-offline");
test.todo("health--heizung-tab-chain-mismatch");
test.todo("home--day-all-fresh-uv-chart");
test.todo("home--night-everything-stale");
test.todo("home2--boiler-heating-with-history");
test.todo("home2--lock-disconnected-amber-dot");
test.todo("home3--noon-car-home-charging");
test.todo("home3--night-car-away-battery-discharging");
test.todo("home3--no-data-after-start");
