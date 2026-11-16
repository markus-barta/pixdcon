/**
 * Skeleton marker (PIXD-83). Every interface method that phase 3 has to build
 * calls `todo("Class.method", …args)`. Passing the arguments keeps the
 * parameter names of the documented signature in place and lint-clean.
 */

export class NotImplementedError extends Error {
  /** @param {string} what */
  constructor(what) {
    super(`not implemented: ${what}`);
    this.name = "NotImplementedError";
    this.code = "E_NOT_IMPLEMENTED";
    /** HTTP status used by the API layer for a route that is not built yet. */
    this.statusCode = 501;
  }
}

/**
 * @param {string} what      "Class.method" or "METHOD /route"
 * @param {...unknown} _args the documented parameters, unused in the skeleton
 * @returns {never}
 */
export function todo(what, ..._args) {
  throw new NotImplementedError(what);
}

/**
 * Run a start/stop step of the composition root. A step that is still a
 * skeleton is logged and skipped, so `npm run dev` works from day one and
 * lights up module by module without anyone editing the wiring.
 *
 * @param {string} name
 * @param {() => unknown} step
 * @param {{debug: (msg: string) => void}} logger
 * @returns {Promise<boolean>} true when the step ran, false when it is not built yet
 */
export async function runStep(name, step, logger) {
  try {
    await step();
    return true;
  } catch (error) {
    if (error instanceof NotImplementedError) {
      logger.debug(`[pixdcon2] skeleton: ${name} skipped (${error.message})`);
      return false;
    }
    throw error;
  }
}
