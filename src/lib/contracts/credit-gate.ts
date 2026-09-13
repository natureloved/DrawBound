import { evaluateDraw } from "../domain/covenant";
import type { CreditPosition, LoanHealthProof } from "../domain/types";

/**
 * Transport-neutral DRAW gate: the same covenant result feeds native, relay,
 * fixture, and live writes. `expectedNonce` (the nonce presented and signed by
 * the caller) must match the position's current nonce or the draw fails closed.
 */
export function creditGate(
  position: CreditPosition,
  proof: LoanHealthProof | undefined,
  requestedAmount: number,
  expectedNonce?: number,
) {
  return evaluateDraw({ position, proof, requestedAmount, expectedNonce });
}
