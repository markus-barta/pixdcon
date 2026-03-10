/**
 * Test pattern scene — verifies the display is working.
 * Draws a red dot that travels across the 32x8 matrix.
 *
 * Note: frame state is per-render-instance via closure, not module-level,
 * so reloading config correctly resets it.
 */

export default {
  name: "test-pattern",
  pretty_name: "Test Pattern",
  deviceType: "ulanzi",
  description: "Animated test pattern for display verification",

  // Instance state — reset when scene is reloaded via clearCache()
  _frame: 0,

  async render(device) {
    this._frame = (this._frame + 1) % 32;

    await device.drawCustom({
      draw: [
        { dp: [this._frame, 3, "#FF0000"] },
        { dp: [this._frame, 4, "#FF0000"] },
      ],
    });

    return 100; // ~10 FPS
  },
};
