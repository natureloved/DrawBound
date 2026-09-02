import type { TachiAdapter } from "./adapter";

export class FixtureTachiAdapter implements TachiAdapter {
  private sequence = 0;

  async createVault(input: { owner: string; collateralSats: number }) {
    return { vaultRef: `vault:taurus:signet:${input.owner}:${input.collateralSats}` };
  }

  async getVaultState(vaultRef: string) {
    return { collateralSats: vaultRef.includes("drawbound-demo") ? 5000 : 0, exitStatus: "LOCKED" };
  }

  async submitCreditTransition(input: { positionId: string; action: "DRAW" | "REPAY" | "UNLOCK"; amount: number; proofDigest?: string }) {
    this.sequence += 1;
    const suffix = input.proofDigest?.slice(0, 12) ?? "no-proof";
    return { transitionRef: `satvm:fixture:${input.action.toLowerCase()}:${this.sequence}:${suffix}` };
  }
}
