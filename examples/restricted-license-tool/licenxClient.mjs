/** Backend-only client; never bundle this into public JavaScript. */
const TOKEN_RE = /^vcon_sec_[a-f0-9]{48}$/;
const KEY_RE = /^[A-Z0-9_-]{3,128}$/;

export function normalizeLicenseKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toUpperCase();
  return KEY_RE.test(key) ? key : null;
}

export function allowedApiOrigin(value) {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch { return null; }
}

async function boundedJson(response) {
  if (Number(response.headers.get("content-length") || 0) > 4096) return null;
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 4096) return null;
      chunks.push(part.value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
  finally { try { await reader.cancel(); } catch { /* already closed */ } }
}

/** Real-time revalidation on every gated action. Fail closed on any uncertain response. */
export async function checkLicenseMembership({
  apiBaseUrl, consumerToken, toolOrigin, licenseKey, fetchImpl = fetch, now = Date.now(),
} = {}) {
  const apiOrigin = allowedApiOrigin(apiBaseUrl);
  const key = normalizeLicenseKey(licenseKey);
  const approvedOrigin = allowedApiOrigin(toolOrigin);
  if (!approvedOrigin || !apiOrigin || !TOKEN_RE.test(consumerToken || "")) return { allowed: false, code: "NOT_CONFIGURED" };
  if (!key) return { allowed: false, code: "INVALID_LICENSE_KEY" };
  try {
    const response = await fetchImpl(apiOrigin + "/api/v1/public/license/check", {
      method: "POST",
      headers: { Authorization: "Bearer " + consumerToken, "X-LicenX-Tool-Origin": approvedOrigin, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ license_key: key }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
      cache: "no-store",
    });
    if (response.status === 429) {
      const value = Number(response.headers.get("retry-after"));
      return { allowed: false, code: "RATE_LIMITED", retryAfter: Number.isFinite(value) && value > 0 ? Math.min(900, Math.ceil(value)) : 60 };
    }
    if (response.status !== 200) return { allowed: false, code: "VALIDATOR_UNAVAILABLE" };
    const body = await boundedJson(response);
    if (body?.valid === false) return { allowed: false, code: "LICENSE_NOT_VALID" };
    if (!body || body.valid !== true || body.status !== "active" ||
        !Number.isSafeInteger(body.checked_at) || Math.abs(body.checked_at - now) > 120000 ||
        (body.expires_at !== null && (!Number.isSafeInteger(body.expires_at) || body.expires_at <= now))) {
      return { allowed: false, code: "VALIDATOR_UNAVAILABLE" };
    }
    return { allowed: true, code: "OK" };
  } catch { return { allowed: false, code: "VALIDATOR_UNAVAILABLE" }; }
}
