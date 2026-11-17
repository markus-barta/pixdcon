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
import { readFile, writeFile } from "node:fs/promises";
import { ConfigStore } from "../../src/config/config-store.js";
import {
  DEFAULTS,
  parseConfig,
  validateConfig,
} from "../../src/config/schema.js";
import { manualClock } from "../../src/core/clock.js";
import { createLogger } from "../../src/core/logger.js";
import { NotImplementedError } from "../../src/core/todo.js";
import { createApp } from "../../src/main.js";
import { MqttGateway } from "../../src/mqtt/mqtt-gateway.js";
import { StatusPublisher } from "../../src/mqtt/status-publisher.js";
import { createTopics } from "../../src/mqtt/topics.js";
import {
  normalizeSettingValue,
  percentToNative,
  resolveSetting,
  resolveBlobWriter,
  resolveOutput,
} from "../../src/state/precedence.js";
import { buildEffectiveConfig } from "../../src/state/runtime-config.js";
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
  const stack = await startStack(t, { mqtt: false });
  const logger = createLogger({ sink: { out() {}, err() {} } });
  for (const forceShadow of [false, true]) {
    for (const statusBaseTopic of [DEFAULTS.mqtt.baseTopic, "shadow/status"]) {
      const config = { mqtt: { ...DEFAULTS.mqtt, statusBaseTopic } };
      // Keep this composition check independent of unfinished modules.
      const load = t.mock.method(
        ConfigStore.prototype,
        "load",
        async () => ({}),
      );
      const file = t.mock.method(ConfigStore.prototype, "file", () => ({
        valid: true,
      }));
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
      await createApp(
        {
          PIXDCON_CONFIG_PATH: stack.configPath,
          PIXDCON2_FORCE_SHADOW: forceShadow ? "1" : "0",
        },
        { logger },
      );
      assert.equal(gateway.mock.callCount(), 1);
      for (const method of [load, file, get, gateway]) method.mock.restore();
    }
  }
});

