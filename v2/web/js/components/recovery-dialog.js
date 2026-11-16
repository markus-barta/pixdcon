/**
 * Component: recovery dialog ("Recovery steps").
 * Approved mockups: pixd-device-offline (Pixoo), pixd-device-offline-ulanzi.
 *
 * Top-anchored at 72 px, at most 600 px wide, focus kept inside, Esc closes
 * and returns focus to the opener. Header: device, address, type, failed
 * renders, last contact. Body: last error text, numbered steps for the device
 * type, commands in a copyable mono line. Footer: "Retry now"
 * (POST /api/v2/devices/<name>/retry) and Close.
 * The steps depend on why the display is not online (health.reason): hardware
 * steps for device_unreachable, the scene's error and "choose another scene"
 * for scene_error (matrix S-6, S-29).
 *
 * Owner: UI worker.
 */

import { todo } from "../todo.js";

/**
 * @param {any} device DeviceView
 * @param {HTMLElement} opener receives the focus again on close
 * @returns {{update: (device: any) => void, close: () => void}}
 */
export function openRecoveryDialog(device, opener) {
  return todo("components/recovery-dialog.openRecoveryDialog", device, opener);
}
