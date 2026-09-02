import type { LoanHealthProof } from "../domain/types";

export interface ProofAdapter {
  normalize(raw: unknown): Promise<LoanHealthProof>;
  verify(proof: LoanHealthProof): Promise<boolean>;
}
