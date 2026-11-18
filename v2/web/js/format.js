/**
 * Formatting: times, ages, percentages and the version, as the mockups write them.
 *
 *  - times in 24-hour form, local time of the browser: "18:42:06" (build note)
 *  - ages: "1 s ago", "41 s ago", "14 min ago", "9 h 28 min"
 *  - preview label: "frame 18:42:06", "frame 2 s ago", "last frame 18:42:06";
 *    never "updated" or "changed" (build rule 5)
 *  - version: Pretty CalVer "26·10·09 06:53" from "261009065314.0.0"; a click
 *    copies the canonical version. The mockups draw it as plain text in the
 *    meta colour, so it is formatted here; the tinted renderer of the pinned
 *    bundle under /vendor/inspr-versioning is not used (colour carries state
 *    only, approved spec section 4)
 *  - numbers grouped by three with a space, as in the mockups: "3 600 000"
 *
 * Pure: no DOM. Owner: UI worker.
 */

/**
 * @param {string|number|null|undefined} at ISO time or epoch ms
 * @returns {Date|null}
 */
function toDate(at) {
  if (at === null || at === undefined || at === "") return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

const two = (/** @type {number} */ n) => String(n).padStart(2, "0");

/** @param {string|number|null|undefined} at ISO time or epoch ms @returns {string} "18:42:06" or "—" */
export function clock(at) {
  const date = toDate(at);
  if (!date) return "—";
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** @param {string|number|null|undefined} at @returns {string} "18:42" or "—" */
export function clockShort(at) {
  const date = toDate(at);
  if (!date) return "—";
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * A length of time as the mockups write it: "4 s", "14 min", "9 h 28 min", "3 d 2 h".
 *
 * @param {number} ms
 * @returns {string}
 */
export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** @param {string|number|null|undefined} at @param {number} now epoch ms @returns {string} "2 s ago", or "—" */
export function ago(at, now) {
  const date = toDate(at);
  if (!date) return "—";
  return `${duration(now - date.getTime())} ago`;
}

/** @param {number|null|undefined} value @returns {string} "30 %" or "—" */
export function percent(value) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return `${Math.round(value)} %`;
}

/** @param {number} value @returns {string} "3 600 000" */
export function grouped(value) {
  if (!Number.isFinite(value)) return String(value);
  const sign = value < 0 ? "-" : "";
  const [whole, fraction] = String(Math.abs(value)).split(".");
  const digits = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${digits}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Pretty CalVer of the release coordinate "YYMMDDhhmmss.0.0".
 *
 * @param {string|null|undefined} version
 * @returns {{pretty: string, canonical: string, utc: string}|null} null when it is not a CalVer coordinate
 */
export function prettyVersion(version) {
  const match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.0\.0$/.exec(
    version ?? "",
  );
  if (!match) return null;
  const [, yy, mm, dd, hh, mi, ss] = match;
  return {
    pretty: `${yy}·${mm}·${dd} ${hh}:${mi}`,
    canonical: /** @type {string} */ (version),
    utc: `20${yy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC`,
  };
}

/**
 * The preview caption's time part (build rule 5: when a frame was last
 * received, never "updated").
 *
 * @param {string|null|undefined} receivedAt
 * @param {number} now
 * @param {{stale?: boolean}} [options] stale: also say the age ("frame 18:41:26, 41 s ago")
 * @returns {string}
 */
export function frameLabel(receivedAt, now, options = {}) {
  if (!toDate(receivedAt)) return "no frame yet";
  return options.stale
    ? `frame ${clock(receivedAt)}, ${ago(receivedAt, now)}`
    : `frame ${clock(receivedAt)}`;
}

/** @param {string} text @returns {string} the text with &, <, >, " and ' escaped for HTML */
export function esc(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * A topic with break opportunities after each "/", escaped (the Source row
 * of the device page lets long topics break there, approved spec 5).
 *
 * @param {string} topic
 * @returns {string} HTML
 */
export function topicHtml(topic) {
  return String(topic ?? "")
    .split("/")
    .map(esc)
    .join("/<wbr>");
}
