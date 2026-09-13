import { randomBytes, timingSafeEqual } from "node:crypto";
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
}

const sessions = new Map<string, Session>();

export function createSession(input: {
  vaultRef: string;
  positionId: string;
  publicKey: string;
  ttlMs?: number;
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
  };
  sessions.set(session.token, session);
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

/** Extract the session token from a request (header first, then JSON body field). */
export function sessionTokenFromRequest(request: Request, body?: { sessionToken?: unknown }): string | undefined {
  const header = request.headers.get(SESSION_HEADER);
  if (header) return header;
  if (body && typeof body.sessionToken === "string") return body.sessionToken;
  return undefined;
}

/** Constant-time token comparison helper for admin token checks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
