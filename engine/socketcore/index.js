// SocketCore generic engine from vibtoolshq/SocketCore @ 55863d5; import/export adapted for LicenX ESM.
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { WebSocketServer } from "ws";
import {
  resolveHeartbeat,
  resolveLimits,
  resolveTimeouts,
} from "./config.js";
import { createConnectionManager } from "./connection-manager.js";
import { createMessageRouter } from "./message-router.js";
import { createMetrics, safeLog } from "./observability.js";

function resolveUpgradePath(path) {
  if (path === undefined) return null;
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new TypeError("path must be an absolute URL pathname");
  }

  try {
    const parsed = new URL(path, "http://localhost");
    if (
      parsed.origin !== "http://localhost" ||
      parsed.pathname !== path ||
      parsed.search ||
      parsed.hash
    ) {
      throw new TypeError("path must be an absolute URL pathname");
    }
  } catch {
    throw new TypeError("path must be an absolute URL pathname");
  }
  return path;
}

function createEngine({
  authenticate = /** @type {((req: import('node:http').IncomingMessage, options: { signal: AbortSignal }) => unknown) | undefined} */ (undefined),
  authorizeSubscription = async () => false,
  allowedOrigins = [],
  path = /** @type {string | undefined} */ (undefined),
  limits = {},
  heartbeat = {},
  timeouts = {},
  websocket = {},
  logger = console,
  metrics: metricsOption = {},
} = {}) {
  if (typeof authenticate !== "function") {
    throw new TypeError("authenticate callback is required");
  }
  if (typeof authorizeSubscription !== "function") {
    throw new TypeError("authorizeSubscription must be a function");
  }

  const config = resolveLimits(limits);
  const heartbeatConfig = resolveHeartbeat(heartbeat);
  const timeoutConfig = resolveTimeouts(timeouts);
  const upgradePath = resolveUpgradePath(path);
  const metrics = createMetrics(metricsOption, logger);

  const connectionManager = createConnectionManager({
    ...heartbeatConfig,
    maxConnections: config.maxConnections,
    maxBufferedBytes: config.maxBufferedBytes,
    maxTotalBufferedBytes: config.maxTotalBufferedBytes,
    maxSubscriptionsPerClient: config.maxSubscriptionsPerClient,
    maxGroupNameLength: config.maxGroupNameLength,
    authorizeSubscription,
    logger,
    metrics: metricsOption,
  });
  const messageRouter = createMessageRouter({ logger, metrics: metricsOption });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
    perMessageDeflate: websocket.perMessageDeflate ?? false,
  });
  let attachedServer = null;
  let pendingUpgrades = 0;
  const activeCallbacks = new Set();
  const activeHandlerControllers = new Set();
  let activeHandlerWork = 0;
  let stopped = false;
  let globalTokens = config.maxGlobalMessagesPerSecond;
  let globalLastRefill = Date.now();
  let stopPromise = null;
  let metricsTimer = null;
  let eventLoopDelayEnabled = false;
  const eventLoopDelay = metrics.enabled
    ? monitorEventLoopDelay({ resolution: 20 })
    : null;

  function sampleEventLoopDelay() {
    if (!eventLoopDelay) return;
    const meanMs = eventLoopDelay.mean / 1e6;
    if (Number.isFinite(meanMs))
      metrics.observe("ws.event_loop_lag_ms", meanMs);
    eventLoopDelay.reset();
  }

  function startMetrics() {
    if (!eventLoopDelay || metricsTimer) return;
    eventLoopDelay.enable();
    eventLoopDelayEnabled = true;
    metricsTimer = setInterval(
      sampleEventLoopDelay,
      timeoutConfig.metricsIntervalMs,
    );
    metricsTimer.unref?.();
  }

  function stopMetrics() {
    if (metricsTimer) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }
    if (eventLoopDelayEnabled) {
      sampleEventLoopDelay();
      eventLoopDelay.disable();
      eventLoopDelayEnabled = false;
    }
  }

  function withTimeout(callback, timeoutMs, callbackName) {
    const controller = new AbortController();
    activeCallbacks.add(controller);
    const providerWork = Promise.resolve().then(() =>
      callback(controller.signal),
    );
    const callbackWork = providerWork.then(
      (value) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return value;
      },
      (error) => {
        if (controller.signal.aborted) throw controller.signal.reason || error;
        throw error;
      },
    );
    const workSettled = providerWork.then(
      () => activeCallbacks.delete(controller),
      () => activeCallbacks.delete(controller),
    );
    let timer;
    let rejectAborted;
    const aborted = new Promise((_, reject) => {
      rejectAborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAborted, {
        once: true,
      });
    });
    const promise = Promise.race([callbackWork, aborted]).finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", rejectAborted);
    });
    timer = setTimeout(() => {
      const error = new Error(`${callbackName} timed out`);
      error.code = "CALLBACK_TIMEOUT";
      error.callbackName = callbackName;
      controller.abort(error);
    }, timeoutMs);

    return { promise, workSettled };
  }

  function abortActiveCallbacks() {
    const reason = new Error("engine stopped");
    reason.code = "ENGINE_STOPPED";
    for (const controller of activeCallbacks) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  function abortActiveHandlers() {
    const reason = new Error("engine stopped");
    reason.code = "ENGINE_STOPPED";
    for (const controller of activeHandlerControllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  function releasePendingUpgradeAfter(workSettled) {
    if (workSettled) {
      workSettled.then(() => {
        pendingUpgrades--;
      });
      return;
    }
    pendingUpgrades--;
  }

  function rejectUpgrade(socket, status, message) {
    metrics.increment("ws.upgrades.rejected", 1, { status });
    if (socket.destroyed) return;
    const body = `${message}\n`;
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }

  async function originAllowed(req, options) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (allowedOrigins === "*") return true;
    if (typeof allowedOrigins === "function") {
      return !!(await allowedOrigins(origin, req, options));
    }
    return Array.isArray(allowedOrigins) && allowedOrigins.includes(origin);
  }

  function detach() {
    if (!attachedServer) return;
    attachedServer.off("upgrade", handleUpgrade);
    attachedServer = null;
  }

  function attach(server) {
    if (stopped) throw new Error("engine has been stopped");
    if (attachedServer && attachedServer !== server) {
      throw new Error("engine is already attached to another server");
    }
    if (attachedServer) return () => detach();
    attachedServer = server;
    server.on("upgrade", handleUpgrade);
    return () => detach();
  }

  async function handleUpgrade(req, socket, head) {
    if (upgradePath) {
      try {
        if (new URL(req.url, "http://localhost").pathname !== upgradePath) {
          return;
        }
      } catch {
        return;
      }
    }
    socket.on("error", () => {});
    if (stopped) {
      return rejectUpgrade(socket, "503 Service Unavailable", "engine stopped");
    }
    if (pendingUpgrades >= config.maxPendingUpgrades) {
      return rejectUpgrade(socket, "503 Service Unavailable", "server busy");
    }
    pendingUpgrades++;
    let providerWorkSettled = null;

    try {
      let isOriginAllowed;
      try {
        const originCheck = withTimeout(
          (signal) => originAllowed(req, { signal }),
          timeoutConfig.originCheckMs,
          "origin check",
        );
        providerWorkSettled = originCheck.workSettled;
        isOriginAllowed = await originCheck.promise;
      } catch (error) {
        if (error?.code === "CALLBACK_TIMEOUT") {
          return rejectUpgrade(
            socket,
            "503 Service Unavailable",
            "origin check timed out",
          );
        }
        throw error;
      }
      if (!isOriginAllowed) {
        return rejectUpgrade(socket, "403 Forbidden", "origin not allowed");
      }
      if (stopped) {
        return rejectUpgrade(
          socket,
          "503 Service Unavailable",
          "engine stopped",
        );
      }

      let identity;
      try {
        const authentication = withTimeout(
          (signal) => authenticate(req, { signal }),
          timeoutConfig.authenticateMs,
          "authentication",
        );
        providerWorkSettled = authentication.workSettled;
        identity = await authentication.promise;
      } catch (error) {
        if (error?.code === "CALLBACK_TIMEOUT") {
          return rejectUpgrade(
            socket,
            "503 Service Unavailable",
            "authentication timed out",
          );
        }
        throw error;
      }
      if (stopped) {
        return rejectUpgrade(
          socket,
          "503 Service Unavailable",
          "engine stopped",
        );
      }
      if (
        !identity ||
        typeof identity !== "object" ||
        Array.isArray(identity)
      ) {
        return rejectUpgrade(
          socket,
          "401 Unauthorized",
          "authentication required",
        );
      }
      if (connectionManager.size() + pendingUpgrades > config.maxConnections) {
        return rejectUpgrade(
          socket,
          "503 Service Unavailable",
          "connection limit reached",
        );
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const clientId = crypto.randomUUID();
        const client = connectionManager.add(clientId, ws, identity);
        if (!client) {
          metrics.increment("ws.upgrades.rejected", 1, {
            reason: "connection_limit",
          });
          ws.close(1013, "connection limit reached");
          return;
        }
        metrics.increment("ws.upgrades.accepted");

        const handlerController = new AbortController();
        activeHandlerControllers.add(handlerController);
        const abortHandlerController = () => {
          if (!handlerController.signal.aborted) handlerController.abort();
          activeHandlerControllers.delete(handlerController);
        };
        ws.once("close", abortHandlerController);
        ws.once("error", abortHandlerController);
        const ctx = {
          clientId,
          identity,
          client,
          meta: identity,
          signal: handlerController.signal,
          reply: (payload) => connectionManager.sendTo(clientId, payload),
          subscribe: (group) =>
            connectionManager.subscribe(clientId, group, req),
          unsubscribe: (group) =>
            connectionManager.unsubscribe(clientId, group),
          publish: (group, payload) =>
            connectionManager.publish(group, payload),
        };

        connectionManager.sendTo(clientId, {
          type: "connected",
          clientId,
        });

        let tokens = config.maxMessagesPerSecond;
        let lastRefill = Date.now();
        let activeMessages = 0;
        ws.on("message", (raw) => {
          metrics.increment("ws.messages.in");
          const now = Date.now();
          tokens = Math.min(
            config.maxMessagesPerSecond,
            tokens + ((now - lastRefill) * config.maxMessagesPerSecond) / 1000,
          );
          lastRefill = now;
          if (tokens < 1) {
            metrics.increment("ws.messages.dropped", 1, {
              reason: "client_rate_limit",
            });
            ws.close(1008, "message rate limit exceeded");
            return;
          }
          if (activeMessages >= config.maxConcurrentMessagesPerClient) {
            metrics.increment("ws.messages.dropped", 1, {
              reason: "client_concurrency_limit",
            });
            ws.close(1013, "too many in-flight messages");
            return;
          }
          if (activeHandlerWork >= config.maxGlobalConcurrentMessages) {
            metrics.increment("ws.messages.dropped", 1, {
              reason: "global_concurrency_limit",
            });
            ws.close(1013, "server is busy");
            return;
          }
          if (config.maxGlobalMessagesPerSecond !== Infinity) {
            const globalNow = Date.now();
            globalTokens = Math.min(
              config.maxGlobalMessagesPerSecond,
              globalTokens +
                ((globalNow - globalLastRefill) *
                  config.maxGlobalMessagesPerSecond) /
                  1000,
            );
            globalLastRefill = globalNow;
            if (globalTokens < 1) {
              metrics.increment("ws.messages.dropped", 1, {
                reason: "global_rate_limit",
              });
              ws.close(1008, "global message rate limit exceeded");
              return;
            }
            globalTokens -= 1;
          }
          tokens -= 1;
          activeMessages++;
          activeHandlerWork++;
          messageRouter
            .dispatch(ctx, raw)
            .catch((error) => {
              metrics.increment("ws.messages.dispatch_failures");
              safeLog(logger, "error", "[engine] dispatch error", error);
            })
            .finally(() => {
              activeMessages--;
              activeHandlerWork--;
            });
        });
      });
    } catch (error) {
      safeLog(logger, "warn", "[engine] upgrade rejected", error);
      if (stopped) {
        rejectUpgrade(socket, "503 Service Unavailable", "engine stopped");
      } else if (error?.code === "CALLBACK_TIMEOUT") {
        rejectUpgrade(
          socket,
          "503 Service Unavailable",
          "upgrade callback timed out",
        );
      } else {
        rejectUpgrade(socket, "500 Internal Server Error", "connection failed");
      }
    } finally {
      releasePendingUpgradeAfter(providerWorkSettled);
    }
  }

  function register(type, handler) {
    return messageRouter.register(type, handler);
  }

  function start() {
    if (stopped) throw new Error("engine has been stopped");
    connectionManager.startHeartbeat();
    startMetrics();
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    detach();
    abortActiveCallbacks();
    abortActiveHandlers();
    stopMetrics();
    stopPromise = (async () => {
      await connectionManager.drain(timeoutConfig.shutdownDrainMs);
      await new Promise((resolve) => wss.close(() => resolve()));
    })();
    return stopPromise;
  }

  return {
    attach,
    register,
    start,
    stop,
    connectionManager,
    messageRouter,
  };
}

export { createEngine };
