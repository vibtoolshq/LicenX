/** Admin API license issuance input guards. Keep successful response schema unchanged. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isIntegerLike = (value: unknown, min: number): boolean =>
  (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= min;

/** Return a safe, public-facing error for malformed fields, or null for accepted requests. */
export function validateAdminLicenseCreation(body: unknown): string | null {
  if (!isRecord(body)) return "Invalid license request body";

  const strings: Record<string, number> = {
    key: 256, prefix: 64, tier: 128, app_id: 256, app_slug: 256,
    validity_type: 32, customer_name: 512, customer_email: 320, notes: 8192,
  };
  for (const [field, limit] of Object.entries(strings)) {
    const value = body[field];
    if (value !== undefined && value !== null &&
        (typeof value !== "string" || value.length > limit)) {
      return "Invalid " + field;
    }
  }
  if (body.prefix === null || body.tier === null || body.validity_type === null) {
    return "Invalid license request fields";
  }
  if (typeof body.key === "string" && body.key !== "" && !body.key.trim()) {
    return "Invalid key";
  }
  // Preserve legacy Unicode prefixes; only reject unsafe control characters.
  if (typeof body.prefix === "string" &&
      /[\u0000-\u001F\u007F]/.test(body.prefix)) return "Invalid prefix";
  if (body.validity_type !== undefined && body.validity_type !== null &&
      !["lifetime", "daily", "hourly"].includes(body.validity_type as string)) {
    return "Invalid validity_type";
  }
  if (body.device_limit !== undefined && body.device_limit !== null &&
      !isIntegerLike(body.device_limit, 1)) return "Invalid device_limit";
  if (body.validity_value !== undefined && body.validity_value !== null &&
      !isIntegerLike(body.validity_value, 0)) return "Invalid validity_value";
  if (body.expires_at !== undefined && body.expires_at !== null &&
      !isIntegerLike(body.expires_at, 0)) return "Invalid expires_at";
  return null;
}

/** Malformed %-encoding is a client error, not a server fault. */
export function decodeAdminLicensePathKey(raw: string): string | null {
  try {
    return decodeURIComponent(raw).trim().toUpperCase();
  } catch {
    return null;
  }
}
