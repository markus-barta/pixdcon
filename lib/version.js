import { readFileSync } from "node:fs";

const SCHEME = "inspr-calver-3";
const GRAMMAR = /^(?:[1-9][0-9])(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?:[01][0-9]|2[0-3])(?:[0-5][0-9])(?:[0-5][0-9])\.0\.0$/;

export function validateVersion(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Invalid version.json: expected a version record");
  }
  if (record.version_scheme !== SCHEME) {
    throw new Error(`Invalid version.json: version_scheme must be ${SCHEME}`);
  }
  const value = record.version;
  if (typeof value !== "string" || value.length !== 16 || !GRAMMAR.test(value)) {
    throw new Error("Invalid version.json: version must be YYMMDDhhmmss.0.0");
  }
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error("Invalid version.json: version contains an invalid Gregorian date");
  }
  return Object.freeze({ version: value, scheme: SCHEME });
}

export function loadVersion(path = new URL("../version.json", import.meta.url)) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error("Invalid version.json: cannot read the authoritative version record", { cause: error });
  }
  return validateVersion(record);
}

export function validateReleaseTag(tag, record) {
  const release = validateVersion(record);
  if (tag !== `v${release.version}`) {
    throw new Error(`Release tag must match version.json: v${release.version}`);
  }
  return release;
}

export const { version, scheme } = loadVersion();
