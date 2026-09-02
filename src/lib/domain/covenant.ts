import type { CreditPosition, LoanHealthProof } from "./types";

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

export function evaluateDraw({
  position,
  proof,
  requestedAmount,
  now = new Date(),
  expectedNetwork = "signet",
  expectedCovenantVersion = "drawbound-v1",
}: CovenantInput): CovenantDecision {
  const deny = (reason: string): CovenantDecision => ({ allowed: false, reason, resultingState: "FROZEN" });
  if (position.state === "EXITED") return deny("Position has exited");
  if (requestedAmount <= 0 || !Number.isInteger(requestedAmount)) return deny("Amount must be a positive whole unit");
  if (position.drawCount >= 3) return deny("Draw cap reached for this position");
  if (position.debtUnits + requestedAmount > position.creditLimitUnits) return deny("Requested amount exceeds credit limit");
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
