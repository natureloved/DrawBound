import { NextResponse } from "next/server";
import { assertPositionInvariants } from "@/lib/domain/invariants";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { getTachiAdapter, isLiveMode } from "@/lib/tachi";
import { deriveHealthProof } from "@/lib/proofs/derive";
import { authenticateAction } from "@/lib/auth/action-auth";
import { badRequest, guardRateLimit, nonceConflict, readJsonBody } from "@/app/api/_lib/http";
import { addReceipt, getProcessedDraw, rememberProcessedDraw, savePosition, transitionFingerprint } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const auth = await authenticateAction(request, body, "REPAY");
  if (!auth.ok) return auth.response;
  const { position: before, amount, nonce } = auth.value;

  if (amount < 0) return badRequest("Repay amount cannot be negative");
  // Repayment is always permitted (even while FROZEN) and capped at the outstanding debt.
  const applied = Math.min(amount, before.debtUnits);

  const fingerprint = transitionFingerprint(before.id, "REPAY", amount, nonce);
  const previousReceipt = await getProcessedDraw(fingerprint);
  if (previousReceipt) {
    return NextResponse.json({ decision: previousReceipt.result, receipt: previousReceipt, position: before, idempotent: true });
  }

  const stale = nonceConflict(nonce, before.nonce);
  if (stale) return stale;

  const txHex = typeof body.txHex === "string" && body.txHex.trim() ? body.txHex.trim() : undefined;
  if (isLiveMode() && !txHex) {
    const reason = "Live mode requires a real Taurus-signed txHex to broadcast";
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: before.id,
      action: "REPAY",
      requestedAmount: amount,
      previousState: before.state,
      result: "DENY",
      reason,
      resultingState: before.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: before });
  }

  let transition: { transitionRef: string };
  try {
    transition = await getTachiAdapter().submitCreditTransition({ positionId: before.id, action: "REPAY", amount: applied, txHex });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Live credit transition failed";
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: before.id,
      action: "REPAY",
      requestedAmount: amount,
      previousState: before.state,
      result: "DENY",
      reason,
      resultingState: before.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: before });
  }

  const debtUnits = before.debtUnits - applied;
  const next = {
    ...before,
    debtUnits,
    state: debtUnits === 0 ? ("REPAID" as const) : before.state,
    exitStatus: debtUnits === 0 ? ("AVAILABLE" as const) : before.exitStatus,
    nonce: before.nonce + 1,
  };
  // Refresh the stored attestation to the post-repay debt so the UI and the next
  // gate see the real ratio immediately.
  next.latestProof = deriveHealthProof(next);
  assertPositionInvariants(next);
  await savePosition(next);

  const receipt = createReceipt({
    id: createReceiptId(),
    positionId: before.id,
    action: "REPAY",
    requestedAmount: amount,
    previousState: before.state,
    result: "ALLOW",
    reason: applied ? "Repayment accepted while collateral remains locked" : "No outstanding debt to repay",
    resultingState: next.state,
    transitionRef: transition.transitionRef,
    createdAt: new Date().toISOString(),
  });
  await addReceipt(receipt);
  await rememberProcessedDraw(fingerprint, receipt);
  return NextResponse.json({ decision: "ALLOW", receipt, position: next });
}
