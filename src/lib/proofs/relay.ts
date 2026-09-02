import { createHash } from "node:crypto";
import type { CreditPosition, HealthAttestationV1, LoanHealthProof } from "../domain/types";
import { verifyNormalizedProof } from "./verify";

export function createFixtureAttestation(proof: LoanHealthProof, position: CreditPosition): HealthAttestationV1 {
  if (!verifyNormalizedProof(proof)) throw new Error("Cannot attest an invalid proof");
  const nonce = String(position.nonce + 1);
  const payload = `${proof.digest}:${position.id}:${nonce}`;
  return {
    schema: "drawbound.health.v1",
    network: proof.network,
    positionId: position.id,
    vaultRef: position.vaultRef,
    covenantVersion: proof.covenantVersion,
    healthBps: proof.healthBps,
    observedAt: proof.observedAt,
    expiresAt: proof.expiresAt,
    proofDigest: proof.digest,
    verifier: "fixture-relay-v1",
    verifierSignature: createHash("sha256").update(payload).digest("hex"),
    nonce,
  };
}
