/* global window, location */
/**
 * Router: hash routes, one page module per route.
 *
 *   #/devices                       pages/devices.js      Devices overview
 *   #/devices/<name>                pages/device.js       Device control
 *   #/devices/<name>/enlarged       components/enlarged-preview.js over the page it was opened from
 *   #/overlays                      pages/overlays.js
 *   #/config                        pages/config.js       (#/config/<name> = that device's row open for editing)
 *   #/config/raw                    pages/config-raw.js
 *   #/health                        pages/health.js
 *
 * Leaving a device page ends its settings preview ("leaving this page reverts
 * them"). Focus goes to the page title after a route change.
 *
 * Owner: UI worker.
 */

import { todo } from "./todo.js";

/**
 * @typedef {object} Page
 * @property {(root: HTMLElement, params: Record<string, string>) => void} mount
 * @property {() => void} unmount
 */

/**
 * @param {HTMLElement} root the element pages render into
 * @returns {{go: (hash: string) => void, current: () => {route: string, params: Record<string, string>}}}
 */
export function startRouter(root) {
  return todo("router.startRouter", root, window, location);
}
