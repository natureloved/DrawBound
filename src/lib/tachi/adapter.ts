import type { LiveVaultRead } from "./live-adapter";

/**
 * What a transition actually did on chain, as reported by the adapter.
 *
 * Fixture mode supplies `transitionRef` alone. Live mode additionally reports the
 * daemon hash and whether the daemon confirmed the commit, so a receipt can say
 * "committed in epoch N" instead of "we POSTed something and the promise resolved".
 */
export interface TachiTransitionReceipt {
  transitionRef: string;
  /** Daemon-reported transaction hash. Absent means "not observed on chain". */
  txHash?: string;
  /** True only when the daemon reported the transaction committed. */
  confirmed?: boolean;
  status?: "committed" | "rejected" | "unconfirmed";
  epoch?: number;
  blockHash?: string;
  /** Chain id the daemon attested, recorded so a receipt names its network. */
  chainId?: string;
  /** Daemon log for a rejection. */
  daemonLog?: string;
}

export interface TachiAdapter {
  createVault(input: { owner: string; collateralSats: number }): Promise<{ vaultRef: string }>;
  getVaultState(vaultRef: string): Promise<{ collateralSats: number; exitStatus: string }>;
  submitCreditTransition(input: {
    positionId: string;
    action: "DRAW" | "REPAY" | "UNLOCK";
    amount: number;
    proofDigest?: string;
    /** Required for a live transition: a signed txHex built with the Taurus tooling. */
    txHex?: string;
    /**
     * The vault the transition moves value for. Live mode requires it: the
     * allowlist and the network binding are meaningless without it.
     */
    vaultRef?: string;
  }): Promise<TachiTransitionReceipt>;
  /**
   * Live adapters expose the underlying chain read (counts, attestation, whether
   * the vault is funded) so callers can distinguish an empty vault from a failed
   * read instead of treating both as zero collateral.
   */
  readVault?(vaultRef: string): Promise<LiveVaultRead>;
}
