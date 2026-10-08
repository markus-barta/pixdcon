/**
 * Ping collector — checks ping-type wifi devices via ICMP.
 * ESM port of health-pixoo/src/collectors/ping-collector.js.
 *
 * @param {Object} config  - Scene config (config.wifi, config.pingIntervalMs)
 * @param {Object} state   - Shared state object (state.wifi)
 * @param {Object} logger  - Logger instance
 * @returns {{ stop: Function }}
 */

import { execFile } from "child_process";

function pingHost(ip, signal) {
  return new Promise((resolve) => {
    const isMac = process.platform === "darwin";
    const args = ["-c", "1", "-W", isMac ? "2000" : "2", ip];

    execFile("ping", args, { timeout: 5000, signal }, (err, stdout) => {
      if (err) {
        resolve({ alive: false, ms: null });
        return;
      }
      const match = stdout.match(/time[<=]([\d.]+)/);
      resolve({ alive: true, ms: match ? parseFloat(match[1]) : null });
    });
  });
}

async function pollOnce(config, state, logger, signal) {
  const pingDevices = config.wifi.filter((d) => d.type === "ping");
  for (const dev of pingDevices) {
    if (signal.aborted) return;
    try {
      const result = await pingHost(dev.ip, signal);
      if (signal.aborted) return;
      state.wifi[dev.label].online  = result.alive;
      state.wifi[dev.label].rssi    = null; // ping-only: no RSSI
      state.wifi[dev.label].pingMs  = result.ms;
      if (result.alive) state.wifi[dev.label].lastSeen = new Date();
      logger.debug(`[ping] ${dev.label}: alive=${result.alive} ms=${result.ms}`);
    } catch (err) {
      logger.warn(`[ping] ${dev.label} error: ${err.message}`);
    }
  }
}

export function start(config, state, logger) {
  const controller = new AbortController();
  let busy = false;
  const poll = async () => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    try {
      await pollOnce(config, state, logger, controller.signal);
    } catch (err) {
      logger.warn(`[ping-collector] Poll failed: ${err.message}`);
    } finally {
      busy = false;
    }
  };
  poll();
  const id = setInterval(poll, config.pingIntervalMs);
  logger.info(`[ping-collector] Started (interval: ${config.pingIntervalMs}ms)`);
  return {
    stop() {
      clearInterval(id);
      controller.abort();
    },
  };
}