test("composition: the namespace of a run is reported, and an unbuilt health model is said to be unmeasured", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  stack.app.modules.health.controller = () => {
    throw new NotImplementedError("unmeasured test peer");
  };
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
    effective: { ...runtime.get(), devices: [], rev: runtime.get().rev + 1 },
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
test("namespace: an invalid config.json at start leaves MQTT off for the run (nothing is published under any base); repairing the file reports restartRequired", async (t) => {
  const stack = await startStack(t, { configText: "{broken", mqtt: false });
  assert.equal(stack.app.modules.mqtt, null);
  assert.equal(stack.app.modules.config.file().valid, false);
  assert.equal(stack.app.modules.state.views().length, 0);
  await stack.app.modules.config.replaceRaw('{"devices":[],"scenes":{}}');
  assert.match(
    stack.app.controller().restartRequired?.reason ?? "",
    /not valid when pixdcon started/,
  );
  assert.equal(stack.app.modules.mqtt, null);
});
test("namespace change: editing mqtt.* in config.json while running moves nothing on the wire and reports restartRequired; after a restart the new names are used", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  await stack.app.modules.config.update((raw) => {
    raw.mqtt = { baseTopic: "another/base" };
  });
  assert.equal(stack.app.topics.base, DEFAULTS.mqtt.baseTopic);
  assert.match(
    stack.app.controller().restartRequired?.reason ?? "",
    /MQTT settings/,
  );
  await stack.app.stop();
  const app = await createApp(
    { PIXDCON_CONFIG_PATH: stack.configPath, WEB_PORT: "0" },
    { logger: stack.app.logger },
  );
  t.after(() => app.stop());
  assert.equal(app.topics.base, "another/base");
  assert.equal(app.controller().restartRequired, null);
});
test.todo(
  "output policy: driver choice, overlay clears, controls, telemetry, discovery, availability, status lists, the plug and scene state files all follow the same answer for a device",
);
test("interlock: ownership unknown keeps a device in shadow; v1's list naming it keeps it in shadow with 'still driven by pixdcon v1'; a list without it releases it within a second", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, {
    clock,
    config: (raw) => {
      raw.mqtt = { statusBaseTopic: "shadow/status" };
    },
  });
  const { state, ownership } = stack.app.modules;
  assert.equal(state.view("pixoo-t").desired.output, "shadow");
  assert.equal(
    state.view("pixoo-t").desired.outputProblem,
    "waiting for pixdcon v1's device list",
  );
  await stack.broker.inject(
    stack.app.topics.v1ConfigEffective,
    JSON.stringify({ devices: [{ name: "pixoo-t" }] }),
    { retain: true },
  );
  await until(() => ownership.status().known);
  assert.equal(
    state.view("pixoo-t").desired.outputProblem,
    "still driven by pixdcon v1",
  );
  assert.equal(state.view("ulanzi-t").desired.output, "drive");
  await stack.broker.inject(
    stack.app.topics.v1ConfigEffective,
    JSON.stringify({ devices: [] }),
    { retain: true },
  );
  await until(() => state.view("pixoo-t").desired.output === "drive");
});
test("interlock: the broker going away does not blank the displays v2 already drives; v1 taking a display back puts it in shadow at once", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, {
    clock,
    config: (raw) => {
      raw.mqtt = { statusBaseTopic: "shadow/status" };
    },
  });
  const { state, mqtt } = stack.app.modules;
  assert.ok(mqtt);
  await stack.broker.inject(
    stack.app.topics.v1ConfigEffective,
    JSON.stringify({ devices: [] }),
    { retain: true },
  );
  await until(() => state.view("pixoo-t").desired.output === "drive");
  await stack.broker.dropClients();
  await until(() => mqtt.status().state === "offline");
  assert.equal(state.view("pixoo-t").desired.output, "drive");
  await clock.advance(5000);
  await until(() => mqtt.status().connection === 2);
  await mqtt.settle();
  await stack.broker.inject(
    stack.app.topics.v1ConfigEffective,
    JSON.stringify({ devices: [{ name: "pixoo-t" }] }),
    { retain: true },
  );
  await until(() => state.view("pixoo-t").desired.output === "shadow");
  assert.equal(
    state.view("pixoo-t").desired.outputProblem,
    "still driven by pixdcon v1",
  );
});
test("effective runtime config: a blob entry that patches minFrameMs, powerCyclePlugin and ip reaches the device runtime; nothing of it is written to config.json", () => {
  const input = effectiveInput();
  input.structural.blobDevices = [
    {
      name: "D",
      ip: "127.0.0.2:80",
      minFrameMs: 20,
      powerCyclePlugin: { topic: "plug/set" },
    },
  ];
  const before = structuredClone(input.config);
  const { effective } = buildEffectiveConfig(
    input.config,
    input.structural,
    () => ({ mode: "drive", requested: "drive", reason: null }),
    DEFAULTS.mqtt,
    "2026-11-17T07:00:00Z",
  );
  const device = effective.devices[0];
  assert.equal(device.address, "127.0.0.2:80");
  assert.equal(device.addressSource, "blob");
  assert.equal(device.minFrameMs, 20);
  assert.equal(device.powerCyclePlugin?.topic, "plug/set");
  assert.deepEqual(input.config, before);
});
test("effective runtime config: a device that exists only in the blob is listed with origin blob after the config.json devices and runs", () => {
  const input = effectiveInput();
  input.structural.blobDevices = [
    { name: "B", type: "ulanzi", ip: "localhost:81", scene: "blob-scene" },
  ];
  const { effective } = buildEffectiveConfig(
    input.config,
    input.structural,
    () => ({ mode: "drive", requested: "drive", reason: null }),
    DEFAULTS.mqtt,
    "2026-11-17T07:00:00Z",
  );
  assert.deepEqual(
    effective.devices.map((device) => device.name),
    ["D", "B"],
  );
  assert.equal(effective.devices[1].origin, "blob");
  assert.equal(effective.devices[1].savedScene, null);
  assert.equal(effective.devices[1].enabled, true);
});
test("effective runtime config: a granular scene path overlay replaces the file of a registered key and can register a new key; the scenes it names are reloaded", () => {
  const input = effectiveInput();
  input.structural.blobScenes = { A: { path: "blob.js" } };
  input.structural.scenePaths = { A: "new.js", B: "second.js" };
  const { effective } = buildEffectiveConfig(
    input.config,
    input.structural,
    () => ({ mode: "drive", requested: "drive", reason: null }),
    DEFAULTS.mqtt,
    "2026-11-17T07:00:00Z",
  );
  assert.deepEqual(effective.scenes, {
    A: { path: "new.js", source: "overlay" },
    B: { path: "second.js", source: "overlay" },
  });
  assert.equal(input.config.scenes.A.path, "a.js");
});
test("effective runtime config: a blob entry that would make a device unusable leaves the config.json entry running and is listed as invalid", () => {
  const input = effectiveInput();
  input.structural.blobDevices = [{ name: "D", type: "not-a-display" }];
  const result = buildEffectiveConfig(
    input.config,
    input.structural,
    () => ({ mode: "drive", requested: "drive", reason: null }),
    DEFAULTS.mqtt,
    "2026-11-17T07:00:00Z",
  );
  assert.equal(result.effective.devices[0].type, "pixoo");
  assert.deepEqual(result.effective.devices[0].blobKeys, []);
  assert.equal(result.rejected[0].name, "D");
});
test("controller health: the measured status and its reasons are in the snapshot, and a change reaches the live channel as a controller event", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, { clock, mqtt: false });
  const { scheduler, health, live, scenes } = stack.app.modules;
  let failed = false;
  /** @type {any[]} */ const events = [];
  scheduler.status = () => ({
    devices: 2,
    loopsAlive: 2,
    restarts: 0,
    lastWatchdogAt: new Date(clock.now()).toISOString(),
    watchdogIntervalMs: 1000,
  });
  health.controller = () => ({
    status: failed ? "failed" : "ok",
    reasons: failed ? ["watchdog_overdue"] : [],
  });
  scenes.list = () => [];
  live.publish = (type, data) => {
    events.push({ type, data });
    return events.length;
  };
  const snapshot = live.deps.snapshot();
  assert.equal(snapshot.controller.measured, true);
  assert.equal(snapshot.incarnations, 2);
  await clock.advance(1000);
  failed = true;
  await clock.advance(1000);
  const answer = await stack.api("/api/health");
  assert.equal(answer.status, 503);
  assert.deepEqual(answer.body.reasons, ["watchdog_overdue"]);
  assert.equal(events.at(-1).type, "controller");
  assert.equal(events.at(-1).data.status, "failed");
});

