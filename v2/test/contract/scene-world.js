/**
 * A small stand-in for the overlay service and the state store around the
 * pure scene layers (src/overlay/scene-layers.js), for the contract tests:
 * it feeds inputs to the reducer, carries out what the reducer answers with
 * the way the two modules have to (the choice and its suppressions saved in
 * one write, a retired suppression removed by its generation), and answers
 * what a display would show through the scene precedence.
 *
 * Not a test file. Owner: core/state worker.
 */

import {
  createLayers,
  planChoice,
  reduce,
  sceneInputs,
} from "../../src/overlay/scene-layers.js";
import { resolveScene } from "../../src/state/precedence.js";

export const T0 = "2026-11-16T17:42:07.000Z";

/**
 * @param {{outputs: Record<string, "drive"|"shadow">, choices?: Record<string, string|null>}} options
 */
export function world(options) {
  /** Runs of the process: each has its own secret for the write marks. */
  let runs = 1;
  let state = createLayers({ outputs: options.outputs, secret: "run 1" });
  /** config.json: the saved choice per device and the saved suppressions. @type {Map<string, string|null>} */
  const choices = new Map(Object.entries(options.choices ?? {}));
  /** @type {Map<string, import("../../src/types.js").SceneSuppression>} */
  const saved = new Map();
  /** @type {Array<import("../../src/overlay/scene-layers.js").LayersEffect & {on: string}>} */
  const effects = [];

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
    return result;
  };

  return {
    feed,
    state: () => state,
    saved,
    effects,
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
     *
     * @param {string} device
     */
    remove(device) {
      const result = feed({ type: "removed", device });
      choices.delete(device);
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
    /** A new process: nothing but config.json survives. */
    restart() {
      runs += 1;
      state = createLayers({
        secret: `run ${runs}`,
        outputs: Object.fromEntries(state.outputs),
        saved: [...saved].map(([key, suppression]) => {
          const [device, layer] = key.split("/");
          return {
            device,
            layer: /** @type {"granular"|"blob"} */ (layer),
            suppression,
          };
        }),
      });
    },
    /** What the display of a device shows, by the scene precedence. @param {string} device */
    shows(device) {
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
    },
  };
}
