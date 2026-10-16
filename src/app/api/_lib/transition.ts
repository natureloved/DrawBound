import { getTachiAdapter, isLiveMode } from "@/lib/tachi";
import { isTachiLiveError } from "@/lib/tachi/errors";
import type { TachiTransitionReceipt } from "@/lib/tachi/adapter";

/**
 * Shared live-transition submission for /api/draw, /api/repay and /api/unlock.
 *
 * Two things are decided here rather than in each route, because they must not
 * diverge between them:
 *
 * 1. **`vaultRef` is always passed.** The allowlist and the network binding are
 *    properties of the vault, and a transition that does not name its vault cannot
 *    be checked against either.
 *
 * 2. **An ambiguous broadcast is reported as `pending`, not as a plain failure.**
 *    "The daemon accepted the transaction but we did not observe it commit" is a
 *    different fact from "the daemon rejected it": the first may still become a
 *    real on-chain transition, so the caller must journal the hash and never
 *    re-broadcast the same transition blindly. A rejection carries no hash and is
 *    safe to retry with a corrected transaction.
 */
export type TransitionOutcome =
  | { ok: true; transition: TachiTransitionReceipt }
  | { ok: false; reason: string; pendingTxHash?: string };

export async function submitLiveTransition(input: {
  positionId: string;
  action: "DRAW" | "REPAY" | "UNLOCK";
  amount: number;
  proofDigest?: string;
  txHex?: string;
  vaultRef: string;
  /**
   * Live mode refuses a transition with no real signed transaction. Callers check
   * this themselves for the denial-receipt they write; the helper only enforces it
   * when asked, so fixture mode keeps its simulated path.
   */
  requireTxHexInLiveMode?: boolean;
}): Promise<TransitionOutcome> {
  const { requireTxHexInLiveMode, ...transitionInput } = input;
  if (requireTxHexInLiveMode && isLiveMode() && !transitionInput.txHex) {
    return { ok: false, reason: "Live mode requires a real Taurus-signed txHex to broadcast" };
  }
  try {
    const transition = await getTachiAdapter().submitCreditTransition(transitionInput);
    return { ok: true, transition };
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : "Live credit transition failed";
    if (isTachiLiveError(error, "UNCONFIRMED")) {
      return { ok: false, reason, pendingTxHash: error.txHash };
    }
    return { ok: false, reason };
  }
}
