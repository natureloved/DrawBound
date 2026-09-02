import type { ProofAdapter } from "./adapter";
import type { LoanHealthProof } from "../domain/types";
import { normalizeProof } from "./normalize";
import { verifyNormalizedProof } from "./verify";

export const fixtureProofAdapter: ProofAdapter = {
  async normalize(raw: unknown) { return normalizeProof(raw); },
  async verify(proof: LoanHealthProof) { return verifyNormalizedProof(proof); },
};
