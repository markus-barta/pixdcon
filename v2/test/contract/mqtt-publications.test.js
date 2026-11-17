/**
 * Test kind 2 of 3 (API and MQTT contract): what pixdcon 2 publishes.
 *
 * Health, state, config, telemetry and Home Assistant discovery keep their v1
 * topics and fields (matrix C-022 to C-024, C-113 to C-138); the todo entries
 * name the cases. Read with a second client on the in-memory broker. The
 * two real tests pin the finished rules: when a per-device availability is
 * retired, and when an entity expires.
 * Owner: API + live channel worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { expireAfterSeconds } from "../../src/mqtt/ha-discovery.js";
import {
  availabilityOutcome,
  availabilitySent,
  createAvailabilityLedger,
  owesOffline,
  planAvailability,
} from "../../src/mqtt/status-publisher.js";

/**
 * A ledger in which these payloads were published and confirmed, in order.
 *
 * @param {Array<[string, "online"|"offline"]>} published
 */
function ledgerOf(published) {
  const ledger = createAvailabilityLedger();
  for (const [device, payload] of published)
    availabilityOutcome(
      ledger,
      device,
      payload,
      availabilitySent(ledger, device, payload),
      "confirmed",
    );
  return ledger;
}

test("availability is retired: a device that left the config, was disabled or went from drive to shadow gets one more offline while the controller stays online", () => {
  const ledger = ledgerOf([
    ["ulanzi-a", "online"],
    ["ulanzi-b", "online"],
    ["pixoo-c", "online"],
    ["pixoo-d", "online"],
    ["pixoo-d", "offline"],
    ["gone", "online"],
    ["gone-offline", "online"],
    ["gone-offline", "offline"],
  ]);
  const plan = planAvailability(ledger, [
    { name: "ulanzi-a", driven: true, health: "online" },
    { name: "ulanzi-b", driven: false, health: "shadow" }, // drive → shadow, e.g. v1 took it back
    { name: "pixoo-c", driven: false, health: null }, // disabled
    { name: "pixoo-d", driven: true, health: "offline" },
    { name: "never-driven", driven: false, health: "shadow" },
    { name: "starting", driven: true, health: "starting" },
  ]);
  assert.deepEqual(plan, [
    { device: "ulanzi-a", payload: "online", retire: false },
    { device: "ulanzi-b", payload: "offline", retire: true },
    { device: "pixoo-c", payload: "offline", retire: true },
    { device: "pixoo-d", payload: "offline", retire: false },
    { device: "starting", payload: "online", retire: false },
    { device: "gone", payload: "offline", retire: true }, // removed from config.json
  ]);
  // Nothing for a device this instance never said "online" for, and
  // nothing twice: once the offline is confirmed, the device is forgotten.
  const after = ledgerOf([["ulanzi-a", "online"]]);
  assert.deepEqual(
    planAvailability(after, [
      { name: "ulanzi-a", driven: true, health: "stale" },
      { name: "ulanzi-b", driven: false, health: "shadow" },
    ]),
    [{ device: "ulanzi-a", payload: "online", retire: false }],
    "stale is still available; only offline is not",
  );
  // A clean stop: nothing is driven any more, so everything that was said
  // to be online is taken back.
  assert.deepEqual(
    planAvailability(
      ledgerOf([
        ["ulanzi-a", "online"],
        ["pixoo-d", "online"],
        ["pixoo-d", "offline"],
      ]),
      [],
    ),
    [{ device: "ulanzi-a", payload: "offline", retire: true }],
  );
});

