/* global document, location */
/**
 * Theme: System, Light or Dark for this browser (Config › This browser).
 * Order: `?theme=dark|light` in the address, then localStorage key
 * "pixdcon.theme", then the system setting. Sets `data-theme` on <html>;
 * app.css does the rest.
 *
 * Owner: UI worker.
 */

const KEY = "pixdcon.theme";

/** @returns {"light"|"dark"|null} the theme the address asks for */
function fromAddress() {
  const value = new URLSearchParams(location.search).get("theme");
  return value === "light" || value === "dark" ? value : null;
}

/** @returns {"system"|"light"|"dark"} the choice saved in this browser */
function saved() {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** @returns {"system"|"light"|"dark"} */
export function currentTheme() {
  return fromAddress() ?? saved();
}

/** @returns {"system"|"light"|"dark"} what Config › This browser shows as chosen: the saved choice, not the address */
export function savedTheme() {
  return saved();
}

/** @param {"system"|"light"|"dark"} theme */
export function setTheme(theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {}
  applyTheme();
}

/** @returns {"pretty"|"semver"} the version display chosen in this browser (Health › Version display, B-058) */
export function versionDisplay() {
  try {
    return localStorage.getItem("pixdcon.versionDisplay") === "semver" ? "semver" : "pretty";
  } catch {
    return "pretty";
  }
}

/** @param {"pretty"|"semver"} value */
export function setVersionDisplay(value) {
  try {
    localStorage.setItem("pixdcon.versionDisplay", value);
  } catch {}
}

/** Put the theme in effect on <html>: the address wins, then the saved choice. */
export function applyTheme() {
  const theme = currentTheme();
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}
