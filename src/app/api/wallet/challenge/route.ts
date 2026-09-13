import { NextResponse } from "next/server";
import { issueOwnershipChallenge } from "@/lib/auth/ownership";
import { badRequest, guardRateLimit, readJsonBody } from "@/app/api/_lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/wallet/challenge — request a single-use BIP-322 ownership challenge.
 *
 * Body: { vaultRef: string }
 * Returns { challenge, nonce, expiresAt }. The operator signs `challenge` with
 * the vault user key (BIP-322 simple signature) and presents nonce + signature
 * + ownership address on /api/wallet/connect.
 */
export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const vaultRef = typeof body.vaultRef === "string" ? body.vaultRef.trim() : "";
  if (vaultRef.length <= 4 || vaultRef.length > 200 || /[\u0000-\u0020\u007f]/.test(vaultRef)) {
    return badRequest("Invalid vault reference");
  }

  const issued = issueOwnershipChallenge(vaultRef);
  return NextResponse.json(issued, { headers: { "cache-control": "no-store" } });
}
