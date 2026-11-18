/**
 * Operations: one rule for everything a page sends (PIXD-86, fix round 2).
 *
 * Every user action, load, retry and cleanup is an operation in a slot. A
 * slot is the identity of what the operation acts on, written as a key:
 *
 *   scene:<device>@<epoch>/<incarnation>    a control of one life of a device
 *                                           (scene, mode, brightness, restore,
 *                                           adopt, retry, patch)
 *   settings:<device>/<scene>@<epoch>/<incarnation>   Save, Revert, Clear of a form
 *   load:<device>/<scene>@<epoch>/<incarnation>       the settings values of a scope
 *   preview:<device>/<scene>@<epoch>/<incarnation>   one preview lane outcome
 *   end:<device>/<scene>                    the end of this page's preview of a scene
 *   copy:<scene>  overlay:<id>  add-device  raw-load  raw-save  raw-reload  log
 *
 * The rule, as this module carries it:
 *  1. An operation takes a token when it starts; the slot's token is the
 *     operation that is current for it.
 *  2. Its outcome changes the slot, and runs the caller's `done`, only while
 *     its token is still the slot's and its captured epoch and device life
 *     are current. Device callers declare `device`; inherited captures keep
 *     that life through queued work. Missing devices retire their old work.
 *     Page effects declare their identity projection through `effect` or
 *     `current.effect`. Deferred work inherits the capture through `owner`
 *     or `current.follow`; it is checked before any request starts.
 *     An obsolete outcome changes nothing on
 *     screen. What an answer brings goes to the store first, in the
 *     operation's own work (store.applyAnswer: the fence decides), whether
 *     or not the operation is still current.
 *  3. A failure of the current operation is kept in the slot, and the page
 *     says it beside the action, which stays available to retry (B-175).
 *  4. Every request has a time bound (api.js REQUEST_TIMEOUT_MS). When it
 *     runs out, the request fails like any other, and the slot is free.
 *  5. One busy owner per slot, across all pages and openings: the slots are
 *     kept in the store (`state.ops`) for the run, and `start` ignores a second start
 *     while the slot is busy, before anything is changed (B-176).
 *  6. A retry is a new operation in the same slot, with the identity it
 *     retries (the caller passes it on).
 *
 * `start` is for what a person does (rule 5). `follow` is for loads and
 * cleanups: it always starts, and the operation that ran in the slot
 * before becomes obsolete. Pages render busy labels, failures and notes
 * from `op(key)`; the store calls them when a slot changes.
 * A resource observation can retire declared slots when a newer streamed
 * copy arrives; deferred replacement keeps its run, observation and visit.
 *
 * Owner: UI worker.
 */

import { ApiError, retireControl } from "./api.js";
import { fence, getState, setOp, subscribe } from "./store.js";

/** @typedef {import("./store.js").OpSlot} OpSlot */

/** @type {OpSlot} */
const IDLE = Object.freeze({
  token: 0,
  busy: false,
  label: "",
  value: undefined,
  failure: null,
  note: null,
});

let tokens = 0;

/**
 * Readers name the identities an effect may project on. Values are taken
 * once, before work starts; a deferred step inherits this same capture.
 * Device life is a baseline for device work, including explicit projections.
 * Child effects add definition and draft readers with derive; the scope's
 * captured epoch/life/scene values are inherited, never refreshed.
 *
 * @typedef {{readers: Record<string, () => unknown>, values: Record<string, unknown>, slot?: {key: string, token: number}}} Ownership
 */
/** @template T @typedef {Promise<T> & {retire: () => void}} Task a pending operation with cancellation bound to its captured token */
/**
 * @typedef {((projection?: string[]) => boolean) & {owner: Ownership, effect: <T>(name: string, work: () => T) => T|undefined, follow: <T>(key: string, work: (current: Operation) => Promise<T>, options?: OpOptions<T>) => Promise<T>}} Operation
 */

/** @param {Record<string, () => unknown>} [owns] @param {string} [device] @returns {Ownership} */
export function capture(owns = {}, device) {
  const readers = Object.freeze({ epoch: () => getState().epoch, ...owns,
    ...(device === undefined ? {} : { life: () => getState().devices.get(device)?.incarnation ?? null }),
  });
  return Object.freeze({
    readers,
    values: Object.freeze(Object.fromEntries(Object.entries(readers).map(([name, read]) => [name, read()]))),
  });
}

/** Add effect identities without refreshing any identity already captured.
 * A preview can capture its definition and draft when it leaves a lane,
 * while retaining the scope that originally queued it.
 * @param {Ownership} owner @param {Record<string, () => unknown>} owns
 * @returns {Ownership}
 */
