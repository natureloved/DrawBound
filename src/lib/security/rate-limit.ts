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

/**
 * Drop keys whose bucket is entirely outside the current window. Runs on EVERY
 * call, not only when a request is rejected, so a flood of distinct
 * under-the-limit identities cannot grow the map without bound.
 */
function sweepExpired(windowStart: number): void {
  for (const [key, hits] of buckets) {
    if (hits.every((t) => t <= windowStart)) buckets.delete(key);
  }
}

export function rateLimit(
  key: string,
  options: { max?: number; windowMs?: number; now?: number } = {},
): RateLimitResult {
  const max = options.max ?? env.rateLimitMax();
  const windowMs = options.windowMs ?? env.rateLimitWindowMs();
  const now = options.now ?? Date.now();
  const windowStart = now - windowMs;

  const filtered = (buckets.get(key) ?? []).filter((t) => t > windowStart);

  if (buckets.size > MAX_TRACKED_KEYS) sweepExpired(windowStart);

  if (filtered.length >= max) {
    // Bucket map must never grow without bound under hostile traffic either.
    if (buckets.size > MAX_TRACKED_KEYS) sweepExpired(windowStart);
    const oldest = filtered[0] ?? now;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
  }

  filtered.push(now);
  buckets.set(key, filtered);
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Best-effort client identity for rate limiting (never used for auth).
 *
 * `x-forwarded-for` / `x-real-ip` are client-supplied unless a proxy you control
 * overwrites them, so they are honored ONLY when TRUSTED_PROXY_HOPS is set to the
 * number of proxy hops in front of this app. Without that, the key falls back to
 * a single shared bucket — rate limiting degrades, but cannot be defeated by
 * rotating a header, which is the failure mode that matters: an attacker who can
 * pick their own bucket key has no rate limit at all.
 */
export function clientIp(request: Request): string {
  const hops = env.trustedProxyHops();
  if (hops <= 0) return "client";

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const chain = forwarded.split(",").map((entry) => entry.trim()).filter(Boolean);
    // The left-most untrusted entry is the client; the trusted proxy depth
    // strips the hops appended by infrastructure we control.
    const index = Math.max(0, chain.length - hops);
    return chain[index]!;
  }
  return request.headers.get("x-real-ip") ?? "client";
}

/** Test helper. */
export function clearRateLimits(): void {
  buckets.clear();
}
