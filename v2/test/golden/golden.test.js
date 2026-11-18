/**
 * Test kind 1 of 3: fixed screen images per scene (golden frames).
 *
 * Every scenario runs through v1's drawing engine and v2's scene runtime,
 * adapter and surface. Both must match byte for byte before the reference
 * PNG (and AWTRIX JSON) is compared. Fixtures include independent device glow,
 * boiler history, sensor state, HTTP answers and canned ping results.
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
  expectPayload,
  renderScenario,
  installGoldenPingPeer,
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

test("harness: every shared v1 scene loads in v2's process", async (t) => {
  const hook = await installGoldenPingPeer();
  t.after(() => hook.deregister());
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

test("fixtures: every picture has a distinct sentence describing its visible contents", async () => {
  const notes = new Set();
  for (const file of (await readdir(FIXTURES_DIR)).filter((name) =>
    name.endsWith(".json"),
  )) {
    const { note } = await loadScenario(file);
    assert.equal(typeof note, "string", `${file}: review note required`);
    const sentence = note ?? "";
    assert.match(sentence, /^[A-Z].+[.!?]$/, `${file}: complete sentence`);
    assert.equal(
      (sentence.match(/[.!?](?=\s|$)/g) ?? []).length,
      1,
      `${file}: one sentence`,
    );
    assert.doesNotMatch(
      sentence,
      /v1 reference drawing|frozen inputs|example scenario/i,
      `${file}: describe the picture`,
    );
    assert.equal(
      notes.has(sentence),
      false,
      `${file}: distinct picture description`,
    );
    notes.add(sentence);
  }
});

// --- Phase 3: one golden frame per line. Names are the scenario and frame file names. -------------
// Ulanzi (payload + 32×8 picture)
test("clock--default-with-seconds", async (t) => {
  await goldenCase(t, "clock--default-with-seconds");
});
test("clock--no-seconds-custom-colour", async (t) => {
  await goldenCase(t, "clock--no-seconds-custom-colour");
});
test("test-pattern--first-frame", async (t) => {
  await goldenCase(t, "test-pattern--first-frame");
});
test("test-pattern--frame-17", async (t) => {
  await goldenCase(t, "test-pattern--frame-17");
});
test("clock_with_homestats--day-all-closed-battery-charging", async (t) => {
  await goldenCase(t, "clock_with_homestats--day-all-closed-battery-charging");
});
test("clock_with_homestats--night-door-open-lock-unknown", async (t) => {
  await goldenCase(t, "clock_with_homestats--night-door-open-lock-unknown");
});
test("clock_with_homestats--debug-battery-override", async (t) => {
  await goldenCase(t, "clock_with_homestats--debug-battery-override");
});
// Pixoo64 (64×64 picture)
test("funkeykid--title-before-first-key", async (t) => {
  await goldenCase(t, "funkeykid--title-before-first-key");
});
test("funkeykid--letter-a-with-picture", async (t) => {
  await goldenCase(t, "funkeykid--letter-a-with-picture");
});
test("funkeykid--idle-picture-only", async (t) => {
  await goldenCase(t, "funkeykid--idle-picture-only");
});
test("funkeykid--volume-bar-70-percent", async (t) => {
  await goldenCase(t, "funkeykid--volume-bar-70-percent");
});
test("health--home-tab-all-green", async (t) => {
  await goldenCase(t, "health--home-tab-all-green");
});
// Two instances of health, frames rendered in turn: the glow of the second
// starts where a fresh instance starts, not where the first one is (B-005).
test("health--second-device-starts-its-own-glow", async (t) => {
  await goldenCase(t, "health--second-device-starts-its-own-glow");
});
test("health--wlan-tab-one-device-offline", async (t) => {
  await goldenCase(t, "health--wlan-tab-one-device-offline");
});
test("health--heizung-tab-chain-mismatch", async (t) => {
  await goldenCase(t, "health--heizung-tab-chain-mismatch");
});
test("home--day-all-fresh-uv-chart", async (t) => {
  await goldenCase(t, "home--day-all-fresh-uv-chart");
});
test("home--night-everything-stale", async (t) => {
  await goldenCase(t, "home--night-everything-stale");
});
test("home2--boiler-heating-with-history", async (t) => {
  await goldenCase(t, "home2--boiler-heating-with-history");
});
test("home2--lock-disconnected-amber-dot", async (t) => {
  await goldenCase(t, "home2--lock-disconnected-amber-dot");
});
test("home3--noon-car-home-charging", async (t) => {
  await goldenCase(t, "home3--noon-car-home-charging");
});
test("home3--night-car-away-battery-discharging", async (t) => {
  await goldenCase(t, "home3--night-car-away-battery-discharging");
});
test("home3--no-data-after-start", async (t) => {
  await goldenCase(t, "home3--no-data-after-start");
});

/** @param {import('node:test').TestContext} t @param {string} name */
async function goldenCase(t, name) {
  const scenario = await loadScenario(`${name}.json`);
  t.diagnostic(scenario.note ?? "");
  const expected = await renderScenario(t, scenario, { reference: true });
  const actual = await renderScenario(
    t,
    scenario,
    name.includes("second-device") ? { priorDeviceFrames: 7 } : {},
  );
  assert.deepEqual(
    actual.frame,
    expected.frame,
    `${name}: v2 pixels equal the unchanged v1 drawing engine`,
  );
  assert.deepEqual(
    actual.payload,
    expected.payload,
    `${name}: AWTRIX wire payload equals v1`,
  );
  assert.deepEqual(
    actual.brightness,
    expected.brightness,
    `${name}: scene brightness requests`,
  );
  await expectFrame(name, expected.frame);
  if (scenario.deviceType === "ulanzi")
    await expectPayload(name, expected.payload);
}

