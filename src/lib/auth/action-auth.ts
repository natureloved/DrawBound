import type { NextResponse } from "next/server";
import { badRequest, forbidden, resolveSession, unauthorized } from "@/app/api/_lib/http";
import type { Session } from "@/lib/auth/sessions";
import { getPosition } from "@/lib/store";
import type { Action, CreditPosition } from "@/lib/domain/types";
import { canonicalTransitionMessage, verifyCanonical } from "@/lib/wallet/canonical";

/**
 * Authenticates a state-changing credit action.
 *
 * The caller must present:
 *   - a valid session token (from /api/wallet/connect),
 *   - a BIP-340 Schnorr signature, by the session's browser-held private key,
 *     over the canonical message
 *       DrawBound:v1:<positionId>:<vaultRef>:<action>:<amount>:<nonce>,
 *   - the position's CURRENT nonce.
 *
 * Because the signature covers positionId, vaultRef, action, amount, and nonce,
 * a captured signature cannot be replayed for a different action/amount, and a
 * stale nonce is rejected (replay fails closed). The private key never reaches
 * the server; only the session public key registered at connect time.
 */

export interface AuthenticatedAction {
  session: Session;
  position: CreditPosition;
  amount: number;
  nonce: number;
}

export type AuthResult =
  | { ok: true; value: AuthenticatedAction }
  | { ok: false; response: NextResponse };

function parseInteger(body: Record<string, unknown>, field: string): number | null {
  const raw = body[field];
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isInteger(value) ? value : null;
}

export async function authenticateAction(
  request: Request,
  body: Record<string, unknown>,
  action: Action,
): Promise<AuthResult> {
  const session = resolveSession(request, body);
  if (!session) return { ok: false, response: unauthorized("Missing or expired session; connect a wallet first") };

  const position = await getPosition(session.positionId);
  if (!position) return { ok: false, response: unauthorized("Session references an unknown position; reconnect") };

  const amount = parseInteger(body, "amount");
  if (amount === null) return { ok: false, response: badRequest("amount must be an integer") };
  const nonce = parseInteger(body, "nonce");
  if (nonce === null) return { ok: false, response: badRequest("nonce must be an integer") };

  // NOTE: the nonce is authenticated here (covered by the signature) but its
  // freshness against position state is checked by the route AFTER the
  // idempotency lookup, so a retried already-processed request returns the
  // original receipt instead of a confusing replay rejection.

  const signature = typeof body.signature === "string" ? body.signature : "";
  let message: string;
  try {
    message = canonicalTransitionMessage({
      positionId: position.id,
      vaultRef: position.vaultRef,
      action,
      amount,
      nonce,
    });
  } catch (error) {
    return { ok: false, response: badRequest(error instanceof Error ? error.message : "Invalid canonical message fields") };
  }

  if (!verifyCanonical(message, signature, session.publicKey)) {
    return { ok: false, response: forbidden("Session signature over the canonical transition message is invalid") };
  }

  return { ok: true, value: { session, position, amount, nonce } };
}
