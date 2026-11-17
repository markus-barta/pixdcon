/**
 * Test kind 2 of 3 (API and MQTT contract): the wire strings and the broker premise.
 *
 * Pins what must never move by accident: the v1 topic strings, the built-in
 * mode keys, and the two facts about brokers that the overlay rules rest on:
 * a retained replay carries the retain flag, and it may arrive late. The
 * gateway's own guarantees are named at the end. Owner: core/state worker.
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
  // New in v2, next to the telemetry of the device (C-121, C-137, C-138).
  assert.equal(
    topics.availability("ulanzi-56"),
    "home/hsb1/pixdcon/ulanzi-56/availability",
  );
  assert.equal(topics.parse(topics.availability("ulanzi-56")), null);
  // No transition by default: v2 is the one controller on these topics.
  assert.equal(topics.transition, false);
  assert.equal(topics.v1ConfigEffective, topics.configEffective);
});

test("MQTT topics: incoming topics are told apart, and a second status base moves only the controller topics", () => {
  const topics = createTopics({ statusBaseTopic: "home/hsb1/pixdcon2" });
  assert.equal(topics.health, "home/hsb1/pixdcon2/health");
  assert.equal(topics.state, "home/hsb1/pixdcon2/state");
  assert.equal(topics.configEffective, "home/hsb1/pixdcon2/config/effective");
  // The transition: v1 still publishes its device list under the base, and v2 reads it there.
  assert.equal(topics.transition, true);
  assert.equal(topics.v1ConfigEffective, "home/hsb1/pixdcon/config/effective");
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

test("broker premise 2: a replay can arrive after the SUBACK, after a sync echo and after the store changed; only its retain flag tells", async (t) => {
  // aedes answers a SUBSCRIBE with the SUBACK first and streams the retained
  // messages afterwards. holdRetained() makes that gap as long as the test
  // wants. This is the order the overlay rules must survive: nothing may be
  // concluded from "the subscribe is acknowledged and my marker came back".
  const broker = await startMemoryBroker();
  t.after(() => broker.stop());
  const topic = "home/hsb1/pixdcon/overlay/device/pixoo-t/scene";
  const sync = "home/hsb1/pixdcon/_sync/n1";

  const outside = await mqtt.connectAsync(broker.url);
  t.after(() => outside.endAsync(true));
  await outside.publishAsync(topic, "builtin:clock", { retain: true, qos: 1 });

  const subscriber = await mqtt.connectAsync(broker.url);
  t.after(() => subscriber.endAsync(true));
  /** @type {Array<{topic: string, payload: string, retain: boolean}>} */
  const seen = [];
  /** @type {Array<() => void>} */
  let waiting = [];
  subscriber.on("message", (messageTopic, payload, packet) => {
    seen.push({
      topic: messageTopic,
      payload: payload.toString(),
      retain: packet.retain,
    });
    for (const wake of waiting) wake();
    waiting = [];
  });
  /** @param {number} count */
  const received = async (count) => {
    while (seen.length < count)
      await new Promise((wake) => waiting.push(() => wake(undefined)));
  };

  const release = broker.holdRetained();
  await subscriber.subscribeAsync([topic, sync], { qos: 1 }); // SUBACK received
  await subscriber.publishAsync(sync, "n1", { qos: 1 });
  await received(1);
  assert.deepEqual(
    seen,
    [{ topic: sync, payload: "n1", retain: false }],
    "the marker is back and the stored overlay has not been delivered yet",
  );

  // Meanwhile the overlay is cleared on the broker (what a UI choice does).
  await outside.publishAsync(topic, "", { retain: true, qos: 1 });
  await received(2);
  assert.deepEqual(seen[1], { topic, payload: "", retain: false });
  assert.deepEqual(broker.retained(), {}, "the store holds nothing any more");

  release();
  await received(3);
  assert.deepEqual(
    seen[2],
    { topic, payload: "builtin:clock", retain: true },
    "the old value arrives last, as a replay: flag set, although the store is empty",
  );
});

// --- Phase 3: what the gateway guarantees (mqtt-gateway.js) ------------------------------------
test.todo(
  "gateway: every message carries the retain flag as delivered and the number of its connection; nothing is derived from arrival order",
);
test.todo(
  "gateway settle: a pacing hint only; a replay held back past it (holdRetained) is still delivered to the owner, flag set",
);
test.todo(
  "gateway publish: a QoS 1 publish cut off by a disconnect answers offline and is not sent again on the next connection",
);
test.todo(
  "gateway owners: a second owner of a filter gets the retained replay (C-036); removing one owner leaves the other's handlers and the wire subscription",
);
test.todo(
  "gateway instance tokens: the scene contexts of a running instance and of its replacement are two owners; releasing the replacement leaves the running one subscribed",
);
test.todo(
  "gateway last will: the will of the CONNECT packet is the health topic of the status base the process started with",
);

// --- Ordering (knowledge entry, section 3.0) ---
test.todo(
  "gateway order: connect is emitted before the first message of a connection and disconnect after its last; a handler is called synchronously, in the order the packets arrived; connection numbers only rise",
);
test.todo(
  "gateway publish outcome: no acknowledgement in time on a connection that stays up answers timeout; error only when the message was certainly not sent; the own echo arrives on the connection it was published on",
);
test.todo(
  "gateway timers: the reconnect, the connect timeout and the settle timeout change the status and the hint only; no subscriber is called because one of them fired",
);
