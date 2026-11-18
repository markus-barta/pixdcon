/* global document */
/**
 * Small DOM helpers shared by the pages: icons from the sprite in
 * index.html, escaped lines in the shape of the mockups, and slots that are
 * written only when what they show changed, so focus, open selects and
 * hover states survive the 1 s refresh.
 *
 * Owner: UI worker.
 */

import { esc } from "./format.js";

/**
 * @param {string} name sprite id without "i-"
 * @param {string} [cls] "sm" for 14 px
 * @returns {string} HTML
 */
export function icon(name, cls = "sm") {
  const spin = name === "spinner" ? " spin" : "";
  return `<svg class="i ${cls}${spin}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/**
 * @param {string|null|undefined} kind "ok", "warn", "bad", "idle", "shadow"
 * @returns {string} HTML
 */
export function dot(kind) {
  return `<span class="dot ${esc(kind ?? "idle")}" aria-hidden="true"></span>`;
}

/**
 * A line of the view model with its icon or dot.
 *
 * @param {{text: string, icon?: string|null, dot?: string|null}} line
 * @returns {string} HTML
 */
export function lineHtml(line) {
  const lead = line.dot ? dot(line.dot) : line.icon ? icon(line.icon) : "";
  return `${lead}${esc(line.text)}`;
}

/** @type {WeakMap<Element, string>} */
const written = new WeakMap();

/**
 * Write HTML into a slot when it differs from what the slot shows.
 *
 * @param {Element|null|undefined} slot
 * @param {string} html
 * @returns {boolean} true when the slot was written
 */
export function setHtml(slot, html) {
  if (!slot || written.get(slot) === html) return false;
  slot.innerHTML = html;
  written.set(slot, html);
  return true;
}

/**
 * @param {Element|null|undefined} element
 * @param {string} cls
 */
export function setClass(element, cls) {
  if (element && element.className !== cls) element.className = cls;
}

/**
 * @param {Element|null|undefined} element
 * @param {string} name
 * @param {string|null} value null removes it
 */
export function setAttr(element, name, value) {
  if (!element) return;
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value)
    element.setAttribute(name, value);
}

/**
 * @param {string} html one element
 * @returns {HTMLElement}
 */
export function fromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return /** @type {HTMLElement} */ (template.content.firstElementChild);
}

/**
 * The title line every page starts with (approved spec 2): h1 plus one
 * status sentence; problems are written into it, never into a banner.
 *
 * @param {Element} slot the `.sub` span
 * @param {{text: string, cls?: string, icon?: string|null, title?: string, parts?: Array<{text: string, cls?: string}>}|null} line
 */
export function setStatusLine(slot, line) {
  if (!line) {
    setClass(slot, "sub");
    setHtml(slot, "");
    setAttr(slot, "title", null);
    return;
  }
  setClass(slot, `sub${line.cls ? ` ${line.cls}` : ""}`);
  const body = line.parts
    ? line.parts
        .map((part) =>
          part.cls
            ? `<span style="color:var(--${part.cls})">${esc(part.text)}</span>`
            : esc(part.text),
        )
        .join(" · ")
    : esc(line.text);
  setHtml(slot, line.icon ? `${icon(line.icon)}<span>${body}</span>` : body);
  setAttr(slot, "title", line.title ?? line.text);
}
