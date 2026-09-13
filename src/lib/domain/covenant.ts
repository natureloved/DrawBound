import type { CreditPosition, LoanHealthProof } from "./types";
import { env } from "../config/env";

export interface CovenantInput {
  position: CreditPosition;
  proof?: LoanHealthProof;
  requestedAmount: number;
  /**
   * Nonce presented with the transition request. When supplied it MUST equal the
   * position's current nonce: a replayed or out-of-order request fails closed.
   */
  expectedNonce?: number;
  now?: Date;
  expectedNetwork?: string;
  expectedCovenantVersion?: string;
}

export interface CovenantDecision {
  allowed: boolean;
  reason: string;
  resultingState: CreditPosition["state"];
}

/**
 * Default collateral sats backing one credit unit in the prototype risk model
 * (5000 sats collateral <-> 500 unit credit limit, i.e. 1 unit = 10 sats).
 * Overridable per deployment via CREDIT_UNIT_SATS.
 */
export const DEFAULT_COLLATERAL_SATS_PER_UNIT = 10;

/** Live sats-per-credit-unit ratio shared by the credit-limit calculator and the health verifier. */
export function collateralSatsPerUnit(): number {
  return env.creditUnitSats();
}

/** @deprecated Use collateralSatsPerUnit(); kept as the default value. */
export const COLLATERAL_SATS_PER_UNIT = DEFAULT_COLLATERAL_SATS_PER_UNIT;

/**
 * Calculates the dynamic credit limit from collateral sats at the configured
 * sats-per-unit ratio.
 */
export function calculateCreditLimit(collateralSats: number): number {
  if (!collateralSats || collateralSats <= 0) return 0;
  return Math.max(1, Math.floor(collateralSats / collateralSatsPerUnit()));
}

export function evaluateDraw({
  position,
  proof,
  requestedAmount,
  expectedNonce,
  now = new Date(),
  expectedNetwork = env.network(),
  expectedCovenantVersion = "drawbound-v1",
}: CovenantInput): CovenantDecision {
  const deny = (reason: string): CovenantDecision => ({ allowed: false, reason, resultingState: "FROZEN" });

  if (position.state === "EXITED") return deny("Position has exited");
  if (requestedAmount <= 0 || !Number.isInteger(requestedAmount)) return deny("Amount must be a positive whole unit");

  // Replay / out-of-order guard: the presented nonce must match the position state.
  if (expectedNonce !== undefined) {
    if (!Number.isInteger(expectedNonce) || expectedNonce < 0) return deny("Transition nonce must be a non-negative integer");
    if (expectedNonce !== position.nonce) return deny("Transition nonce does not match position state (stale or replayed request)");
  }

  const maxDraws = env.maxDrawsPerPosition();
  if (maxDraws && position.drawCount >= maxDraws) {
    return deny("Draw cap reached for this position");
  }

  const effectiveCreditLimit = position.creditLimitUnits || calculateCreditLimit(position.collateralSats);
  if (position.debtUnits + requestedAmount > effectiveCreditLimit) {
    return deny("Requested amount exceeds credit limit");
  }

  if (!proof) return deny("No loan-health proof supplied");
  if (proof.verification !== "VERIFIED") return deny("Proof is not verified");
  if (proof.positionId !== position.id) return deny("Proof is bound to another position");
  if (proof.collateralRef !== position.vaultRef) return deny("Proof is bound to another TAURUS vault");
  if (proof.network !== expectedNetwork) return deny("Proof network is not allowlisted");
  if (proof.covenantVersion !== expectedCovenantVersion) return deny("Covenant version mismatch");
  if (new Date(proof.expiresAt).getTime() <= now.getTime()) return deny("Proof is stale");
  if (proof.healthBps < position.minHealthBps) return deny("Loan health is below covenant threshold");

  return { allowed: true, reason: "Fresh verified proof satisfies covenant", resultingState: "ACTIVE" };
}
