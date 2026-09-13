import type { CreditPosition, LoanHealthProof } from "./types";
import { policy } from "../security/policy";

export interface CovenantInput {
  position: CreditPosition;
  proof?: LoanHealthProof;
  requestedAmount: number;
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
 * Collateral sats backing one credit unit in the prototype's risk model.
 * 5000 sats collateral <-> 500 unit credit limit (calculateCreditLimit), i.e. 1 unit = 10 sats.
 * Shared by the credit-limit calculator and the live health-proof verifier so the
 * reported loan-health ratio stays consistent with the drawable limit.
 */
export const COLLATERAL_SATS_PER_UNIT = 10;

/**
 * Calculates dynamic credit limit based on collateral sats (e.g. 10% in units, 70% LTV equivalent)
 */
export function calculateCreditLimit(collateralSats: number): number {
  if (!collateralSats || collateralSats <= 0) return 0;
  // Default: 1 unit per 10 sats (up to 70% collateralization ratio)
  return Math.max(100, Math.floor(collateralSats / COLLATERAL_SATS_PER_UNIT));
}

export function evaluateDraw({
  position,
  proof,
  requestedAmount,
  now = new Date(),
  expectedNetwork = policy.network || "signet",
  expectedCovenantVersion = "drawbound-v1",
}: CovenantInput): CovenantDecision {
  const deny = (reason: string): CovenantDecision => ({ allowed: false, reason, resultingState: "FROZEN" });
  
  if (position.state === "EXITED") return deny("Position has exited");
  if (requestedAmount <= 0 || !Number.isInteger(requestedAmount)) return deny("Amount must be a positive whole unit");
  
  // Guard maximum draws if configured
  if (policy.maxDrawsPerPosition && position.drawCount >= policy.maxDrawsPerPosition) {
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
