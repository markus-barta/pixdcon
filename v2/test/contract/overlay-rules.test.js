/**
 * Test kind 2 of 3 (API and MQTT contract): the overlay, save and preview rules.
 *
 * The rules Markus approved for phase 2: a UI choice beats an overlay; Save
 * never promotes overlays; previews are ephemeral and not retained. Each todo
 * below is one rule from the knowledge entry "pixdcon-2-interfaces", section
 * "State model". They are tested from the outside only: HTTP requests, the
 * live channel, and MQTT messages on the in-memory broker
 * (test/helpers/harness.js startStack, broker.inject for the outside client).
 *
 * Rules 10 to 18 are the cases the round-1 cross-read found (PIXD-83). They
 * need the two tools the harness has for them: broker.holdRetained() delays
 * a retained replay past the SUBACK and past the gateway's sync echo
 * (test/contract/wire.test.js shows that order), and "restart" means stopping
 * pixdcon 2 and starting it again on the same data directory and broker.
 * Owner: core/state worker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { manualClock } from "../../src/core/clock.js";
import { createApp } from "../../src/main.js";
import { startStack, stopApp } from "../helpers/harness.js";

test("overlay rule 1: a UI scene choice beats a stored scene overlay, and the retained overlay is cleared on the broker", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  assert.equal(world.state.view(D).desired.scene.scene, "B");
  const answer = await world.state.chooseScene(D, "C");
  assert.equal(answer.view.desired.scene.scene, "C");
  assert.equal(answer.persisted, true);
  await until(
    () =>
      world.broker.retained()[world.topics.overlayDeviceScene(D)] === undefined,
  );
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "C");
});
test("overlay rule 2: after a UI choice, a retained replay of the old overlay (reconnect) does not bring it back", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  await world.state.chooseScene(D, "C");
  await world.flush();
  await world.reconnect();
  assert.equal(world.state.view(D).desired.scene.scene, "C");
  assert.equal(world.overlays.get("device-scene:" + D), undefined);
});
test("overlay rule 3: a scene overlay published live after a UI choice wins again (Home Assistant scene toggle)", async (t) => {
  const world = await serviceWorld(t);
  await world.state.chooseScene(D, "C");
  await world.flush();
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  assert.equal(world.state.view(D).desired.scene.scene, "B");
});
test("overlay rule 4: a UI choice made while MQTT is offline holds; nothing is published because the connection came back, and the stored overlay is cleared when the new connection replays it", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  const gateway = world.app.modules.mqtt;
  assert.ok(gateway);
  await world.broker.dropClients();
  await until(() => gateway.status().state === "offline");
  await world.state.chooseScene(D, "C");
  const release = world.broker.holdRetained();
  const before = overlayPublications(world).length;
  await world.clock.advance(5000);
  await until(() => gateway.status().connection === 2);
  await gateway.settle();
  await world.flush();
  assert.equal(overlayPublications(world).length, before);
  assert.equal(world.state.view(D).desired.scene.scene, "C");
  release();
  await until(
    () =>
      world.broker.retained()[world.topics.overlayDeviceScene(D)] === undefined,
  );
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "C");
});
test("overlay rule 5: a UI choice with an unconfirmed clear survives a restart of pixdcon (supersedes marker in config.json)", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  delayOverlayWrites(t, world);
  await world.state.chooseScene(D, "C");
  const saved = JSON.parse(await readFile(world.configPath, "utf8"));
  assert.equal(saved.devices[0].scene, "C");
  assert.ok(saved.devices[0].supersedes.granular);
  await world.restart();
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "C");
  await until(
    () =>
      world.broker.retained()[world.topics.overlayDeviceScene(D)] === undefined,
  );
});
test("overlay rule 6: a blob overlay scene for the device is superseded the same way, other blob fields stay", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({
      devices: [{ name: D, scene: "B", minFrameMs: 123 }],
      extra: "keep",
    }),
  );
  const answer = await world.state.chooseScene(D, "C");
  assert.equal(answer.view.desired.scene.scene, "C");
  await until(
    () =>
      !JSON.parse(world.broker.retained()[world.topics.overlayBlob] ?? "{}")
        .devices?.[0]?.scene,
  );
  const blob = JSON.parse(world.broker.retained()[world.topics.overlayBlob]);
  assert.equal(blob.extra, "keep");
  assert.equal(blob.devices[0].minFrameMs, 123);
  assert.match(blob._pixdcon, /^[0-9a-z]+\.[0-9a-f]{16}$/);
});
test("overlay rule 7: an overlay naming an unknown scene is listed as invalid and the choice stays on the display", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "unknown");
  assert.equal(world.state.view(D).desired.scene.scene, "A");
  assert.equal(world.overlays.get(`device-scene:${D}`)?.valid, false);
});
test("overlay rule 8: an overlay message that changes nothing causes no event and no device restart; one that only confirms a record again after a reconnect, or repeats the stored value live, causes one event for the overlay list and nothing on the display", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  /** @type {any[]} */ const notices = [];
  /** @type {any[]} */ const desired = [];
  world.overlays.on("changed", (event) => notices.push(event));
  world.state.on("desired", (event) => desired.push(event));
  const gateway = world.app.modules.mqtt;
  assert.ok(gateway);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  assert.equal(notices.length, 0);
  assert.equal(desired.length, 0);
  const release = world.broker.holdRetained();
  await world.reconnect();
  assert.equal(world.overlays.get("device-scene:" + D)?.confirmed, false);
  release();
  await until(
    () => world.overlays.get("device-scene:" + D)?.confirmed === true,
  );
  await world.flush();
  assert.equal(notices.length, 2);
  assert.equal(world.state.view(D).desired.scene.scene, "B");
});
test("overlay rule 9: shadow output: a UI choice changes the preview and publishes nothing", async (t) => {
  const world = await serviceWorld(t, { shadow: true });
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  const before = world.broker.published().length;
  assert.equal(
    (await world.state.chooseScene(D, "C")).view.desired.scene.scene,
    "C",
  );
  await world.flush();
  assert.equal(world.broker.published().length, before);
});
test("overlay rule 10 (late replay): a stored scene overlay delivered after the SUBACK and after the sync echo does not undo a UI choice made before it arrived; it is superseded and cleared again", async (t) => {
  const world = await serviceWorld(t);
  await stopApp(world.app, world.clock);
  await world.broker.inject(world.topics.overlayDeviceScene(D), "B", {
    retain: true,
  });
  const release = world.broker.holdRetained();
  await world.restart();
  assert.equal(world.overlays.get("device-scene:" + D), undefined);
  await world.state.chooseScene(D, "C");
  await world.flush();
  release();
  await until(
    () =>
      world.broker.retained()[world.topics.overlayDeviceScene(D)] === undefined,
  );
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "C");
});
test("overlay rule 11 (late replay after the clear): a replay of the old value that arrives after the broker confirmed the clear and after the clear's own echo is ignored", async (t) => {
  const world = await serviceWorld(t);
  await stopApp(world.app, world.clock);
  await world.broker.inject(world.topics.overlayDeviceScene(D), "B", {
    retain: true,
  });
  const release = world.broker.holdRetained();
  await world.restart();
  await world.state.chooseScene(D, "C");
  await until(
    () =>
      world.broker.retained()[world.topics.overlayDeviceScene(D)] === undefined,
  );
  await world.flush();
  release();
  await world.flush();
  assert.equal(world.overlays.get("device-scene:" + D), undefined);
  assert.equal(world.state.view(D).desired.scene.scene, "C");
});
test("overlay rule 12 (per layer): a live granular overlay ends the granular suppression only; after a restart, clearing that granular overlay shows the choice, not the blob scene the choice had replaced", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({ devices: [{ name: D, scene: "B" }] }),
  );
  delayOverlayWrites(t, world);
  await world.state.chooseScene(D, "C");
  await world.app.modules.mqtt?.client?.publishAsync(
    world.topics.overlayDeviceScene(D),
    "",
    { retain: true, qos: 1 },
  );
  await world.flush();
  await world.inject(world.topics.overlayDeviceScene(D), "X");
  assert.ok(world.overlays.suppressions(D).blob);
  assert.equal(world.overlays.suppressions(D).granular, null);
  await world.restart();
  await world.flush();
  await world.inject(world.topics.overlayDeviceScene(D), "");
  assert.equal(world.state.view(D).desired.scene.scene, "C");
});
test("overlay rule 13 (generation): the acknowledgement of the clear of an older choice does not end the suppression of a newer choice", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  const pending = delayOverlayWrites(t, world);
  await world.state.chooseScene(D, "C");
  const old = world.overlays.suppressions(D).granular?.generation;
  await world.state.chooseScene(D, "X");
  const newer = world.overlays.suppressions(D).granular?.generation;
  assert.ok(old && newer && newer > old);
  pending[0].finish({
    ok: true,
    outcome: "confirmed",
    connection: 1,
    error: null,
  });
  await world.flush();
  const raw = JSON.parse(await readFile(world.configPath, "utf8"));
  assert.equal(raw.devices[0].supersedes.granular.generation, newer);
});
test("overlay rule 14 (stored while away): after a restart with an unconfirmed clear, a replay of the same value stays superseded and is cleared; a replay of another value wins as a new command", async (t) => {
  for (const replacement of ["B", "X"]) {
    const world = await serviceWorld(t);
    await world.inject(world.topics.overlayDeviceScene(D), "B");
    delayOverlayWrites(t, world);
    await world.state.chooseScene(D, "C");
    await stopApp(world.app, world.clock);
    await world.broker.inject(world.topics.overlayDeviceScene(D), replacement, {
      retain: true,
    });
    await world.restart();
    await world.flush();
    assert.equal(
      world.state.view(D).desired.scene.scene,
      replacement === "B" ? "C" : "X",
    );
  }
});
test("overlay rule 15 (blob echo): two choices on two devices; the first rewrite echoing back late does not restore the second device's blob scene", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({
      devices: [
        { name: D, scene: "B" },
        { name: D2, scene: "B" },
      ],
    }),
  );
  const gateway = world.app.modules.mqtt;
  assert.ok(gateway);
  const original = gateway.publish.bind(gateway);
  const pending = delayOverlayWrites(t, world);
  await world.state.chooseScene(D, "C");
  await world.state.chooseScene(D2, "X");
  const writes = pending.filter(
    (write) => write.topic === world.topics.overlayBlob,
  );
  assert.ok(writes.length >= 2);
  for (const write of writes) {
    const result = await original(write.topic, write.payload, {
      retain: true,
      qos: 1,
    });
    write.finish(result);
  }
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "C");
  assert.equal(world.state.view(D2).desired.scene.scene, "X");
});
test("overlay rule 16 (blob reconnect): a blob rewrite cut off by a disconnect is not sent again; after the reconnect it is rebuilt from the blob the broker replays and keeps a field another publisher changed meanwhile", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({ devices: [{ name: D, scene: "B" }], extra: "old" }),
  );
  delayOverlayWrites(t, world);
  await world.state.chooseScene(D, "C");
  const gateway = world.app.modules.mqtt;
  assert.ok(gateway);
  await world.broker.dropClients();
  await until(() => gateway.status().state === "offline");
  await world.broker.inject(
    world.topics.overlayBlob,
    JSON.stringify({ devices: [{ name: D, scene: "B" }], extra: "new" }),
    { retain: true },
  );
  t.mock.restoreAll();
  await world.clock.advance(5000);
  await until(() => gateway.status().connection === 2);
  await gateway.settle();
  await until(
    () =>
      JSON.parse(world.broker.retained()[world.topics.overlayBlob]).devices[0]
        .scene === undefined,
  );
  assert.equal(
    JSON.parse(world.broker.retained()[world.topics.overlayBlob]).extra,
    "new",
  );
});
test("overlay rule 17 (legacy key): a blob entry with a legacy `scenes` array is superseded like `scene`, and both keys are gone from the rewrite", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({
      devices: [{ name: D, scenes: ["B", "X"], minFrameMs: 25 }],
    }),
  );
  assert.equal(world.state.view(D).desired.scene.scene, "B");
  await world.state.chooseScene(D, "C");
  await until(
    () =>
      !JSON.parse(world.broker.retained()[world.topics.overlayBlob]).devices[0]
        .scenes,
  );
  const entry = JSON.parse(world.broker.retained()[world.topics.overlayBlob])
    .devices[0];
  assert.equal(entry.scene, undefined);
  assert.equal(entry.scenes, undefined);
  assert.equal(entry.minFrameMs, 25);
});
test("overlay rule 18 (shadow to drive): a suppression made while the device was in shadow is dropped when it becomes driven; no clear is published and the stored overlay shows", async (t) => {
  const world = await serviceWorld(t);
  await world.config.updateDevice(D, (raw) => {
    raw.output = "shadow";
  });
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  await world.state.chooseScene(D, "C");
  await world.flush();
  const before = overlayPublications(world).length;
  await world.config.updateDevice(D, (raw) => {
    raw.output = "drive";
  });
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "B");
  assert.equal(world.overlays.suppressions(D).granular, null);
  assert.equal(overlayPublications(world).length, before);
});
test("save rule 1: no route ever writes an overlay value into config.json (scene, ip, enabled, blob devices, setting overlays)", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({
      devices: [{ name: D, scene: "B", ip: "127.0.0.9", minFrameMs: 25 }],
    }),
  );
  await world.inject(world.topics.setting(D, "A", "n"), "90");
  await world.settings.save(D, "A", { set: { other: 5 } });
  const saved = JSON.parse(await readFile(world.configPath, "utf8"));
  assert.equal(saved.devices[0].scene, "A");
  assert.notEqual(saved.devices[0].ip, "127.0.0.9");
  assert.equal(saved.devices[0].minFrameMs, 50);
  assert.deepEqual(saved.devices[0].sceneSettings, { A: { other: 5 } });
});
test("save rule 2: PATCH device, PUT scene and PUT settings change one device entry; a second device and a disabled device stay byte-identical", async (t) => {
  const world = await serviceWorld(t);
  await world.config.updateDevice(D2, (raw) => {
    raw.enabled = false;
    raw.comment = "untouched";
  });
  const before = JSON.parse(await readFile(world.configPath, "utf8"))
    .devices[1];
  await world.config.updateDevice(D, (raw) => {
    raw.displayName = "Changed";
  });
  await world.state.chooseScene(D, "C");
  await world.settings.save(D, "A", { set: { n: 4 } });
  const after = JSON.parse(await readFile(world.configPath, "utf8"));
  assert.equal(JSON.stringify(after.devices[1]), JSON.stringify(before));
});
test("save rule 3: saving a setting clears the MQTT overlay of that key only", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.setting(D, "A", "n"), "50");
  await world.inject(world.topics.setting(D, "A", "other"), "60");
  const result = await world.settings.save(D, "A", { set: { n: 7 } });
  await world.flush();
  assert.deepEqual(result.overlaysNotCleared, []);
  assert.equal(
    world.broker.retained()[world.topics.setting(D, "A", "n")],
    undefined,
  );
  assert.equal(
    world.broker.retained()[world.topics.setting(D, "A", "other")],
    "60",
  );
  assert.equal(world.settings.state(D, "A").values.n.effective, 7);
});
test("save rule 4: config.json is replaced atomically; the previous version is config.json.bak", async (t) => {
  const world = await serviceWorld(t);
  const before = await readFile(world.configPath, "utf8");
  await world.config.updateDevice(D, (raw) => {
    raw.comment = "atomic";
  });
  assert.equal(await readFile(world.configPath + ".bak", "utf8"), before);
  assert.equal(
    JSON.parse(await readFile(world.configPath, "utf8")).devices[0].comment,
    "atomic",
  );
});
test("save rule 5 (overlay-only device): its scene switch works and answers persisted false with reason overlay_only_device; a settings save answers 409; config.json is untouched", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({
      devices: [
        {
          name: "extra",
          type: "pixoo",
          ip: "127.0.0.9",
          scene: "B",
          minFrameMs: 25,
        },
      ],
    }),
  );
  const original = await readFile(world.configPath, "utf8");
  const result = await world.state.chooseScene("extra", "C");
  assert.equal(result.persisted, false);
  assert.equal(result.notSavedReason, "overlay_only_device");
  assert.equal(result.view.desired.scene.scene, "C");
  await assert.rejects(world.settings.save("extra", "A", { set: { n: 7 } }), {
    code: "overlay_only_device",
  });
  assert.equal(await readFile(world.configPath, "utf8"), original);
});
test("save rule 6 (adoption): adopt writes name, type and address and the scene chosen here in one atomic write, and no other key of the blob entry; afterwards saves work", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({
      devices: [
        {
          name: "extra",
          type: "pixoo",
          ip: "127.0.0.9",
          scene: "B",
          minFrameMs: 25,
          comment: "overlay only",
        },
      ],
    }),
  );
  await world.state.chooseScene("extra", "C");
  await world.state.adoptDevice("extra");
  await world.flush();
  const raw = JSON.parse(await readFile(world.configPath, "utf8"));
  const entry = raw.devices.find(
    (/** @type {any} */ item) => item.name === "extra",
  );
  assert.equal(entry.name, "extra");
  assert.equal(entry.ip, "127.0.0.9");
  assert.equal(entry.type, "pixoo");
  assert.equal(entry.scene, "C");
  assert.equal(entry.minFrameMs, undefined);
  assert.equal(entry.comment, undefined);
  assert.equal(world.state.view("extra").origin, "config");
  await world.settings.save("extra", "A", { set: { n: 7 } });
});
test("preview rule 1: a settings preview reaches the running scene and publishes nothing to MQTT", async (t) => {
  const world = await serviceWorld(t);
  const before = world.broker.published().length;
  const result = world.settings.preview(D, "A", {
    session: "page",
    draft: 1,
    values: { n: 7 },
  });
  assert.equal(result.applied, true);
  assert.equal(result.state.values.n.effective, 7);
  assert.equal(result.state.values.n.source, "preview");
  assert.equal(world.broker.published().length, before);
  assert.equal(
    JSON.parse(await readFile(world.configPath, "utf8")).devices[0]
      .sceneSettings,
    undefined,
  );
});
test("preview rule 2: a preview ends on revert, on save, on the end-session call, and when the live connection is gone", async (t) => {
  const world = await serviceWorld(t);
  world.settings.preview(D, "A", {
    session: "page",
    draft: 1,
    values: { n: 7 },
  });
  world.settings.endPreview("page");
  assert.equal(world.settings.state(D, "A").values.n.effective, 1);
  world.settings.preview(D, "A", {
    session: "page",
    draft: 2,
    values: { n: 8 },
  });
  await world.settings.save(D, "A", {
    set: { n: 8 },
    session: "page",
    draft: 2,
  });
  assert.equal(world.settings.state(D, "A").preview, null);
  world.settings.preview(D, "A", {
    session: "page",
    draft: 3,
    values: { n: 9 },
  });
  world.settings.sessionConnection("page", false);
  await world.clock.advance(4999);
  assert.equal(world.settings.state(D, "A").values.n.effective, 9);
  world.settings.sessionConnection("page", true);
  await world.clock.advance(10);
  assert.equal(world.settings.state(D, "A").values.n.effective, 9);
  world.settings.sessionConnection("page", false);
  await world.clock.advance(5000);
  assert.equal(world.settings.state(D, "A").values.n.effective, 8);
});
test("preview rule 3: a JSON setting that does not parse is rejected with the parse error and never stored as {}", async (t) => {
  const world = await serviceWorld(t);
  const before = await readFile(world.configPath, "utf8");
  const preview = world.settings.preview(D, "A", {
    session: "page",
    draft: 1,
    values: { data: "{bad" },
  });
  assert.equal(preview.applied, false);
  assert.match(preview.rejected.data, /JSON|property|position/i);
  const saved = await world.settings.save(D, "A", { set: { data: "{bad" } });
  assert.ok(saved.rejected.data);
  assert.equal(await readFile(world.configPath, "utf8"), before);
  assert.equal(world.settings.state(D, "A").preview, null);
});
test("preview rule 4 (drafts): a preview sent while Save is under way survives the Save, whichever of the two requests arrives first", async (t) => {
  for (const previewFirst of [true, false]) {
    const world = await serviceWorld(t);
    world.settings.preview(D, "A", {
      session: "page",
      draft: 1,
      values: { n: 5 },
    });
    if (previewFirst)
      world.settings.preview(D, "A", {
        session: "page",
        draft: 2,
        values: { n: 9 },
      });
    const save = world.settings.save(D, "A", {
      set: { n: 5 },
      session: "page",
      draft: 1,
    });
    if (!previewFirst)
      world.settings.preview(D, "A", {
        session: "page",
        draft: 2,
        values: { n: 9 },
      });
    await save;
    const state = world.settings.state(D, "A");
    assert.equal(state.values.n.saved, 5);
    assert.equal(state.values.n.effective, 9);
    assert.equal(state.preview?.draft, 2);
  }
});
test("preview rule 5 (drafts): a preview that arrives after a Save of the same or a newer draft is ignored", async (t) => {
  const world = await serviceWorld(t);
  await world.settings.save(D, "A", {
    set: { n: 7 },
    session: "page",
    draft: 3,
  });
  for (const draft of [1, 2, 3])
    assert.equal(
      world.settings.preview(D, "A", {
        session: "page",
        draft,
        values: { n: 9 },
      }).applied,
      false,
    );
  assert.equal(world.settings.state(D, "A").values.n.effective, 7);
});
test("transition rule 1: while v1 still lists a device in its retained config/effective, v2 keeps that device in shadow and says why", async (t) => {
  const world = await serviceWorld(t, { transition: true });
  await world.inject(
    world.topics.v1ConfigEffective,
    JSON.stringify({ devices: [{ name: D }] }),
  );
  assert.equal(world.state.view(D).desired.output, "shadow");
  assert.equal(
    world.state.view(D).desired.outputProblem,
    "still driven by pixdcon v1",
  );
  assert.equal(world.state.view(D2).desired.output, "drive");
});
test("transition rule 2: before v1's list was received, every device is in shadow; the settle hint passing without a list does not release them", async (t) => {
  const world = await serviceWorld(t, { transition: true });
  await world.app.modules.mqtt?.settle();
  await world.clock.advance(10000);
  for (const view of world.state.views()) {
    assert.equal(view.desired.output, "shadow");
    assert.equal(
      view.desired.outputProblem,
      "waiting for pixdcon v1's device list",
    );
  }
});
// The interlock/no-clear portion is proved here. Scene state-file redirection
// is W5's adapter contract (scenes.test.js); this worktree has its skeleton.
test("transition rule 3: for a device the interlock holds back, a UI choice publishes no clear and its scene writes no file beside the scene", async (t) => {
  const world = await serviceWorld(t, { transition: true });
  const before = overlayPublications(world).length;
  assert.equal(
    (await world.state.chooseScene(D, "C")).view.desired.scene.scene,
    "C",
  );
  await world.flush();
  assert.equal(overlayPublications(world).length, before);
  assert.equal(world.runtime.outputOf(D), "shadow");
});

