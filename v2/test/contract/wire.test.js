/**
 * Test kind 2 of 3 (API and MQTT contract): the wire strings and the broker premise.
 *
 * Pins what must never move by accident: the v1 topic strings, the built-in
 * mode keys, and how a broker marks a retained replay, which the overlay
 * rules rest on. Owner: core/state worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import mqtt from "mqtt";
import { startMemoryBroker } from "../../dev/memory-broker.js";
import { BUILTIN_MODES } from "../../src/drivers/builtin-modes.js";
import { createTopics } from "../../src/mqtt/topics.js";
import { requireNetGuard } from "../helpers/harness.js";

test("MQTT topics: the v1 wire strings are unchanged", () => {
  requireNetGuard();
  const topics = createTopics();
  // The Home Assistant automation flirc_tv_radio_pixoo189_scene_toggle publishes here, retained.
  assert.equal(
    topics.overlayDeviceScene("pixoo-189"),
    "home/hsb1/pixdcon/overlay/device/pixoo-189/scene",
  );
  assert.equal(
    topics.overlayDeviceIp("ulanzi-56"),
    "home/hsb1/pixdcon/overlay/device/ulanzi-56/ip",
  );
  assert.equal(
    topics.overlayDeviceEnabled("ulanzi-56"),
    "home/hsb1/pixdcon/overlay/device/ulanzi-56/enabled",
  );
  assert.equal(
    topics.overlayScenePath("home3"),
    "home/hsb1/pixdcon/overlay/scene/home3/path",
  );
  assert.equal(topics.overlayBlob, "home/hsb1/pixdcon/overlay/blob");
  assert.deepEqual(topics.overlayFilters, [
    "home/hsb1/pixdcon/overlay/device/+/scene",
    "home/hsb1/pixdcon/overlay/device/+/ip",
    "home/hsb1/pixdcon/overlay/device/+/enabled",
    "home/hsb1/pixdcon/overlay/scene/+/path",
    "home/hsb1/pixdcon/overlay/blob",
  ]);
  assert.equal(topics.mode("pixoo-159"), "home/hsb1/pixdcon/pixoo-159/mode");
  assert.equal(
    topics.brightnessOverride("pixoo-159"),
    "home/hsb1/pixdcon/pixoo-159/brightness_override",
  );
  assert.equal(
    topics.setting("ulanzi-56", "clock_with_homestats", "night_start_hour"),
    "pixdcon/ulanzi-56/clock_with_homestats/settings/night_start_hour",
  );
  assert.equal(
    topics.settingsRoot("ulanzi-56", "clock"),
    "pixdcon/ulanzi-56/clock/settings",
  );
  assert.equal(topics.settingsFilter, "pixdcon/+/+/settings/+");
  assert.equal(topics.health, "home/hsb1/pixdcon/health");
  assert.equal(topics.state, "home/hsb1/pixdcon/state");
  assert.equal(topics.config, "home/hsb1/pixdcon/config");
  assert.equal(topics.configEffective, "home/hsb1/pixdcon/config/effective");
  assert.equal(
    topics.telemetry("ulanzi-56"),
    "home/hsb1/pixdcon/ulanzi-56/telemetry",
  );
  assert.equal(
    topics.discoverySensor("ulanzi-56", "bat"),
    "homeassistant/sensor/pixdcon_ulanzi-56_bat/config",
  );
  assert.equal(
    topics.discoveryBinarySensor("pixoo-159", "reachable"),
    "homeassistant/binary_sensor/pixdcon_pixoo-159_reachable/config",
  );
});

test("MQTT topics: incoming topics are told apart, and a second status base moves only the controller topics", () => {
  const topics = createTopics({ statusBaseTopic: "home/hsb1/pixdcon2" });
  assert.equal(topics.health, "home/hsb1/pixdcon2/health");
  assert.equal(topics.overlayBlob, "home/hsb1/pixdcon/overlay/blob");
  assert.equal(
    topics.telemetry("ulanzi-56"),
    "home/hsb1/pixdcon/ulanzi-56/telemetry",
  );

  assert.deepEqual(
    topics.parse("home/hsb1/pixdcon/overlay/device/pixoo-189/scene"),
    {
      kind: "device-scene",
      device: "pixoo-189",
      scene: null,
      key: null,
    },
  );
  assert.equal(
    topics.parse("home/hsb1/pixdcon/overlay/device/pixoo-189/ip")?.kind,
    "device-ip",
  );
  assert.equal(
    topics.parse("home/hsb1/pixdcon/overlay/device/pixoo-189/enabled")?.kind,
    "device-enabled",
  );
  assert.deepEqual(topics.parse("home/hsb1/pixdcon/overlay/scene/home3/path"), {
    kind: "scene-path",
    device: null,
    scene: "home3",
    key: null,
  });
  assert.equal(topics.parse("home/hsb1/pixdcon/overlay/blob")?.kind, "blob");
  assert.deepEqual(
    topics.parse(
      "pixdcon/ulanzi-56/clock_with_homestats/settings/night_start_hour",
    ),
    {
      kind: "setting",
      device: "ulanzi-56",
      scene: "clock_with_homestats",
      key: "night_start_hour",
    },
  );
  assert.equal(topics.parse("home/hsb1/pixdcon/pixoo-159/mode")?.kind, "mode");
  assert.equal(
    topics.parse("home/hsb1/pixdcon/pixoo-159/brightness_override")?.kind,
    "brightness",
  );
  // v1 documented ".../scenes" (plural) for years; it was never subscribed (matrix A-BUG-34).
  assert.equal(
    topics.parse("home/hsb1/pixdcon/overlay/device/pixoo-189/scenes"),
    null,
  );
  assert.equal(topics.parse("home/hsb1/pixdcon/health"), null);
  assert.equal(topics.parse("home/hsb1/funkeykid/display"), null);
});

test("built-in modes: keys, labels and order are v1's", () => {
  assert.deepEqual(
    BUILTIN_MODES.pixoo.map((mode) => mode.key),
    [
      "builtin:clock",
      "builtin:cloud",
      "builtin:visualizer",
      "builtin:animation",
      "builtin:black",
    ],
  );
  assert.deepEqual(
    BUILTIN_MODES.ulanzi.map((mode) => [mode.key, mode.app]),
    [
      ["builtin:time", "Time"],
      ["builtin:date", "Date"],
      ["builtin:temp", "Temperature"],
      ["builtin:humidity", "Humidity"],
      ["builtin:battery", "Battery"],
    ],
  );
});

test("broker premise: a retained replay carries the retain flag, a live message does not, an empty payload deletes", async (t) => {
  // The overlay rules (a UI choice beats a stored overlay; a newer live overlay
  // wins again) depend on telling these two deliveries apart. This is how the
  // in-memory broker and Mosquitto behave; if it ever stops holding, the rules
  // need another signal.
  const broker = await startMemoryBroker();
  t.after(() => broker.stop());
  const topic = "home/hsb1/pixdcon/overlay/device/pixoo-t/scene";

  const publisher = await mqtt.connectAsync(broker.url);
  t.after(() => publisher.endAsync(true));
  await publisher.publishAsync(topic, "builtin:clock", {
    retain: true,
    qos: 1,
  });
  assert.deepEqual(broker.retained(), { [topic]: "builtin:clock" });

  const subscriber = await mqtt.connectAsync(broker.url);
  t.after(() => subscriber.endAsync(true));
  /** @type {Array<{payload: string, retain: boolean}>} */
  const seen = [];
  /** @type {Array<() => void>} */
  let waiting = [];
  subscriber.on("message", (_topic, payload, packet) => {
    seen.push({ payload: payload.toString(), retain: packet.retain });
    for (const wake of waiting) wake();
    waiting = [];
  });
  /** @param {number} count */
  const received = async (count) => {
    while (seen.length < count)
      await new Promise((wake) => waiting.push(() => wake(undefined)));
  };

  await subscriber.subscribeAsync(topic, { qos: 1 });
  await received(1);
  assert.deepEqual(
    seen[0],
    { payload: "builtin:clock", retain: true },
    "stored overlay: replayed with the retain flag",
  );

  await publisher.publishAsync(topic, "funkeykid", { retain: true, qos: 1 });
  await received(2);
  assert.deepEqual(
    seen[1],
    { payload: "funkeykid", retain: false },
    "new command: delivered live, flag clear",
  );

  await publisher.publishAsync(topic, "", { retain: true, qos: 1 });
  await received(3);
  assert.deepEqual(seen[2], { payload: "", retain: false });
  assert.deepEqual(
    broker.retained(),
    {},
    "an empty retained payload deletes the stored overlay",
  );
});
