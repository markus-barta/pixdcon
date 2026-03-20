/**
 * Ulanzi/AWTRIX HTTP API driver
 * Reference: /Users/markus/Code/pidicon-light/docs/AWTRIX-API.md
 * Source: https://github.com/Blueforcer/awtrix3/blob/main/docs/api.md
 * Target: 32x8 LED matrix
 */

export class UlanziDriver {
  constructor(ip, options = {}) {
    this.ip = ip;
    this.baseUrl = `http://${ip}`;
    this.appName = options.appName || "pidicon_light";
    this.logger = options.logger || console;
  }

  /**
   * Initialize and verify device is reachable
   */
  async initialize() {
    try {
      const response = await fetch(`${this.baseUrl}/api/stats`);
      if (response.ok) {
        const stats = await response.json();
        this.logger.info(
          `[UlanziDriver] Initialized ${this.ip} (battery: ${stats.bat || "AC"}%)`,
        );
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error(`[UlanziDriver] Init failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Push raw frame (base64 encoded bitmap)
   * @param {Uint8Array} frame - 32x8 RGB frame (768 bytes)
   */
  async push(frame) {
    const base64 = Buffer.from(frame).toString("base64");
    const response = await fetch(`${this.baseUrl}/api/draw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matrix: base64 }),
    });
    if (!response.ok) {
      throw new Error(`Push HTTP ${response.status}`);
    }
    return true;
  }

  /**
   * Clear display (black screen)
   */
  async clear() {
    const blackFrame = new Uint8Array(32 * 8 * 3);
    return this.push(blackFrame);
  }

  /**
   * Create/update persistent custom app using draw API
   * @param {Object} appData - Custom app config (text, draw, icon, etc.)
   */
  async drawCustom(appData) {
    const url = `${this.baseUrl}/api/custom?name=${encodeURIComponent(this.appName)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appData),
    });
    if (!response.ok) {
      throw new Error(`drawCustom HTTP ${response.status}`);
    }
    await this.switchToApp(this.appName);
    return true;
  }

  /**
   * Switch to specific app
   * @param {string} appName - App name (e.g., 'Time', 'Date', or custom app name)
   */
  async switchToApp(appName) {
    try {
      const response = await fetch(`${this.baseUrl}/api/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: appName }),
      });
      return response.ok;
    } catch (error) {
      this.logger.error(`[UlanziDriver] switchToApp failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Show temporary notification overlay
   * @param {Object} notification - Notification config
   */
  async showNotification(notification) {
    try {
      const response = await fetch(`${this.baseUrl}/api/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notification),
      });
      return response.ok;
    } catch (error) {
      this.logger.error(
        `[UlanziDriver] showNotification failed: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Get device stats
   * @returns {Promise<Object|null>} Device statistics
   */
  async getStats() {
    try {
      const response = await fetch(`${this.baseUrl}/api/stats`);
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch (error) {
      this.logger.error(`[UlanziDriver] getStats failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get current screen (LiveView)
   * @returns {Promise<Array|null>} Array of 24-bit colors
   */
  async getScreen(options = {}) {
    try {
      const response = await fetch(`${this.baseUrl}/api/screen`);
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch (error) {
      if (!options.silent) {
        this.logger.error(`[UlanziDriver] getScreen failed: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Set power on/off
   * @param {boolean} power - true for on, false for off
   */
  async setPower(power) {
    try {
      const response = await fetch(`${this.baseUrl}/api/power`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ power }),
      });
      return response.ok;
    } catch (error) {
      this.logger.error(`[UlanziDriver] setPower failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Set brightness (0-255)
   * @param {number} level - Brightness level
   */
  async setBrightness(level) {
    try {
      const response = await fetch(`${this.baseUrl}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ BRI: level }),
      });
      return response.ok;
    } catch (error) {
      this.logger.error(
        `[UlanziDriver] setBrightness failed: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Draw a pixel using draw commands
   * @param {number} x - X position (0-31)
   * @param {number} y - Y position (0-7)
   * @param {string|Array} color - Hex color or [r,g,b] array
   */
  async drawPixel(x, y, color) {
    return this.drawCustom({
      draw: [{ dp: [x, y, color] }],
    });
  }

  /**
   * Draw a line using draw commands
   * @param {number} x0 - Start X
   * @param {number} y0 - Start Y
   * @param {number} x1 - End X
   * @param {number} y1 - End Y
   * @param {string|Array} color - Color
   */
  async drawLine(x0, y0, x1, y1, color) {
    return this.drawCustom({
      draw: [{ dl: [x0, y0, x1, y1, color] }],
    });
  }

  /**
   * Draw a rectangle using draw commands
   * @param {number} x - Top-left X
   * @param {number} y - Top-left Y
   * @param {number} w - Width
   * @param {number} h - Height
   * @param {string|Array} color - Color
   */
  async drawRect(x, y, w, h, color) {
    return this.drawCustom({
      draw: [{ dr: [x, y, w, h, color] }],
    });
  }

  /**
   * Draw a filled rectangle
   * @param {number} x - Top-left X
   * @param {number} y - Top-left Y
   * @param {number} w - Width
   * @param {number} h - Height
   * @param {string|Array} color - Color
   */
  async fillRect(x, y, w, h, color) {
    return this.drawCustom({
      draw: [{ df: [x, y, w, h, color] }],
    });
  }

  /**
   * Draw a circle
   * @param {number} x - Center X
   * @param {number} y - Center Y
   * @param {number} r - Radius
   * @param {string|Array} color - Color
   */
  async drawCircle(x, y, r, color) {
    return this.drawCustom({
      draw: [{ dc: [x, y, r, color] }],
    });
  }

  /**
   * Draw a filled circle
   * @param {number} x - Center X
   * @param {number} y - Center Y
   * @param {number} r - Radius
   * @param {string|Array} color - Color
   */
  async fillCircle(x, y, r, color) {
    return this.drawCustom({
      draw: [{ dfc: [x, y, r, color] }],
    });
  }

  /**
   * Draw text
   * @param {string} text - Text to draw
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {string|Array} color - Color
   */
  async drawText(text, x, y, color) {
    return this.drawCustom({
      draw: [{ dt: [x, y, text, color] }],
    });
  }
}

export default UlanziDriver;
