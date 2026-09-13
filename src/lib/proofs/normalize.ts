import { createHash } from "node:crypto";
import type { LoanHealthProof, ProofSource, ProofVerification } from "../domain/types";

function digestEnvelope(envelope: Omit<LoanHealthProof, "digest" | "verification" | "source" | "signature" | "oraclePubkey">): string {
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

const SOURCES: ProofSource[] = ["fixture", "derived", "oracle"];
const VERIFICATIONS: ProofVerification[] = ["VERIFIED", "INVALID", "UNVERIFIED"];

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

  const verification = VERIFICATIONS.includes(value.verification as ProofVerification)
    ? (value.verification as ProofVerification)
    : "UNVERIFIED";

  return {
    ...envelope,
    digest: digestEnvelope(envelope),
    verification,
    // Provenance and any attached oracle signature are PRESERVED (the digest
    // covers the envelope only; verifyNormalizedProof checks the signature
    // against the digest bytes).
    ...(SOURCES.includes(value.source as ProofSource) ? { source: value.source } : {}),
    ...(optionalString(value.signature) ? { signature: optionalString(value.signature) } : {}),
    ...(optionalString(value.oraclePubkey) ? { oraclePubkey: optionalString(value.oraclePubkey) } : {}),
  };
}

export function proofDigest(proof: LoanHealthProof): string {
  return digestEnvelope(proof);
}
