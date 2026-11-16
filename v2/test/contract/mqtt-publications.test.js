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
  "Home Assistant discovery: topics, unique_id, object_id and state_topic equal v1 for Ulanzi (10) and Pixoo (2)",
);
test.todo(
  "telemetry: Ulanzi publishes only good reads, Pixoo publishes reachable false; nothing for a shadow device",
);
test.todo(
  "retained bootstrap: devices start with mode and brightness already applied, without a fixed sleep",
);
