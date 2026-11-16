/**
 * Golden frames: compare a rendered picture with a stored one.
 *
 * Test kind 1 of 3 (Markus, phase-2 decision): fixed screen images per scene,
 * rendered from fixed inputs (time, time zone, settings, MQTT messages, HTTP
 * answers). No per-function unit tests.
 *
 * A golden frame is a PNG under test/golden/frames/, one per scenario, so a
 * person can open it and a diff in a pull request shows the picture. PNG is
 * lossless; the comparison is on the decoded RGB bytes, exact, no tolerance.
 * For Ulanzi scenes the exact contract with the display is the AWTRIX payload;
 * it is stored next to the picture as <name>.json and compared as JSON.
 *
 *   UPDATE_GOLDEN=1 npm run test:golden      write or overwrite the stored frames
 *
 * When a comparison fails, the rendered picture and a diff picture (changed
 * pixels in magenta on the dimmed expected frame) are written to test/.out/.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
export const FRAMES_DIR = resolve(here, "../golden/frames");
export const FIXTURES_DIR = resolve(here, "../golden/fixtures");
export const OUT_DIR = resolve(here, "../.out");

/** @typedef {import("../../src/types.js").Frame} Frame */

/**
 * @param {Frame} frame
 * @returns {Promise<Buffer>} PNG bytes
 */
export function encodePng(frame) {
  assert.equal(
    frame.rgb.length,
    frame.width * frame.height * 3,
    "frame size does not match its dimensions",
  );
  return sharp(Buffer.from(frame.rgb), {
    raw: { width: frame.width, height: frame.height, channels: 3 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * @param {Buffer} png
 * @returns {Promise<Frame>}
 */
export async function decodePng(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgb: new Uint8Array(data) };
}

/**
 * Compare a frame with the stored golden frame `name`.
 *
 * @param {string} name file name without extension, e.g. "home3--noon-all-fresh"
 * @param {Frame} frame
 * @returns {Promise<void>} rejects with the number and the first position of differing pixels
 */
export async function expectFrame(name, frame) {
  const file = join(FRAMES_DIR, `${name}.png`);
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(FRAMES_DIR, { recursive: true });
    await writeFile(file, await encodePng(frame));
    return;
  }
  let stored;
  try {
    stored = await readFile(file);
  } catch {
    assert.fail(
      `no golden frame ${name}.png yet; create it with UPDATE_GOLDEN=1 npm run test:golden and look at it`,
    );
  }
  const expected = await decodePng(stored);
  assert.deepEqual(
    { width: frame.width, height: frame.height },
    { width: expected.width, height: expected.height },
    `${name}: size differs`,
  );
  let different = 0;
  let first = "";
  const diff = new Uint8Array(expected.rgb.length);
  for (let i = 0; i < expected.rgb.length; i += 3) {
    const same =
      expected.rgb[i] === frame.rgb[i] &&
      expected.rgb[i + 1] === frame.rgb[i + 1] &&
      expected.rgb[i + 2] === frame.rgb[i + 2];
    if (same) {
      diff[i] = expected.rgb[i] >> 2;
      diff[i + 1] = expected.rgb[i + 1] >> 2;
      diff[i + 2] = expected.rgb[i + 2] >> 2;
    } else {
      different += 1;
      if (!first)
        first = `x${(i / 3) % expected.width} y${Math.floor(i / 3 / expected.width)}`;
      diff[i] = 255;
      diff[i + 2] = 255;
    }
  }
  if (different === 0) return;
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, `${name}.actual.png`), await encodePng(frame));
  await writeFile(
    join(OUT_DIR, `${name}.diff.png`),
    await encodePng({ ...expected, rgb: diff }),
  );
  assert.fail(
    `${name}: ${different} pixel(s) differ, first at ${first}; see test/.out/${name}.actual.png and .diff.png`,
  );
}

/**
 * Compare an AWTRIX payload with the stored one.
 *
 * @param {string} name
 * @param {unknown} payload
 */
export async function expectPayload(name, payload) {
  const file = join(FRAMES_DIR, `${name}.json`);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(FRAMES_DIR, { recursive: true });
    await writeFile(file, text);
    return;
  }
  let stored;
  try {
    stored = await readFile(file, "utf8");
  } catch {
    assert.fail(
      `no golden payload ${name}.json yet; create it with UPDATE_GOLDEN=1 npm run test:golden and read it`,
    );
  }
  assert.deepEqual(
    payload,
    JSON.parse(stored),
    `${name}: AWTRIX payload differs`,
  );
}

/**
 * A scenario file under test/golden/fixtures/: the fixed inputs of one frame.
 *
 * @typedef {object} GoldenScenario
 * @property {string} name golden frame name
 * @property {string} scene scene key as in dev/dev-config.json
 * @property {import("../../src/types.js").DeviceType} deviceType
 * @property {string} now ISO time with offset, the frozen "now" of the render
 * @property {string} timeZone e.g. "Europe/Vienna"
 * @property {Record<string, unknown>} [settings] saved setting values
 * @property {Array<{topic: string, payload: string|Record<string, unknown>}>} [mqtt] messages delivered after init, in order
 * @property {Array<{url: string, status?: number, body?: unknown}>} [http] answers for the scene's own requests; anything else fails
 * @property {number} [frames] render this many frames and compare the last one (animations), default 1
 * @property {string} [note] what the picture should show, for the person reviewing it
 */

/**
 * @param {string} file name under test/golden/fixtures/
 * @returns {Promise<GoldenScenario>}
 */
export async function loadScenario(file) {
  return JSON.parse(await readFile(join(FIXTURES_DIR, file), "utf8"));
}
