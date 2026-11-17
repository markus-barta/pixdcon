/**
 * Test kind 2 of 3 (API and MQTT contract): how the parts are put together.
 *
 * What main.js guarantees to everything outside: which MQTT namespace this
 * process speaks in and when it is fixed, the one output policy (who may
 * touch a display and the broker), the effective runtime config, and the
 * measured controller health. What exists now pins the two pieces that are
 * finished code: the output policy and the last will. The todo entries are
 * the cases of the round-1 cross-read (PIXD-83). Owner: core/state worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { StatusPublisher } from "../../src/mqtt/status-publisher.js";
import { createTopics } from "../../src/mqtt/topics.js";
import { resolveOutput } from "../../src/state/precedence.js";
import { requireNetGuard, startStack } from "../helpers/harness.js";

test("output policy: shadow as soon as one reason for it exists, and unknown ownership is a reason", () => {
  requireNetGuard();
  /** @type {Parameters<typeof resolveOutput>[0]} */
  const driven = {
    forceShadow: false,
    deviceOutput: null,
    configDefault: null,
    envDefault: "drive",
    transition: false,
    owner: "free",
  };
  assert.deepEqual(resolveOutput(driven), {
    mode: "drive",
    requested: "drive",
    reason: null,
  });

  // Who asks for what: the device, then config.json's default, then the environment.
  assert.equal(
    resolveOutput({ ...driven, envDefault: "shadow" }).reason,
    "config",
  );
  assert.equal(
    resolveOutput({ ...driven, envDefault: "shadow", configDefault: "drive" })
      .mode,
    "drive",
  );
  assert.equal(
    resolveOutput({ ...driven, configDefault: "drive", deviceOutput: "shadow" })
      .mode,
    "shadow",
  );

  // The instance switch beats everything.
  assert.deepEqual(
    resolveOutput({ ...driven, deviceOutput: "drive", forceShadow: true }),
    { mode: "shadow", requested: "drive", reason: "force_shadow" },
  );

  // The transition interlock: only "free" lets a display be driven.
  const transition = {
    ...driven,
    deviceOutput: /** @type {const} */ ("drive"),
    transition: true,
  };
  assert.equal(resolveOutput({ ...transition, owner: "free" }).mode, "drive");
  assert.deepEqual(resolveOutput({ ...transition, owner: "v1" }), {
    mode: "shadow",
    requested: "drive",
    reason: "v1_owner",
  });
  assert.deepEqual(resolveOutput({ ...transition, owner: "unknown" }), {
    mode: "shadow",
    requested: "drive",
    reason: "ownership_unknown",
  });
  // Without a transition v1's list is not consulted at all.
  assert.equal(resolveOutput({ ...driven, owner: "unknown" }).mode, "drive");
  assert.equal(resolveOutput({ ...driven, owner: "v1" }).mode, "drive");
});

test("last will: the health topic of the status base, retained, status offline in the v1 shape", () => {
  const v1Names = StatusPublisher.lastWill(createTopics());
  assert.equal(v1Names.topic, "home/hsb1/pixdcon/health");
  assert.equal(v1Names.retain, true);
  assert.equal(v1Names.qos, 1);
  assert.deepEqual(JSON.parse(v1Names.payload), {
    status: "offline",
    timestamp: null,
    devices: [],
    errorCount: 0,
    lastError: null,
  });

  // During the transition the will must not land on v1's health topic.
  const transition = StatusPublisher.lastWill(
    createTopics({ statusBaseTopic: "home/hsb1/pixdcon2" }),
  );
  assert.equal(transition.topic, "home/hsb1/pixdcon2/health");
});

