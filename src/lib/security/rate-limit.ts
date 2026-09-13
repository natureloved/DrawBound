import { env } from "@/lib/config/env";

/**
 * Minimal in-memory sliding-window rate limiter for API routes.
 *
 * Single-process scope: it protects one Node instance (the deployment unit for
 * the JSON-store configuration). Multi-instance deployments should front this
 * with an edge limiter or swap in a shared store; the interface stays the same.
 */

const buckets = new Map<string, number[]>();
const MAX_TRACKED_KEYS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  options: { max?: number; windowMs?: number; now?: number } = {},
): RateLimitResult {
  const max = options.max ?? env.rateLimitMax();
  const windowMs = options.windowMs ?? env.rateLimitWindowMs();
  const now = options.now ?? Date.now();
  const windowStart = now - windowMs;

  const hits = (buckets.get(key) ?? []).filter((t) => t > windowStart);
  if (hits.length >= max) {
    // Bucket map must never grow without bound under hostile traffic.
    if (buckets.size > MAX_TRACKED_KEYS) {
      for (const [k, v] of buckets) {
        if (v.length === 0 || v.every((t) => t <= windowStart)) buckets.delete(k);
      }
    }
    const oldest = hits[0] ?? now;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true, retryAfterSec: 0 };
}

/** Best-effort client identity for rate limiting (never used for auth). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "local";
}

/** Test helper. */
export function clearRateLimits(): void {
  buckets.clear();
}
