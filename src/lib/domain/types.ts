export type CreditState =
  | "EMPTY"
  | "COLLATERALIZED"
  | "CREDIT_OPEN"
  | "ACTIVE"
  | "FROZEN"
  | "REPAID"
  | "UNLOCKABLE"
  | "EXITED";

export type ExitStatus = "UNKNOWN" | "LOCKED" | "COUNTDOWN" | "AVAILABLE" | "EXITED";
export type ProofVerification = "VERIFIED" | "INVALID" | "UNVERIFIED";

/** Where a loan-health proof came from; surfaced in receipts and API responses. */
export type ProofSource = "fixture" | "derived" | "oracle";

export interface LoanHealthProof {
  positionId: string;
  network: string;
  collateralRef: string;
  covenantVersion: string;
  healthBps: number;
  observedAt: string;
  expiresAt: string;
  digest: string;
  verification: ProofVerification;
  /** Provenance of the attestation. Unsigned derived/fixture proofs are labeled as such. */
  source?: ProofSource;
  /** Optional BIP-340 Schnorr signature over the 32-byte digest (hex). */
  signature?: string;
  /** X-only public key (32-byte hex) of the oracle/relay that signed the digest. */
  oraclePubkey?: string;
}

export interface CreditPosition {
  id: string;
  vaultRef: string;
  collateralSats: number;
  debtUnits: number;
  creditLimitUnits: number;
  minHealthBps: number;
  state: CreditState;
  latestProof?: LoanHealthProof;
  exitStatus: ExitStatus;
  drawCount: number;
  nonce: number;
}

export type Action = "DRAW" | "REPAY" | "UNLOCK";

export interface DecisionReceipt {
  id: string;
  positionId: string;
  action: Action;
  requestedAmount: number;
  proofDigest?: string;
  previousState: CreditState;
  result: "ALLOW" | "DENY";
  reason: string;
  resultingState: CreditState;
  transitionRef?: string;
  createdAt: string;
  receiptDigest: string;
}

export interface HealthAttestationV1 {
  schema: "drawbound.health.v1";
  network: string;
  positionId: string;
  vaultRef: string;
  covenantVersion: string;
  healthBps: number;
  observedAt: string;
  expiresAt: string;
  proofDigest: string;
  verifier: string;
  verifierSignature: string;
  nonce: string;
}
