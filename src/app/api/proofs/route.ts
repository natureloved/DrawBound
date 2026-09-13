import { NextResponse } from "next/server";
import { fixtureProof } from "@/lib/proofs/fixtures";
import { normalizeProof } from "@/lib/proofs/normalize";
import { verifyNormalizedProof } from "@/lib/proofs/verify";
import { fetchLiveLoanHealthProof } from "@/lib/proofs/oracle-client";
import { getPosition, setProof } from "@/lib/store";
import { isLiveMode } from "@/lib/tachi";
import { resolveSession, guardRateLimit, readJsonBody, unauthorized } from "@/app/api/_lib/http";
import { env } from "@/lib/config/env";

export const dynamic = "force-dynamic";

const kinds = ["healthy", "unhealthy", "stale", "invalid"] as const;

/**
 * POST /api/proofs — refresh the loan-health attestation for the SESSION's position.
 *
 * A session is required: proofs mutate position state, and the position is
 * resolved from the authenticated session (never from client-supplied ids).
 *
 * Modes:
 *   - live mode (or body.live): real chain read / configured HAT oracle.
 *   - fixture mode: body.kind selects a deterministic rehearsal proof
 *     (healthy | unhealthy | stale | invalid) bound to the session position.
 *   - body.proof: an externally supplied envelope; normalized and verified.
 *     In strict mode (PROOF_RELAY_PUBLIC_KEYS set) it must carry a valid
 *     allowlisted Schnorr signature or verification fails (422).
 */
export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const session = resolveSession(request, body);
  if (!session) return unauthorized("Missing or expired session; connect a wallet first");
  const current = await getPosition(session.positionId);
  if (!current) return unauthorized("Session references an unknown position; reconnect");

  let proof;
  if (body.proof) {
    proof = normalizeProof(body.proof);
  } else if (isLiveMode() || body.live === true) {
    proof = await fetchLiveLoanHealthProof({
      vaultRef: current.vaultRef,
      positionId: current.id,
      network: env.network(),
      debtUnits: current.debtUnits,
      collateralSats: current.collateralSats,
    });
  } else {
    const kind = kinds.includes(body.kind as (typeof kinds)[number]) ? (body.kind as (typeof kinds)[number]) : "healthy";
    proof = fixtureProof(kind, { positionId: current.id, collateralRef: current.vaultRef });
  }

  if (!verifyNormalizedProof(proof)) {
    return NextResponse.json({ error: "Proof verification failed", proof }, { status: 422 });
  }

  await setProof(current.id, proof);
  return NextResponse.json({
    proof,
    source: proof.source ?? (isLiveMode() ? "live-hat-oracle" : "official-proof-fixture"),
    mode: isLiveMode() ? "LIVE" : "FIXTURE",
  });
}