// --- Ordering (knowledge entry, section 3.0; the scene layers are run in ordering.test.js and ordering-model.test.js) ---
test("overlay service and scene layers: the service feeds every gateway message, connect, disconnect, settle hint and publish outcome to the reducer and carries out exactly the effects it answers with, against the in-memory broker with holdRetained", async (t) => {
  const world = await serviceWorld(t);
  const pending = delayOverlayWrites(t, world);
  await world.state.chooseScene(D, "C");
  await world.state.chooseScene(D2, "X");
  const first = pending.find(
    (write) => write.topic === world.topics.overlayDeviceScene(D),
  );
  const second = pending.find(
    (write) => write.topic === world.topics.overlayDeviceScene(D2),
  );
  assert.ok(first && second);
  second.finish({ ok: true, outcome: "confirmed", connection: 1, error: null });
  await world.flush();
  assert.equal(world.overlays.suppressions(D2).granular?.confirmed, true);
  assert.equal(world.overlays.suppressions(D).granular?.confirmed, false);
  first.finish({ ok: true, outcome: "confirmed", connection: 1, error: null });
  await world.flush();
  assert.equal(world.overlays.suppressions(D).granular?.confirmed, true);
  const before = overlayPublications(world).length;
  const release = world.broker.holdRetained();
  await world.reconnect();
  assert.equal(overlayPublications(world).length, before);
  world.overlays.accept({
    topic: world.topics.overlayDeviceScene(D),
    payload: "B",
    retain: false,
    connection: 1,
    receivedAt: new Date(world.clock.now()).toISOString(),
  });
  assert.equal(world.overlays.sceneInputs(D).granular, null);
  release();
});
test("mirror after a reconnect (M4): a record that the new connection has not delivered stays listed, with the older connection number and confirmed false; the settle hint removes nothing; a clear from outside removes it; what the record does meanwhile is rule 19 for a scene overlay, rule 20 for what the other kinds command and rule 24 for what they hold back", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.mode(D), "pause");
  const release = world.broker.holdRetained();
  await world.reconnect();
  const record = world.overlays.get(`mode:${D}`);
  assert.equal(record?.connection, 1);
  assert.equal(record?.confirmed, false);
  await world.app.modules.mqtt?.settle();
  assert.equal(world.overlays.get(`mode:${D}`)?.confirmed, false);
  await world.inject(world.topics.mode(D), "");
  assert.equal(world.overlays.get(`mode:${D}`), undefined);
  release();
});
test("own control writes: a mode or brightness change from the UI that echoes back after a newer one does not undo it; a control that was certainly not sent goes back to what the broker holds", async (t) => {
  const world = await serviceWorld(t);
  await world.state.setMode(D, "pause");
  await world.state.setMode(D, "play");
  await world.state.setBrightness(D, 25);
  await world.state.setBrightness(D, 70);
  await world.flush();
  assert.equal(world.state.view(D).desired.mode.value, "play");
  assert.equal(world.state.view(D).desired.brightness.override, 70);
  await world.state.setBrightness(D, null);
  await world.flush();
  assert.equal(world.state.view(D).desired.brightness.override, null);
});
test("held setting overlay: a setting overlay whose scene has no schema yet is kept and takes effect when the registry reports the schema", async (t) => {
  const world = await serviceWorld(t);
  const registry = world.app.modules.scenes;
  const get = registry.get.bind(registry);
  registry.get = () => undefined;
  await world.inject(world.topics.setting(D, "A", "n"), "9");
  assert.equal(world.overlays.get("setting:" + D + ":A:n")?.valid, false);
  assert.deepEqual(world.overlays.settingValues(D, "A"), {});
  registry.get = get;
  registry.emit("changed", { keys: ["A"] });
  assert.equal(world.settings.state(D, "A").values.n.effective, 9);
  assert.equal(world.overlays.get("setting:" + D + ":A:n")?.valid, true);
});
// Blocker: the frozen LayersInput has no explicit scene/blob own-write
// input (PIXD-95). Mirror writes are fenced; arbitrary scene writes/whole-blob clears
// still need that core decision (w1-to-coordinator-1.md). Do not invent one
// in the shell or silently treat their echoes as outside commands.
test.todo(
  "explicit clears and the v1 overlay route: an own write through clear, clearSettings, publishSettings, publishSceneOverlay or publishControl is remembered until its echo; what arrives on its topic before that is older",
);

