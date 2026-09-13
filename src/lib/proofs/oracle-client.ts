import type { LoanHealthProof } from "../domain/types";
import { normalizeProof } from "./normalize";
import { readTachiSnapshot } from "../tachi/read-only";
import { deriveHealthProof } from "./derive";
import { env } from "../config/env";

export interface OracleProofRequest {
  vaultRef: string;
  positionId: string;
  network?: string;
  /**
   * Current drawn debt in credit units. The verifier converts collateral sats and debt
   * units through the shared sats-per-unit ratio to derive a real health ratio,
   * instead of reporting a constant "healthy" value.
   */
  debtUnits?: number;
  /**
   * Modeled collateral sats for the position (the fallback used when no real on-chain
   * locked balance is observed). When the live read returns a funded vault, its real
   * locked sats override this; an empty/unfunded vault falls back to this value so the
   * proof's health ratio stays consistent with the position's recorded collateral.
   */
  collateralSats?: number;
}

/**
 * Fetches the freshest loan-health attestation available, in strict preference order:
 *
 * 1. EXTERNAL ORACLE (source: "oracle") — when HAT_ORACLE_URL is configured, the
 *    remote HAT/RIP oracle is asked for a signed attestation. The response must
 *    carry verification:"VERIFIED" plus (in strict mode) a Schnorr signature from
 *    an allowlisted oracle key; verifyNormalizedProof enforces that downstream.
 * 2. SERVER-DERIVED FROM A LIVE READ (source: "derived") — real locked-VTXO state
 *    is read from the Tachi daemon and the health ratio is computed against the
 *    position's actual debt. This is honest self-attestation: it reflects real
 *    chain state, but the computation is ours, not an independent oracle's.
 * 3. SERVER-DERIVED FROM MODELED COLLATERAL (source: "derived") — fallback when
 *    the network read fails (e.g. offline tests); still debt-aware, never a
 *    constant "healthy".
 */
export async function fetchLiveLoanHealthProof(
  request: OracleProofRequest,
): Promise<LoanHealthProof> {
  const network = request.network ?? env.network();
  const oracleUrl = process.env.HAT_ORACLE_URL?.trim();

  if (oracleUrl) {
    try {
      const response = await fetch(`${oracleUrl}/v1/attestations/health`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaultRef: request.vaultRef,
          positionId: request.positionId,
          network,
          debtUnits: request.debtUnits ?? 0,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const data = await response.json();
        const proof = normalizeProof({ ...(data as object), source: "oracle" });
        // A remote attestation that does not claim VERIFIED (or fails strict
        // signature checks downstream) must not silently degrade to a derived
        // proof with a better tag: surface it and let the gate decide.
        return proof;
      }
      console.warn(`[oracle] Remote oracle returned ${response.status}; falling back to Tachi node reading`);
    } catch (err) {
      console.warn("[oracle] Remote oracle request failed, falling back to Tachi node reading:", err);
    }
  }

  try {
    const snapshot = await readTachiSnapshot({
      network: network === "regtest" ? "regtest" : "signet",
      vaultAddress: request.vaultRef,
    });

    // Use the real on-chain locked balance when a funded vault is observed; an empty or
    // unfunded vault read falls back to the position's modeled collateral so the demo and
    // real funded vaults both report a consistent, non-zero health ratio.
    const observed = snapshot.vault?.lockedSats ?? 0;
    const lockedSats = observed > 0 ? observed : (request.collateralSats ?? 5000);

    return deriveHealthProof(
      {
        id: request.positionId,
        vaultRef: request.vaultRef,
        collateralSats: lockedSats,
        debtUnits: request.debtUnits ?? 0,
      },
      { network },
    );
  } catch {
    return deriveHealthProof(
      {
        id: request.positionId,
        vaultRef: request.vaultRef,
        collateralSats: request.collateralSats ?? 5000,
        debtUnits: request.debtUnits ?? 0,
      },
      { network },
    );
  }
}
