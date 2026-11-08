import { WebSocket } from "ws";
import {
  DEFAULT_TIMEOUTS,
  DEFAULT_HEARTBEAT,
  DEFAULT_LIMITS,
  resolveHeartbeat,
  resolveLimits,
} from "./config.js";
import { createMetrics, safeLog } from "./observability.js";

function createConnectionManager(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("connection manager options must be an object");
  }
  const allowedOptions = new Set([
    "heartbeatIntervalMs",
    "staleThresholdMs",
    "maxConnections",
    "maxBufferedBytes",
    "maxTotalBufferedBytes",
    "maxSubscriptionsPerClient",
    "maxGroupNameLength",
    "authorizeSubscription",
    "logger",
    "metrics",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) {
      throw new TypeError(`unknown connection manager option "${key}"`);
    }
  }

  const {
    heartbeatIntervalMs = DEFAULT_HEARTBEAT.heartbeatIntervalMs,
    staleThresholdMs = DEFAULT_HEARTBEAT.staleThresholdMs,
    maxConnections = DEFAULT_LIMITS.maxConnections,
    maxBufferedBytes = DEFAULT_LIMITS.maxBufferedBytes,
    maxTotalBufferedBytes = DEFAULT_LIMITS.maxTotalBufferedBytes,
    maxSubscriptionsPerClient = DEFAULT_LIMITS.maxSubscriptionsPerClient,
    maxGroupNameLength = DEFAULT_LIMITS.maxGroupNameLength,
    authorizeSubscription = async () => false,
    logger = console,
    metrics: metricsOption = {},
  } = options;
  if (typeof authorizeSubscription !== "function") {
    throw new TypeError("authorizeSubscription must be a function");
  }

  const limits = resolveLimits({
    maxConnections,
    maxBufferedBytes,
    maxTotalBufferedBytes,
    maxSubscriptionsPerClient,
    maxGroupNameLength,
  });
  const heartbeat = resolveHeartbeat({ heartbeatIntervalMs, staleThresholdMs });
  const metrics = createMetrics(metricsOption, logger);
  const clients = new Map();
  const groups = new Map();
  let heartbeatTimer = null;
  let totalBufferedBytes = 0;

  function add(clientId, ws, identity = {}) {
    if (clients.has(clientId) || clients.size >= limits.maxConnections)
      return null;
    const client = {
      id: clientId,
      ws,
      identity,
      lastPong: Date.now(),
      subscriptions: new Set(),
      pendingSends: new Set(),
    };
    clients.set(clientId, client);
    metrics.gauge("ws.connections.active", clients.size);
    ws.on("pong", () => {
      client.lastPong = Date.now();
    });
    ws.on("close", () => {
      metrics.increment("ws.connections.closed");
      remove(clientId);
    });
    ws.on("error", (error) => {
      safeLog(logger, "warn", "[engine] websocket error", error);
      remove(clientId);
    });
    return client;
  }

  function remove(clientId) {
    const client = clients.get(clientId);
    if (!client) return false;
    for (const group of client.subscriptions) {
      const members = groups.get(group);
      members?.delete(clientId);
      if (members?.size === 0) groups.delete(group);
    }
    clients.delete(clientId);
    for (const pendingSend of [...client.pendingSends]) pendingSend.release();
    metrics.gauge("ws.connections.active", clients.size);
    return true;
  }

  function reserveBufferedBytes(client, bytes) {
    const pendingSend = {
      released: false,
      release() {
        if (pendingSend.released) return;
        pendingSend.released = true;
        client.pendingSends.delete(pendingSend);
        totalBufferedBytes -= bytes;
        metrics.gauge("ws.buffered_bytes.total", totalBufferedBytes);
      },
    };
    client.pendingSends.add(pendingSend);
    totalBufferedBytes += bytes;
    metrics.gauge("ws.buffered_bytes.total", totalBufferedBytes);
    return pendingSend;
  }

  function get(clientId) {
    return clients.get(clientId);
  }

  function size() {
    return clients.size;
  }

  function serialize(payload) {
    if (typeof payload === "string") return payload;
    const data = JSON.stringify(payload);
    return typeof data === "string" ? data : null;
  }

  function sendData(client, data) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      metrics.increment("ws.messages.dropped", 1, { reason: "not_open" });
      return false;
    }
    const bytes = Buffer.byteLength(data);
    if (client.ws.bufferedAmount + bytes > limits.maxBufferedBytes) {
      metrics.increment("ws.messages.dropped", 1, {
        reason: "client_buffer_limit",
      });
      try {
        client.ws.close(1013, "client is too slow");
      } catch {}
      remove(client.id);
      return false;
    }
    if (totalBufferedBytes + bytes > limits.maxTotalBufferedBytes) {
      metrics.increment("ws.messages.dropped", 1, {
        reason: "aggregate_buffer_limit",
      });
      return false;
    }

    const pendingSend = reserveBufferedBytes(client, bytes);
    try {
      client.ws.send(data, (error) => {
        pendingSend.release();
        if (error) {
          metrics.increment("ws.send.failures");
          safeLog(logger, "warn", "[engine] websocket send failed", error);
          remove(client.id);
        }
      });
      metrics.increment("ws.messages.out");
      return true;
    } catch (error) {
      pendingSend.release();
      metrics.increment("ws.send.failures");
      safeLog(logger, "warn", "[engine] websocket send failed", error);
      remove(client.id);
      return false;
    }
  }

  function sendTo(clientId, payload) {
    const client = clients.get(clientId);
    const data = serialize(payload);
    return !!client && data !== null && sendData(client, data);
  }

  function sendToClients(clientIds, payload, filter) {
    const data = serialize(payload);
    if (data === null) return 0;
    let delivered = 0;
    for (const clientId of clientIds) {
      const client = clients.get(clientId);
      if (!client || (filter && !filter(client))) continue;
      if (sendData(client, data)) delivered++;
    }
    return delivered;
  }

  function broadcast(payload, filter) {
    return sendToClients(clients.keys(), payload, filter);
  }

  async function subscribe(clientId, group, req) {
    const client = clients.get(clientId);
    if (
      !client ||
      typeof group !== "string" ||
      group.length === 0 ||
      group.length > limits.maxGroupNameLength
    ) {
      return false;
    }

    try {
      if (!(await authorizeSubscription(client.identity, group, req))) {
        return false;
      }
    } catch (error) {
      safeLog(
        logger,
        "error",
        "[engine] subscription authorization failed",
        error,
      );
      return false;
    }
    if (clients.get(clientId) !== client) return false;

    if (client.subscriptions.has(group)) return true;
    if (client.subscriptions.size >= limits.maxSubscriptionsPerClient) {
      return false;
    }

    let members = groups.get(group);
    if (!members) groups.set(group, (members = new Set()));
    members.add(clientId);
    client.subscriptions.add(group);
    return true;
  }

  function unsubscribe(clientId, group) {
    const client = clients.get(clientId);
    if (!client || !client.subscriptions.delete(group)) return false;
    const members = groups.get(group);
    members?.delete(clientId);
    if (members?.size === 0) groups.delete(group);
    return true;
  }

  function publish(group, payload, filter) {
    const members = groups.get(group);
    return members ? sendToClients(members, payload, filter) : 0;
  }

  function startHeartbeat() {
    if (heartbeatTimer || heartbeat.heartbeatIntervalMs <= 0) return;
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, c] of clients) {
        if (now - c.lastPong > heartbeat.staleThresholdMs) {
          try {
            c.ws.terminate();
          } catch {}
          remove(id);
        } else {
          try {
            c.ws.ping();
          } catch {
            remove(id);
          }
        }
      }
    }, heartbeat.heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function closeAll() {
    for (const c of [...clients.values()]) {
      try {
        c.ws.close(1001, "server shutdown");
      } catch {}
      remove(c.id);
    }
    stopHeartbeat();
  }

  function drain(timeoutMs = DEFAULT_TIMEOUTS.shutdownDrainMs) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("drain timeout must be a non-negative integer");
    }
    stopHeartbeat();
    const snapshot = [...clients.values()];
    if (snapshot.length === 0) return Promise.resolve();

    return new Promise((resolve) => {
      const pending = new Map();
      let timer = null;
      const finish = (clientId) => {
        const entry = pending.get(clientId);
        if (!entry) return;
        pending.delete(clientId);
        entry.ws.off("close", entry.onClose);
        remove(clientId);
        if (pending.size === 0) {
          if (timer) clearTimeout(timer);
          resolve();
        }
      };

      for (const client of snapshot) {
        const onClose = () => finish(client.id);
        pending.set(client.id, { ws: client.ws, onClose });
        client.ws.once("close", onClose);
        try {
          client.ws.close(1001, "server shutdown");
        } catch {
          try {
            client.ws.terminate();
          } catch {}
          finish(client.id);
        }
      }
      if (pending.size === 0) {
        resolve();
        return;
      }
      timer = setTimeout(() => {
        for (const [clientId, entry] of [...pending]) {
          try {
            entry.ws.terminate();
          } catch {}
          finish(clientId);
        }
      }, timeoutMs);
    });
  }

  return {
    add,
    remove,
    get,
    size,
    sendTo,
    broadcast,
    subscribe,
    unsubscribe,
    publish,
    startHeartbeat,
    stopHeartbeat,
    closeAll,
    drain,
  };
}

export { createConnectionManager };