// --- Cross-read round 3 (knowledge entry, section "Cross-read round 3"; the pure rules are run in ordering.test.js) ---
test("overlay rule 19 (N3, A-182): a retained scene overlay that is cleared while pixdcon is disconnected stops deciding after the reconnect: the display shows the choice, the Overlays page lists the record as not confirmed, nothing is published; with the overlay still stored and its replay held back (holdRetained) the display returns to it when the replay is delivered", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  const release = world.broker.holdRetained();
  await world.reconnect();
  assert.equal(world.state.view(D).desired.scene.scene, "A");
  assert.equal(world.overlays.get("device-scene:" + D)?.confirmed, false);
  release();
  await until(
    () => world.overlays.get("device-scene:" + D)?.confirmed === true,
  );
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "B");
  await world.broker.dropClients();
  const gateway = world.app.modules.mqtt;
  assert.ok(gateway);
  await until(() => gateway.status().state === "offline");
  await world.broker.inject(world.topics.overlayDeviceScene(D), "", {
    retain: true,
  });
  await world.clock.advance(5000);
  await until(() => gateway.status().connection === 3);
  await gateway.settle();
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "A");
  assert.equal(world.overlays.get("device-scene:" + D)?.confirmed, false);
});
test("overlay rule 20 (R4-5): a setting overlay, mode, brightness and a scene path overlay that are cleared while pixdcon is disconnected stop at the reconnect: the saved value, play, the scene's own brightness and config.json's path apply, as in a process that has just started; the records are listed as not confirmed; with the replay held back (holdRetained) each is back in effect when it is delivered; while the broker is away nothing changes; a suppression is saved before and after the reconnect", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.setting(D, "A", "n"), "9");
  await world.inject(world.topics.mode(D), "pause");
  await world.inject(world.topics.brightnessOverride(D), "40");
  await world.inject(world.topics.overlayScenePath("A"), "overlay.js");
  const release = world.broker.holdRetained();
  await world.reconnect();
  assert.equal(world.settings.state(D, "A").values.n.effective, 1);
  assert.equal(world.state.view(D).desired.mode.value, "play");
  assert.equal(world.state.view(D).desired.brightness.override, null);
  assert.notEqual(world.runtime.scenes().A.path, "overlay.js");
  for (const record of world.overlays.list())
    assert.equal(record.inEffect, false);
  release();
  await until(() => world.overlays.get("mode:" + D)?.confirmed === true);
  await world.flush();
  assert.equal(world.settings.state(D, "A").values.n.effective, 9);
  assert.equal(world.state.view(D).desired.mode.value, "pause");
  assert.equal(world.runtime.scenes().A.path, "overlay.js");
});
test("overlay rule 21 (N1): remove a device in the raw config and add it again while the clear of its last choice is on its way, then choose again: the new choice sends its own clear with a higher generation, and the late acknowledgement of the old clear leaves its suppression in config.json", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  const pending = delayOverlayWrites(t, world);
  await world.state.chooseScene(D, "C");
  const old = world.overlays.suppressions(D).granular?.generation;
  const identity = world.runtime.device(D);
  assert.ok(identity);
  await world.config.update((raw) => {
    raw.devices = /** @type {any[]} */ (raw.devices).filter(
      (entry) => entry.name !== D,
    );
  });
  await world.config.addDevice({
    name: D,
    type: identity.type,
    ip: identity.address,
  });
  await world.state.chooseScene(D, "X");
  const current = world.overlays.suppressions(D).granular?.generation;
  assert.ok(current && old && current > old);
  pending[0].finish({
    ok: true,
    outcome: "confirmed",
    connection: 1,
    error: null,
  });
  await world.flush();
  const raw = JSON.parse(await readFile(world.configPath, "utf8"));
  assert.equal(
    raw.devices.find((/** @type {any} */ entry) => entry.name === D).supersedes
      .granular.generation,
    current,
  );
});
test("overlay rule 22 (N2, R4-2): every blob rewrite on the wire carries the _pixdcon mark, two rewrites never share one, and pixdcon v1's merge ignores the key; an outside client that publishes the document of a rewrite that is on its way, and one that publishes an earlier rewrite again, the very first of a long run included, end no suppression; the same document without the mark is a command", async (t) => {
  const world = await serviceWorld(t);
  for (let turn = 0; turn < 40; turn++) {
    await world.inject(
      world.topics.overlayBlob,
      JSON.stringify({
        devices: [
          { name: D, scene: "B" },
          { name: D2, scene: "B" },
        ],
        turn,
      }),
    );
    await world.state.chooseScene(D, "C");
    await world.flush();
  }
  const blobWrites = () =>
    overlayPublications(world).filter(
      (entry) =>
        entry.topic === world.topics.overlayBlob && entry.payload !== "",
    );
  // flush() advances virtual time and drains config I/O, not the MQTT socket.
  await until(() => blobWrites().length >= 40);
  await world.flush();
  const writes = blobWrites();
  assert.ok(writes.length >= 40);
  const marks = writes.map((entry) => JSON.parse(entry.payload)._pixdcon);
  assert.equal(new Set(marks).size, marks.length);
  const pending = delayOverlayWrites(t, world);
  await world.state.chooseScene(D2, "X");
  await world.inject(world.topics.overlayBlob, writes[0].payload);
  assert.equal(world.state.view(D2).desired.scene.scene, "X");
  const gateway = world.app.modules.mqtt;
  assert.ok(gateway?.client);
  for (const write of pending) {
    await gateway.client.publishAsync(write.topic, write.payload, {
      retain: true,
      qos: 1,
    });
    write.finish({
      ok: true,
      outcome: "confirmed",
      connection: 1,
      error: null,
    });
  }
  t.mock.restoreAll();
  await world.flush();
  const outside = JSON.parse(writes[0].payload);
  delete outside._pixdcon;
  await world.inject(world.topics.overlayBlob, JSON.stringify(outside));
  assert.equal(world.state.view(D2).desired.scene.scene, "B");
});
test("overlay rule 23 (R4-3): one writer of the blob. With the transition on (mqtt.statusBaseTopic differs from mqtt.baseTopic), and with PIXDCON2_FORCE_SHADOW=1, a UI choice on a driven display clears its granular topic and publishes nothing to <base>/overlay/blob; a blob that another controller publishes afterwards, with any scene for that display, does not show on it, live or after a restart; Clear of the blob answers 409 blob_not_writer; after the transition the same saved suppression strips the blob", async (t) => {
  const world = await serviceWorld(t, { transition: true });
  await world.inject(
    world.topics.v1ConfigEffective,
    JSON.stringify({ devices: [] }),
  );
  assert.equal(world.state.view(D).desired.output, "drive");
  assert.equal(world.app.controller().blobWriter.writer, false);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({ devices: [{ name: D, scene: "B" }] }),
  );
  await world.state.chooseScene(D, "C");
  await world.flush();
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({ devices: [{ name: D, scene: "X" }] }),
  );
  assert.equal(world.state.view(D).desired.scene.scene, "C");
  assert.equal(
    overlayPublications(world).filter(
      (entry) => entry.topic === world.topics.overlayBlob,
    ).length,
    0,
  );
  await assert.rejects(world.overlays.clear("blob"), {
    code: "blob_not_writer",
  });
  await world.restart();
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "C");
});
test("overlay rule 24 (R4-5): what holds back stays. An enabled overlay that says false keeps the display off across a reconnect although its replay is held back, and although it was cleared while pixdcon was away, until a message for its topic is delivered or the user clears it; a display with an ip overlay that is not confirmed is held: listed, not started, no request to the overlay's address and none to the one in config.json", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceEnabled(D), "false");
  await world.inject(world.topics.overlayDeviceIp(D2), "127.0.0.9");
  const release = world.broker.holdRetained();
  await world.reconnect();
  assert.equal(world.runtime.device(D)?.enabled, false);
  assert.equal(world.runtime.device(D2)?.held, true);
  assert.equal(world.runtime.device(D2)?.enabled, false);
  assert.equal(world.overlays.get("device-enabled:" + D)?.restricts, "off");
  assert.equal(world.overlays.get("device-ip:" + D2)?.restricts, "held");
  await world.overlays.clear("device-enabled:" + D);
  await world.overlays.clear("device-ip:" + D2);
  await world.flush();
  assert.equal(world.runtime.device(D)?.enabled, true);
  assert.equal(world.runtime.device(D2)?.held, false);
  release();
});
test("overlay rule 25 (R4-5): a blob that is not confirmed after a reconnect patches no device key, adds no device and no scene; an entry with enabled false keeps its display off and an entry with ip holds it; when the blob is delivered again everything it says is back", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({
      devices: [
        { name: D, ip: "127.0.0.9", minFrameMs: 25 },
        { name: D2, enabled: false },
        { name: "extra", type: "pixoo", ip: "127.0.0.8" },
      ],
      scenes: { X: { path: "blob.js" } },
    }),
  );
  assert.equal(world.runtime.device(D)?.minFrameMs, 25);
  assert.ok(world.runtime.device("extra"));
  const release = world.broker.holdRetained();
  await world.reconnect();
  assert.equal(world.runtime.device(D)?.minFrameMs, 50);
  assert.equal(world.runtime.device(D)?.held, true);
  assert.equal(world.runtime.device(D2)?.enabled, false);
  assert.equal(world.runtime.device("extra"), undefined);
  assert.notEqual(world.runtime.scenes().X.path, "blob.js");
  release();
  await until(() => world.overlays.get("blob")?.confirmed === true);
  await world.flush();
  assert.equal(world.runtime.device(D)?.minFrameMs, 25);
  assert.equal(world.runtime.device(D)?.held, false);
  assert.ok(world.runtime.device("extra"));
});
test("gate r3 C1: a disabled blob-only device stays listed and held while retained replay waits", async (t) => {
  const world = await serviceWorld(t);
  const name = "blob-disabled";
  const entry = { name, type: "ulanzi", ip: world.awtrix.address, enabled: false };
  await world.inject(world.topics.overlayBlob, JSON.stringify({ devices: [entry] }));
  const before = world.state.view(name);
  assert.ok(before, "the confirmed blob lists the disabled device");
  assert.equal(before.origin, "blob");
  assert.equal(before.desired.enabled, false);
  const release = world.broker.holdRetained();
  t.after(release);
  await world.reconnect();
  const held = world.state.view(name);
  assert.ok(held, "the unconfirmed blob must keep the disabled device visible");
  assert.equal(held.incarnation, before.incarnation, "reconfirmation preserves the device's life");
  assert.equal(held.type, entry.type);
  assert.equal(held.desired.enabled, false);
  assert.equal(held.desired.held, true);
  assert.equal(world.runtime.device(name)?.held, true);
  assert.equal(world.runtime.device(name)?.enabled, false);
  await world.clock.advance(3000);
  assert.equal([...world.app.modules.sceneRuntime.instances].some((instance) => instance.device === name), false, "the held identity starts no scene runtime");
  assert.equal(world.app.modules.scheduler.runtimes.has(name), false, "the unconfirmed address starts no driver or display command");
  release();
  await until(() => world.overlays.get("blob")?.confirmed === true);
  await world.flush();
  const confirmed = world.state.view(name);
  assert.equal(confirmed.incarnation, before.incarnation);
  assert.equal(confirmed.desired.held, false);
  assert.equal(confirmed.desired.enabled, false, "reconfirmation does not lift the explicit switch-off");
});
test("overlay rule 26 (R4-1): every change of what an overlay record does is announced once: the service's changed event names a device when its records wait after a connect, and again when the replay confirms them without changing a value; a state store that computes only on that event shows what GET /api/v2/overlays lists", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  /** @type {any[]} */ const notices = [];
  world.overlays.on("changed", (event) => notices.push(event));
  const release = world.broker.holdRetained();
  await world.reconnect();
  assert.equal(notices.length, 1);
  assert.ok(notices[0].devices.includes(D));
  assert.equal(world.state.view(D).desired.scene.scene, "A");
  release();
  await until(
    () => world.overlays.get("device-scene:" + D)?.confirmed === true,
  );
  await world.flush();
  assert.equal(notices.length, 2);
  assert.ok(notices[1].devices.includes(D));
  assert.equal(world.state.view(D).desired.scene.scene, "B");
});
test("overlay service start: the secret for the write marks is made once per run and never leaves the process; whether this instance is the blob's writer is handed to the reducer once (deps.blobWriter); publish outcomes reach the reducer in the order they resolve; the six other kinds of retained topic go through reduceMirror, and structural(), settingValues() and controls() answer from overrideEffect", async (t) => {
  const world = await serviceWorld(t);
  assert.equal(world.overlays.layers.secret.length, 32);
  assert.equal(world.overlays.layers.blobWriter, true);
  assert.ok(
    !JSON.stringify(world.overlays.list()).includes(
      world.overlays.layers.secret,
    ),
  );
  await world.inject(world.topics.overlayDeviceIp(D), "127.0.0.8");
  await world.inject(world.topics.mode(D), "pause");
  await world.inject(world.topics.setting(D, "A", "n"), "8");
  assert.equal(world.overlays.structural().deviceIps[D], "127.0.0.8");
  assert.equal(world.overlays.controls(D).mode?.value, "pause");
  assert.equal(world.overlays.settingValues(D, "A").n, 8);
});

