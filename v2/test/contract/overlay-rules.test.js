/**
 * Test kind 2 of 3 (API and MQTT contract): the overlay, save and preview rules.
 *
 * The rules Markus approved for phase 2: a UI choice beats an overlay; Save
 * never promotes overlays; previews are ephemeral and not retained. Each todo
 * below is one rule from the knowledge entry "pixdcon-2-interfaces", section
 * "State model". They are tested from the outside only: HTTP requests, the
 * live channel, and MQTT messages on the in-memory broker
 * (test/helpers/harness.js startStack, broker.inject for the outside client).
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
  "overlay rule 4: a UI choice made while MQTT is offline holds, and the clear is sent after the reconnect",
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
  "preview rule 1: a settings preview reaches the running scene and publishes nothing to MQTT",
);
test.todo(
  "preview rule 2: a preview ends on revert, on save, on the end-session call, and when the live connection is gone",
);
test.todo(
  "preview rule 3: a JSON setting that does not parse is rejected with the parse error and never stored as {}",
);
test.todo(
  "transition rule: while v1 still lists a device in its retained config/effective, v2 keeps that device in shadow",
);
