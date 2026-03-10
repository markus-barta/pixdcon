/**
 * Example clock scene
 * Shows current time on 32x8 display
 */

export default {
  name: 'clock',
  description: 'Simple clock display',

  async render(device) {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const time = `${hours}:${minutes}`;

    // TODO: Implement actual drawing with device methods
    // For now, just clear and return interval
    await device.clear();
    
    console.log(`[Clock] ${time}`);
    
    // Update every second
    return 1000;
  }
};
