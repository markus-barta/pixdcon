/**
 * The one seam to files that v2 shares with v1.
 *
 * Scenes are shared with v1 and loaded unchanged. They, and the few helpers
 * they import, live outside v2/ and are read-only for v2:
 *
 *   scenes/                 the scene modules (repo, and /data/scenes on the mount)
 *   lib/pixoo-image.js      loadPixooImage, drawPixooImage (imported by the Pixoo scenes; needs `sharp`)
 *   lib/pixoo-font.js       the 3×5 bitmap font (the Pixoo scene surface draws text with it)
 *   lib/collectors/*.js     ping and RPC collectors (imported by scenes/pixoo/health.js)
 *   lib/version.js          v1's validator of the release coordinate; v2 calls it instead of keeping a copy (A-104)
 *   assets/                 sprites the scenes resolve relative to their own file
 *   version.json            the release coordinate (inspr-calver-3), one per repository
 *   vendor/inspr-versioning the pinned version presentation bundle served to the UI
 *
 * No other v2 module may name a path outside v2/. When v1 is retired these
 * files move, and this module is the only one to change.
 *
 * Two layouts, found by looking for lib/pixoo-image.js:
 *   repository checkout   <repo>/v2/src/scenes/v1-shared.js   → shared root <repo>
 *   container image       /app/src/scenes/v1-shared.js        → shared root /app
 *     (v2/Dockerfile copies the shared files of lib/, scenes/, assets/, version.json and vendor/ next to src/)
 *
 * Owner: fixtures + edge lane worker.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lstat, mkdir, symlink } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));

/** Directory that holds v2's package.json and node_modules: <repo>/v2, or /app in the image. */
export const V2_ROOT = resolve(here, "../..");

/**
 * @returns {{root: string, scenesDir: string, libDir: string, assetsDir: string, versionFile: string, versioningDir: string}}
 */
export function sharedPaths() {
  const override = process.env.PIXDCON2_SHARED_ROOT;
  const root = override
    ? resolve(override)
    : existsSync(resolve(V2_ROOT, "lib/pixoo-image.js"))
      ? V2_ROOT
      : resolve(V2_ROOT, "..");
  return {
    root,
    scenesDir: resolve(root, "scenes"),
    libDir: resolve(root, "lib"),
    assetsDir: resolve(root, "assets"),
    versionFile: resolve(root, "version.json"),
    versioningDir: resolve(root, "vendor/inspr-versioning"),
  };
}

let hookInstalled = false;
/** @type {Set<string>} */
const sharedPrefixes = new Set();

/**
 * Make the shared files use v2's packages.
 *
 * lib/pixoo-image.js imports `sharp`. By default Node looks for it next to
 * lib/, that is in the repository root, where only v1's install would put it.
 * This hook resolves every bare import from a shared file (or from a scene on
 * the data mount) against v2's own node_modules first, and falls back to the
 * default lookup. So:
 *  - `cd v2 && npm ci` is all a worker needs; the root install is optional
 *  - when both installs exist, v2 still runs on the versions in v2's lock
 *    file, and only one copy of the native image library is loaded (two
 *    copies in one process make macOS warn about duplicate classes and can
 *    crash)
 * In the image there is one node_modules; the hook then changes nothing.
 *
 * Idempotent. Call once before the first scene import: main.js and the test
 * helpers do.
 *
 * @param {{extraDirs?: string[]}} [options] more directories whose files are treated like shared files, e.g. the data directory
 */
export function installSharedResolution(options = {}) {
  const paths = sharedPaths();
  for (const dir of [
    paths.libDir,
    paths.scenesDir,
    ...(options.extraDirs ?? []),
  ]) sharedPrefixes.add(pathToFileURL(`${resolve(dir)}/`).href);
  if (hookInstalled) return;
  hookInstalled = true;
  const anchor = pathToFileURL(resolve(V2_ROOT, "package.json")).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const bare = !/^(\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier);
      const parent = context.parentURL ?? "";
      if (isBuiltin(specifier) || !bare || ![...sharedPrefixes].some((prefix) => parent.startsWith(prefix))) {
        return nextResolve(specifier, context);
      }
      try {
        return nextResolve(specifier, { ...context, parentURL: anchor });
      } catch (error) {
        const notFound =
          error instanceof Error &&
          /** @type {{code?: string}} */ (error).code ===
            "ERR_MODULE_NOT_FOUND";
        if (notFound) return nextResolve(specifier, context);
        throw error;
      }
    },
  });
}

