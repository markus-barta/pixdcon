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
import { ConfigStore } from "../../src/config/config-store.js";
import { DEFAULTS } from "../../src/config/schema.js";
import { manualClock } from "../../src/core/clock.js";
import { createLogger } from "../../src/core/logger.js";
import { createApp } from "../../src/main.js";
import { MqttGateway } from "../../src/mqtt/mqtt-gateway.js";
import { StatusPublisher } from "../../src/mqtt/status-publisher.js";
import { createTopics } from "../../src/mqtt/topics.js";
import {
  resolveBlobWriter,
  resolveOutput,
} from "../../src/state/precedence.js";
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

test("blob writer: one instance per base topic writes the blob overlay. pixdcon v1 while the transition is on, never an instance that is forced into shadow, nobody without MQTT; the answer has no input that can change in a run", () => {
  const writer = { mqtt: true, forceShadow: false, transition: false };
  assert.deepEqual(resolveBlobWriter(writer), { writer: true, reason: null });
  assert.deepEqual(resolveBlobWriter({ ...writer, transition: true }), {
    writer: false,
    reason: "v1_writes",
  });
  assert.deepEqual(resolveBlobWriter({ ...writer, forceShadow: true }), {
    writer: false,
    reason: "force_shadow",
  });
  // The edge instance during the transition: both reasons hold, one answer.
  assert.equal(
    resolveBlobWriter({ mqtt: true, forceShadow: true, transition: true })
      .writer,
    false,
  );
  assert.deepEqual(resolveBlobWriter({ ...writer, mqtt: false }), {
    writer: false,
    reason: "mqtt_off",
  });
  // The transition is what the namespace says, and the namespace is read
  // once per run (topics.transition): v1's device list is not an input, so
  // a list that is empty, late or missing makes nobody the writer.
  assert.deepEqual(Object.keys(writer).sort(), [
    "forceShadow",
    "mqtt",
    "transition",
  ]);
  assert.equal(resolveBlobWriter.length, 1);
  assert.equal(
    createTopics({ statusBaseTopic: "home/hsb1/pixdcon2" }).transition,
    true,
  );
  assert.equal(createTopics().transition, false);
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

test("composition force-shadow: a shared status namespace registers no controller will; a separate namespace keeps its will", async (t) => {
  requireNetGuard();
  const logger = createLogger({ sink: { out() {}, err() {} } });
  for (const forceShadow of [false, true]) {
    for (const statusBaseTopic of [DEFAULTS.mqtt.baseTopic, "shadow/status"]) {
      const config = { mqtt: { ...DEFAULTS.mqtt, statusBaseTopic } };
      // Keep this composition check independent of unfinished modules.
      const load = t.mock.method(ConfigStore.prototype, "load", async () => ({}));
      const file = t.mock.method(ConfigStore.prototype, "file", () => ({ valid: true }));
      const get = t.mock.method(ConfigStore.prototype, "get", () => config);
      /** @type {typeof MqttGateway.fromEnv} */
      const fromEnv = (_env, deps) => {
        if (forceShadow && statusBaseTopic === DEFAULTS.mqtt.baseTopic)
          assert.equal(deps.will, undefined);
        else {
          assert.ok(deps.will);
          assert.equal(deps.will.topic, `${statusBaseTopic}/health`);
          assert.equal(deps.will.retain, true);
        }
        return null;
      };
      const gateway = t.mock.method(MqttGateway, "fromEnv", fromEnv);
      await createApp({ PIXDCON2_FORCE_SHADOW: forceShadow ? "1" : "0" }, { logger });
      assert.equal(gateway.mock.callCount(), 1);
      for (const method of [load, file, get, gateway]) method.mock.restore();
    }
  }
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
  // Without MQTT in this run nothing is written to the blob overlay.
  assert.deepEqual(health.body.blobWriter, {
    writer: false,
    reason: "mqtt_off",
  });
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

test("N7 shutdown: a scene import that is still running when the wait for the registry lane runs out is fenced, not only waited for. It gets the lane's signal, scenes are released, stop returns; when the import comes back it invalidates nothing", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, { mqtt: false, clock });
  const { scenes, sceneRuntime, runtime, registryLane } = stack.app.modules;
  /** @type {string[]} */
  const log = [];
  /** @type {AbortSignal|undefined} */
  let given;
  let finishImport = () => {};
  const imported = new Promise((resolve) => {
    finishImport = () => resolve(undefined);
  });
  // The registry and the scene runtime are skeletons: stand-ins that
  // record. The registry's stand-in does what the contract asks of the real
  // one: it commits nothing once its signal is aborted.
  scenes.sync = async (_change, options) => {
    given = options?.signal;
    log.push("import started");
    await imported;
    log.push(
      given?.aborted ? "import back: not committed" : "import back: committed",
    );
    return { keys: given?.aborted ? [] : ["clock"] };
  };
  sceneRuntime.invalidate = async (keys) => {
    log.push(`invalidate ${keys}`);
    return { devices: [] };
  };
  sceneRuntime.releaseAll = /** @type {any} */ (
    async () => {
      log.push("scenes released");
    }
  );

  // The effective scene map changes; the import it starts does not end.
  runtime.emit("changed", {
    effective: { devices: [] },
    diff: { scenesAdded: ["clock"], scenesRemoved: [], scenesChanged: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["import started"]);
  assert.equal(given?.aborted, false, "the piece got the lane's signal");

  // Shutdown. The wait for the lane is 2 s on the clock.
  const stopped = stack.app.stop().then(() => log.push("stop returned"));
  for (let step = 0; step < 30; step++) await clock.advance(100);
  await stopped;
  assert.deepEqual(log, ["import started", "scenes released", "stop returned"]);
  assert.equal(registryLane.closed(), true);
  assert.equal(given?.aborted, true, "closing the lane told the import");
  assert.equal(registryLane.pending(), 1, "it is still running");

  // The import comes back, long after stop returned.
  finishImport();
  await registryLane.drain();
  assert.deepEqual(
    log,
    [
      "import started",
      "scenes released",
      "stop returned",
      "import back: not committed",
    ],
    "no invalidate: nothing touches the scenes that were released",
  );
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
test.todo(
  "blob writer of a run: with mqtt.statusBaseTopic different from mqtt.baseTopic the controller status says {writer: false, reason: v1_writes} and no publish reaches <base>/overlay/blob in the whole run; with PIXDCON2_FORCE_SHADOW=1 force_shadow; with both bases equal and a driven display the instance is the writer",
);
test.todo(
  "commands lapse, restrictions stay: after a reconnect whose replay is held back, the effective config is built without the granular ip, the scene paths and the blob's patches, devices and scenes; a display with an ip overlay or a blob ip is held (enabled false, held true), a display that an overlay switched off stays off; the delivered replay puts everything back with one changed event",
);