const D = "pixoo-t",
  D2 = "ulanzi-t";
const KEYS = ["A", "B", "C", "X"];
const FIELD = /** @type {import("../../src/types.js").SettingField} */ ({
  type: "int",
  label: "Number",
  group: "General",
  description: "",
  placeholder: "",
  default: 1,
  min: 0,
  max: 100,
});
const SCHEMA = {
  n: FIELD,
  other: FIELD,
  data: { ...FIELD, type: /** @type {const} */ ("json"), default: {} },
};

/** @param {import("node:test").TestContext} t @param {{shadow?: boolean, transition?: boolean}} [options] */
async function serviceWorld(t, options = {}) {
  const clock = manualClock();
  const stack = await startStack(t, {
    clock,
    env: options.shadow ? { PIXDCON2_FORCE_SHADOW: "1" } : {},
    config: (config) => {
      config.devices.forEach((/** @type {any} */ device) => {
        device.scene = "A";
      });
      for (const key of KEYS)
        config.scenes[key] = { path: config.scenes.funkeykid.path };
      if (options.transition)
        config.mqtt = { statusBaseTopic: "shadow/status" };
    },
  });
  let app = stack.app;
  /** @param {typeof app} target */
  const registryPeer = (target) => {
    target.modules.scenes.get = (key) =>
      KEYS.includes(key)
        ? {
            key,
            path: "scene.js",
            pathSource: "config",
            name: key,
            pretty_name: key,
            description: "",
            deviceType: null,
            settingsSchema: SCHEMA,
            resources: { assetDirs: [], stateFields: [] },
            status: "ok",
            error: null,
          }
        : undefined;
    target.modules.scenes.check = (key) =>
      key === null || KEYS.includes(key) || key.startsWith("builtin:")
        ? null
        : "unknown scene";
    target.modules.scenes.list = () =>
      KEYS.flatMap((key) => target.modules.scenes.get(key) ?? []);
    target.modules.scenes.emit("changed", { keys: KEYS });
  };
  registryPeer(app);
  let probe = 0;
  return {
    ...stack,
    clock,
    get app() {
      return app;
    },
    get topics() {
      return app.topics;
    },
    get state() {
      return app.modules.state;
    },
    get config() {
      return app.modules.config;
    },
    get runtime() {
      return app.modules.runtime;
    },
    get overlays() {
      return app.modules.overlays;
    },
    get settings() {
      return app.modules.settings;
    },
    async flush() {
      await clock.advance(300);
      await app.modules.config.readRaw();
      await clock.advance(300);
    },
    /** @param {string} topic @param {string} payload */
    async inject(topic, payload) {
      const gateway = app.modules.mqtt;
      assert.ok(gateway);
      let received = false;
      const off = gateway.subscribe(
        `test-probe:${++probe}`,
        topic,
        (message) => {
          if (!message.retain && message.payload === payload) received = true;
        },
      );
      await gateway.settle();
      await stack.broker.inject(topic, payload, { retain: true });
      await until(() => received);
      off();
      await clock.advance(300);
      await app.modules.config.readRaw();
      await clock.advance(300);
    },
    async restart() {
      await stopApp(app, clock);
      app = await createApp(
        {
          PIXDCON_CONFIG_PATH: stack.configPath,
          WEB_PORT: "0",
          MOSQUITTO_HOST: stack.broker.host,
          MQTT_PORT: String(stack.broker.port),
          PIXDCON2_MQTT_ANONYMOUS: "1",
          PIXDCON2_FORCE_SHADOW: options.shadow ? "1" : "0",
        },
        { clock, logger: stack.app.logger },
      );
      const restarted = app;
      stack.cleanup.add("pixdcon2 restart", () => stopApp(restarted, clock));
      await app.start();
      registryPeer(app);
      return app;
    },
    async reconnect() {
      const gateway = app.modules.mqtt;
      assert.ok(gateway);
      const connection = gateway.status().connection;
      await stack.broker.dropClients();
      await until(() => gateway.status().state === "offline");
      await clock.advance(5000);
      await until(() => gateway.status().connection > connection);
      await gateway.settle();
      await clock.advance(300);
    },
  };
}