const requireShared = createRequire(import.meta.url);

/**
 * Check a version record with v1's own validator (lib/version.js): scheme
 * exactly "inspr-calver-3", version YYMMDDhhmmss.0.0 with years 10 to 99,
 * a real month, day, hour, minute and second, and a date that exists in the
 * calendar (matrix A-104). One validator for the one release coordinate of
 * the repository: v2 keeps no copy of the grammar that could drift.
 *
 * Loading lib/version.js also makes it read <shared root>/version.json
 * itself and fail closed for a bad record, with v1's message.
 *
 * @param {unknown} record parsed content of a version.json
 * @returns {{version: string, version_scheme: string}}
 * @throws {Error} "Invalid version.json: …", v1's wording
 */
export function validateVersionRecord(record) {
  const { libDir } = sharedPaths();
  const v1 = requireShared(resolve(libDir, "version.js"));
  const valid = v1.validateVersion(record);
  return { version: valid.version, version_scheme: valid.scheme };
}

/**
 * The release coordinate of the repository. Fails closed like v1 (matrix
 * A-001, A-104): no valid version record, no start.
 *
 * @returns {{version: string, version_scheme: string}}
 */
export function readVersion() {
  const { versionFile } = sharedPaths();
  let record;
  try {
    record = JSON.parse(readFileSync(versionFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid version.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateVersionRecord(record);
}

/**
 * The v1 bitmap font, for the Pixoo scene surface.
 *
 * @returns {Promise<{FONT_SPECS: {WIDTH: number, HEIGHT: number, SPACING: number}, BITMAP_FONT: Record<string, number[]>, measureText: (text: string) => {width: number, height: number}}>}
 */
export async function loadV1Font() {
  const { libDir } = sharedPaths();
  return import(pathToFileURL(resolve(libDir, "pixoo-font.js")).href);
}

/**
 * Scenes on the data mount import `../../lib/…` and `../../assets/…` relative
 * to their own file, which is <data dir>/lib and <data dir>/assets. v1's image
 * provides them as symlinks next to the mount points; with v2's directory
 * mount they must exist inside the mounted directory. Creates the two links
 * when they are missing and leaves anything that is already there alone.
 *
 * @param {string} dataDir directory of config.json
 * @param {import("../types.js").Logger} logger
 * @returns {Promise<{created: string[]}>}
 */
export async function ensureDataLinks(dataDir, logger) {
  await mkdir(dataDir, { recursive: true });
  const paths = sharedPaths();
  const created = [];
  for (const [name, source] of [["lib", paths.libDir], ["assets", paths.assetsDir]]) {
    const target = resolve(dataDir, name);
    try { await lstat(target); continue; }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    }
    try {
      await symlink(source, target, "dir");
      created.push(target);
      logger.info(`Shared scene link created: ${name}`);
    } catch (error) {
      // Another startup can create the link between lstat and symlink.
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    }
  }
  return { created };
}

/** Reference drawing engines, used only by the golden harness. Network methods are
 * replaced by the harness before rendering. Keep all paths to v1 in this seam.
 * @returns {Promise<{PixooDriver: any, UlanziDriver: any}>}
 */
export async function loadV1ReferenceDrivers() {
  const { libDir } = sharedPaths();
  const pixoo = await import(pathToFileURL(resolve(libDir, "pixoo-driver.js")).href);
  const ulanzi = await import(pathToFileURL(resolve(libDir, "ulanzi-driver.js")).href);
  return { PixooDriver: pixoo.PixooDriver, UlanziDriver: ulanzi.UlanziDriver };
}