export function derive(owner, owns) {
  const additions = Object.fromEntries(Object.entries(owns).filter(([name]) => !(name in owner.readers)));
  return Object.freeze({
    ...owner,
    readers: Object.freeze({ ...owner.readers, ...additions }),
    values: Object.freeze({ ...owner.values, ...Object.fromEntries(Object.entries(additions).map(([name, read]) => [name, read()])) }),
  });
}

/** The single admission rule for slot outcomes and projected page effects.
 * @param {Ownership} owner @param {string[]} projection @returns {boolean}
 */
export function owned(owner, projection) {
  if (owner.slot && op(owner.slot.key).token !== owner.slot.token) return false;
  if (owner.readers.life && owner.readers.life() !== owner.values.life) return false;
  for (const name of projection) {
    const read = owner.readers[name];
    if (read() !== owner.values[name]) return false;
  }
  return true;
}

/** @template T @param {Ownership} owner @param {string[]} projection @param {() => T} work @returns {T|undefined} */
export function effect(owner, projection, work) {
  if (!owned(owner, projection)) return;
  return work();
}

/** Observe a newer streamed copy of a resource in the same run, or only run
 * changes when resource is null. HTTP answers do not move the stream and
 * must not recursively request themselves. A snapshot replaces an untouched
 * resource editor only when its declared revision advanced; equal reconnects
 * preserve its read. Capture the observation and slot tokens before deferring:
 * neither a later snapshot nor a successor operation belongs to this event.
 * @param {string|null} resource @param {() => void} changed
 * @param {{eligible?: () => boolean, slots?: string[], version?: () => number|undefined}} [options]
 * @returns {() => void}
 */
export function observeResource(resource, changed, options = {}) {
  /** @type {{epoch: string|null, seq: number, position: number, floor: number, version: number|undefined}|undefined} */
  let previous;
  let generation = 0;
  let active = true;
  const unsubscribe = subscribe(
    () => ({ epoch: getState().epoch, seq: fence().seq, position: resource === null ? 0 : fence().applied.get(resource) ?? 0,
      floor: fence().floor, version: options.version?.() }),
    (now) => {
      const before = previous;
      previous = now;
      if (before && (resource === null ? now.epoch !== before.epoch :
        now.epoch === before.epoch && now.seq > before.seq && now.position > before.position &&
        (now.position > now.floor || (now.version ?? 0) > (before.version ?? 0)))) {
        const mine = ++generation;
        const slots = (options.slots ?? []).map((key) => ({ key, token: op(key).token }));
        // Coalesce one publication/input turn; recheck local eligibility and
        // the captured run before starting deferred replacement work.
        queueMicrotask(() => {
          if (!active || mine !== generation || getState().epoch !== now.epoch || resource !== null && fence().floor > now.floor || !(options.eligible?.() ?? true)) return;
          for (const { key, token } of slots) {
            if (token && op(key).token === token) {
              retireControl(key);
              dropOwn(key, token);
            }
          }
          changed();
        });
      }
    },
  );
  return () => { active = false; unsubscribe(); };
}

/** Drop only the operation this continuation actually superseded.
 * @param {string} key @param {number} token
 */
export function dropOwn(key, token) {
  if (op(key).token === token) drop(key);
}

/**
 * @param {string} key
 * @returns {OpSlot} the slot, or an idle one
 */
export function op(key) {
  return getState().ops.get(key) ?? IDLE;
}

/**
 * @param {string} key
 * @returns {boolean} an operation of the slot runs
 */
export function busy(key) {
  return op(key).busy;
}

/**
 * The slot of a control of one life of a device: another epoch of pixdcon
 * or another incarnation of the device is another slot, so nothing of an
 * earlier life (busy, failure) reaches the device that took its name.
 *
 * @param {string} control
 * @param {{name: string, epoch?: string|null, incarnation?: number|string|null}} view the DeviceView
 * @returns {string}
 */
export function deviceSlot(control, view) {
  return `${control}:${view.name}@${view.epoch ?? ""}/${Number(view.incarnation ?? 0)}`;
}

/**
 * @param {unknown} error
 * @returns {string} one sentence for a person
 */
export function failureText(error) {
  return error instanceof ApiError ? error.message : "The request failed.";
}

