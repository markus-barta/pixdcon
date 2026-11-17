/** Scene copies: validate both keys before access; stamp every file and isolate
 * declared stateFields under .state; preserve imports/assets; import before registration.
 */
import {
  copyFile,
  stat,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpError } from "../core/errors.js";
import { deviceCommand, invalid, keys, text } from "./commands.js";

/** @param {unknown} value @param {string} [field] @returns {string} */
function sceneKey(value, field = "targetKey") {
  const key = text(value, field);
  if (
    !/^[a-z0-9_-]+$/i.test(key) ||
    ["__proto__", "constructor", "prototype"].includes(key)
  )
    invalid(field, "Scene keys need letters, digits, underscores or hyphens");
  return key;
}

/** @param {import("./routes-v1.js").ApiDeps} deps @param {string} key @param {Record<string, unknown>} body
 * @param {{backupSource?: boolean}} [options] v1 backs up ordinary clones too
 */
export function copyScene(deps, key, body, options = {}) {
  return deviceCommand(deps, "@scene-copy", async () => {
    sceneKey(key, "scene");
    keys(body, ["targetKey", "name", "replace"]);
    if ("replace" in body && typeof body.replace !== "boolean")
      invalid("replace", "replace must be boolean");
    if ("name" in body && typeof body.name !== "string")
      invalid("name", "name must be a string");
    const source = deps.scenes.get(key);
    const file = deps.scenes.fileOf(key);
    if (!source || !file)
      throw new HttpError(404, "unknown_scene", "Unknown scene");
    const target = sceneKey(body.replace ? key : body.targetKey);
    if (body.replace && "targetKey" in body && body.targetKey !== key)
      invalid("targetKey", "A replacement keeps its scene key");
    if (!body.replace && deps.scenes.get(target))
      throw new HttpError(409, "scene_exists", "Scene key already exists");
    if (!deps.config.file().valid)
      throw new HttpError(
        409,
        "config_invalid",
        "Repair config.json before copying a scene",
      );
    const base = deps.config.baseDir();
    const generated = join(base, "generated-scenes", basename(dirname(file)));
    const stamp = `${new Date(deps.clock.now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const path = `./generated-scenes/${basename(dirname(file))}/${target}-${stamp}.js`;
    const destination = resolve(base, path);
    const backups = join(base, "generated-scenes", "_backups");
    // The data-directory lib/assets links are a deployment prerequisite
    // (contract section 10). Keep imports portable, and history beside the copy.
    let content = await readFile(file, "utf8");
    const exportDefault = /^export\s+default\s+/m;
    if (!exportDefault.test(content))
      invalid("scene", "Scene needs a default export");
    let binding = "_pixdconCopy";
    while (content.includes(binding)) binding += "_";
    content = content.replace(exportDefault, `const ${binding} = `);
    if (!body.replace)
      content += `\n${binding}.name = ${JSON.stringify(target)};\n`;
    if (body.name)
      content += `\n${binding}.pretty_name = ${JSON.stringify(body.name)};\n`;
    // Declared state paths are instance overrides (the adapter uses the same
    // contract in shadow). A copy starts empty, with no source-history fallback.
    if (source.resources.stateFields.length) {
      content += `\nimport { fileURLToPath as ${binding}Path } from "node:url";\n`;
      for (const [index, field] of source.resources.stateFields.entries()) {
        const history = `./.state/${target}-${stamp}-${index}.json`;
        content += `${binding}[${JSON.stringify(field)}] = ${binding}Path(new URL(${JSON.stringify(history)}, import.meta.url));\n`;
      }
    }
    content += `\nexport default ${binding};\n`;
    await mkdir(generated, { recursive: true });
    await mkdir(backups, { recursive: true });
    /** @type {string[]} */
    const linkedAssetDirs = [];
    for (const resource of source.resources.assetDirs) {
      if (
        !resource ||
        resource !== basename(resource) ||
        resource === "." ||
        resource === ".."
      )
        invalid("resources", "Asset folders must be names beside the source");
      const original = join(dirname(file), resource);
      const link = join(generated, resource);
      if (!(await stat(original)).isDirectory())
        invalid("resources", "Asset resource must be a directory");
      try {
        await symlink(original, link, "dir");
      } catch (error) {
        if (
          /** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST" ||
          (await realpath(link)) !== (await realpath(original))
        )
          throw new HttpError(
            409,
            "asset_exists",
            "A different asset folder already exists",
          );
      }
      linkedAssetDirs.push(resource);
    }
    const backup =
      body.replace || options.backupSource
        ? join(backups, `${key}-${stamp}-${basename(file)}`)
        : null;
    if (backup) await copyFile(file, backup);
    try {
      await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST")
        throw new HttpError(409, "scene_exists", "Scene file already exists");
      throw error;
    }
    try {
      let loaded;
      try {
        loaded = (
          await import(`${pathToFileURL(destination).href}?copy=${stamp}`)
        ).default;
      } catch {
        throw new HttpError(
          400,
          "invalid_field",
          "The copied scene could not be loaded",
          { field: "scene" },
        );
      }
      if (!loaded || typeof loaded.render !== "function")
        invalid("scene", "Copied scene needs render()");
      await deps.config.update((raw) => {
        const entries = /** @type {Record<string, unknown>} */ (
          raw.scenes ??= {}
        );
        if (!body.replace && Object.hasOwn(entries, target))
          throw new HttpError(409, "scene_exists", "Scene key already exists");
        entries[target] = { path };
      });
      const scene = {
        ...source,
        key: target,
        path,
        pathSource: /** @type {const} */ ("config"),
        name: loaded.name ?? source.name,
        pretty_name: loaded.pretty_name ?? source.pretty_name,
        status: /** @type {const} */ ("ok"),
        error: null,
      };
      return { scene, path, backup, linkedAssetDirs };
    } catch (error) {
      // Preserve failed artifacts for diagnosis, while leaving the key retryable.
      await rename(
        destination,
        join(backups, `rejected-${target}-${stamp}.js`),
      );
      throw error;
    }
  });
}
