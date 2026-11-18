/** Commands use the finished ordering lane, preserving rejection for callers. */
import { HttpError } from "./errors.js";
import { createLane } from "./ordering.js";

export function commandLane() {
  const lane = createLane();
  return {
    /** @template T @param {() => T|Promise<T>} work @returns {Promise<T>} */
    async run(work) {
      const result = await lane.run("command", async () => {
        try {
          return { ok: /** @type {const} */ (true), value: await work() };
        } catch (error) {
          return { ok: /** @type {const} */ (false), error };
        }
      });
      if (!result.ran)
        throw new HttpError(503, "stopping", "Command lane is closed");
      if (!result.value.ok) throw result.value.error;
      return result.value.value;
    },
    drain: () => lane.drain(),
    close: () => lane.close(),
  };
}