/** @param {() => boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "overlay condition timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** @param {Awaited<ReturnType<typeof serviceWorld>>} world */
function overlayPublications(world) {
  return world.broker
    .published()
    .filter(
      (entry) =>
        entry.clientId !== "outside" &&
        (entry.topic.startsWith(`${world.topics.base}/overlay/`) ||
          entry.topic.startsWith(`${world.topics.settingsBase}/`)),
    );
}

/** @param {import("node:test").TestContext} t @param {Awaited<ReturnType<typeof serviceWorld>>} world */
function delayOverlayWrites(t, world) {
  const gateway = world.app.modules.mqtt;
  assert.ok(gateway);
  const original = gateway.publish.bind(gateway);
  /** @type {Array<{topic: string, payload: string, finish: (result: import("../../src/mqtt/mqtt-gateway.js").PublishResult) => void}>} */
  const pending = [];
  /** @type {typeof gateway.publish} */
  const publish = async (topic, payload, options) => {
    if (topic.startsWith(`${world.topics.base}/overlay/`)) {
      return new Promise((resolve) =>
        pending.push({ topic, payload: String(payload), finish: resolve }),
      );
    }
    return original(topic, payload, options);
  };
  t.mock.method(gateway, "publish", publish);
  return pending;
}

test("settings instance tokens: subscribers get copies in revision order; releasing one instance leaves its replacement alive and drops queued callbacks of the old one", async (t) => {
  const world = await serviceWorld(t);
  const first = { device: D, scene: "A", token: "first" };
  const second = { device: D, scene: "A", token: "replacement" };
  const old = world.settings.runtimeContext(first),
    fresh = world.settings.runtimeContext(second);
  /** @type {unknown[]} */ const a = [];
  /** @type {unknown[]} */ const b = [];
  old.subscribe((values) => {
    a.push(values.n);
    values.n = 100;
  });
  fresh.subscribe((values) => b.push(values.n));
  await until(() => a.length === 1 && b.length === 1);
  world.settings.releaseContext(first);
  world.settings.preview(D, "A", {
    session: "page",
    draft: 1,
    values: { n: 8 },
  });
  await until(() => b.length === 2);
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1, 8]);
  assert.equal(fresh.get("n"), 8);
  assert.deepEqual(old.all(), {});
  assert.equal(world.settings.state(D, "A").values.n.effective, 8);
});

