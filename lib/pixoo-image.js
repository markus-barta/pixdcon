import sharp from "sharp";

const imageCache = new Map();

export async function loadPixooImage(imagePath) {
  if (imageCache.has(imagePath)) return imageCache.get(imagePath);

  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const image = {
    width: info.width,
    height: info.height,
    channels: info.channels,
    data,
  };
  imageCache.set(imagePath, image);
  return image;
}

export function drawPixooImage(device, image, x, y) {
  const { width, height, data, channels } = image;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = (row * width + col) * channels;
      const alpha = channels >= 4 ? data[idx + 3] : 255;
      if (alpha === 0) continue;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if (alpha === 255) {
        device._setPixel(x + col, y + row, r, g, b);
      } else {
        device._blendPixel(x + col, y + row, r, g, b, alpha);
      }
    }
  }
}
