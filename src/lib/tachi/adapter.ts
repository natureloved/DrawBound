export interface TachiAdapter {
  createVault(input: { owner: string; collateralSats: number }): Promise<{ vaultRef: string }>;
  getVaultState(vaultRef: string): Promise<{ collateralSats: number; exitStatus: string }>;
  submitCreditTransition(input: {
    positionId: string;
    action: "DRAW" | "REPAY" | "UNLOCK";
    amount: number;
    proofDigest?: string;
  }): Promise<{ transitionRef: string }>;
}