test("device view revision: a setting-overlay count change raises rev and emits a device view, without a desired frame change", async (t) => {
  const world = await serviceWorld(t);
  const before = world.state.view(D);
  /** @type {any[]} */ const devices = [];
  /** @type {any[]} */ const desired = [];
  world.state.on("device", (view) => {
    if (view.name === D) devices.push(view);
  });
  world.state.on("desired", (event) => {
    if (event.name === D) desired.push(event);
  });
  await world.inject(world.topics.setting(D, "A", "n"), "9");
  const after = world.state.view(D);
  assert.equal(after.settingOverlayCount, 1);
  assert.ok(after.rev > before.rev);
  assert.equal(devices.at(-1)?.settingOverlayCount, 1);
  assert.equal(desired.length, 0);
  await world.inject(world.topics.setting(D, "A", "n"), "");
  assert.equal(world.state.view(D).settingOverlayCount, 0);
  assert.ok(world.state.view(D).rev > after.rev);
});

test("settings device life: a new incarnation accepts a page's first draft again; old contexts and queued subscriber deliveries do not reach it", async (t) => {
  const world = await serviceWorld(t);
  const ref = { device: D, scene: "A", token: "old-life" };
  const context = world.settings.runtimeContext(ref);
  let release = () => {};
  const wait = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  /** @type {unknown[]} */ const seen = [];
  context.subscribe(async (values) => {
    seen.push(values.n);
    await wait;
  });
  await until(() => seen.length === 1);
  world.settings.preview(D, "A", {
    session: "page",
    draft: 100,
    values: { n: 8 },
  });
  const identity = world.runtime.device(D);
  assert.ok(identity);
  const oldLife = world.settings.state(D, "A").incarnation;
  await world.config.update((raw) => {
    raw.devices = /** @type {any[]} */ (raw.devices).filter(
      (entry) => entry.name !== D,
    );
  });
  await world.config.update((raw) => {
    /** @type {any[]} */ (raw.devices).push({
      name: D,
      type: identity.type,
      ip: identity.address,
      scene: "A",
    });
  });
  const result = world.settings.preview(D, "A", {
    session: "page",
    draft: 1,
    values: { n: 3 },
  });
  assert.equal(result.applied, true);
  assert.ok(result.state.incarnation > oldLife);
  release();
  await world.flush();
  assert.deepEqual(seen, [1]);
  assert.deepEqual(context.all(), {});
});