// --- Ordering (knowledge entry, section 3.0; the pure fences are run in ordering.test.js) ---
test("saved choice at boot: a process that starts with a saved scene and no overlay drives that scene on its display (effective device savedScene)", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  const { runtime, state } = stack.app.modules;
  assert.equal(runtime.device("pixoo-t")?.savedScene, "funkeykid");
  assert.equal(state.view("pixoo-t").desired.scene.scene, "funkeykid");
  assert.equal(state.view("pixoo-t").desired.scene.source, "config");
  assert.equal(state.views().length, 2);
  assert.equal(state.view("pixoo-t").incarnation, 1);
  assert.equal(state.view("ulanzi-t").incarnation, 2);
  assert.equal(runtime.incarnations(), 2);
  assert.ok(Object.isFrozen(state.get("pixoo-t")));
});
test("saved choice from outside: editing only a device's scene in config.json switches that display and restarts nothing; the diff names savedScene", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  const { runtime, state, config } = stack.app.modules;
  /** @type {import("../../src/types.js").EffectiveDiff[]} */
  const diffs = [];
  runtime.on("changed", (event) => diffs.push(event.diff));
  const raw = JSON.parse(await readFile(stack.configPath, "utf8"));
  raw.devices[1].scene = "test-pattern";
  await writeFile(stack.configPath, JSON.stringify(raw));
  await config.reload();
  assert.equal(state.view("ulanzi-t").desired.scene.scene, "test-pattern");
  assert.deepEqual(diffs.at(-1)?.devicesChanged["ulanzi-t"], ["savedScene"]);
  assert.equal(stack.app.factories.changeImpact("savedScene"), "view");
  assert.equal(state.view("ulanzi-t").incarnation, 2);
});
test.todo(
  "registry lane: a path overlay whose import is slow, then a newer path for the same key: the registry ends on the newer one; a change during the first load is applied after it; shutdown waits for the import that runs",
);
test.todo(
  "effective revision: runtime config, state store, scheduler and settings service apply a runtime change only when its rev is higher than the one they hold",
);
test("config store order: an own write is not an outside edit; a file read that began before a write of this process finished is dropped and repeated; a file event alone changes nothing", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  const { config } = stack.app.modules;
  /** @type {string[]} */
  const origins = [];
  config.on("changed", (event) => origins.push(event.origin));
  const original = await readFile(stack.configPath, "utf8");
  const earlierRead = config.reload();
  await Promise.all([
    earlierRead,
    config.updateDevice("pixoo-t", (raw) => {
      raw.comment = "one";
    }),
    config.updateDevice("ulanzi-t", (raw) => {
      raw.comment = "two";
    }),
  ]);
  assert.deepEqual(origins, ["api", "api"]);
  const rev = config.file().rev;
  await config.reload();
  assert.equal(config.file().rev, rev);
  assert.deepEqual(origins, ["api", "api"]);
  const current = JSON.parse(await readFile(stack.configPath, "utf8"));
  assert.equal(current.devices[0].comment, "one");
  assert.equal(current.devices[1].comment, "two");
  const backup = JSON.parse(await readFile(`${stack.configPath}.bak`, "utf8"));
  assert.equal(backup.devices[0].comment, "one");
  assert.equal(backup.devices[1].comment, undefined);
  assert.deepEqual(current.scenes, JSON.parse(original).scenes);
  await writeFile(stack.configPath, "{bad");
  await config.reload();
  assert.equal(config.file().valid, false);
  assert.equal(config.get().devices[0].comment, "one");
  await assert.rejects(
    config.updateDevice("pixoo-t", () => {}),
    { code: "config_invalid" },
  );
  assert.ok(config.file().error?.line);
});
test("interlock order: v1's list held back as a replay and delivered after a live list on the same connection releases nothing (holdRetained)", async (t) => {
  const stack = await startStack(t, {
    mqtt: false,
    config: (raw) => {
      raw.mqtt = { statusBaseTopic: "shadow/status" };
    },
  });
  await stack.app.stop();
  await stack.broker.inject(
    stack.app.topics.v1ConfigEffective,
    JSON.stringify({ devices: [] }),
    { retain: true },
  );
  const release = stack.broker.holdRetained();
  const app = await createApp(
    {
      PIXDCON_CONFIG_PATH: stack.configPath,
      WEB_PORT: "0",
      MOSQUITTO_HOST: stack.broker.host,
      MQTT_PORT: String(stack.broker.port),
      PIXDCON2_MQTT_ANONYMOUS: "1",
    },
    { logger: stack.app.logger },
  );
  t.after(() => app.stop());
  await app.start();
  await stack.broker.inject(
    app.topics.v1ConfigEffective,
    JSON.stringify({ devices: [{ name: "pixoo-t" }] }),
    { retain: true },
  );
  await until(() => app.modules.ownership.status().known);
  release();
  await app.modules.mqtt?.settle();
  assert.equal(app.modules.state.view("pixoo-t").desired.output, "shadow");
  assert.equal(
    app.modules.state.view("pixoo-t").desired.outputProblem,
    "still driven by pixdcon v1",
  );
});
test("restriction survives a reconnect: a device that an enabled overlay switched off does not start while the new connection holds its replay back past the settle hint", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, { clock });
  const { mqtt, overlays, runtime } = stack.app.modules;
  assert.ok(mqtt);
  await stack.broker.inject(
    stack.app.topics.overlayDeviceEnabled("pixoo-t"),
    "false",
    { retain: true },
  );
  await until(() => overlays.get("device-enabled:pixoo-t")?.value === false);
  await clock.advance(300);
  assert.equal(runtime.device("pixoo-t")?.enabled, false);
  const release = stack.broker.holdRetained();
  await stack.broker.dropClients();
  await until(() => mqtt.status().state === "offline");
  await clock.advance(5000);
  await until(() => mqtt.status().connection === 2);
  await mqtt.settle();
  await clock.advance(300);
  assert.equal(runtime.device("pixoo-t")?.enabled, false);
  assert.equal(overlays.get("device-enabled:pixoo-t")?.confirmed, false);
  release();
});
test("overlay cannot widen: a blob entry with output drive, or enabled true, for a device that config.json keeps in shadow or disabled changes neither; the record names the ignored keys", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, {
    clock,
    config: (raw) => {
      raw.devices[0].enabled = false;
      raw.devices[0].output = "shadow";
    },
  });
  const { overlays, runtime } = stack.app.modules;
  await stack.broker.inject(
    stack.app.topics.overlayBlob,
    JSON.stringify({
      devices: [{ name: "pixoo-t", output: "drive", enabled: true }],
    }),
    { retain: true },
  );
  await until(() => Boolean(overlays.get("blob")));
  await clock.advance(300);
  assert.equal(runtime.device("pixoo-t")?.output.mode, "shadow");
  assert.equal(runtime.device("pixoo-t")?.enabled, false);
  assert.match(overlays.get("blob")?.problem ?? "", /output/);
  assert.match(overlays.get("blob")?.problem ?? "", /enabled/);
});
test("blob writer of a run: with mqtt.statusBaseTopic different from mqtt.baseTopic the controller status says {writer: false, reason: v1_writes} and no publish reaches <base>/overlay/blob in the whole run; with PIXDCON2_FORCE_SHADOW=1 force_shadow; with both bases equal and a driven display the instance is the writer", async (t) => {
  for (const [
    transition,
    shadow,
    writer,
    reason,
  ] of /** @type {Array<[boolean,boolean,boolean,string|null]>} */ ([
    [true, false, false, "v1_writes"],
    [false, true, false, "force_shadow"],
    [false, false, true, null],
  ])) {
    const clock = manualClock();
    const stack = await startStack(t, {
      clock,
      env: { PIXDCON2_FORCE_SHADOW: shadow ? "1" : "0" },
      config: (raw) => {
        if (transition) raw.mqtt = { statusBaseTopic: "shadow/status" };
      },
    });
    assert.deepEqual(stack.app.controller().blobWriter, { writer, reason });
    const { overlays, state } = stack.app.modules;
    await stack.broker.inject(
      stack.app.topics.overlayBlob,
      JSON.stringify({ devices: [{ name: "pixoo-t", scene: "funkeykid" }] }),
      { retain: true },
    );
    await until(() => Boolean(overlays.get("blob")));
    await clock.advance(300);
    await state.chooseScene("pixoo-t", "funkeykid");
    await clock.advance(300);
    const writes = stack.broker
      .published()
      .filter(
        (entry) =>
          entry.topic === stack.app.topics.overlayBlob &&
          entry.clientId !== "outside",
      );
    assert.equal(writes.length > 0, writer);
  }
});
test("commands lapse, restrictions stay: after a reconnect whose replay is held back, the effective config is built without the granular ip, the scene paths and the blob's patches, devices and scenes; a display with an ip overlay or a blob ip is held (enabled false, held true), a display that an overlay switched off stays off; the delivered replay puts everything back with one changed event", async (t) => {
  const clock = manualClock();
  const stack = await startStack(t, { clock });
  const { overlays, runtime, mqtt } = stack.app.modules;
  assert.ok(mqtt);
  await stack.broker.inject(
    stack.app.topics.overlayDeviceIp("pixoo-t"),
    "127.0.0.8",
    { retain: true },
  );
  await stack.broker.inject(
    stack.app.topics.overlayBlob,
    JSON.stringify({
      devices: [{ name: "ulanzi-t", ip: "127.0.0.9", minFrameMs: 25 }],
      scenes: { extra: { path: "extra.js" } },
    }),
    { retain: true },
  );
  await until(
    () =>
      Boolean(overlays.get("blob")) &&
      Boolean(overlays.get("device-ip:pixoo-t")),
  );
  await clock.advance(300);
  assert.equal(runtime.device("ulanzi-t")?.minFrameMs, 25);
  /** @type {any[]} */ const notices = [];
  overlays.on("changed", (event) => notices.push(event));
  const release = stack.broker.holdRetained();
  await stack.broker.dropClients();
  await until(() => mqtt.status().state === "offline");
  await clock.advance(5000);
  await until(() => mqtt.status().connection === 2);
  await mqtt.settle();
  await clock.advance(300);
  assert.equal(runtime.device("pixoo-t")?.held, true);
  assert.equal(runtime.device("ulanzi-t")?.held, true);
  assert.equal(runtime.device("ulanzi-t")?.minFrameMs, 50);
  assert.equal(runtime.scenes().extra, undefined);
  assert.equal(notices.length, 1);
  release();
  await until(
    () =>
      overlays.get("blob")?.confirmed === true &&
      overlays.get("device-ip:pixoo-t")?.confirmed === true,
  );
  await clock.advance(300);
  assert.equal(notices.length, 2);
  assert.equal(runtime.device("ulanzi-t")?.minFrameMs, 25);
  assert.equal(runtime.device("pixoo-t")?.held, false);
});

