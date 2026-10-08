import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";
import { UlanziDriver } from "../lib/ulanzi-driver.js";
import { PixooDriver } from "../lib/pixoo-driver.js";
import { BITMAP_FONT, FONT_SPECS, measureText } from "../lib/pixoo-font.js";
import { loadPixooImage, drawPixooImage } from "../lib/pixoo-image.js";

const logger = { info() {}, debug() {}, warn() {}, error() {} };

test("Ulanzi deadlines cover every HTTP operation, including blocked response bodies", async (t) => {
  const operations = [
    ["initialize", [], false], ["getStats", [], null], ["getScreen", [], null],
    ["switchToApp", ["Time"], false], ["showNotification", [{}], false],
    ["setPower", [true], false], ["setBrightness", [100], false],
    ["push", [new Uint8Array(768)]], ["drawCustom", [{}]],
  ];
  for (const [method, args, expected] of operations) {
    await t.test(method, async (st) => {
      const controller = new AbortController();
      st.mock.method(AbortSignal, "timeout", (ms) => {
        assert.equal(ms, 5000);
        return controller.signal;
      });
      st.mock.method(globalThis, "fetch", async (_url, options) => {
        assert.ok(options.signal instanceof AbortSignal);
        const wait = () => new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
        if (["initialize", "getStats", "getScreen"].includes(method)) {
          return { ok: true, json: wait };
        }
        return wait();
      });
      const driver = new UlanziDriver("device.invalid", { logger });
      const result = driver[method](...args);
      const checked = expected === undefined
        ? assert.rejects(result, /deadline/)
        : result.then((value) => assert.equal(value, expected));
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort(new Error("deadline"));
      await checked;
    });
  }
});

test("Ulanzi status-only responses release their bodies and preserve valid frames", async (t) => {
  const calls = [];
  let cancellations = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options]);
    return { ok: true, body: { async cancel() { cancellations++; } } };
  });
  const driver = new UlanziDriver("device.invalid", { logger });
  const frame = new Uint8Array(768).fill(47);
  assert.equal(await driver.push(frame), true);
  const data = JSON.parse(calls[0][1].body);
  assert.deepEqual(Buffer.from(data.matrix, "base64"), Buffer.from(frame));
  assert.equal(await driver.drawCustom({ text: "Hi" }), true);
  assert.equal(cancellations, 3);
  await assert.rejects(driver.push(new Uint8Array(767)), /768/);
  assert.equal(calls.length, 3);
});

test("legacy cleanup requests have deadlines and release deletion responses", async (t) => {
  let deleted = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (url.includes("/list?")) return { ok: true, async json() { return [
      { type: "file", name: "pixdcon.json" }, { type: "file", name: "old.json" },
    ]; } };
    assert.ok(url.endsWith("name=old"));
    return { ok: true, body: { async cancel() { deleted = true; } } };
  });
  await new UlanziDriver("device.invalid", { logger })._cleanupNonPixdconApps();
  assert.equal(deleted, true);
});

test("drawCustom warns on a failed app switch without failing the frame", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: !url.endsWith("/api/switch"),
    body: { async cancel() {} },
  }));
  const warnings = [];
  const driver = new UlanziDriver("device.invalid", {
    logger: { ...logger, warn: (msg) => warnings.push(msg) },
  });
  assert.equal(await driver.drawCustom({ text: "Hi" }), true);
  assert.match(warnings.join("\n"), /switchToApp failed/);
});

test("Pixoo tolerates unparseable bodies but rejects reported errors", async (t) => {
  const driver = new PixooDriver("device.invalid", { logger });
  let fetchMock = t.mock.method(globalThis, "fetch", async () => ({
    ok: true, async json() { throw new SyntaxError("bad JSON"); },
  }));
  assert.deepEqual(await driver._httpPost({ Command: "test" }), {});
  fetchMock.mock.restore();
  for (const error_code of [0, "0"]) {
    fetchMock = t.mock.method(globalThis, "fetch", async () => ({ ok: true, async json() { return { error_code }; } }));
    assert.deepEqual(await driver._httpPost({ Command: "test" }), { error_code });
    fetchMock.mock.restore();
  }
  for (const error_code of [1, "Request data illegal json"]) {
    fetchMock = t.mock.method(globalThis, "fetch", async () => ({ ok: true, async json() { return { error_code }; } }));
    await assert.rejects(driver._httpPost({ Command: "test" }), new RegExp(`Pixoo error_code ${error_code}`));
    fetchMock.mock.restore();
  }
});

test("Pixoo clipping keeps invalid coordinates from corrupting RGB channels", () => {
  const driver = new PixooDriver("device.invalid", { logger });
  for (const [x, y] of [[-1, 0], [64, 0], [0, 64], [1 / 3, 0], [0, 1 / 192], [NaN, 0]]) {
    driver._setPixel(x, y, 255, 200, 100);
    driver._blendPixel(x, y, 255, 200, 100);
  }
  assert.equal(driver.buf.some((value) => value !== 0), false);
  driver._setPixel(63, 63, 10, 20, 30);
  assert.deepEqual([...driver.buf.slice(-3)], [10, 20, 30]);
});

test("fractional Pixoo lines terminate and rasterize their integer endpoints", async () => {
  const moduleUrl = new URL("../lib/pixoo-driver.js", import.meta.url).href;
  const source = `import { PixooDriver } from ${JSON.stringify(moduleUrl)};
    const d = new PixooDriver('device.invalid');
    await d.drawLineRgba([0.9, 0], [1.1, 1], [47, 0, 0]);
    console.log(JSON.stringify([d.buf[0], d.buf[(64 + 1) * 3]]));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], { timeout: 2000 });
  assert.deepEqual(JSON.parse(stdout), [47, 47]);
});

test("font measurement preserves unknown Unicode fallback and glyph spacing", async () => {
  assert.ok(Object.values(BITMAP_FONT).every((glyph) => glyph.length === FONT_SPECS.WIDTH * FONT_SPECS.HEIGHT));
  assert.equal(measureText("A😀B").width, 11);
  assert.equal(measureText("").width, 0);
  const driver = new PixooDriver("device.invalid", { logger });
  assert.equal(await driver.drawTextRgbaAligned("A😀B", [0, 0], [255, 0, 0]), 11);
  assert.equal(driver.buf.slice(3 * 4, 3 * 7).some((value) => value !== 0), false);
});

test("PNG decode failures propagate and alpha overlays clip correctly", async () => {
  await assert.rejects(loadPixooImage(Buffer.from("invalid PNG")));
  const png = await sharp(Buffer.from([255, 0, 0, 128, 0, 255, 0, 255]), {
    raw: { width: 2, height: 1, channels: 4 },
  }).png().toBuffer();
  const image = await loadPixooImage(png);
  assert.equal(image.channels, 4);
  const driver = new PixooDriver("device.invalid", { logger });
  drawPixooImage(driver, image, 63, 63);
  assert.deepEqual([...driver.buf.slice(-3)], [128, 0, 0]);
});
