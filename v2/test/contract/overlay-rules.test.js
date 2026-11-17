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

import test from "node:test";

test.todo(
  "overlay rule 1: a UI scene choice beats a stored scene overlay, and the retained overlay is cleared on the broker",
);
test.todo(
  "overlay rule 2: after a UI choice, a retained replay of the old overlay (reconnect) does not bring it back",
);
test.todo(
  "overlay rule 3: a scene overlay published live after a UI choice wins again (Home Assistant scene toggle)",
);
test.todo(
  "overlay rule 4: a UI choice made while MQTT is offline holds; nothing is published because the connection came back, and the stored overlay is cleared when the new connection replays it",
);
test.todo(
  "overlay rule 5: a UI choice with an unconfirmed clear survives a restart of pixdcon (supersedes marker in config.json)",
);
test.todo(
  "overlay rule 6: a blob overlay scene for the device is superseded the same way, other blob fields stay",
);
test.todo(
  "overlay rule 7: an overlay naming an unknown scene is listed as invalid and the choice stays on the display",
);
test.todo(
  "overlay rule 8: an unchanged overlay message causes no event and no device restart",
);
test.todo(
  "overlay rule 9: shadow output: a UI choice changes the preview and publishes nothing",
);
test.todo(
  "overlay rule 10 (late replay): a stored scene overlay delivered after the SUBACK and after the sync echo does not undo a UI choice made before it arrived; it is superseded and cleared again",
);
test.todo(
  "overlay rule 11 (late replay after the clear): a replay of the old value that arrives after the broker confirmed the clear and after the clear's own echo is ignored",
);
test.todo(
  "overlay rule 12 (per layer): a live granular overlay ends the granular suppression only; after a restart, clearing that granular overlay shows the choice, not the blob scene the choice had replaced",
);
test.todo(
  "overlay rule 13 (generation): the acknowledgement of the clear of an older choice does not end the suppression of a newer choice",
);
test.todo(
  "overlay rule 14 (stored while away): after a restart with an unconfirmed clear, a replay of the same value stays superseded and is cleared; a replay of another value wins as a new command",
);
test.todo(
  "overlay rule 15 (blob echo): two choices on two devices; the first rewrite echoing back late does not restore the second device's blob scene",
);
test.todo(
  "overlay rule 16 (blob reconnect): a blob rewrite cut off by a disconnect is not sent again; after the reconnect it is rebuilt from the blob the broker replays and keeps a field another publisher changed meanwhile",
);
test.todo(
  "overlay rule 17 (legacy key): a blob entry with a legacy `scenes` array is superseded like `scene`, and both keys are gone from the rewrite",
);
test.todo(
  "overlay rule 18 (shadow to drive): a suppression made while the device was in shadow is dropped when it becomes driven; no clear is published and the stored overlay shows",
);
test.todo(
  "save rule 1: no route ever writes an overlay value into config.json (scene, ip, enabled, blob devices, setting overlays)",
);
test.todo(
  "save rule 2: PATCH device, PUT scene and PUT settings change one device entry; a second device and a disabled device stay byte-identical",
);
test.todo(
  "save rule 3: saving a setting clears the MQTT overlay of that key only",
);
test.todo(
  "save rule 4: config.json is replaced atomically; the previous version is config.json.bak",
);
test.todo(
  "save rule 5 (overlay-only device): its scene switch works and answers persisted false with reason overlay_only_device; a settings save answers 409; config.json is untouched",
);
test.todo(
  "save rule 6 (adoption): adopt writes name, type and address and the scene chosen here in one atomic write, and no other key of the blob entry; afterwards saves work",
);
test.todo(
  "preview rule 1: a settings preview reaches the running scene and publishes nothing to MQTT",
);
test.todo(
  "preview rule 2: a preview ends on revert, on save, on the end-session call, and when the live connection is gone",
);
test.todo(
  "preview rule 3: a JSON setting that does not parse is rejected with the parse error and never stored as {}",
);
test.todo(
  "preview rule 4 (drafts): a preview sent while Save is under way survives the Save, whichever of the two requests arrives first",
);
test.todo(
  "preview rule 5 (drafts): a preview that arrives after a Save of the same or a newer draft is ignored",
);
test.todo(
  "transition rule 1: while v1 still lists a device in its retained config/effective, v2 keeps that device in shadow and says why",
);
test.todo(
  "transition rule 2: before v1's list was received, every device is in shadow; the settle hint passing without a list does not release them",
);
test.todo(
  "transition rule 3: for a device the interlock holds back, a UI choice publishes no clear and its scene writes no file beside the scene",
);

// --- Ordering (knowledge entry, section 3.0; the scene layers are run in ordering.test.js and ordering-model.test.js) ---
test.todo(
  "overlay service and scene layers: the service feeds every gateway message, connect, disconnect, settle hint and publish outcome to the reducer and carries out exactly the effects it answers with, against the in-memory broker with holdRetained",
);
test.todo(
  "mirror after a reconnect (M4): a record that the new connection has not delivered stays listed, with the older connection number and confirmed false; the settle hint removes nothing; a clear from outside removes it; what the record decides meanwhile is rule 19 for a scene overlay and rule 20 for every other kind",
);
test.todo(
  "own control writes: a mode or brightness change from the UI that echoes back after a newer one does not undo it; a control that was certainly not sent goes back to what the broker holds",
);
test.todo(
  "held setting overlay: a setting overlay whose scene has no schema yet is kept and takes effect when the registry reports the schema",
);
test.todo(
  "explicit clears and the v1 overlay route: an own write through clear, clearSettings, publishSettings, publishSceneOverlay or publishControl is remembered until its echo; what arrives on its topic before that is older",
);

// --- Cross-read round 3 (knowledge entry, section "Cross-read round 3"; the pure rules are run in ordering.test.js) ---
test.todo(
  "overlay rule 19 (N3, A-182): a retained scene overlay that is cleared while pixdcon is disconnected stops deciding after the reconnect: the display shows the choice, the Overlays page lists the record as not confirmed, nothing is published; with the overlay still stored and its replay held back (holdRetained) the display returns to it when the replay is delivered",
);
test.todo(
  "overlay rule 20 (N3): an enabled overlay, an ip overlay, a setting overlay and a retained control that are not delivered again after a reconnect stay in effect, listed as not confirmed; a suppression is saved before and after the reconnect",
);
test.todo(
  "overlay rule 21 (N1): remove a device in the raw config and add it again while the clear of its last choice is on its way, then choose again: the new choice sends its own clear with a higher generation, and the late acknowledgement of the old clear leaves its suppression in config.json",
);
test.todo(
  "overlay rule 22 (N2): every blob rewrite on the wire carries the _pixdcon mark, two rewrites never share one, and pixdcon v1's merge ignores the key; an outside client that publishes the document of a rewrite that is on its way, and one that publishes the bytes of an earlier rewrite, end no suppression",
);
test.todo(
  "overlay service start: the secret for the write marks is made once per run and never leaves the process; the reducer's own, sent and outstanding lists are fed from the gateway's publish outcomes in the order they resolve",
);
