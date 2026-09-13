export interface TachiAdapter {
  createVault(input: { owner: string; collateralSats: number }): Promise<{ vaultRef: string }>;
  getVaultState(vaultRef: string): Promise<{ collateralSats: number; exitStatus: string }>;
  submitCreditTransition(input: {
    positionId: string;
    action: "DRAW" | "REPAY" | "UNLOCK";
    amount: number;
    proofDigest?: string;
    /** Required for a live (non-fixture) credit transition: a signed txHex built via the Taurus wallet. */
    txHex?: string;
  }): Promise<{ transitionRef: string }>;
}
