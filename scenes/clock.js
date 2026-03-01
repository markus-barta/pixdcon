/**
 * Clock scene for AWTRIX 32x8 display
 * Shows current time as HH:MM:SS, updates every second
 */

export default {
  name: "clock",
  description: "Digital clock HH:MM:SS",

  async render(device) {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, "0");
    const m = String(now.getMinutes()).padStart(2, "0");
    const s = String(now.getSeconds()).padStart(2, "0");

    await device.drawCustom({
      text: `${h}:${m}:${s}`,
      color: "#00FF00",
      center: true,
    });

    return 1000;
  },
};
