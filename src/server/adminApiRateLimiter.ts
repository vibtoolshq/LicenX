/** Bounded, per-runtime Admin API request limiter (120 requests / 60s by default). */
export function createAdminApiRateLimiter(
  maxRequests = 120,
  windowMs = 60_000,
  maxClients = 4_096,
) {
  const entries = new Map<string, { count: number; windowStart: number }>();

  return {
    check(identity: string, now = Date.now()): boolean {
      const id = identity || "unknown";
      const current = entries.get(id);
      if (current && now - current.windowStart < windowMs && now >= current.windowStart) {
        if (current.count >= maxRequests) return false;
        current.count += 1;
        return true;
      }
      // Prune expired buckets before admitting new clients; never evict an active limit.
      if (!current && entries.size >= maxClients) {
        for (const [key, item] of entries) {
          if (now - item.windowStart >= windowMs || now < item.windowStart) entries.delete(key);
        }
        if (entries.size >= maxClients) return false;
      }
      entries.set(id, { count: 1, windowStart: now });
      return true;
    },
    /** Synthetic-test-only diagnostic; no mutation of shared state. */
    size(): number {
      return entries.size;
    },
  };
}
