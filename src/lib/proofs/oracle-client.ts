import type { LoanHealthProof } from "../domain/types";
import { normalizeProof } from "./normalize";
import { readTachiSnapshot } from "../tachi/read-only";
import { deriveHealthProof } from "./derive";
import { env } from "../config/env";
import { TachiLiveError } from "../tachi/errors";

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
 * Upper bound on a health ratio. Derived health is documented as capped at 650%,
 * so an oracle asserting a value above this is malformed (or manipulating the
 * gate) rather than merely optimistic.
 */
const MAX_HEALTH_BPS = 65_000;

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
        //
        // The response is also bound to what was ASKED: an oracle answering for a
        // different vault, position or network is confused or malicious, and
        // healthBps is bounded so one cannot simply assert perfect health.
        if (
          proof.positionId !== request.positionId ||
          proof.collateralRef !== request.vaultRef ||
          proof.network !== network ||
          !Number.isFinite(proof.healthBps) ||
          proof.healthBps < 0 ||
          proof.healthBps > MAX_HEALTH_BPS ||
          Number.isNaN(new Date(proof.expiresAt).getTime())
        ) {
          throw new Error("Oracle attestation is not bound to the requested position/network, or is out of range");
        }
        return proof;
      }
      console.warn(`[oracle] Remote oracle returned ${response.status}; falling back to Tachi node reading`);
    } catch (err) {
      console.warn("[oracle] Remote oracle request failed, falling back to Tachi node reading:", err);
    }
  }

  try {
    const snapshot = await readTachiSnapshot({
      network: network === "regtest" || network === "mainnet" ? network : "signet",
      vaultAddress: request.vaultRef,
    });

    // The chain the read came from must be the chain this deployment is gating on.
    // The daemon's own answer outranks our configuration: if it reports a
    // different chain id, every number below describes some other network.
    if (env.liveEnabled() && !snapshot.binding.matched) {
      throw new TachiLiveError(`Refusing to gate a live decision on ${snapshot.baseUrl}: ${snapshot.binding.detail}`, {
        code: "ATTESTATION",
      });
    }

    const observed = snapshot.vault?.lockedSats ?? 0;

    // Live mode collateral is exactly what the daemon reports — including 0.
    // Falling back to modeled collateral here is how a draw gets priced against
    // sats that are not in the vault.
    if (env.liveEnabled()) {
      if (snapshot.vault && !snapshot.vault.readComplete) {
        throw new TachiLiveError(`Live collateral read unusable: ${snapshot.vault.reason}`, { code: "CHAIN_READ" });
      }
      return deriveHealthProof(
        { id: request.positionId, vaultRef: request.vaultRef, collateralSats: observed, debtUnits: request.debtUnits ?? 0 },
        { network },
      );
    }

    // Fixture mode: a funded real vault still wins over the modeled number, so the
    // demo and a rehearsal vault against a live read both report a consistent ratio.
    const lockedSats = observed > 0 ? observed : (request.collateralSats ?? 5000);
    return deriveHealthProof(
      { id: request.positionId, vaultRef: request.vaultRef, collateralSats: lockedSats, debtUnits: request.debtUnits ?? 0 },
      { network },
    );
  } catch (error) {
    // In live mode a failed read is a denial, not a fallback: rethrow so the route
    // records the reason. LIVE_REQUIRE_CHAIN_READ=false restores the old behavior
    // for an operator who deliberately wants to decide on modeled collateral.
    if (env.liveEnabled() && env.liveRequiresChainRead()) throw error;
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
