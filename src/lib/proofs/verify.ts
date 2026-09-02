import { proofDigest } from "./normalize";
import type { LoanHealthProof } from "../domain/types";

export function verifyNormalizedProof(proof: LoanHealthProof): boolean {
  return proof.verification === "VERIFIED" && proof.digest === proofDigest(proof);
}
