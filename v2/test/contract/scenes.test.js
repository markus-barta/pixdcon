/**
 * Test kind 2 of 3 (API and MQTT contract): the contract with the shared
 * scenes and with the files v2 shares with v1.
 *
 * What exists now pins the release coordinate: v2 accepts exactly what v1
 * accepts, because it asks v1's validator. The todo entries are the scene
 * side of the round-1 cross-read (PIXD-83): isolation per device, instance
 * tokens, and resources that follow a scene through aliases and copies.
 * Owner: fixtures + edge lane worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  readVersion,
  validateVersionRecord,
} from "../../src/scenes/v1-shared.js";
import { requireNetGuard } from "../helpers/harness.js";

test("version record: v1's grammar and calendar check, through the shared seam", () => {
  requireNetGuard();
  const scheme = "inspr-calver-3";
  /** @param {string} version */
  const check = (version) =>
    validateVersionRecord({ version, version_scheme: scheme });

  assert.deepEqual(check("261116181524.0.0"), {
    version: "261116181524.0.0",
    version_scheme: scheme,
  });
  assert.deepEqual(check("240229235959.0.0").version, "240229235959.0.0");

  // Twelve digits are not enough: each part has to be a real one (matrix A-104).
  for (const [version, why] of [
    ["269999999999.0.0", "month 99"],
    ["261332000000.0.0", "month 13"],
    ["261100000000.0.0", "day 00"],
    ["261116240000.0.0", "hour 24"],
    ["261116236000.0.0", "minute 60"],
    ["261116235960.0.0", "second 60"],
    ["091116181524.0.0", "year 09"],
    ["v261116181524.0.0", "prefix"],
    ["261116181524.0.0-rc1", "suffix"],
    ["261116181524.1.0", "not .0.0"],
    ["2.4.1", "SemVer"],
  ]) {
    assert.throws(
      () => check(version),
      /^Error: Invalid version\.json: version must be YYMMDDhhmmss\.0\.0$/,
      `${version} (${why})`,
    );
  }
  for (const [version, why] of [
    ["260230120000.0.0", "30 February"],
    ["250229120000.0.0", "29 February in a year that has none"],
    ["260431120000.0.0", "31 April"],
  ]) {
    assert.throws(
      () => check(version),
      /^Error: Invalid version\.json: version contains an invalid Gregorian date$/,
      `${version} (${why})`,
    );
  }
  assert.throws(
    () =>
      validateVersionRecord({
        version: "261116181524.0.0",
        version_scheme: "semver",
      }),
    /version_scheme must be inspr-calver-3/,
  );

  // The repository's own record passes, and is what the process reports.
  assert.match(readVersion().version, /^\d{12}\.0\.0$/);
});

// --- Phase 3 ---------------------------------------------------------------------------------------
test.todo(
  "v1 scene contract: init gets a fresh ctx, render gets the device surface, destroy gets a fresh ctx; afterwards the instance's subscriptions are gone also when destroy threw",
);
test.todo(
  "isolation per device: the scene file is evaluated once per device, so a module-level variable of one device's instance is not seen by another's",
);
test.todo(
  "instance tokens: a replacement instance and the instance it replaces have different tokens, MQTT owners and settings subscribers",
);
test.todo(
  "resources: home3 reports assetDirs [home3-assets] and stateFields [_boilerStatePath]; so do an alias key for the same file and a copy of it",
);
test.todo(
  "resources: home, funkeykid, health and the Ulanzi scenes report no asset folder and no state field",
);
test.todo(
  "shared files: a scene on the data mount resolves ../../lib and ../../assets through the links pixdcon 2 creates, and `sharp` comes from v2's own packages",
);

// --- Ordering (knowledge entry, section 3.0) ---
test.todo(
  "registry order: load, refresh and sync are called from main.js's lane only, read the effective scene map when they run, and a failed import keeps the last good metadata",
);
test.todo(
  "scene runtime order: one pending load per scene and device; an instance whose load finishes after it was released or replaced is destroyed and not handed out; MQTT and settings callbacks of a released instance are not called",
);
test.todo(
  "scenes watcher order: a file event is a hint; the file is read after the debounce, and a change that arrives while a reload runs waits in the lane behind it",
);
