#!/usr/bin/env node
/**
 * preview-to-png — fetch the live frame for a device from pixdcon's web UI
 * and write it to a PNG (optionally upscaled).
 *
 * USAGE:
 *   node scripts/preview-to-png.js [--host hsb1:8080] [--device pixoo-159]
 *                                   [--out /tmp/frame.png] [--scale 8]
 *
 * EXAMPLES:
 *   node scripts/preview-to-png.js                              # defaults
 *   node scripts/preview-to-png.js --device pixoo-189 --scale 16
 *   node scripts/preview-to-png.js --host localhost:8080
 */

import sharp from "sharp";
import { writeFileSync } from "fs";

function parseArgs(argv) {
  const out = {
    host: "hsb1:8080",
    device: "pixoo-159",
    out: "/tmp/frame.png",
    scale: 8,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") out.host = argv[++i];
    else if (a === "--device") out.device = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--scale") out.scale = parseInt(argv[++i], 10);
  }
  return out;
}

async function main() {
  const { host, device, out, scale } = parseArgs(process.argv.slice(2));
  const url = `http://${host}/api/previews`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const previews = await res.json();
  const frame = previews[device];
  if (!frame) {
    throw new Error(
      `Device "${device}" not in previews. Available: ${Object.keys(previews).join(", ")}`,
    );
  }

  const { width, height, data } = frame;
  const raw = Buffer.from(data, "base64");
  const expected = width * height * 3;
  if (raw.length !== expected) {
    throw new Error(
      `Buffer size ${raw.length} != expected ${expected} (${width}x${height}x3)`,
    );
  }

  const png = await sharp(raw, { raw: { width, height, channels: 3 } })
    .resize(width * scale, height * scale, { kernel: "nearest" })
    .png()
    .toBuffer();
  writeFileSync(out, png);
  console.log(
    `Wrote ${out} (${width}x${height} @ ${scale}x = ${width * scale}x${height * scale})`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
