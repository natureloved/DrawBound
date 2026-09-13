import type { CreditPosition, LoanHealthProof } from "../domain/types";
import { normalizeProof } from "./normalize";
import { COLLATERAL_SATS_PER_UNIT } from "../domain/covenant";

/** Ceiling for the reported health factor (650% = "very over-collateralized, no draw pressure"). */
export const MAX_HEALTH_BPS = 65000;

/**
 * Derives a HAT/RIP loan-health attestation from the position's own known state:
 * - `collateralSats` is the collateral captured from a live vault read at connect/refresh
 *   (or the modeled fallback when the vault has no on-chain locked balance);
 * - `debtUnits` is the position's current drawn debt.
 *
 * Pure and local (no network), so the credit gate can always evaluate against a proof
 * that reflects the actual present debt rather than a stale snapshot minted earlier.
 * The loan-health ratio is collateral sats over debt obligation sats, in basis points
 * (10000 bps = 100%); at the credit limit the obligation equals 100% of collateral.
 */
export function deriveHealthProof(
  position: Pick<CreditPosition, "id" | "vaultRef" | "collateralSats" | "debtUnits">,
  opts: {
    network?: string;
    now?: Date;
    verification?: LoanHealthProof["verification"];
  } = {},
): LoanHealthProof {
  const network = opts.network ?? "signet";
  const now = opts.now ?? new Date();
  const collateralSats = position.collateralSats > 0 ? position.collateralSats : 5000;
  const obligationSats = position.debtUnits * COLLATERAL_SATS_PER_UNIT;
  const healthBps =
    obligationSats > 0
      ? Math.min(MAX_HEALTH_BPS, Math.floor((collateralSats / obligationSats) * 10000))
      : MAX_HEALTH_BPS;
  return normalizeProof({
    positionId: position.id,
    network,
    collateralRef: position.vaultRef,
    covenantVersion: "drawbound-v1",
    healthBps,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    verification: opts.verification ?? "VERIFIED",
  });
}
