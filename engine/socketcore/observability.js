function safeErrorDetails(error) {
  const details = {};
  if (error && typeof error.name === "string") details.name = error.name;
  if (
    error &&
    (typeof error.code === "string" || typeof error.code === "number")
  ) {
    details.code = error.code;
  }
  return details;
}

function safeLog(logger, level, message, error) {
  try {
    const log = logger?.[level];
    if (typeof log !== "function") return;
    const result =
      error === undefined
        ? log.call(logger, message)
        : log.call(logger, message, safeErrorDetails(error));
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {}
}

function createMetrics(metrics = {}, logger = console) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new TypeError("metrics must be an object");
  }
  const methods = ["increment", "gauge", "observe"];
  for (const method of methods) {
    if (
      metrics[method] !== undefined &&
      typeof metrics[method] !== "function"
    ) {
      throw new TypeError(`metrics.${method} must be a function`);
    }
  }

  function emit(method, name, value, attributes) {
    const callback = metrics[method];
    if (!callback) return;
    try {
      const result = callback.call(metrics, name, value, attributes);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {
          safeLog(logger, "warn", "[engine] metrics callback failed");
        });
      }
    } catch {
      safeLog(logger, "warn", "[engine] metrics callback failed");
    }
  }

  return {
    enabled: methods.some((method) => typeof metrics[method] === "function"),
    increment(name, value = 1, attributes) {
      emit("increment", name, value, attributes);
    },
    gauge(name, value, attributes) {
      emit("gauge", name, value, attributes);
    },
    observe(name, value, attributes) {
      emit("observe", name, value, attributes);
    },
  };
}

export { createMetrics, safeErrorDetails, safeLog };