test("N6: an online whose acknowledgement was lost with the connection is still owed an offline; the debt ends only when the broker confirmed an offline that was sent after it", () => {
  const ledger = createAvailabilityLedger();
  const driven = [
    { name: "D", driven: true, health: /** @type {const} */ ("online") },
  ];
  const shadow = [
    { name: "D", driven: false, health: /** @type {const} */ ("shadow") },
  ];
  assert.deepEqual(planAvailability(ledger, driven), [
    { device: "D", payload: "online", retire: false },
  ]);

  // The online is handed to the gateway. The broker stores it; the
  // connection ends before its acknowledgement arrives.
  const first = availabilitySent(ledger, "D", "online");
  assert.equal(
    owesOffline(ledger, "D"),
    true,
    "owed from the moment it was handed over, not from the acknowledgement",
  );
  availabilityOutcome(ledger, "D", "online", first, "offline");
  assert.equal(owesOffline(ledger, "D"), true);

  // D goes into shadow, or leaves the config, while the broker is away.
  const retire = [{ device: "D", payload: "offline", retire: true }];
  assert.deepEqual(planAvailability(ledger, shadow), retire);
  assert.deepEqual(planAvailability(ledger, []), retire);

  // After the reconnect the offline is sent. Whatever does not confirm it
  // leaves the debt: a timeout, an error, another lost acknowledgement.
  for (const outcome of /** @type {const} */ ([
    "timeout",
    "error",
    "offline",
    "sent",
  ])) {
    const attempt = availabilitySent(ledger, "D", "offline");
    availabilityOutcome(ledger, "D", "offline", attempt, outcome);
    assert.deepEqual(planAvailability(ledger, shadow), retire, outcome);
  }

  // An offline that was sent before a newer online does not take that back.
  const early = availabilitySent(ledger, "D", "offline");
  const again = availabilitySent(ledger, "D", "online");
  availabilityOutcome(ledger, "D", "offline", early, "confirmed");
  availabilityOutcome(ledger, "D", "online", again, "confirmed");
  assert.deepEqual(planAvailability(ledger, shadow), retire);

  // The broker confirms an offline sent after it: paid, and forgotten.
  const last = availabilitySent(ledger, "D", "offline");
  availabilityOutcome(ledger, "D", "offline", last, "confirmed");
  assert.equal(owesOffline(ledger, "D"), false);
  assert.deepEqual(planAvailability(ledger, shadow), []);
  assert.deepEqual(planAvailability(ledger, []), []);
  assert.equal(ledger.devices.size, 0);
});

test("discovery expiry: every entity loses its state three telemetry intervals after the last telemetry, at least 30 s", () => {
  assert.equal(expireAfterSeconds(60000), 180);
  assert.equal(expireAfterSeconds(5000), 30);
  assert.equal(expireAfterSeconds(10000), 30);
  assert.equal(expireAfterSeconds(10001), 31);
});

test.todo(
  "health and state payloads keep the v1 fields; the scene of a device is published when it changes",
);
test.todo("last will: the health topic says offline when the process dies");
test.todo(
  "Home Assistant discovery identity: topic, unique_id, object_id, state_topic, value_template and the device block equal v1 for Ulanzi (10) and Pixoo (2)",
);
test.todo(
  "Home Assistant discovery availability: Ulanzi sensors and Pixoo brightness name the controller health and the device's availability topic, mode all; every entity, Ulanzi and Pixoo, carries expire_after of three telemetry intervals",
);
test.todo(
  "per-device availability: an unplugged Ulanzi turns offline on its own availability topic after 2 min while the other display stays online; back online with the first good frame",
);
test.todo(
  "per-device availability: nothing is published for a device in shadow or held back by the v1 interlock, except the one offline that retires a display this instance stopped driving",
);
test.todo(
  "availability retirement on the wire: a device removed from config.json and a device changed from drive to shadow each get one retained offline while the controller health stays ok; an offline that could not be confirmed is sent again after the reconnect; an online whose acknowledgement was lost with the connection (the broker stored it) is still taken back when the display is no longer driven; a clean stop retires every driven display",
);
test.todo(
  "status publisher order: the 30 s republish and the publish on connect are built from the state of that moment; a state event of a device that was removed publishes nothing but its retirement",
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
