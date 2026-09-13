import { describe, expect, it, beforeEach } from "vitest";
import { rateLimit, clearRateLimits } from "@/lib/security/rate-limit";

describe("sliding-window rate limiter", () => {
  beforeEach(() => clearRateLimits());

  it("allows requests under the limit and blocks over it", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      expect(rateLimit("ip-1", { max: 5, windowMs: 1000, now: now + i }).allowed).toBe(true);
    }
    const blocked = rateLimit("ip-1", { max: 5, windowMs: 1000, now: now + 10 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("scopes limits per key", () => {
    const now = 2_000_000;
    expect(rateLimit("ip-a", { max: 1, windowMs: 1000, now }).allowed).toBe(true);
    expect(rateLimit("ip-a", { max: 1, windowMs: 1000, now: now + 1 }).allowed).toBe(false);
    expect(rateLimit("ip-b", { max: 1, windowMs: 1000, now: now + 2 }).allowed).toBe(true);
  });

  it("re-allows after the window slides past the oldest hit", () => {
    const now = 3_000_000;
    expect(rateLimit("ip-2", { max: 1, windowMs: 1000, now }).allowed).toBe(true);
    expect(rateLimit("ip-2", { max: 1, windowMs: 1000, now: now + 999 }).allowed).toBe(false);
    expect(rateLimit("ip-2", { max: 1, windowMs: 1000, now: now + 1001 }).allowed).toBe(true);
  });
});
