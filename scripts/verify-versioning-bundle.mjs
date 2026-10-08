import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned literals, independent of the candidate bundle being verified.
export const PIN = Object.freeze({
  revision: "72d656469b7180f971a866532ad9317580296665",
  configSha256: "bf6aa144cd73dc97dc941f0f0914138b04ae0a28fbead5123465b15b1f2a2fd9",
  manifestSha256: "4d2e3d33387dc54785e39611a11f71307cac2df18276d101c8b767aa1a036c13",
});
const bundlePath = fileURLToPath(new URL("../vendor/inspr-versioning/", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularFile(path) {
  if (!(await lstat(path)).isFile()) throw new Error("Bundle payload must be a regular file");
  return readFile(path);
}

export async function verifyVersioningBundle(path = bundlePath) {
  if (!(await lstat(path)).isDirectory()) throw new Error("Bundle must be a regular directory");
  const bytes = await regularFile(join(path, "manifest.json"));
  if (digest(bytes) !== PIN.manifestSha256) throw new Error("Versioning manifest digest mismatch");
  const manifest = JSON.parse(bytes);
  if (manifest.repository !== "inspr-at/inspr" || manifest.revision !== PIN.revision ||
      manifest.expectedConfigSha256 !== PIN.configSha256) {
    throw new Error("Versioning source pin mismatch");
  }
  const expected = new Set(["manifest.json", ...manifest.files.map((file) => file.outputPath)]);
  const actual = await readdir(path);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file))) {
    throw new Error("Versioning bundle contains missing or extra files");
  }
  for (const file of manifest.files) {
    const payload = await regularFile(join(path, file.outputPath));
    if (payload.length !== file.size || digest(payload) !== file.sha256) {
      throw new Error(`Versioning payload mismatch: ${file.outputPath}`);
    }
    if (file.outputPath === "display.json" && digest(payload) !== PIN.configSha256) {
      throw new Error("Versioning configuration digest mismatch");
    }
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyVersioningBundle();
    console.log(`Verified INSPR versioning bundle at ${PIN.revision}`);
  } catch (error) {
    console.error(`Invalid INSPR versioning bundle: ${error.message}`);
    process.exitCode = 1;
  }
}
