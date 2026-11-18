/**
 * A small stand-in for the overlay service and the state store around the
 * pure scene layers (src/overlay/scene-layers.js), for the contract tests:
 * it feeds inputs to the reducer, carries out what the reducer answers with
 * the way the two modules have to (the choice and its suppressions saved in
 * one write, a retired suppression removed by its generation), and answers
 * what a display would show through the scene precedence.
 *
 * It also is the consumer the fifth round asks for: `follower` holds, per
 * device, what a module holds that computes a device again only when a
 * "changed" effect names it, and never looks at the state otherwise; and
 * the blob as a document, read again only when the effect says so. The
 * tests compare both with the whole state after every step (`stale()`):
 * they must always agree.
 *
 * Not a test file. Owner: core/state worker.
 */

import { isDeepStrictEqual } from "node:util";
import {
  blobView,
  createLayers,
  planChoice,
  reduce,
  sceneInputs,
} from "../../src/overlay/scene-layers.js";
import { resolveScene } from "../../src/state/precedence.js";

export const T0 = "2026-11-16T17:42:07.000Z";

/**
 * A small seeded generator (mulberry32): the same seed, the same walk.
 *
 * @param {number} seed
 * @returns {() => number} numbers in [0, 1)
 */
export function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} options
 * @param {Record<string, "drive"|"shadow">} options.outputs the resolved output of every device in the effective config. A process starts with every device in shadow and is told these, one `output` input each, as the overlay service is by main.js (OverlayService.applyOutputs)
 * @param {Record<string, string|null>} [options.choices] the saved choices config.json starts with
 * @param {boolean} [options.blobWriter] default true: this instance is the one that may write the blob (scene-layers.js W1). false: v1 still runs (the transition), or this is the edge instance
 * @param {string} [options.name] names the instance in the secrets of its runs; two worlds on one broker need two names
 * @param {Record<string, import("../../src/types.js").SceneSuppression>} [options.saved] the suppressions config.json starts with, by "<device>/<layer>": a process that starts on the file an earlier run left
 */
