/**
 * Built-in modes: one registry for the UI list and for activation.
 *
 * v1 keeps the list for the UI in the drivers and the activation maps in the
 * render loop; an unknown key such as "builtin:Time" was logged as active and
 * did nothing (matrix D-197, D-B24). Here both come from one table, and an
 * unknown key is rejected when a scene is chosen.
 *
 * Keys, labels and order are the v1 contract (D-010, D-085): they are stored
 * in config.json and in retained scene overlays (pixoo-189 runs "builtin:clock").
 *
 * Owner: drivers worker.
 */

/** @typedef {import("../types.js").BuiltinMode} BuiltinMode */
/** @typedef {import("../types.js").DeviceType} DeviceType */

/** @type {Readonly<Record<DeviceType, ReadonlyArray<BuiltinMode>>>} */
export const BUILTIN_MODES = Object.freeze({
  pixoo: Object.freeze([
    { key: "builtin:clock", label: "Clock", channel: 0 },
    { key: "builtin:cloud", label: "Cloud Channel", channel: 1 },
    { key: "builtin:visualizer", label: "Visualizer", channel: 2 },
    { key: "builtin:animation", label: "Animation", channel: 4 },
    // screen off; no channel is selected
    { key: "builtin:black", label: "Black (Screen Off)" },
  ]),
  ulanzi: Object.freeze([
    { key: "builtin:time", label: "Time", app: "Time" },
    { key: "builtin:date", label: "Date", app: "Date" },
    { key: "builtin:temp", label: "Temperature", app: "Temperature" },
    { key: "builtin:humidity", label: "Humidity", app: "Humidity" },
    { key: "builtin:battery", label: "Battery", app: "Battery" },
  ]),
});

/** @param {string|null|undefined} scene */
export function isBuiltin(scene) {
  return typeof scene === "string" && scene.startsWith("builtin:");
}

/**
 * @param {DeviceType} type
 * @param {string} key
 * @returns {BuiltinMode|null} null for a key this device type does not have
 */
export function findBuiltin(type, key) {
  return BUILTIN_MODES[type]?.find((mode) => mode.key === key) ?? null;
}
