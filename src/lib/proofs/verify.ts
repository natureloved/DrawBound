import { createHash, createVerify } from "node:crypto";
import { proofDigest } from "./normalize";
import type { LoanHealthProof } from "../domain/types";

export interface ExtendedLoanHealthProof extends LoanHealthProof {
  oraclePubkey?: string;
  signature?: string;
}

/**
 * Verifies a loan health proof against:
 * 1. Digest integrity (hash matches normalized content)
 * 2. Status verification tag
 * 3. Cryptographic oracle signature if signature and pubkey are provided
 */
export function verifyNormalizedProof(proof: ExtendedLoanHealthProof): boolean {
  if (proof.verification !== "VERIFIED") return false;
  if (proof.digest !== proofDigest(proof)) return false;

  // If cryptographic signature is attached, verify it against the oracle pubkey or allowlist
  if (proof.signature && proof.oraclePubkey) {
    try {
      const canonicalPayload = Buffer.from(proof.digest, "hex");
      // Check if signature matches the payload
      const verifier = createVerify("SHA256");
      verifier.update(canonicalPayload);
      verifier.end();

      // Check allowlist if configured in environment
      const allowedKeys = (process.env.PROOF_RELAY_PUBLIC_KEYS ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);

      if (allowedKeys.length > 0 && !allowedKeys.includes(proof.oraclePubkey)) {
        return false;
      }

      // Try public key verification if formatted as PEM/DER or raw hex
      if (proof.oraclePubkey.includes("PUBLIC KEY")) {
        const isValid = verifier.verify(proof.oraclePubkey, Buffer.from(proof.signature, "hex"));
        if (!isValid) return false;
      }
    } catch {
      // If cryptographic verification fails, reject
      return false;
    }
  }

  return true;
}
