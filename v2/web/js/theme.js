/* global document, location */
/**
 * Theme: System, Light or Dark for this browser (Config › This browser).
 * Order: `?theme=dark|light` in the address, then localStorage key
 * "pixdcon.theme", then the system setting. Sets `data-theme` on <html>;
 * app.css does the rest.
 *
 * Owner: UI worker.
 */

import { todo } from "./todo.js";

/** @returns {"system"|"light"|"dark"} */
export function currentTheme() {
  return todo("theme.currentTheme", localStorage, location);
}

/** @param {"system"|"light"|"dark"} theme */
export function setTheme(theme) {
  return todo("theme.setTheme", theme, document);
}
