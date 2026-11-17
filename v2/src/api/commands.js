/** API boundary validation and shared per-device admission lanes (v1 and v2). */
import { HttpError } from "../core/errors.js";
import { createLane } from "../core/ordering.js";

/** @type {WeakMap<object, Map<string, ReturnType<typeof createLane>>>} */
const lanes = new WeakMap();

/** Reserve the device's turn before reading its request body.
 * @template T
 * @param {object} deps @param {string} device @param {() => T|Promise<T>} command
 * @returns {Promise<T>}
 */
export async function deviceCommand(deps, device, command) {
  let devices = lanes.get(deps);
  if (!devices) {
    devices = new Map();
    lanes.set(deps, devices);
  }
  let lane = devices.get(device);
  if (!lane) {
    lane = createLane();
    devices.set(device, lane);
  }
  // Capture the error inside the lane: its infrastructure deliberately catches errors.
  const result = await lane.run(device, async () => {
    try {
      return { value: await command() };
    } catch (error) {
      return { error };
    }
  });
  if (!lane.pending()) devices.delete(device);
  if (!result.ran)
    throw new HttpError(503, "shutting_down", "pixdcon is stopping");
  if ("error" in result.value) throw result.value.error;
  return /** @type {T} */ (result.value.value);
}

/** @param {unknown} value @param {string} field @returns {string} */
export function text(value, field) {
  if (typeof value !== "string" || !value.trim())
    invalid(field, `${field} is required`);
  return /** @type {string} */ (value);
}

/** @param {unknown} value @param {string} field @returns {Record<string, unknown>} */
export function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(field, `${field} must be an object`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {string} field @param {string} message @returns {never} */
export function invalid(field, message) {
  throw new HttpError(400, "invalid_field", message, { field });
}

/** Resolve the store's authoritative output policy before a broker write.
 * @param {import("./routes-v1.js").ApiDeps} deps @param {string} name
 */
export function requireDrive(deps, name) {
  if (deps.state.view(name).desired.output === "shadow")
    throw new HttpError(
      409,
      "shadow_output",
      "This device is in shadow output",
    );
}

/** @param {Record<string, unknown>} body @param {string[]} allowed */
export function keys(body, allowed) {
  for (const key of Object.keys(body))
    if (!allowed.includes(key)) invalid(key, `Unsupported field: ${key}`);
}

/** @param {Record<string, unknown>} body */
export function draft(body) {
  text(body.session, "session");
  if (
    !Number.isSafeInteger(body.draft) ||
    /** @type {number} */ (body.draft) < 0
  )
    invalid("draft", "draft must be a non-negative integer");
  return {
    session: /** @type {string} */ (body.session),
    draft: /** @type {number} */ (body.draft),
  };
}

/** @param {Record<string, unknown>} body @returns {{name: string, type: import("../types.js").DeviceType, ip: string}} */
export function newDevice(body) {
  const name = text(body.name, "name");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name) ||
    ["__proto__", "constructor", "prototype"].includes(name)
  )
    invalid("name", "Invalid device name");
  if (body.type !== "pixoo" && body.type !== "ulanzi")
    invalid("type", "type must be pixoo or ulanzi");
  return { name, type: body.type, ip: text(body.ip, "ip") };
}

/** @param {Record<string, unknown>} patch @param {boolean} [legacy] */
export function devicePatch(patch, legacy = false) {
  keys(
    patch,
    legacy
      ? ["displayName", "comment", "preview", "ip", "scene", "enabled"]
      : ["displayName", "comment", "preview"],
  );
  for (const key of ["displayName", "comment", "ip"])
    if (key in patch && typeof patch[key] !== "string")
      invalid(key, `${key} must be a string`);
  if ("enabled" in patch && typeof patch.enabled !== "boolean")
    invalid("enabled", "enabled must be boolean");
  if (
    "scene" in patch &&
    patch.scene !== null &&
    typeof patch.scene !== "string"
  )
    invalid("scene", "scene must be a string or null");
  if ("preview" in patch) {
    const preview = object(patch.preview, "preview");
    keys(preview, ["pollMs", "showGrid"]);
    if ("showGrid" in preview && typeof preview.showGrid !== "boolean")
      invalid("preview.showGrid", "showGrid must be boolean");
    if (
      "pollMs" in preview &&
      (!Number.isInteger(preview.pollMs) ||
        Number(preview.pollMs) < 1000 ||
        Number(preview.pollMs) > 10000)
    )
      invalid("preview.pollMs", "pollMs must be an integer from 1000 to 10000");
  }
  return patch;
}