test("restore a device: returning to its saved choice strips only its blob scene, keeps sibling scenes and structural fields, and respects shadow output", async (t) => {
  const world = await serviceWorld(t);
  await world.inject(
    world.topics.overlayBlob,
    JSON.stringify({
      devices: [
        { name: D, scene: "B", minFrameMs: 25 },
        { name: D2, scene: "X", comment: "keep" },
      ],
      scenes: { X: { path: "keep.js" } },
      extra: "keep",
    }),
  );
  const result = await world.state.clearSceneOverlay(D);
  assert.equal(result.desired.scene.scene, "A");
  await until(
    () =>
      !JSON.parse(world.broker.retained()[world.topics.overlayBlob]).devices[0]
        .scene,
  );
  const blob = JSON.parse(world.broker.retained()[world.topics.overlayBlob]);
  assert.equal(blob.devices[0].minFrameMs, 25);
  assert.deepEqual(blob.devices[1], { name: D2, scene: "X", comment: "keep" });
  assert.deepEqual(blob.scenes, { X: { path: "keep.js" } });
  assert.equal(blob.extra, "keep");
  await world.config.updateDevice(D, (raw) => {
    raw.output = "shadow";
  });
  await assert.rejects(world.state.clearSceneOverlay(D), {
    code: "shadow_output",
  });
});

