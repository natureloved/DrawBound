import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { env } from "../config/env";
import { proofDigest } from "./normalize";
import type { LoanHealthProof } from "../domain/types";

/**
 * Loan-health proof verification.
 *
 * Layers, all fail-closed:
 * 1. The proof must carry the VERIFIED tag and its digest must match the
 *    canonical envelope hash (integrity).
 * 2. If a BIP-340 Schnorr signature is attached, it MUST verify against the
 *    attached x-only oracle pubkey over the 32-byte digest. A broken or forged
 *    signature rejects even in non-strict mode.
 * 3. STRICT MODE — when PROOF_RELAY_PUBLIC_KEYS is configured (recommended for
 *    any live deployment), an attached signature from an allowlisted oracle key
 *    is REQUIRED. Unsigned self-derived attestations are then rejected, which
 *    removes the server's ability to self-attest health.
 *
 * Note on (2): a well-formed signature from an UNKNOWN key only proves the
 * attestation was signed by *somebody* — use verifyProofSignature when the
 * oracle's identity must be allowlisted too.
 *
 * Without strict mode, unsigned "derived"/"fixture" proofs remain acceptable —
 * that is the documented testnet/demo trust model (see docs/threat-model.md):
 * the health ratio is computed by this server from its own live vault reads.
 */

function verifyDigestSignature(proof: LoanHealthProof): boolean {
  if (!proof.signature || !proof.oraclePubkey) return false;
  try {
    return schnorr.verify(hexToBytes(proof.signature), hexToBytes(proof.digest), hexToBytes(proof.oraclePubkey));
  } catch {
    return false;
  }
}

/**
 * True when the proof carries a valid oracle signature from an ALLOWLISTED key.
 *
 * With PROOF_RELAY_PUBLIC_KEYS unset this returns false rather than true for any
 * key: a signature from an arbitrary x-only pubkey previously passed
 * verification, so a forged oracle attestation from a key nobody vetted was
 * accepted as VERIFIED. An oracle is now trusted only when it is explicitly
 * allowlisted (strict mode).
 */
export function verifyProofSignature(proof: LoanHealthProof): boolean {
  if (!proof.signature || !proof.oraclePubkey) return false;
  if (!verifyDigestSignature(proof)) return false;
  const allowed = env.proofRelayPublicKeys();
  return allowed.length > 0 && allowed.includes((proof.oraclePubkey ?? "").toLowerCase());
}

export function verifyNormalizedProof(proof: LoanHealthProof): boolean {
  if (proof.verification !== "VERIFIED") return false;
  if (proof.digest !== proofDigest(proof)) return false;

  const hasSignature = Boolean(proof.signature && proof.oraclePubkey);
  if (hasSignature && !verifyDigestSignature(proof)) return false;

  const allowedKeys = env.proofRelayPublicKeys();
  if (allowedKeys.length > 0) {
    // Strict mode: only allowlisted, signed attestations pass.
    if (!hasSignature) return false;
    return allowedKeys.includes((proof.oraclePubkey ?? "").toLowerCase());
  }

  return true;
}
