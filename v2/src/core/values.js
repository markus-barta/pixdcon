/** Shared value helpers. No I/O, no retained mutable state. */

/** @template T @param {T} value @returns {T} */
export function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
export function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {import("../types.js").ConfigDiff} diff @returns {boolean} */
export function hasDiff(diff) {
  return Object.values(diff).some((value) =>
    Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0,
  );
}
