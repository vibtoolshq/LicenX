/** Minimal backend-only integration: each protected action revalidates membership. */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkLicenseMembership, normalizeLicenseKey, allowedApiOrigin } from "./licenxClient.mjs";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_RATE = 10;
const MAX_CLIENTS = 1000;
const MAX_BODY = 1024;

function respond(res, status, body, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Credentials": "false",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function createLimiter(max = DEFAULT_RATE, windowMs = DEFAULT_WINDOW_MS) {
  const clients = new Map();
  return (ip, now = Date.now()) => {
    let previous = clients.get(ip);
    if (!previous && clients.size >= MAX_CLIENTS) {
      for (const [id, record] of clients) if (now - record.start >= windowMs) clients.delete(id);
      if (clients.size >= MAX_CLIENTS) return false;
    }
    if (!previous || now - previous.start >= windowMs || now < previous.start) {
      previous = { start: now, used: 0 };
      clients.set(ip, previous);
    }
    previous.used++;
    return previous.used <= max;
  };
}

async function readSmallBody(req) {
  const rawLength = Number(req.headers["content-length"] || 0);
  if (!Number.isFinite(rawLength) || rawLength > MAX_BODY) throw new Error("TOO_LARGE");
  const data = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("TOO_LARGE");
    data.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(data).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new Error("INVALID_JSON"); }
}

export function createToolServer({
  apiBaseUrl, consumerToken, toolOrigin,
  fetchImpl = fetch,
  now = () => Date.now(),
  rateMax = DEFAULT_RATE,
} = {}) {
  const allowedToolOrigin = allowedApiOrigin(toolOrigin);
  const limiter = createLimiter(rateMax);
  const ready = Boolean(allowedToolOrigin && allowedApiOrigin(apiBaseUrl) && /^vcon_sec_[a-f0-9]{48}$/.test(consumerToken || ""));
  return createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === "/health" && req.method === "GET") return respond(res, ready ? 200 : 503, { status: ready ? "ok" : "not_ready" });
    if (pathname !== "/tool/run") return respond(res, 404, { code: "NOT_FOUND" });
    if (req.method !== "POST") return respond(res, 405, { code: "METHOD_NOT_ALLOWED" }, { Allow: "POST" });
    if (!ready) return respond(res, 503, { code: "NOT_CONFIGURED" });
    const declaredOrigin = req.headers.origin;
    if (declaredOrigin && declaredOrigin !== allowedToolOrigin) return respond(res, 403, { code: "ORIGIN_DENIED" });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
      return respond(res, 415, { code: "UNSUPPORTED_MEDIA_TYPE" });
    }
    const source = req.socket.remoteAddress || "unknown"; // Never use caller-supplied X-Forwarded-For.
    if (!limiter(source, now())) return respond(res, 429, { code: "RATE_LIMITED" }, { "Retry-After": "60" });
    let input;
    try { input = await readSmallBody(req); }
    catch (error) { return respond(res, error.message === "TOO_LARGE" ? 413 : 400, { code: "INVALID_REQUEST" }); }
    const key = normalizeLicenseKey(input.license_key);
    if (!key) return respond(res, 400, { code: "INVALID_REQUEST" });
    const result = await checkLicenseMembership({ apiBaseUrl, consumerToken, licenseKey: key, fetchImpl, now: now() });
    if (!result.allowed) {
      if (result.code === "RATE_LIMITED") return respond(res, 429, { code: "RATE_LIMITED" }, { "Retry-After": String(result.retryAfter) });
      if (result.code === "LICENSE_NOT_VALID") return respond(res, 403, { code: "LICENSE_NOT_VALID" });
      return respond(res, 503, { code: "VALIDATOR_UNAVAILABLE" });
    }
    // Replace this non-sensitive placeholder with your own backend-only free tool action.
    return respond(res, 200, { success: true, result: { message: "Authorized sample tool action" } });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const toolServer = createToolServer({
    apiBaseUrl: process.env.LICENX_API_BASE_URL,
    consumerToken: process.env.LICENX_CONSUMER_TOKEN,
    toolOrigin: process.env.TOOL_PUBLIC_ORIGIN,
  });
  const port = Number(process.env.PORT || 3001);
  toolServer.listen(port, "127.0.0.1", () => console.info("[Restricted tool] listening on 127.0.0.1:" + port));
}
