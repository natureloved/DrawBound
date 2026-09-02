import { evaluateDraw } from "../domain/covenant";
import type { CreditPosition, LoanHealthProof } from "../domain/types";

export function creditGate(position: CreditPosition, proof: LoanHealthProof | undefined, requestedAmount: number) {
  // This function is intentionally transport-neutral: the same result feeds native, relay, and fixture writes.
  return evaluateDraw({ position, proof, requestedAmount });
}