/** Config/overlay boundary, shared by the effective-config contract cases. */
function effectiveInput() {
  return {
    config: validateConfig({
      devices: [{ name: "D", type: "pixoo", ip: "127.0.0.1", scene: "A" }],
      scenes: { A: { path: "a.js" } },
    }).config,
    structural:
      /** @type {import("../../src/types.js").StructuralOverlays} */ ({
        blobDevices: [],
        blobScenes: {},
        scenePaths: {},
        deviceIps: {},
        deviceEnabled: {},
        deviceHeld: [],
      }),
  };
}

test("config contract: v1 normalization, safe identities, duplicate rejection, unknown keys and parse positions", () => {
  const input = {
    devices: [
      {
        name: " D ",
        type: "pixoo",
        ip: " localhost:1234 ",
        scenes: ["A"],
        preview: { pollMs: 1 },
        extra: 7,
      },
    ],
    scenes: { A: { path: "a.js" } },
    extra: { keep: true },
  };
  const result = validateConfig(input);
  assert.equal(result.config.devices[0].name, "D");
  assert.equal(result.config.devices[0].scene, "A");
  assert.equal(Object.hasOwn(result.config.devices[0], "scenes"), false);
  assert.equal(result.config.devices[0].preview.pollMs, 1000);
  assert.equal(result.config.devices[0].enabled, true);
  assert.equal(result.config.output.default, null);
  assert.equal(result.warnings.length, 2);
  assert.deepEqual(input.devices[0].name, " D ");
  assert.throws(
    () =>
      validateConfig({
        ...input,
        devices: [...input.devices, ...input.devices],
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...input,
        devices: [{ ...input.devices[0], name: "unsafe/#" }],
      }),
    /invalid name/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...input,
        devices: [{ ...input.devices[0], ip: "http://host/path" }],
      }),
    /host/,
  );
  assert.throws(
    () => parseConfig('{\n "devices": [oops] }'),
    (error) => {
      assert.equal(/** @type {any} */ (error).line, 2);
      return true;
    },
  );
});

