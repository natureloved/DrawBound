import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/config/env";
import { isHex } from "@/lib/wallet/canonical";

/**
 * Server-side session registry.
 *
 * A session is created by `/api/wallet/connect` and binds:
 *   - an opaque random token (sent back to the browser, presented on every action),
 *   - the connected vault ref and its position id,
 *   - the browser's ephemeral Schnorr PUBLIC key.
 *
 * Every state-changing request must present the token AND a Schnorr signature,
 * over the canonical transition message, made with the matching private key.
 * The private key never reaches the server.
 *
 * Honesty note: this authenticates the browser session that connected the vault;
 * it does not prove on-chain ownership of the vault (that would require a
 * signature from the vault key itself — the Taurus-signed txHex in live mode).
 * Sessions live in process memory; a server restart invalidates them and the
 * browser reconnects automatically with its stored keypair.
 */

export interface Session {
  token: string;
  vaultRef: string;
  positionId: string;
  publicKey: string;
  createdAt: number;
  expiresAt: number;
  /** True when a valid BIP-322 ownership proof was presented at connect. */
  ownershipVerified: boolean;
  /** The key-path P2TR address that signed the ownership proof (when verified). */
  ownershipAddress?: string;
}

const sessions = new Map<string, Session>();

// Expired entries are only dropped lazily today (on the next presentation of the
// same token), so an attacker who creates many sessions and never reuses them
// could grow the map without bound. A periodic sweep caps that.
const MAX_SESSIONS = 10_000;
let lastSweepAt = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function sweepExpiredSessions(now = Date.now()): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  // Hard cap: a session flood must not exhaust memory.
  if (sessions.size > MAX_SESSIONS) {
    const ordered = [...sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [token] of ordered.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(token);
  }
}

export function createSession(input: {
  vaultRef: string;
  positionId: string;
  publicKey: string;
  ttlMs?: number;
  ownershipVerified?: boolean;
  ownershipAddress?: string;
}): Session {
  if (!isHex(input.publicKey, 32)) {
    throw new Error("Session public key must be a 32-byte x-only hex key");
  }
  const now = Date.now();
  const session: Session = {
    token: randomBytes(32).toString("hex"),
    vaultRef: input.vaultRef,
    positionId: input.positionId,
    publicKey: input.publicKey.toLowerCase(),
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? env.sessionTtlMs()),
    ownershipVerified: Boolean(input.ownershipVerified),
    ...(input.ownershipVerified && input.ownershipAddress ? { ownershipAddress: input.ownershipAddress } : {}),
  };
  sessions.set(session.token, session);
  sweepExpiredSessions(now);
  return session;
}

export function getSession(token: string | null | undefined): Session | undefined {
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return session;
}

export function revokeSession(token: string | null | undefined): boolean {
  if (!token) return false;
  return sessions.delete(token);
}

/** Number of live sessions (for /api/health). */
export function sessionCount(): number {
  return sessions.size;
}

/** Test helper: drop every session. */
export function clearSessions(): void {
  sessions.clear();
}

export const SESSION_HEADER = "x-drawbound-session";

/**
 * Extract the session token from a request.
 *
 * HEADER ONLY. The body field is deliberately not accepted: a body-borne bearer
 * token is exactly the shape a cross-site form/fetch can auto-submit, so it
 * turns any authenticated route into a CSRF target. Browsers do not send custom
 * headers cross-origin without an explicit CORS preflight, so the header form is
 * a structural CSRF defense.
 */
export function sessionTokenFromRequest(request: Request, _body?: { sessionToken?: unknown }): string | undefined {
  return request.headers.get(SESSION_HEADER) ?? undefined;
}

/**
 * Constant-time token comparison helper for admin token checks.
 *
 * A length mismatch must not short-circuit: leaking the token's length through
 * timing helps an attacker narrow a brute-force search. Both sides are hashed to
 * a fixed width first, so the compare itself always runs over equal lengths.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = createHash("sha256").update(a, "utf8").digest();
  const bufB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(bufA, bufB);
}