test("surface--v1-lines-alpha-and-aligned-text", async () => {
  const { loadV1ReferenceDrivers, loadV1Font } =
    await import("../../src/scenes/v1-shared.js");
  const { createPixooSurface } =
    await import("../../src/scenes/v1-device-facade.js");
  const { sinkDriver } = await import("../helpers/scene-context.js");
  const { PixooDriver } = await loadV1ReferenceDrivers();
  const reference = new PixooDriver("127.0.0.1");
  const actual = createPixooSurface(
    { name: "drawing-card", address: "127.0.0.1" },
    {
      driver: sinkDriver(),
      async show() {},
      async requestBrightness() {
        return true;
      },
    },
    await loadV1Font(),
  );
  /** @param {any} surface */
  const draw = async (surface) => {
    await surface.drawRectangleRgba([-4, 3], [37, 25], [32, 64, 128]);
    for (const [x, y] of [
      [-4, 0],
      [68, 1],
      [64, 63],
      [-2, 60],
      [18, 65],
      [33, -2],
      [32, 32],
    ]) {
      await surface.drawLineRgba([32, 32], [x, y], [240, 128, 32, 128]);
      await surface.drawLineRgba([x, y], [31, 31], [0, 200, 255, 100]);
    }
    await surface.drawRectangleRgba([44, 0], [24, 7], [0, 255, 128, 160]);
    await surface.drawTextRgbaAligned(
      "ÄÖÜ 12:34",
      [32, 40],
      [255, 255, 255],
      "center",
    );
    await surface.drawTextRgbaAligned(
      "odd",
      [32, 48],
      [255, 64, 64, 150],
      "center",
    );
    await surface.drawTextRgbaAligned(
      "right",
      [63, 57],
      [128, 255, 64],
      "right",
    );
  };
  await draw(reference);
  await draw(actual);
  assert.deepEqual(actual.buf, reference.buf);
  await expectFrame("surface--v1-lines-alpha-and-aligned-text", {
    width: 64,
    height: 64,
    rgb: reference.buf,
  });
});

test("raster--awtrix-drawing-commands-and-unsupported-fields", async () => {
  const { rasterizeAwtrixApp } =
    await import("../../src/drivers/awtrix-raster.js");
  const app = {
    draw: [
      { df: [-2, -2, 5, 5, "#102030"] },
      { dr: [5, 1, 4, 6, [255, 0, 0]] },
      { dl: [-1e12, 7, 1e12, 7, "#00FF00"] },
      { dp: [31, 0, [0, 0, 255]] },
      { dt: [11, 1, "A:9", "#FF8800"] },
      { dc: [0, 0, 1, "#FFFFFF"] },
    ],
    icon: "unsupported",
  };
  const saved = structuredClone(app);
  const { frame, unsupported } = rasterizeAwtrixApp(app);
  assert.deepEqual(unsupported, ["draw.dc", "icon"]);
  assert.deepEqual(app, saved, "drawing never rewrites the wire payload");
  assert.deepEqual([...frame.rgb.slice(0, 3)], [16, 32, 48]);
  assert.deepEqual([...frame.rgb.slice(31 * 3, 32 * 3)], [0, 0, 255]);
  assert.deepEqual(
    [...frame.rgb.slice(7 * 32 * 3, 7 * 32 * 3 + 3)],
    [0, 255, 0],
  );
  await expectFrame(
    "raster--awtrix-drawing-commands-and-unsupported-fields",
    frame,
  );
});
