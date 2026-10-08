/**
 * RPC collector — polls Shelly Gen2 devices + checks HTTP service liveness.
 * ESM port of health-pixoo/src/collectors/rpc-collector.js.
 *
 * @param {Object} config  - Scene config (config.wifi, config.services, config.rpcIntervalMs)
 * @param {Object} state   - Shared state object (state.wifi, state.services, state.heatChain)
 * @param {Object} logger  - Logger instance
 * @returns {{ stop: Function }}
 */

async function fetchWithTimeout(url, signal, timeoutMs = 5000) {
  return fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
}

async function pollRpc(config, state, logger, signal) {
  const rpcDevices = config.wifi.filter((d) => d.type === "shelly-gen2-rpc");
  for (const dev of rpcDevices) {
    if (signal.aborted) return;
    try {
      const res = await fetchWithTimeout(dev.rpcUrl, signal);
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (signal.aborted) return;

      // Navigate nested rssiField (e.g. 'wifi.rssi')
      const rssi = dev.rssiField
        .split(".")
        .reduce((cur, key) => (cur != null && cur[key] !== undefined ? cur[key] : null), data);

      // Grab switch:0 output for heat chain tracking
      const sw0 = data["switch:0"];
      if (sw0 !== undefined) {
        state.heatChain.output1 = sw0.output ?? null;
      }

      state.wifi[dev.label].rssi     = rssi;
      state.wifi[dev.label].online   = true;
      state.wifi[dev.label].lastSeen = new Date();
      logger.debug(`[rpc] ${dev.label}: rssi=${rssi} output1=${state.heatChain.output1}`);
    } catch (err) {
      if (signal.aborted) return;
      state.wifi[dev.label].online = false;
      logger.warn(`[rpc] ${dev.label} failed: ${err.message}`);
    }
  }
}

async function pollServices(config, state, logger, signal) {
  for (const svc of config.services) {
    if (signal.aborted) return;
    if (svc.type !== "http") continue;
    try {
      const res = await fetchWithTimeout(svc.url, signal);
      await res.body?.cancel();
      if (signal.aborted) return;
      state.services[svc.label].alive       = res.ok || res.status < 500;
      state.services[svc.label].lastChecked = new Date();
      logger.debug(`[rpc] service ${svc.label}: alive=${state.services[svc.label].alive}`);
    } catch {
      if (signal.aborted) return;
      state.services[svc.label].alive       = false;
      state.services[svc.label].lastChecked = new Date();
    }
  }
}

function checkStaleDevices(state, logger) {
  const STALE_MS = 5 * 60 * 1000;
  const now = Date.now();
  for (const [label, s] of Object.entries(state.wifi)) {
    if (s.lastSeen && s.online && now - s.lastSeen.getTime() > STALE_MS) {
      logger.warn(`[rpc] ${label} went stale`);
      state.wifi[label].online = false;
    }
  }
}

export function start(config, state, logger) {
  const controller = new AbortController();
  let rpcBusy = false;
  let servicesBusy = false;
  const runRpc = async () => {
    if (rpcBusy || controller.signal.aborted) return;
    rpcBusy = true;
    try {
      await pollRpc(config, state, logger, controller.signal);
    } catch (err) {
      logger.warn(`[rpc-collector] RPC poll failed: ${err.message}`);
    } finally {
      rpcBusy = false;
    }
  };
  const runServices = async () => {
    if (servicesBusy || controller.signal.aborted) return;
    servicesBusy = true;
    try {
      await pollServices(config, state, logger, controller.signal);
    } catch (err) {
      logger.warn(`[rpc-collector] Service poll failed: ${err.message}`);
    } finally {
      servicesBusy = false;
    }
  };
  runRpc();
  runServices();
  const id1 = setInterval(runRpc,      config.rpcIntervalMs);
  const id2 = setInterval(runServices, config.rpcIntervalMs);
  const id3 = setInterval(() => checkStaleDevices(state, logger),    60_000);
  logger.info(`[rpc-collector] Started (interval: ${config.rpcIntervalMs}ms)`);
  return {
    stop() {
      clearInterval(id1);
      clearInterval(id2);
      clearInterval(id3);
      controller.abort();
    },
  };
}
