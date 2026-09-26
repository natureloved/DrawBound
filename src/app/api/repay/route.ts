import { NextResponse } from "next/server";
import { assertPositionInvariants } from "@/lib/domain/invariants";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { getTachiAdapter, isLiveMode } from "@/lib/tachi";
import { deriveHealthProof } from "@/lib/proofs/derive";
import { authenticateAction } from "@/lib/auth/action-auth";
import { badRequest, guardRateLimit, nonceConflict, readJsonBody } from "@/app/api/_lib/http";
import { addReceipt, commitTransition, getPosition, getProcessedDraw, rememberProcessedDraw, transitionFingerprint, withPositionLock } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const auth = await authenticateAction(request, body, "REPAY");
  if (!auth.ok) return auth.response;
  const { position: before, amount, nonce, session } = auth.value;

  if (amount < 0) return badRequest("Repay amount cannot be negative");
  // Repayment is always permitted (even while FROZEN) and capped at the outstanding debt.

  // Bound to the signer's public key (BIP-340 signatures are randomized, so the
  // signature bytes themselves cannot key idempotency). Runs under the position
  // lock like every transition.
  const fingerprint = transitionFingerprint(before.id, "REPAY", amount, nonce, session.publicKey);

  return withPositionLock(before.id, async () => {
  const previousReceipt = await getProcessedDraw(fingerprint);
  if (previousReceipt) {
    // Re-read so an idempotent replay reports the position's CURRENT state
    // rather than a snapshot a later transition has already superseded.
    const current = await getPosition(before.id);
    return NextResponse.json({
      decision: previousReceipt.result,
      receipt: previousReceipt,
      position: current ?? before,
      idempotent: true,
    });
  }

  // Re-read under the lock so `current` reflects every transition that has
  // already committed, not the pre-lock snapshot in `before`.
  const current = (await getPosition(before.id)) ?? before;
  const repayable = Math.min(amount, current.debtUnits);

  const stale = nonceConflict(nonce, current.nonce);
  if (stale) return stale;

  const txHex = typeof body.txHex === "string" && body.txHex.trim() ? body.txHex.trim() : undefined;
  if (isLiveMode() && !txHex) {
    const reason = "Live mode requires a real Taurus-signed txHex to broadcast";
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: current.id,
      action: "REPAY",
      requestedAmount: amount,
      previousState: current.state,
      result: "DENY",
      reason,
      resultingState: current.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: current });
  }

  let transition: { transitionRef: string };
  try {
    transition = await getTachiAdapter().submitCreditTransition({ positionId: current.id, action: "REPAY", amount: repayable, txHex });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Live credit transition failed";
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: current.id,
      action: "REPAY",
      requestedAmount: amount,
      previousState: current.state,
      result: "DENY",
      reason,
      resultingState: current.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: current });
  }

  const debtUnits = current.debtUnits - repayable;
  const next = {
    ...current,
    debtUnits,
    state: debtUnits === 0 ? ("REPAID" as const) : current.state,
    exitStatus: debtUnits === 0 ? ("AVAILABLE" as const) : current.exitStatus,
    nonce: current.nonce + 1,
  };
  // Refresh the stored attestation to the post-repay debt so the UI and the next
  // gate see the real ratio immediately.
  next.latestProof = deriveHealthProof(next);
  assertPositionInvariants(next);

  const receipt = createReceipt({
    id: createReceiptId(),
    positionId: current.id,
    action: "REPAY",
    requestedAmount: amount,
    previousState: current.state,
    result: "ALLOW",
    reason: repayable ? "Repayment accepted while collateral remains locked" : "No outstanding debt to repay",
    resultingState: next.state,
    transitionRef: transition.transitionRef,
    createdAt: new Date().toISOString(),
  });
  await commitTransition(next, receipt);
  await rememberProcessedDraw(fingerprint, receipt);
  return NextResponse.json({ decision: "ALLOW", receipt, position: next });
  });
}
