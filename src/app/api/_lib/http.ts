import { NextResponse } from "next/server";
import { getSession, safeEqual, sessionTokenFromRequest, type Session } from "@/lib/auth/sessions";
import { clientIp, rateLimit } from "@/lib/security/rate-limit";
import { env } from "@/lib/config/env";

export { sessionTokenFromRequest };

/**
 * Shared guards for API routes. Every state-changing route runs the same
 * fail-closed pipeline: rate limit -> session -> (admin where applicable).
 */

export function guardRateLimit(request: Request): NextResponse | null {
  const result = rateLimit(clientIp(request));
  if (!result.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfterSec: result.retryAfterSec },
      { status: 429, headers: { "retry-after": String(result.retryAfterSec) } },
    );
  }
  return null;
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Resolve the session for a request, or null (routes turn that into 401). */
export function resolveSession(request: Request, body?: Record<string, unknown>): Session | null {
  return getSession(sessionTokenFromRequest(request, body as { sessionToken?: unknown } | undefined)) ?? null;
}

export function unauthorized(detail: string): NextResponse {
  return NextResponse.json({ error: "Unauthorized", detail }, { status: 401 });
}

export function forbidden(detail: string): NextResponse {
  return NextResponse.json({ error: "Forbidden", detail }, { status: 403 });
}

export function badRequest(detail: string): NextResponse {
  return NextResponse.json({ error: "Bad request", detail }, { status: 400 });
}

/**
 * Nonce-freshness guard applied AFTER the idempotency lookup. A presented nonce
 * that is not the position's current nonce means a stale or replayed request;
 * it is rejected at the transport layer (409) without mutating covenant state.
 */
export function nonceConflict(presented: number, current: number): NextResponse | null {
  if (presented === current) return null;
  // Deliberately generic: echoing the position's current nonce would hand an
  // attacker the exact value needed to forge the next legitimate transition.
  return NextResponse.json(
    { error: "Stale or replayed request", detail: "The presented transition nonce is not current" },
    { status: 409 },
  );
}

/**
 * Admin gate for destructive/demo routes (reset, fixture position seeding).
 * - ADMIN_TOKEN set: header `x-admin-token` must match (constant-time).
 * - ADMIN_TOKEN unset: refused in every mode. A local/demo deployment may opt in
 *   with ALLOW_INSECURE_RESET=true, which is the only insecure escape hatch.
 */
export function requireAdmin(request: Request): NextResponse | null {
  const token = env.adminToken();
  const provided = request.headers.get("x-admin-token") ?? "";
  if (token) {
    if (!provided || !safeEqual(provided, token)) return forbidden("Valid x-admin-token required");
    return null;
  }
  // No token configured: destructive routes stay shut in every mode. A fixture
  // deployment may opt in with ALLOW_INSECURE_RESET=true (dev/demo convenience).
  if (!env.allowInsecureReset()) {
    return forbidden("Destructive routes require ADMIN_TOKEN (or ALLOW_INSECURE_RESET=true in a local demo)");
  }
  return null;
}

/** True when the request carries a valid admin token (used by connect restore). */
export function hasAdminToken(request: Request): boolean {
  const token = env.adminToken();
  const provided = request.headers.get("x-admin-token") ?? "";
  return Boolean(token && provided && safeEqual(provided, token));
}
