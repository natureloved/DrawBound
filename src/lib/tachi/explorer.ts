/**
 * Tachi Explorer links (Bitcoin Signet) — Requirement 2 of the Tachi
 * integration requirements (shared 2026-11-13, deadline 16 Nov 2026):
 * every transaction must trigger an in-app notification with a clickable
 * link to the transaction on the Tachi Explorer, verifiable on Signet.
 *
 * Base URL verified live 2026-11-13 against the executed draw
 * 20C3AA5830525D3FA959EB7F6259C98C01BFC0296A5C09EEFC114605736C1EDC
 * (type transfer, state committed, epoch 1717689).
 */

/** Signet explorer base URL (verified live 2026-11-13). */
export const TACHI_EXPLORER_BASE_URL = "https://signet.tachibtcscan.com";

/** Clickable explorer URL for a daemon transaction hash. */
export function explorerTxUrl(txHash: string): string {
  return `${TACHI_EXPLORER_BASE_URL}/tx/${txHash}`;
}

/**
 * Extract the daemon transaction hash from a receipt `transitionRef`.
 *
 * Live refs carry the real hash:
 * - committed: `satvm:live:<action>:<txHash>:<proofDigest-suffix>`
 * - pending:   `satvm:live:pending:<txHash>`
 *
 * Fixture refs (`satvm:fixture:...`) and anything else carry no real
 * transaction, so they return null and must never render an explorer link.
 */
const LIVE_TRANSITION_REF = /^satvm:live:(?:draw|repay|unlock|pending):([0-9a-fA-F]{64})(?::.*)?$/;

export function txHashFromTransitionRef(ref: string | undefined | null): string | null {
  if (!ref) return null;
  const match = LIVE_TRANSITION_REF.exec(ref);
  return match ? match[1].toLowerCase() : null;
}