test("composition: the namespace of a run is reported, and an unbuilt health model is said to be unmeasured", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  const health = await stack.api("/api/health");
  assert.equal(health.status, 200);
  assert.match(health.body.epoch, /^[0-9a-f]{8}$/);
  assert.deepEqual(health.body.mqttNamespace, {
    baseTopic: "home/hsb1/pixdcon",
    statusBaseTopic: "home/hsb1/pixdcon",
    settingsBaseTopic: "pixdcon",
    discoveryPrefix: "homeassistant",
    transition: false,
  });
  assert.equal(health.body.restartRequired, null);
  // Until the scheduler and the health model exist, "ok" only means "answers".
  assert.equal(health.body.measured, false);
  assert.deepEqual(health.body.reasons, []);
  assert.equal(stack.app.epoch, health.body.epoch);

  // The factories every worker builds against are there before any of them starts.
  assert.deepEqual(Object.keys(stack.app.factories).sort(), [
    "builtinModes",
    "changeImpact",
    "createDriver",
    "createSurface",
    "discovery",
    "findBuiltin",
    "normalizeSettingValue",
    "rasterizeAwtrixApp",
    "sizeOf",
  ]);
  // The two policy helpers that cross worker boundaries are handed over,
  // not imported: the scheduler asks changeImpact, the scene registry
  // normalises schema defaults with the function that judges setting values.
  assert.equal(stack.app.factories.changeImpact("address"), "restart");
  assert.equal(stack.app.factories.changeImpact("savedScene"), "view");
  assert.equal(typeof stack.app.factories.normalizeSettingValue, "function");

  // Scene work has one lane, and the start drained it.
  assert.equal(stack.app.modules.registryLane.pending(), 0);
  assert.equal(stack.app.modules.registryLane.closed(), false);
});

// --- Phase 3 ---------------------------------------------------------------------------------------
test.todo(
  "namespace: with mqtt.statusBaseTopic set in config.json, health, state, config and the last will use it from the first connect; overlays, controls and telemetry stay under baseTopic",
);
test.todo(
  "namespace: an invalid config.json at start leaves MQTT off for the run (nothing is published under any base); repairing the file reports restartRequired",
);
test.todo(
  "namespace change: editing mqtt.* in config.json while running moves nothing on the wire and reports restartRequired; after a restart the new names are used",
);
test.todo(
  "output policy: driver choice, overlay clears, controls, telemetry, discovery, availability, status lists, the plug and scene state files all follow the same answer for a device",
);
test.todo(
  "interlock: ownership unknown keeps a device in shadow; v1's list naming it keeps it in shadow with 'still driven by pixdcon v1'; a list without it releases it within a second",
);
test.todo(
  "interlock: the broker going away does not blank the displays v2 already drives; v1 taking a display back puts it in shadow at once",
);
test.todo(
  "effective runtime config: a blob entry that patches minFrameMs, powerCyclePlugin and ip reaches the device runtime; nothing of it is written to config.json",
);
test.todo(
  "effective runtime config: a device that exists only in the blob is listed with origin blob after the config.json devices and runs",
);
test.todo(
  "effective runtime config: a granular scene path overlay replaces the file of a registered key and can register a new key; the scenes it names are reloaded",
);
test.todo(
  "effective runtime config: a blob entry that would make a device unusable leaves the config.json entry running and is listed as invalid",
);
test.todo(
  "controller health: the measured status and its reasons are in the snapshot, and a change reaches the live channel as a controller event",
);

// --- Ordering (knowledge entry, section 3.0; the pure fences are run in ordering.test.js) ---
test.todo(
  "saved choice at boot: a process that starts with a saved scene and no overlay drives that scene on its display (effective device savedScene)",
);
test.todo(
  "saved choice from outside: editing only a device's scene in config.json switches that display and restarts nothing; the diff names savedScene",
);
test.todo(
  "registry lane: a path overlay whose import is slow, then a newer path for the same key: the registry ends on the newer one; a change during the first load is applied after it; shutdown waits for the import that runs",
);
test.todo(
  "effective revision: runtime config, state store, scheduler and settings service apply a runtime change only when its rev is higher than the one they hold",
);
test.todo(
  "config store order: an own write is not an outside edit; a file read that began before a write of this process finished is dropped and repeated; a file event alone changes nothing",
);
test.todo(
  "interlock order: v1's list held back as a replay and delivered after a live list on the same connection releases nothing (holdRetained)",
);
test.todo(
  "restriction survives a reconnect: a device that an enabled overlay switched off does not start while the new connection holds its replay back past the settle hint",
);
test.todo(
  "overlay cannot widen: a blob entry with output drive, or enabled true, for a device that config.json keeps in shadow or disabled changes neither; the record names the ignored keys",
);
