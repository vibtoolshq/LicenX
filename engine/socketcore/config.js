const DEFAULT_LIMITS = Object.freeze({
  maxConnections: 10000,
  maxPendingUpgrades: 256,
  maxMessagesPerSecond: 100,
  maxConcurrentMessagesPerClient: 32,
  maxGlobalConcurrentMessages: 1024,
  maxPayloadBytes: 64 * 1024,
  maxBufferedBytes: 1024 * 1024,
  maxSubscriptionsPerClient: 100,
  maxGroupNameLength: 128,
  maxGlobalMessagesPerSecond: 500,
  maxTotalBufferedBytes: 64 * 1024 * 1024,
});

const DEFAULT_HEARTBEAT = Object.freeze({
  heartbeatIntervalMs: 30000,
  staleThresholdMs: 45000,
});

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUTS = Object.freeze({
  originCheckMs: 5000,
  authenticateMs: 5000,
  shutdownDrainMs: 10000,
  metricsIntervalMs: 10000,
});

function resolveOptions(name, defaults, overrides, isValid, expected) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError(`${name} must be an object`);
  }

  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new TypeError(`unknown ${name} option "${key}"`);
    }
  }

  const resolved = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(resolved)) {
    if (!isValid(value)) {
      throw new TypeError(`${name}.${key} must be ${expected}`);
    }
  }
  return resolved;
}

function resolveLimits(overrides = {}) {
  return resolveOptions(
    "limits",
    DEFAULT_LIMITS,
    overrides,
    (value) => value === Infinity || (Number.isInteger(value) && value >= 1),
    "a positive integer or Infinity",
  );
}

function resolveHeartbeat(overrides = {}) {
  return resolveOptions(
    "heartbeat",
    DEFAULT_HEARTBEAT,
    overrides,
    (value) => Number.isInteger(value) && value >= 0,
    "a non-negative integer",
  );
}

function resolveTimeouts(overrides = {}) {
  return resolveOptions(
    "timeouts",
    DEFAULT_TIMEOUTS,
    overrides,
    (value) => Number.isInteger(value) && value >= 1,
    "a positive integer",
  );
}

export {
  DEFAULT_HEARTBEAT,
  DEFAULT_LIMITS,
  DEFAULT_PORT,
  DEFAULT_TIMEOUTS,
  resolveHeartbeat,
  resolveLimits,
  resolveTimeouts,
};
