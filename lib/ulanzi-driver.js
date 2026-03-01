/**
 * Minimal Ulanzi/AWTRIX driver
 * Target: 32x8 LED matrix
 */

export class UlanziDriver {
  constructor(ip) {
    this.ip = ip;
    this.baseUrl = `http://${ip}/api`;
  }

  /**
   * Push a frame to the display
   * @param {Uint8Array} frame - 32x8 RGB frame (32 * 8 * 3 = 768 bytes)
   * @returns {Promise<boolean>} Success
   */
  async push(frame) {
    try {
      // Convert frame to base64
      const base64 = Buffer.from(frame).toString("base64");

      // AWTRIX Light API expects base64 encoded frame
      const response = await fetch(`${this.baseUrl}/draw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrix: base64 }),
      });

      return response.ok;
    } catch (error) {
      console.error(`[UlanziDriver] Push failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Clear the display
   * @returns {Promise<boolean>}
   */
  async clear() {
    const blackFrame = new Uint8Array(32 * 8 * 3);
    return this.push(blackFrame);
  }

  /**
   * Get device info
   * @returns {Promise<object>}
   */
  async getInfo() {
    try {
      const response = await fetch(`${this.baseUrl}/info`);
      return response.json();
    } catch (error) {
      console.error(`[UlanziDriver] GetInfo failed: ${error.message}`);
      return null;
    }
  }
}

export default UlanziDriver;