/**
 * @template T
 * @typedef {object} OpOptions
 * @property {string} [label] the busy label
 * @property {unknown} [value] what the operation asks for (shown while it runs)
 * @property {(result: T) => (string|null|void)} [done] runs only while the operation is current; what it returns is the slot's note
 * @property {(result: T) => (string|null)} [note] pure slot note, evaluated under slot ownership independently of page callback projections; overrides done's return
 * @property {(error: unknown) => (string|void)} [describe] the failure sentence to keep, when it is not the error's own
 * @property {(error: unknown) => void} [failed] runs only while the operation is current, after the failure was kept
 * @property {Ownership} [owner] inherited capture, never refreshed by deferred work
 * @property {Record<string, () => unknown>} [owns] additional identities, captured at start
 * @property {string} [device] device whose life owns this work; absent for scene/global resources
 * @property {Record<string, string[]>} [effects] named projections for current.effect, plus start, slot, done and failed; slot outcomes always depend on declared device life, with epoch as the default projection
 */

/**
 * A user action: ignored while its slot is busy (rule 5).
 *
 * @template T
 * @param {string} key the slot
 * @param {(current: Operation) => Promise<T>} work the request(s); applies what comes back to the store. `current()` says whether the operation still owns the effect
 * @param {OpOptions<T>} [options]
 * @returns {boolean} false: the slot was busy, and nothing was started or changed
 */
export function start(key, work, options = {}) {
  const owner = options.owner ?? capture(options.owns, options.device);
  if (!owned(owner, options.effects?.start ?? ["epoch"])) return false;
  if (busy(key)) return false;
  run(key, work, { ...options, owner });
  return true;
}

/**
 * A load or a cleanup: it always starts, and an operation of the slot that
 * still runs becomes obsolete.
 *
 * @template T
 * @param {string} key
 * @param {(current: Operation) => Promise<T>} work
 * @param {OpOptions<T>} [options]
 * @returns {Task<T>} the work itself, with retire() bound to this operation; its failure is kept in the slot already
 */
export function follow(key, work, options = {}) {
  return run(key, work, options);
}

/** @template T @param {Promise<T>} outcome @param {() => void} [retire] @returns {Task<T>} */
const task = (outcome, retire = () => {}) => Object.assign(outcome, { retire });

/**
 * The slot's operation is no longer wanted (its values came by another way,
 * its scope was left): what it brings back changes nothing, and what the
 * slot said is forgotten.
 *
 * @param {string} key
 */
export function drop(key) {
  if (getState().ops.has(key)) setOp(key, null);
}

/**
 * A page opens afresh: what idle slots of its own said is forgotten; a
 * slot whose operation runs keeps it (rule 5), and its outcome is said
 * when it comes.
 *
 * @param {(key: string) => boolean} mine
 */
export function forgetIdle(mine) {
  for (const [key, slot] of getState().ops)
    if (!slot.busy && mine(key)) setOp(key, null);
}

/**
 * An edit after a success: the note goes, a failure stays (rule 3).
 *
 * @param {string} key
 */
export function clearNote(key) {
  const slot = getState().ops.get(key);
  if (slot?.note) setOp(key, { ...slot, note: null });
}

/**
 * @template T
 * @param {string} key
 * @param {(current: Operation) => Promise<T>} work
 * @param {OpOptions<T>} options
 * @returns {Task<T>}
 */
function run(key, work, options) {
  const inherited = options.owner ?? capture(options.owns, options.device);
  const projections = options.effects ?? {};
  if (!owned(inherited, projections.start ?? ["epoch"]))
    return task(Promise.resolve(/** @type {T} */ (undefined)));
  tokens += 1;
  const token = tokens;
  const owner = { ...inherited, slot: { key, token } };
  setOp(key, {
    token,
    busy: true,
    label: options.label ?? "",
    value: options.value,
    failure: null,
    note: null,
  });
  const current = /** @type {Operation} */ ((projection = projections.slot ?? ["epoch"]) => owned(owner, projection));
  current.owner = owner;
  current.effect = (name, work) => effect(owner, projections[name] ?? ["epoch"], work);
  current.follow = (key, work, options = {}) => follow(key, work, { ...options, owner });
  const outcome = (async () => work(current))();
  outcome.then(
    (result) => {
      if (!current()) return;
      /** @type {string|null} */
      let note = null;
      try {
        if (!projections.done || current(projections.done)) note = options.done?.(result) ?? null;
        if (options.note && current()) note = options.note(result);
      } catch {
        // What the page does with an answer it took cannot undo the answer.
      }
      if (!current()) return;
      setOp(key, { ...op(key), busy: false, failure: null, note });
    },
    (error) => {
      if (!current()) return;
      setOp(key, {
        ...op(key),
        busy: false,
        failure: options.describe?.(error) || failureText(error),
        note: null,
      });
      if (!projections.failed || current(projections.failed)) options.failed?.(error);
    },
  );
  return task(outcome, () => dropOwn(key, token));
}
