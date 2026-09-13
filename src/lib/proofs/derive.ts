import type { CreditPosition, LoanHealthProof } from "../domain/types";
import { normalizeProof } from "./normalize";
import { collateralSatsPerUnit } from "../domain/covenant";
import { env } from "../config/env";

/** Ceiling for the reported health factor (650% = "very over-collateralized, no draw pressure"). */
export const MAX_HEALTH_BPS = 65000;

/**
 * Derives a HAT/RIP-shaped loan-health attestation from the position's own known
 * state. This is a SERVER-DERIVED attestation (source: "derived"), not an
 * independently signed oracle statement:
 * - `collateralSats` is the collateral captured from a live vault read at
 *   connect/refresh (or the modeled fallback when no on-chain balance exists);
 * - `debtUnits` is the position's current drawn debt.
 *
 * The health ratio is collateral sats over debt obligation sats in basis points
 * (10000 bps = 100%); at the credit limit the obligation equals 100% of
 * collateral. Deployments that must not trust the server's own computation
 * should configure PROOF_RELAY_PUBLIC_KEYS (strict mode) or HAT_ORACLE_URL,
 * which replaces derived attestations with independently signed ones.
 */
export function deriveHealthProof(
  position: Pick<CreditPosition, "id" | "vaultRef" | "collateralSats" | "debtUnits">,
  opts: {
    network?: string;
    now?: Date;
    verification?: LoanHealthProof["verification"];
    source?: LoanHealthProof["source"];
  } = {},
): LoanHealthProof {
  const network = opts.network ?? env.network();
  const now = opts.now ?? new Date();
  const collateralSats = position.collateralSats > 0 ? position.collateralSats : 5000;
  const obligationSats = position.debtUnits * collateralSatsPerUnit();
  const healthBps =
    obligationSats > 0
      ? Math.min(MAX_HEALTH_BPS, Math.floor((collateralSats / obligationSats) * 10000))
      : MAX_HEALTH_BPS;
  const maxAgeMs = env.proofMaxAgeSeconds() * 1000;
  return normalizeProof({
    positionId: position.id,
    network,
    collateralRef: position.vaultRef,
    covenantVersion: "drawbound-v1",
    healthBps,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Math.min(maxAgeMs, 300_000) - 60_000).toISOString(),
    verification: opts.verification ?? "VERIFIED",
    source: opts.source ?? "derived",
  });
}
