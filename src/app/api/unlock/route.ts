import { NextResponse } from "next/server";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { getTachiAdapter, isLiveMode } from "@/lib/tachi";
import { authenticateAction } from "@/lib/auth/action-auth";
import { badRequest, guardRateLimit, nonceConflict, readJsonBody } from "@/app/api/_lib/http";
import { addReceipt, commitTransition, getPosition, getProcessedDraw, rememberProcessedDraw, savePosition, transitionFingerprint, withPositionLock } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const auth = await authenticateAction(request, body, "UNLOCK");
  if (!auth.ok) return auth.response;
  const { position: before, amount, nonce, session } = auth.value;

  if (amount !== 0) return badRequest("Unlock amount must be zero");

  const fingerprint = transitionFingerprint(before.id, "UNLOCK", amount, nonce, session.publicKey);

  return withPositionLock(before.id, async () => {
  const previousReceipt = await getProcessedDraw(fingerprint);
  if (previousReceipt) {
    const current = await getPosition(before.id);
    return NextResponse.json({ decision: previousReceipt.result, receipt: previousReceipt, position: current ?? before, idempotent: true });
  }

  // Re-read under the lock: the pre-lock snapshot in `before` cannot see a
  // transition that has already committed on this position.
  const current = (await getPosition(before.id)) ?? before;

  const stale = nonceConflict(nonce, current.nonce);
  if (stale) return stale;

  // The documented unilateral exit is available only at zero debt and never re-runs on an exited position.
  if (current.state === "EXITED") {
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: current.id,
      action: "UNLOCK",
      requestedAmount: 0,
      previousState: current.state,
      result: "DENY",
      reason: "Position has already exited",
      resultingState: current.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason: receipt.reason, receipt, position: before });
  }
  if (current.debtUnits !== 0) {
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: current.id,
      action: "UNLOCK",
      requestedAmount: 0,
      previousState: current.state,
      result: "DENY",
      reason: "Collateral remains locked while debt is nonzero",
      resultingState: current.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason: receipt.reason, receipt, position: before });
  }

  const txHex = typeof body.txHex === "string" && body.txHex.trim() ? body.txHex.trim() : undefined;
  if (isLiveMode() && !txHex) {
    const reason = "Live mode requires a real Taurus-signed txHex to broadcast";
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: current.id,
      action: "UNLOCK",
      requestedAmount: 0,
      previousState: current.state,
      result: "DENY",
      reason,
      resultingState: current.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: before });
  }

  let transition: { transitionRef: string };
  try {
    transition = await getTachiAdapter().submitCreditTransition({ positionId: current.id, action: "UNLOCK", amount: 0, txHex });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Live credit transition failed";
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: current.id,
      action: "UNLOCK",
      requestedAmount: 0,
      previousState: current.state,
      result: "DENY",
      reason,
      resultingState: current.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: before });
  }

  const next = { ...before, state: "EXITED" as const, exitStatus: "EXITED" as const, nonce: current.nonce + 1 };
  await savePosition(next);

  const receipt = createReceipt({
    id: createReceiptId(),
    positionId: current.id,
    action: "UNLOCK",
    requestedAmount: 0,
    previousState: current.state,
    result: "ALLOW",
    reason: "Debt is zero; TAURUS unilateral exit path is available",
    resultingState: next.state,
    transitionRef: transition.transitionRef,
    createdAt: new Date().toISOString(),
  });
  await commitTransition(next, receipt);
  await rememberProcessedDraw(fingerprint, receipt);
  return NextResponse.json({ decision: "ALLOW", receipt, position: next });
  });
}
