import { createMetrics, safeLog } from "./observability.js";

function createMessageRouter({
  logger = console,
  metrics: metricsOption = {},
} = {}) {
  const handlers = new Map();
  const metrics = createMetrics(metricsOption, logger);

  function register(type, handler) {
    if (typeof handler !== "function")
      throw new Error(`handler for "${type}" must be a function`);
    handlers.set(type, handler);
    return () => handlers.delete(type);
  }

  async function dispatch(ctx, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return ctx.reply({
        type: "error",
        code: "BAD_JSON",
        message: "invalid JSON payload",
      });
    }
    if (!msg || typeof msg.type !== "string") {
      return ctx.reply({
        type: "error",
        code: "BAD_MESSAGE",
        message: 'missing "type"',
      });
    }
    const handler = handlers.get(msg.type);
    if (!handler) {
      return ctx.reply({
        type: "error",
        code: "UNKNOWN_TYPE",
        message: `no handler for "${msg.type}"`,
      });
    }
    try {
      await handler(ctx, msg);
    } catch (err) {
      metrics.increment("ws.messages.handler_failures");
      safeLog(logger, "error", `[router] handler "${msg.type}" failed`, err);
      ctx.reply({
        type: "error",
        code: "HANDLER_FAILED",
        message: "internal error",
      });
    }
  }

  return { register, dispatch, handlers };
}

export { createMessageRouter };
