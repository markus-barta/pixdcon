/**
 * Test kind 2 of 3 (API and MQTT contract): what pixdcon 2 publishes.
 *
 * Health, state, config, telemetry and Home Assistant discovery keep their v1
 * topics and fields (matrix C-022 to C-024, C-113 to C-138); the todo entries
 * name the cases. Read with a second client on the in-memory broker.
 * Owner: API + live channel worker.
 */

import test from "node:test";

test.todo(
  "health and state payloads keep the v1 fields; the scene of a device is published when it changes",
);
test.todo("last will: the health topic says offline when the process dies");
test.todo(
  "Home Assistant discovery identity: topic, unique_id, object_id, state_topic, value_template and the device block equal v1 for Ulanzi (10) and Pixoo (2)",
);
test.todo(
  "Home Assistant discovery availability: Ulanzi sensors and Pixoo brightness name the controller health and the device's availability topic, mode all; Pixoo entities expire after three telemetry intervals",
);
test.todo(
  "per-device availability: an unplugged Ulanzi turns offline on its own availability topic after 2 min while the other display stays online; back online with the first good frame",
);
test.todo(
  "per-device availability: nothing is published for a device in shadow or held back by the v1 interlock",
);
test.todo(
  "config/effective: the running config in v1's shape includes a blob-only device and a blob-patched key, and lists only driven, enabled devices",
);
test.todo(
  "telemetry: Ulanzi publishes only good reads, Pixoo publishes reachable false; nothing for a shadow device",
);
test.todo(
  "retained bootstrap: devices start with mode and brightness already applied, without a fixed sleep",
);
