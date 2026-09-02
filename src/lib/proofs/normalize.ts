import { createHash } from "node:crypto";
import type { LoanHealthProof } from "../domain/types";

function digestEnvelope(envelope: Omit<LoanHealthProof, "digest" | "verification">): string {
  const canonical = JSON.stringify({
    positionId: envelope.positionId,
    network: envelope.network,
    collateralRef: envelope.collateralRef,
    covenantVersion: envelope.covenantVersion,
    healthBps: envelope.healthBps,
    observedAt: envelope.observedAt,
    expiresAt: envelope.expiresAt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function normalizeProof(raw: unknown): LoanHealthProof {
  if (!raw || typeof raw !== "object") throw new Error("Proof must be an object");
  const value = raw as Partial<LoanHealthProof>;
  const envelope = {
    positionId: String(value.positionId ?? ""),
    network: String(value.network ?? ""),
    collateralRef: String(value.collateralRef ?? ""),
    covenantVersion: String(value.covenantVersion ?? ""),
    healthBps: Number(value.healthBps),
    observedAt: String(value.observedAt ?? ""),
    expiresAt: String(value.expiresAt ?? ""),
  };
  if (!envelope.positionId || !envelope.network || !Number.isFinite(envelope.healthBps)) throw new Error("Proof envelope is incomplete");
  return {
    ...envelope,
    digest: digestEnvelope(envelope),
    verification: value.verification === "INVALID" ? "INVALID" : "VERIFIED",
  };
}

export function proofDigest(proof: LoanHealthProof): string {
  return digestEnvelope(proof);
}
