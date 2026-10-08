import test from "node:test";
import assert from "node:assert/strict";
import { RenderLoop } from "../src/render-loop.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const driver = () => ({ async setBrightness() {}, async initialize() { return true; } });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function withTimeout(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("loop did not finish")), 300);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("scene changes during rendering take effect on the next frame", async () => {
  const entered = deferred();
  const frame = deferred();
  const rendered = [];
  let loop;
  const loader = {
    async load(name) {
      return {
        async render() {
          rendered.push(name);
          if (rendered.length === 1) { entered.resolve(); await frame.promise; }
          else loop.stop();
          return 60_000;
        },
      };
    },
    isLoaded() { return true; },
    async unloadScene() {},
  };
  loop = new RenderLoop(driver(), loader, "old", { logger, minFrameMs: 0 });
  const running = loop.start();
  await entered.promise;
  loop.setScene("new");
  frame.resolve();
  try {
    await withTimeout(running);
    assert.deepEqual(rendered, ["old", "new"]);
  } finally {
    loop.stop();
    await running;
  }
});

test("stop during a built-in driver call cannot register a new idle waiter", async () => {
  const entered = deferred();
  const call = deferred();
  const device = {
    ...driver(), initialized: true,
    async switchToApp() { entered.resolve(); await call.promise; },
  };
  const loop = new RenderLoop(device, {}, "builtin:time", { logger });
  const running = loop.start();
  await entered.promise;
  const stopped = loop.stop();
  call.resolve();
  try {
    await withTimeout(running);
    await stopped;
    assert.equal(loop._modeChanged, null);
  } finally {
    loop.stop();
    await running;
  }
});

test("idle devices can start rendering when a scene is selected", async () => {
  const done = deferred();
  let loop;
  const loader = {
    async load() { return { render() { done.resolve(); loop.stop(); return null; } }; },
    isLoaded() { return true; },
  };
  loop = new RenderLoop(driver(), loader, null, { logger });
  const running = loop.start();
  loop.setScene("clock");
  try {
    await withTimeout(done.promise);
  } finally {
    loop.stop();
    await running;
  }
});

test("a mode change during stop's driver call does not get lost", async () => {
  const entered = deferred();
  const call = deferred();
  let loop;
  const device = { ...driver(), async clear() { entered.resolve(); await call.promise; } };
  const loader = {
    async load() { return { render() { loop.stop(); return null; } }; },
    isLoaded() { return true; },
  };
  loop = new RenderLoop(device, loader, "clock", { logger });
  loop.setMode("stop");
  const running = loop.start();
  await entered.promise;
  loop.setMode("play");
  call.resolve();
  try {
    await withTimeout(running);
  } finally {
    loop.stop();
    await running;
  }
});

test("stop waits for an active frame before destroying scene resources", async () => {
  const entered = deferred();
  const frame = deferred();
  const events = [];
  const loader = {
    async load() {
      return { async render() { entered.resolve(); await frame.promise; events.push("frame ended"); return 60_000; } };
    },
    isLoaded() { return true; },
    async unloadScene() { events.push("destroyed"); },
  };
  const loop = new RenderLoop(driver(), loader, "clock", { logger });
  const running = loop.start();
  await entered.promise;
  const stopped = loop.stop();
  assert.ok(stopped instanceof Promise);
  assert.deepEqual(events, []);
  frame.resolve();
  await withTimeout(stopped);
  await running;
  assert.deepEqual(events, ["frame ended", "destroyed"]);
});

test("scene changes interrupt liveness backoff without a new sleep or probe", async () => {
  let probes = 0;
  const loop = new RenderLoop({
    ...driver(), async initialize() { probes++; return false; },
  }, {}, "old", { logger });
  loop.running = true;
  const waiting = loop._sleepWithLivenessProbe(60_000);
  loop.setScene("new");
  try {
    await withTimeout(waiting);
    assert.equal(probes, 0);
    assert.equal(loop._sleepWake, null);
  } finally {
    loop.stop();
  }
});

test("MQTT outages do not consume power-cycle attempts", async () => {
  const loop = new RenderLoop(driver(), {}, "clock", {
    logger, mqttService: { connected: false },
    powerCyclePlugin: { topic: "plug/set" }, maxPowerCycles: 1,
  });
  loop.running = true;
  loop.consecutiveErrors = loop.maxErrors;
  let waits = 0;
  loop._sleepWithLivenessProbe = async () => { waits++; };
  await loop._runScene("clock");
  assert.equal(loop.powerCycleCount, 0);
  assert.equal(waits, 1);
  assert.equal(loop.running, true);
  loop.stop();
});

test("stopping during the power-cycle OFF wait still switches the plug back on", async () => {
  const published = [];
  const loop = new RenderLoop(driver(), {}, "clock", {
    logger,
    mqttService: { connected: true, publishRaw: (topic, payload) => published.push([topic, payload]) },
    powerCyclePlugin: { topic: "plug/set", offWaitMs: 60_000, onWaitMs: 60_000 },
  });
  loop.running = true;
  const cycle = loop._doPowerCycle();
  loop.stop();
  assert.equal(await withTimeout(cycle), false);
  assert.deepEqual(published.map(([, payload]) => payload), ['{"state":"OFF"}', '{"state":"ON"}']);
});

test("error backoff starts at one second, doubles and respects the cap", () => {
  const loop = new RenderLoop(driver(), {}, "clock", { logger });
  const waits = [];
  for (let i = 0; i < 7; i++) {
    loop._handleError(new Error("offline"), "test");
    waits.push(loop.currentBackoff);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("built-in mode respects stop rather than activating the app again", async () => {
  const entered = deferred();
  let switched = false;
  const loop = new RenderLoop({
    ...driver(), initialized: true,
    async clear() { entered.resolve(); },
    async switchToApp() { switched = true; },
  }, {}, "builtin:time", { logger });
  loop.setMode("stop");
  const running = loop.start();
  await entered.promise;
  await loop.stop();
  await withTimeout(running);
  assert.equal(switched, false);
});

test("leaving a built-in channel restores custom display mode before rendering", async () => {
  const entered = deferred();
  const events = [];
  let loop;
  const device = {
    ...driver(), initialized: true,
    async setScreen(value) { events.push(`screen:${value}`); },
    async setChannel() { entered.resolve(); },
    async initialize() { events.push("custom channel"); return true; },
  };
  const loader = {
    async load() { return { render() { events.push("render"); loop.stop(); return null; } }; },
    isLoaded() { return true; },
  };
  loop = new RenderLoop(device, loader, "builtin:clock", { logger });
  const running = loop.start();
  await entered.promise;
  loop.setScene("clock");
  await withTimeout(running);
  assert.ok(events.indexOf("custom channel") < events.indexOf("render"));
});
