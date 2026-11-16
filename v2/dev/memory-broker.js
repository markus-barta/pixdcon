/**
 * In-memory MQTT broker for dev and tests.
 *
 * Choice: aedes, run inside the process and listening on a loopback TCP port.
 * v2 connects to it with the real `mqtt` client over a real socket, so the
 * things the overlay rules depend on are the broker's real behaviour and not
 * a stand-in's: retained messages are replayed on subscribe with the retain
 * flag set, live messages arrive with the flag clear, an empty retained
 * payload deletes, QoS 1 publishes are acknowledged. Start and stop take a
 * few milliseconds, so every test file can have its own broker.
 *
 * Not for production and never reachable from outside: it binds 127.0.0.1.
 */

import { createServer } from "node:net";
import { Aedes } from "aedes";

/**
 * @typedef {object} MemoryBroker
 * @property {string} host
 * @property {number} port
 * @property {string} url mqtt://127.0.0.1:<port>
 * @property {() => Record<string, string>} retained topic → payload of every retained message the broker holds now
 * @property {() => Array<{topic: string, payload: string, retain: boolean, qos: number, clientId: string|null}>} published every message published by a client so far, oldest first
 * @property {() => number} clients connected clients
 * @property {(topic: string, payload: string, options?: {retain?: boolean}) => Promise<void>} inject publish a message as an outside client would (Home Assistant, Node-RED)
 * @property {() => Promise<void>} dropClients close every client connection (the broker keeps running): a broker outage as the client sees it
 * @property {() => Promise<void>} stop
 */

/**
 * @param {{port?: number}} [options] port 0 (default) picks a free one
 * @returns {Promise<MemoryBroker>}
 */
export async function startMemoryBroker(options = {}) {
  const host = "127.0.0.1";
  /** @type {Map<string, string>} */
  const retained = new Map();
  /** @type {ReturnType<MemoryBroker["published"]>} */
  const published = [];
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();

  /**
   * @param {string} topic
   * @param {string} payload
   * @param {boolean} retain
   * @param {number} qos
   * @param {string|null} clientId
   */
  const record = (topic, payload, retain, qos, clientId) => {
    published.push({ topic, payload, retain, qos, clientId });
    if (!retain) return;
    if (payload === "") retained.delete(topic);
    else retained.set(topic, payload);
  };

  const aedes = await Aedes.createBroker({
    // Called for every client publish before the broker stores or forwards it,
    // so the bookkeeping is complete by the time the publisher gets its
    // acknowledgement. (The "publish" event fires later, after delivery.)
    authorizePublish(client, packet, callback) {
      const payload = Buffer.isBuffer(packet.payload)
        ? packet.payload.toString("utf8")
        : String(packet.payload);
      record(
        packet.topic,
        payload,
        Boolean(packet.retain),
        packet.qos,
        client?.id ?? null,
      );
      callback(null);
    },
  });

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    aedes.handle(socket);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, host, () => resolveListen(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    host,
    port,
    url: `mqtt://${host}:${port}`,
    retained: () => Object.fromEntries(retained),
    published: () => published.slice(),
    clients: () => aedes.connectedClients,
    inject(topic, payload, injectOptions = {}) {
      const retain = injectOptions.retain === true;
      record(topic, payload, retain, 0, "outside");
      return new Promise((resolvePublish, rejectPublish) => {
        aedes.publish(
          /** @type {any} */ ({
            cmd: "publish",
            topic,
            payload: Buffer.from(payload),
            qos: 0,
            retain,
            dup: false,
          }),
          (error) => (error ? rejectPublish(error) : resolvePublish()),
        );
      });
    },
    async dropClients() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveTick) => setImmediate(resolveTick));
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) =>
        server.close(() => resolveClose(undefined)),
      );
      await new Promise((resolveClose) =>
        aedes.close(() => resolveClose(undefined)),
      );
    },
  };
}