test("settings contract: normalization keeps v1 coercion and bounds, invalid layers fall through, JSON errors never become an empty object", () => {
  const field = /** @type {import("../../src/types.js").SettingField} */ ({
    type: "int",
    default: 4,
    min: 1,
    max: 10,
  });
  assert.equal(normalizeSettingValue("8.9", field), 8);
  assert.equal(normalizeSettingValue("8junk", field), undefined);
  assert.equal(normalizeSettingValue(100, field), 10);
  assert.equal(
    resolveSetting(field, { saved: 6, overlay: "invalid", preview: 9 })
      .effective,
    9,
  );
  assert.equal(
    resolveSetting(field, { saved: 6, overlay: "invalid" }).source,
    "saved",
  );
  assert.equal(
    normalizeSettingValue("not json", { ...field, type: "json" }),
    undefined,
  );
  assert.equal(
    normalizeSettingValue("23:59", { ...field, type: "time" }),
    "23:59",
  );
  assert.equal(
    normalizeSettingValue("24:00", { ...field, type: "time" }),
    undefined,
  );
  assert.equal(percentToNative(100, "ulanzi"), 255);
  assert.equal(percentToNative(50, "pixoo"), 50);
});

test("device lives and reports: remove/add hands out a fresh incarnation, old runtime reports are dropped, retry is an explicit queued event", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  const { state, config, runtime } = stack.app.modules;
  state.runtimeStarted("pixoo-t", 10);
  assert.equal(
    state.reportEffective("pixoo-t", { frameCount: 1 }, 10).action,
    "apply",
  );
  state.runtimeStarted("pixoo-t", 11);
  assert.equal(
    state.reportEffective("pixoo-t", { frameCount: 100 }, 10).action,
    "drop",
  );
  assert.equal(state.view("pixoo-t").effective.frameCount, 1);
  const raw = JSON.parse(await readFile(stack.configPath, "utf8"));
  const first = state.view("pixoo-t").incarnation;
  await config.update((file) => {
    file.devices = /** @type {any[]} */ (file.devices).filter(
      (device) => device.name !== "pixoo-t",
    );
  });
  assert.equal(state.get("pixoo-t"), undefined);
  await config.update((file) => {
    /** @type {any[]} */ (file.devices).unshift(raw.devices[0]);
  });
  assert.ok(state.view("pixoo-t").incarnation > first);
  assert.equal(state.view("pixoo-t").rev, 1);
  assert.equal(runtime.incarnations(), 3);
  assert.equal(
    state.reportEffective("pixoo-t", { frameCount: 100 }, 11).action,
    "drop",
  );
  /** @type {Array<{name: string}>} */
  const retries = [];
  state.on("retry", (event) => retries.push(event));
  await state.retry("pixoo-t");
  assert.deepEqual(retries, [{ name: "pixoo-t" }]);
  await assert.rejects(state.retry("missing"), { code: "unknown_device" });
});

