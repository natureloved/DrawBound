import { NextResponse } from "next/server";
import { readTachiSnapshot } from "@/lib/tachi/read-only";
import { connectVault, getPosition, positionIdForVault } from "@/lib/store";
import { fetchLiveLoanHealthProof } from "@/lib/proofs/oracle-client";
import { isLiveMode } from "@/lib/tachi";
import { createSession } from "@/lib/auth/sessions";
import { badRequest, forbidden, guardRateLimit, readJsonBody } from "@/app/api/_lib/http";
import { isHex } from "@/lib/wallet/canonical";
import { env } from "@/lib/config/env";

export const dynamic = "force-dynamic";

/**
 * Connect a self-custodial vault and open an authenticated session.
 *
 * Body: { vaultRef: string, sessionPublicKey: string (32-byte x-only hex) }
 *
 * The browser generates an ephemeral Schnorr keypair, keeps the private key,
 * and registers the public key here. Every later draw/repay/unlock must carry
 * the returned session token plus a signature by that key. Connecting an
 * already-known vault RESTORES its position (debt, receipts) instead of
 * resetting it.
 *
 * Honesty note: connecting proves control of the browser key, not ownership of
 * the vault. Vault ownership is enforced at the chain level in live mode, where
 * the credit transition must be a Taurus-signed transaction for that vault.
 */
export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const vaultRef = typeof body.vaultRef === "string" ? body.vaultRef.trim() : "";
  if (vaultRef.length <= 4 || vaultRef.length > 200 || /[\u0000-\u0020\u007f]/.test(vaultRef)) {
    return badRequest("Invalid vault reference");
  }
  const sessionPublicKey = typeof body.sessionPublicKey === "string" ? body.sessionPublicKey.trim().toLowerCase() : "";
  if (!isHex(sessionPublicKey, 32)) {
    return badRequest("sessionPublicKey must be a 32-byte x-only Schnorr public key (64 hex chars)");
  }

  // Live mode enforces ALLOWED_VAULT_REFS; mirror the adapter gate so connect fails closed too.
  if (isLiveMode()) {
    const allowed = env.allowedVaultRefs();
    if (allowed.length > 0 && !allowed.includes(vaultRef)) {
      return forbidden("Vault is not in ALLOWED_VAULT_REFS; refusing connection");
    }
  }

  // Best-effort real read of the operator's vault collateral via the Tachi SDK.
  let lockedSats: number | undefined;
  let liveReadOk = false;
  try {
    const snapshot = await readTachiSnapshot({ vaultAddress: vaultRef });
    lockedSats = snapshot.vault?.lockedSats;
    liveReadOk = Boolean(snapshot.vault);
  } catch {
    liveReadOk = false;
  }

  // Debt-aware proof bound to this vault's position (restore-safe: reflects existing debt).
  const positionId = positionIdForVault(vaultRef);
  const existing = await getPosition(positionId);
  const modeledCollateral = lockedSats && lockedSats > 0 ? lockedSats : (existing?.collateralSats ?? 5000);
  const liveProof = await fetchLiveLoanHealthProof({
    vaultRef,
    positionId,
    network: env.network(),
    debtUnits: existing?.debtUnits ?? 0,
    collateralSats: modeledCollateral,
  });

  const position = await connectVault(vaultRef, lockedSats ?? 0, liveProof);
  const session = createSession({ vaultRef, positionId: position.id, publicKey: sessionPublicKey });

  return NextResponse.json(
    {
      ok: true,
      vaultRef,
      liveReadOk,
      lockedSats: lockedSats ?? null,
      restored: Boolean(existing),
      proofSource: liveProof.source ?? (isLiveMode() ? "live-hat-oracle" : "live-tachi-read"),
      position,
      sessionToken: session.token,
      sessionExpiresAt: new Date(session.expiresAt).toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
