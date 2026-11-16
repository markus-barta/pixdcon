/**
 * Formatting: times, ages, percentages and the version, as the mockups write them.
 *
 *  - times in 24-hour form, local time of the browser: "18:42:06" (build note)
 *  - ages: "1 s ago", "41 s ago", "14 min ago", "9 h 28 min"
 *  - preview label: "frame 18:42:06", "frame 2 s ago", "last frame 18:42:06";
 *    never "updated" or "changed" (build rule 5)
 *  - version: Pretty CalVer "26·10·09 06:53" from "261009065314.0.0"; a click
 *    copies the canonical version (the pinned bundle under
 *    /vendor/inspr-versioning does the rendering)
 *  - numbers with a thin grouping space as in the mockups: "3 600 000"
 *
 * Owner: UI worker.
 */

import { todo } from "./todo.js";

/** @param {string|number|null} at ISO time or epoch ms @returns {string} "18:42:06" or "—" */
export function clock(at) {
  return todo("format.clock", at);
}

/** @param {string|number|null} at @param {number} now epoch ms @returns {string} "2 s ago" */
export function ago(at, now) {
  return todo("format.ago", at, now);
}

/** @param {number|null} percent @returns {string} "30 %" or "—" */
export function percent(percent) {
  return todo("format.percent", percent);
}

/** @param {number} value @returns {string} "3 600 000" */
export function grouped(value) {
  return todo("format.grouped", value);
}