test("shutdown deadline: app.stop shares one 8 s budget across a hung scheduler and scene release, passes the remainder, and still fences reports and stops ownership", async (t) => {
  for (const hangScheduler of [true, false]) {
    const clock = manualClock();
    const stack = await startStack(t, { clock, mqtt: false });
    const { scheduler, sceneRuntime, state, ownership } = stack.app.modules;
    const never = new Promise(() => {});
    /** @type {number[]} */ const budgets = [];
    scheduler.stop = async (options) => {
      budgets.push(options?.deadlineMs ?? -1);
      if (hangScheduler) await never;
    };
    sceneRuntime.releaseAll = /** @type {any} */ (
      async (/** @type {{deadlineMs?: number}} */ options) => {
        budgets.push(options.deadlineMs ?? -1);
        await never;
      }
    );
    let stoppedOwnership = false;
    ownership.stop = () => {
      stoppedOwnership = true;
    };
    state.runtimeStarted("pixoo-t", 1);
    const began = clock.now();
    const stopped = stack.app.stop();
    for (let step = 0; step < 80; step++) await clock.advance(100);
    await stopped;
    assert.ok(clock.now() - began <= 8000);
    assert.ok(stoppedOwnership);
    assert.equal(budgets.length, 2);
    assert.ok(budgets[0] <= 6000);
    assert.ok(budgets[1] <= (hangScheduler ? 1500 : 7500));
    assert.equal(
      state.reportEffective("pixoo-t", { frameCount: 999 }, 1).action,
      "drop",
    );
  }
});

test("config contract: a consumer failure propagates without labelling valid disk content invalid", async (t) => {
  const stack = await startStack(t, { mqtt: false });
  const config = stack.app.modules.config;
  const raw = JSON.parse(await readFile(stack.configPath, "utf8"));
  raw.devices[0].comment = "outside";
  config.once("changed", () => {
    throw new Error("consumer failure");
  });
  await writeFile(stack.configPath, JSON.stringify(raw));
  await assert.rejects(config.reload(), /consumer failure/);
  assert.equal(config.file().valid, true);
  assert.equal(config.get().devices[0].comment, "outside");
});

/** @param {() => boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "composition condition timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
