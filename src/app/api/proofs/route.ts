import { NextResponse } from "next/server";
import { fixtureProof } from "@/lib/proofs/fixtures";
import { normalizeProof } from "@/lib/proofs/normalize";
import { verifyNormalizedProof } from "@/lib/proofs/verify";
import { getPosition, setProof } from "@/lib/store";

const kinds = ["healthy", "unhealthy", "stale", "invalid"] as const;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const kind = kinds.includes(body.kind) ? body.kind : "healthy";
  const current = getPosition();
  const proof = body.proof ? normalizeProof(body.proof) : fixtureProof(kind, { positionId: current.id, collateralRef: current.vaultRef });
  if (!verifyNormalizedProof(proof)) return NextResponse.json({ error: "Proof verification failed", proof }, { status: 422 });
  setProof(proof);
  return NextResponse.json({ proof, source: "official-proof-fixture", mode: "FIXTURE" });
}