test("startup retirements: a saved shadow suppression dropped before state.start is removed from the same generation in config.json", async (t) => {
  const world = await serviceWorld(t);
  await world.config.updateDevice(D, (raw) => {
    raw.output = "shadow";
  });
  await world.inject(world.topics.overlayDeviceScene(D), "B");
  await world.state.chooseScene(D, "C");
  await world.flush();
  await stopApp(world.app, world.clock);
  const raw = JSON.parse(await readFile(world.configPath, "utf8"));
  assert.ok(raw.devices[0].supersedes.granular);
  raw.devices[0].output = "drive";
  await writeFile(world.configPath, JSON.stringify(raw));
  await world.restart();
  await world.flush();
  assert.equal(world.state.view(D).desired.scene.scene, "B");
  await until(
    () =>
      !world.config.get().devices.find((device) => device.name === D)
        ?.supersedes.blob,
  );
  const saved = JSON.parse(await readFile(world.configPath, "utf8"));
  assert.equal(saved.devices[0].supersedes, undefined);
  assert.equal(world.overlays.suppressions(D).granular, null);
});

test("settings concurrent Saves: an older draft queued behind a newer Save cannot overwrite it, late previews of that draft drop immediately, and a later preview survives both answers", async (t) => {
  const world = await serviceWorld(t);
  const newer = world.settings.save(D, "A", {
    set: { n: 8 },
    session: "page",
    draft: 2,
  });
  const older = world.settings.save(D, "A", {
    set: { n: 3 },
    session: "page",
    draft: 1,
  });
  assert.equal(
    world.settings.preview(D, "A", {
      session: "page",
      draft: 2,
      values: { n: 10 },
    }).applied,
    false,
  );
  assert.equal(
    world.settings.preview(D, "A", {
      session: "page",
      draft: 3,
      values: { n: 9 },
    }).applied,
    true,
  );
  await Promise.all([newer, older]);
  const raw = JSON.parse(await readFile(world.configPath, "utf8"));
  assert.equal(raw.devices[0].sceneSettings.A.n, 8);
  assert.equal(world.settings.state(D, "A").values.n.effective, 9);
  assert.equal(world.settings.state(D, "A").preview?.draft, 3);
});
