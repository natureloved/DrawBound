import type { TachiAdapter } from "./adapter";

export class DisabledLiveTachiAdapter implements TachiAdapter {
  async createVault(): Promise<{ vaultRef: string }> { throw new Error("Live Tachi writes are disabled; use fixture mode"); }
  async getVaultState(): Promise<{ collateralSats: number; exitStatus: string }> { throw new Error("Live Tachi reads are unverified"); }
  async submitCreditTransition(): Promise<{ transitionRef: string }> { throw new Error("Live Tachi writes are disabled; use fixture mode"); }
}
