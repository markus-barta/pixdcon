import { scheme, validateReleaseTag, version } from "../lib/version.js";

try {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    if (args.length !== 2 || args[0] !== "--tag") {
      throw new Error("Usage: node scripts/verify-versioning.mjs [--tag v<version>]");
    }
    validateReleaseTag(args[1], { version, version_scheme: scheme });
  }
  console.log(version);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
