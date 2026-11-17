/**
 * Test kind 2 of 3 (API and MQTT contract): the browser's side of the live
 * channel and of the API.
 *
 * The page gets state from the live stream and from the answers of its own
 * requests. What decides whether something that arrives is applied is pure
 * code and is run in ordering.test.js (web/js/ordering.js). The todo entries
 * here name what the UI worker proves when the store, the live client and
 * the API helper are built: that all three really go through that decision.
 * They run in Node, against stand-ins for EventSource and fetch; no browser.
 * Owner: UI worker.
 */

import test from "node:test";

test.todo(
  "client store: a snapshot, an event, a view and an answer change the store only when the fence answers apply; what is dropped changes nothing on screen",
);
test.todo(
  "client live: every connect and reconnect opens a new EventSource with a new stream generation; events of a replaced stream are dropped, also ones that were queued before it was closed; an event whose id cannot be read is not handed on",
);
test.todo(
  "client api: every request takes its generation before it is sent; the answer carries epoch and seq of X-Pixdcon-Position; an answer without the header is not applied",
);
test.todo(
  "client boot: the bootstrap answer and the stream's snapshot can arrive in either order, also across a restart of pixdcon; the page ends on the newer one",
);
test.todo(
  "client timers: the reconnect timer and the 20 s silence timer change the connection state that is shown and nothing else; values on screen are marked as old, never replaced, by a timer",
);
test.todo(
  "client controls: one request at a time per control; a click while its request runs sends nothing, and the answer of the request is applied by its rev",
);
test.todo(
  "client settings form: every edit raises the draft; a preview answer for an older draft than the one on screen is not shown",
);
test.todo(
  "client store, snapshot (N4): a snapshot is applied part by part: every resource that decideSnapshot does not name in keep, every device view through decideView with the snapshot's seq, and the devices in gone are removed; a late answer that stands before the snapshot changes nothing on screen",
);
test.todo(
  "client store, removal (N4): device-removed calls forgetDevice with the event's seq and drops the device's settings states; the late answer of a write to the old device does not bring it back after a device of the same name was added again",
);
