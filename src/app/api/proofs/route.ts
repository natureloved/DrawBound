import { NextResponse } from "next/server";
import { fixtureProof } from "@/lib/proofs/fixtures";
import { normalizeProof } from "@/lib/proofs/normalize";
import { verifyNormalizedProof } from "@/lib/proofs/verify";
import { fetchLiveLoanHealthProof } from "@/lib/proofs/oracle-client";
import { getPosition, setProof } from "@/lib/store";
import { isLiveMode } from "@/lib/tachi";

const kinds = ["healthy", "unhealthy", "stale", "invalid"] as const;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const current = getPosition();

  let proof;
  if (body.proof) {
    proof = normalizeProof(body.proof);
  } else if (isLiveMode() || body.live === true) {
    proof = await fetchLiveLoanHealthProof({
      vaultRef: current.vaultRef,
      positionId: current.id,
      network: process.env.TACHI_NETWORK,
      debtUnits: current.debtUnits,
      collateralSats: current.collateralSats,
    });
  } else {
    const kind = kinds.includes(body.kind) ? body.kind : "healthy";
    proof = fixtureProof(kind, { positionId: current.id, collateralRef: current.vaultRef });
  }

  if (!verifyNormalizedProof(proof)) {
    return NextResponse.json({ error: "Proof verification failed", proof }, { status: 422 });
  }

  setProof(proof);
  return NextResponse.json({
    proof,
    source: isLiveMode() ? "live-hat-oracle" : "official-proof-fixture",
    mode: isLiveMode() ? "LIVE" : "FIXTURE",
  });
}