export function world(options) {
  const blobWriter = options.blobWriter ?? true;
  const name = options.name ?? "run";
  /** Runs of the process: each has its own secret for the write marks. */
  let runs = 1;
  /** config.json: the saved choice per device and the saved suppressions. @type {Map<string, string|null>} */
  const choices = new Map(Object.entries(options.choices ?? {}));
  /** @type {Map<string, import("../../src/types.js").SceneSuppression>} */
  const saved = new Map(Object.entries(options.saved ?? {}));
  /** What createLayers takes of config.json at a start (S5). */
  const savedList = () =>
    [...saved].map(([key, suppression]) => {
      const [device, layer] = key.split("/");
      return {
        device,
        layer: /** @type {"granular"|"blob"} */ (layer),
        suppression,
      };
    });
  let state = createLayers({
    secret: `${name} 1`,
    blobWriter,
    saved: savedList(),
  });
  /** @type {Array<import("../../src/overlay/scene-layers.js").LayersEffect & {on: string}>} */
  const effects = [];

  /** What the display of a device shows, by the scene precedence over the whole state. @param {string} device */
  const shows = (device) => {
    const inputs = sceneInputs(state, device);
    /** @param {{scene: string, inEffect: boolean}|null} layer @param {string} id */
    const layerOf = (layer, id) =>
      layer && {
        scene: layer.scene,
        inEffect: layer.inEffect,
        since: T0,
        overlayId: id,
      };
    const resolved = resolveScene({
      configScene: choices.get(device) ?? null,
      configSince: T0,
      uiChoice: null,
      granular: layerOf(inputs.granular, `device-scene:${device}`),
      blob: layerOf(inputs.blob, "blob"),
      check: () => null,
    });
    return `${resolved.scene} (${resolved.source})`;
  };

  /**
   * The consumer that is driven by effects: device → what it computed when
   * the device was last named by a "changed" effect (or when it first
   * looked, which is the first build of a module that starts).
   *
   * @type {Map<string, {shows: string, inputs: ReturnType<typeof sceneInputs>}>}
   */
  const follower = new Map();
  /** @param {string} device */
  const compute = (device) => {
    const held = { shows: shows(device), inputs: sceneInputs(state, device) };
    follower.set(device, held);
    return held;
  };
  /** @param {string} device */
  const followed = (device) => follower.get(device) ?? compute(device);
  /** The blob as the consumer read it when it was last told to. */
  let followedBlob = blobView(state);

  /** @param {import("../../src/overlay/scene-layers.js").LayersInput} input */
  const feed = (input) => {
    const result = reduce(state, input);
    state = result.state;
    for (const effect of result.effects) {
      effects.push({ ...effect, on: input.type });
      // The state store removes exactly the generation the effect names.
      if (effect.type === "retire") {
        const key = `${effect.device}/${effect.layer}`;
        if (saved.get(key)?.generation === effect.generation) saved.delete(key);
      }
    }
    // The consumer computes again for exactly what was named.
    for (const effect of result.effects)
      if (effect.type === "changed") {
        effect.devices.forEach(compute);
        if (effect.blob) followedBlob = blobView(state);
      }
    return result;
  };

  /**
   * The start of a process: the runtime config has resolved who is driven,
   * and tells the layers. Then a module that starts builds everything once.
   *
   * @param {Iterable<[string, "drive"|"shadow"]>} outputs
   */
  const boot = (outputs) => {
    for (const [device, output] of outputs)
      feed({ type: "output", device, output });
    const known = new Set([
      ...state.outputs.keys(),
      ...choices.keys(),
      ...follower.keys(),
    ]);
    follower.clear();
    known.forEach(compute);
    followedBlob = blobView(state);
  };
  boot(Object.entries(options.outputs));

  return {
    feed,
    state: () => state,
    saved,
    choices,
    effects,
    blobWriter,
    /**
     * Effects since the mark, of the given types. Typed loosely: a test
     * names the kind it asked for and reads that kind's fields.
     *
     * @param {number} mark
     * @param {...string} types
     * @returns {any[]}
     */
    since: (mark, ...types) =>
      effects.slice(mark).filter((effect) => types.includes(effect.type)),
    /** @param {number} connection */
    connect: (connection) => feed({ type: "connect", connection }),
    /** @param {number} connection */
    disconnect: (connection) => feed({ type: "disconnect", connection }),
    /** @param {number} connection */
    settle: (connection) =>
      feed({ type: "settled", connection, complete: true }),
    /**
     * @param {string} device
     * @param {string} payload
     * @param {{retain: boolean, connection: number}} meta
     */
    granular: (device, payload, meta) =>
      feed({ type: "granular", device, payload, ...meta }),
    /**
     * @param {string|object} payload
     * @param {{retain: boolean, connection: number}} meta
     */
    blob: (payload, meta) =>
      feed({
        type: "blob",
        payload:
          typeof payload === "string" ? payload : JSON.stringify(payload),
        ...meta,
      }),
    /**
     * A UI choice: planned, saved with its suppressions in one write, then
     * put into effect.
     *
     * @param {string} device
     * @param {string|null} scene
     */
    choose(device, scene) {
      const plan = planChoice(state, device, {
        at: T0,
        output: state.outputs.get(device) ?? "shadow",
      });
      choices.set(device, scene);
      for (const layer of /** @type {const} */ (["granular", "blob"])) {
        const suppression = plan[layer];
        if (suppression) saved.set(`${device}/${layer}`, suppression);
        else saved.delete(`${device}/${layer}`);
      }
      return { plan, ...feed({ type: "choice", plan }) };
    },
    /**
     * The device leaves the effective config: its entry is deleted from
     * config.json, and with it the saved choice and the saved suppressions.
     * The file changes first; the overlay service is told then.
     *
     * @param {string} device
     */
    remove(device) {
      choices.delete(device);
      const result = feed({ type: "removed", device });
      saved.delete(`${device}/granular`);
      saved.delete(`${device}/blob`);
      return result;
    },
    /**
     * A device enters the effective config (again), with its resolved output
     * and, if the new entry has one, a saved scene.
     *
     * @param {string} device
     * @param {"drive"|"shadow"} output
     * @param {string|null} [scene]
     */
    add(device, output, scene = null) {
      if (scene === null) choices.delete(device);
      else choices.set(device, scene);
      return feed({ type: "output", device, output });
    },
    /** A new process: nothing but config.json survives. The effective config, and so who is driven, is what it was. */
    restart() {
      runs += 1;
      const outputs = [...state.outputs];
      state = createLayers({
        secret: `${name} ${runs}`,
        blobWriter,
        saved: savedList(),
      });
      boot(outputs);
    },
    shows,
    /** What the consumer that is driven by effects shows for a device. @param {string} device */
    follows: (device) => followed(device).shows,
    /**
     * Where the consumer that is driven by effects no longer agrees with
     * the state: what a device shows, what it holds of the two layers, or
     * the blob as a document. Empty when every change was announced.
     *
     * @param {string[]} devices
     * @returns {string[]} one line per device that is stale
     */
    stale(devices) {
      /** @type {string[]} */
      const lines = [];
      if (!isDeepStrictEqual(followedBlob, blobView(state)))
        lines.push(
          `the blob: the consumer holds ${JSON.stringify(followedBlob)}, the state says ${JSON.stringify(blobView(state))}`,
        );
      for (const device of devices) {
        const held = followed(device);
        const direct = shows(device);
        if (held.shows !== direct)
          lines.push(
            `${device}: the consumer shows ${held.shows}, the state says ${direct}`,
          );
        else if (!isDeepStrictEqual(held.inputs, sceneInputs(state, device)))
          lines.push(
            `${device}: the consumer holds ${JSON.stringify(held.inputs)}, the state says ${JSON.stringify(sceneInputs(state, device))}`,
          );
      }
      return lines;
    },
  };
}
