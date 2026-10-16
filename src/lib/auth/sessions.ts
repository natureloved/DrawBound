import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
  /** Epoch this token was minted in; tokens older than the current epoch are revoked. */
  epoch: number;
}

const sessions = new Map<string, Session>();

// Expired entries are only dropped lazily today (on the next presentation of the
// same token), so an attacker who creates many sessions and never reuses them
// could grow the map without bound. A periodic sweep caps that.
const MAX_SESSIONS = 10_000;
let lastSweepAt = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

// Revocation has to survive the stateless path. `getSession` deliberately
// re-admits a token whose HMAC still verifies when the in-memory map misses
// (multi-container serverless deployments), and that same fallback silently
// re-admitted REVOKED tokens — so `POST /api/wallet/disconnect` had no effect
// on a token that had ever left this process. Tokens therefore carry the epoch
// they were minted in; revoking a token advances the epoch, and every token
// from an older epoch is refused everywhere, including the HMAC fallback.
// Consequence to keep in mind: one revocation invalidates all other live
// sessions. That is the correct trade for a self-custodial vault app (the
// browser reconnects automatically with its stored keypair), and it is far
// better than a disconnect that does not disconnect.
let sessionEpoch = 0;

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

const SESSION_SECRET =
  process.env.ADMIN_TOKEN?.trim() ||
  process.env.SESSION_SECRET?.trim() ||
  "drawbound-session-v1-secret-key-fallback";

function signToken(session: Omit<Session, "token">): string {
  const payload = JSON.stringify([
    session.vaultRef,
    session.positionId,
    session.publicKey,
    session.createdAt,
    session.expiresAt,
    session.ownershipVerified ? 1 : 0,
    session.ownershipAddress || "",
    session.epoch,
    randomBytes(12).toString("hex"),
  ]);
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  const hmac = createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  return `${b64}.${hmac}`;
}

function verifyToken(token: string): Session | undefined {
  const dot = token.indexOf(".");
  if (dot === -1) return undefined;
  const b64 = token.slice(0, dot);
  const hmac = token.slice(dot + 1);
  const expectedHmac = createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  if (!safeEqual(hmac, expectedHmac)) return undefined;

  try {
    const raw = Buffer.from(b64, "base64url").toString("utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length < 9) return undefined;
    const [vaultRef, positionId, publicKey, createdAt, expiresAt, ownershipVerified, ownershipAddress, epoch] = arr;
    const now = Date.now();
    if (typeof expiresAt !== "number" || expiresAt <= now) return undefined;
    // A revoked token must not be resurrected by the stateless fallback: its
    // epoch is older than the current one, so it is refused here too.
    if (typeof epoch !== "number" || epoch < sessionEpoch) return undefined;

    return {
      token,
      vaultRef: String(vaultRef),
      positionId: String(positionId),
      publicKey: String(publicKey),
      createdAt: Number(createdAt),
      expiresAt: Number(expiresAt),
      ownershipVerified: Boolean(ownershipVerified),
      ...(ownershipAddress ? { ownershipAddress: String(ownershipAddress) } : {}),
      epoch: Number(epoch),
    };
  } catch {
    return undefined;
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
  const sessionBase = {
    vaultRef: input.vaultRef,
    positionId: input.positionId,
    publicKey: input.publicKey.toLowerCase(),
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? env.sessionTtlMs()),
    ownershipVerified: Boolean(input.ownershipVerified),
    epoch: sessionEpoch,
    ...(input.ownershipVerified && input.ownershipAddress ? { ownershipAddress: input.ownershipAddress } : {}),
  };
  const token = signToken(sessionBase);
  const session: Session = { ...sessionBase, token };
  sessions.set(session.token, session);
  sweepExpiredSessions(now);
  return session;
}

export function getSession(token: string | null | undefined): Session | undefined {
  if (!token) return undefined;
  let session = sessions.get(token);
  if (!session) {
    // Stateless fallback: verify HMAC for requests hitting different serverless containers
    session = verifyToken(token);
    if (session) {
      sessions.set(token, session);
    }
  }
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  // Defence in depth: the map path must honour the epoch too, in case a revoked
  // token was still cached here from before the revocation.
  if (session.epoch < sessionEpoch) {
    sessions.delete(token);
    return undefined;
  }
  return session;
}

export function revokeSession(token: string | null | undefined): boolean {
  if (!token) return false;
  const deleted = sessions.delete(token);
  // Advance the epoch so the stateless HMAC fallback cannot re-admit this token
  // (or any other token minted before now). Deleting from the map alone was not
  // enough: `getSession` re-cached any HMAC-valid token on its next presentation.
  sessionEpoch += 1;
  for (const [cached, session] of sessions) {
    if (session.epoch < sessionEpoch) sessions.delete(cached);
  }
  return deleted;
}

/** Number of live sessions (for /api/health). */
export function sessionCount(): number {
  return sessions.size;
}

/** Test helper: drop every session. Also resets the revocation epoch. */
export function clearSessions(): void {
  sessions.clear();
  sessionEpoch = 0;
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
