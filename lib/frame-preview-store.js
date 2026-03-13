const PIXOO_WIDTH = 64;
const PIXOO_HEIGHT = 64;
const ULANZI_WIDTH = 32;
const ULANZI_HEIGHT = 8;
const DEFAULT_ULANZI_POLL_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampByte(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseColorValue(value) {
  if (Array.isArray(value) && value.length >= 3) {
    return [clampByte(value[0]), clampByte(value[1]), clampByte(value[2])];
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  }

  if (typeof value === "string") {
    const hex = value.trim().replace(/^#/, "").replace(/^0x/i, "");
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      const num = parseInt(hex, 16);
      return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
    }
  }

  return null;
}

function normalizeUlanziScreen(screen) {
  if (!Array.isArray(screen)) return null;

  const flat = Array.isArray(screen[0]) ? screen.flat() : screen;
  const rawByteShape = ULANZI_WIDTH * ULANZI_HEIGHT * 3;
  const colorShape = ULANZI_WIDTH * ULANZI_HEIGHT;

  if (
    flat.length === rawByteShape &&
    flat.every((value) => typeof value === "number")
  ) {
    return Uint8Array.from(flat.map(clampByte));
  }

  if (flat.length !== colorShape) return null;

  const pixels = new Uint8Array(rawByteShape);
  for (let i = 0; i < flat.length; i++) {
    const color = parseColorValue(flat[i]);
    if (!color) return null;
    const offset = i * 3;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
  }

  return pixels;
}

export class FramePreviewStore {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.frames = new Map();
    this.pollers = new Map();
  }

  capturePixoo(deviceName, pixels) {
    this._store(deviceName, PIXOO_WIDTH, PIXOO_HEIGHT, pixels, {
      source: "runtime",
      intervalMs: 0,
    });
  }

  registerDevice(device, driver) {
    if (!device || !driver) return;

    if (device.type === "ulanzi") {
      this._startUlanziPoll(device, driver, device.preview?.pollMs);
    }
  }

  unregisterDevice(deviceName) {
    const poller = this.pollers.get(deviceName);
    if (poller) {
      poller.active = false;
      this.pollers.delete(deviceName);
    }
    this.frames.delete(deviceName);
  }

  list() {
    const result = {};
    for (const [deviceName, frame] of this.frames.entries()) {
      result[deviceName] = frame;
    }
    return result;
  }

  _store(deviceName, width, height, pixels, meta = {}) {
    const data = Buffer.from(pixels).toString("base64");
    this.frames.set(deviceName, {
      width,
      height,
      data,
      source: meta.source || "runtime",
      intervalMs: meta.intervalMs || 0,
      updatedAt: new Date().toISOString(),
    });
  }

  _startUlanziPoll(device, driver, pollMs = DEFAULT_ULANZI_POLL_MS) {
    this.unregisterDevice(device.name);

    const intervalMs = Number.isInteger(pollMs)
      ? pollMs
      : DEFAULT_ULANZI_POLL_MS;

    const poller = { active: true };
    this.pollers.set(device.name, poller);

    const run = async () => {
      while (poller.active) {
        try {
          const screen = await driver.getScreen({ silent: true });
          const pixels = normalizeUlanziScreen(screen);
          if (pixels) {
            this._store(device.name, ULANZI_WIDTH, ULANZI_HEIGHT, pixels, {
              source: "device",
              intervalMs,
            });
          }
        } catch (error) {
          this.logger.debug?.(
            `[FramePreviewStore] Ulanzi preview poll failed for ${device.name}: ${error.message}`,
          );
        }

        await sleep(intervalMs);
      }
    };

    run().catch((error) => {
      this.logger.warn(
        `[FramePreviewStore] Preview loop exited for ${device.name}: ${error.message}`,
      );
    });
  }
}

export default FramePreviewStore;
