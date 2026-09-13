import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { deriveHealthProof } from "./derive";
import { bytesToHex, isHex } from "../wallet/canonical";
import type { LoanHealthProof } from "../domain/types";

/**
 * Reference HAT/RIP oracle signing core.
 *
 * Computes the debt-aware health attestation (same ratio as DrawBound's derived
 * proofs) and SIGNS the 32-byte digest with an oracle-held BIP-340 key. The
 * resulting proof carries signature + oraclePubkey, so DrawBound deployments
 * running strict mode (PROOF_RELAY_PUBLIC_KEYS) accept it while refusing any
 * unsigned self-derived attestation.
 *
 * The private key lives ONLY in the oracle process (see scripts/hat-oracle.ts);
 * DrawBound verifies with the public key alone.
 */

export interface OracleAttestationRequest {
  vaultRef: string;
  positionId: string;
  network?: string;
  /** Drawn debt in credit units. */
  debtUnits?: number;
  /** Collateral sats observed from the chain read (or modeled fallback). */
  collateralSats: number;
}

export interface OracleKey {
  privateKeyHex: string;
}

export function oraclePublicKey(privateKeyHex: string): string {
  const clean = privateKeyHex.trim().toLowerCase().replace(/^0x/, "");
  if (!isHex(clean, 32)) throw new Error("Oracle private key must be 32-byte hex");
  return bytesToHex(schnorr.getPublicKey(hexToBytes(clean)));
}

/** Build and sign a strict-mode health attestation for a vault/position. */
export function buildSignedHealthAttestation(
  request: OracleAttestationRequest,
  oracle: OracleKey,
  now: Date = new Date(),
): LoanHealthProof {
  const privateKeyHex = oracle.privateKeyHex.trim().toLowerCase().replace(/^0x/, "");
  if (!isHex(privateKeyHex, 32)) throw new Error("Oracle private key must be 32-byte hex");

  const proof = deriveHealthProof(
    {
      id: request.positionId,
      vaultRef: request.vaultRef,
      collateralSats: request.collateralSats,
      debtUnits: request.debtUnits ?? 0,
    },
    { network: request.network, now, source: "oracle" },
  );

  const signature = bytesToHex(schnorr.sign(hexToBytes(proof.digest), hexToBytes(privateKeyHex)));
  return {
    ...proof,
    signature,
    oraclePubkey: oraclePublicKey(privateKeyHex),
  };
}
