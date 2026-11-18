/* global window, location, document, HTMLElement */
/**
 * Router: hash routes, one page module per route.
 *
 *   #/devices                       pages/devices.js      Devices overview
 *   #/devices/<name>                pages/device.js       Device control
 *   #/devices/<name>/recovery       pages/device.js       with the recovery dialog open
 *   #/devices/<name>/enlarged       components/enlarged-preview.js over the page it was opened from
 *   #/overlays                      pages/overlays.js
 *   #/config                        pages/config.js       (#/config/<name> = that device's row open for editing, #/config/add = Add device)
 *   #/config/raw                    pages/config-raw.js
 *   #/health                        pages/health.js
 *
 * Leaving a device page ends its settings preview ("leaving this page reverts
 * them"). Focus goes to the page title after a route change.
 *
 * Owner: UI worker.
 */

import { openEnlargedPreview } from "./components/enlarged-preview.js";
import { page as configPage } from "./pages/config.js";
import { page as configRawPage } from "./pages/config-raw.js";
import { page as devicePage } from "./pages/device.js";
import { page as devicesPage } from "./pages/devices.js";
import { page as healthPage } from "./pages/health.js";
import { page as overlaysPage } from "./pages/overlays.js";

/**
 * @typedef {object} Page
 * @property {(root: HTMLElement, params: Record<string, string>) => void} mount
 * @property {() => void} unmount
 */

/**
 * @param {string} hash
 * @returns {{route: string, params: Record<string, string>, nav: string}}
 */
export function parseHash(hash) {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter((part) => part !== "")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const [first, second, third] = parts;
  if (first === "devices" && second && third === "enlarged")
    return { route: "enlarged", params: { name: second }, nav: "devices" };
  if (first === "devices" && second && third === "recovery")
    return { route: "device", params: { name: second, recovery: "1" }, nav: "devices" };
  if (first === "devices" && second)
    return { route: "device", params: { name: second }, nav: "devices" };
  if (first === "overlays") return { route: "overlays", params: {}, nav: "overlays" };
  if (first === "config" && second === "raw")
    return { route: "config-raw", params: {}, nav: "config" };
  if (first === "config" && second)
    return { route: "config", params: { open: second }, nav: "config" };
  if (first === "config") return { route: "config", params: {}, nav: "config" };
  if (first === "health") return { route: "health", params: {}, nav: "health" };
  return { route: "devices", params: {}, nav: "devices" };
}

/** @type {Record<string, Page>} */
const PAGES = {
  devices: devicesPage,
  device: devicePage,
  overlays: overlaysPage,
  config: configPage,
  "config-raw": configRawPage,
  health: healthPage,
};

/**
 * @param {HTMLElement} root the element pages render into
 * @returns {{go: (hash: string) => void, current: () => {route: string, params: Record<string, string>}}}
 */
export function startRouter(root) {
  /** @type {{route: string, params: Record<string, string>}} */
  let current = { route: "", params: {} };
  /** @type {Page|null} */
  let mounted = null;
  /** The route under the enlarged view, to go back to when it closes. */
  let under = "#/devices";
  /** @type {{close: () => void}|null} */
  let enlarged = null;

  /** @param {string} nav */
  function markNav(nav) {
    for (const link of document.querySelectorAll("[data-nav]")) {
      if (link.getAttribute("data-nav") === nav) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  /**
   * @param {string} route
   * @param {Record<string, string>} params
   */
  function mount(route, params) {
    const same =
      current.route === route &&
      JSON.stringify(current.params) === JSON.stringify(params);
    if (same && mounted) return;
    mounted?.unmount();
    root.replaceChildren();
    mounted = PAGES[route] ?? devicesPage;
    current = { route, params };
    mounted.mount(root, params);
    const title = /** @type {HTMLElement|null} */ (root.querySelector("h1"));
    title?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function follow() {
    const { route, params, nav } = parseHash(location.hash);
    markNav(nav);
    if (route === "enlarged") {
      if (!mounted) mount("device", { name: params.name });
      // An open view steps by itself (Previous, Next, the arrow keys); the
      // address only follows it.
      if (enlarged) return;
      const opener = /** @type {HTMLElement} */ (
        document.activeElement instanceof HTMLElement ? document.activeElement : root
      );
      enlarged = openEnlargedPreview(params.name, opener, {
        onClose: () => {
          enlarged = null;
          if (parseHash(location.hash).route === "enlarged") location.hash = under;
        },
        onStep: (/** @type {string} */ name) => {
          location.replace(`#/devices/${encodeURIComponent(name)}/enlarged`);
        },
      });
      return;
    }
    if (enlarged) {
      const closing = enlarged;
      enlarged = null;
      closing.close();
    }
    under = location.hash || "#/devices";
    mount(route, params);
  }

  window.addEventListener("hashchange", follow);
  follow();
  return {
    go(hash) {
      location.hash = hash;
    },
    current: () => ({ ...current }),
  };
}
