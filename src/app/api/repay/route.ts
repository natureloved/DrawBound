import { NextResponse } from "next/server";
import { assertPositionInvariants } from "@/lib/domain/invariants";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { getTachiAdapter } from "@/lib/tachi";
import { addReceipt, getPosition, setPosition } from "@/lib/store";

const tachi = getTachiAdapter();

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const requestedAmount = Number(body.amount);
  const before = getPosition();
  const amount = Math.max(0, Math.min(before.debtUnits, Number.isFinite(requestedAmount) ? requestedAmount : 0));
  const txHex = typeof body.txHex === "string" ? body.txHex : undefined;
  let transition: { transitionRef: string };
  try {
    transition = await tachi.submitCreditTransition({ positionId: before.id, action: "REPAY", amount, txHex });
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
    addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: getPosition() });
  }
  const debtUnits = before.debtUnits - amount;
  const next = { ...before, debtUnits, state: debtUnits === 0 ? "REPAID" as const : before.state, exitStatus: debtUnits === 0 ? "AVAILABLE" as const : before.exitStatus, nonce: before.nonce + 1 };
  assertPositionInvariants(next);
  setPosition(next);
  const receipt = createReceipt({
    id: createReceiptId(),
    positionId: before.id,
    action: "REPAY",
    requestedAmount: amount,
    previousState: before.state,
    result: "ALLOW",
    reason: amount ? "Repayment accepted while collateral remains locked" : "No outstanding debt to repay",
    resultingState: next.state,
    transitionRef: transition.transitionRef,
    createdAt: new Date().toISOString(),
  });
  addReceipt(receipt);
  return NextResponse.json({ decision: "ALLOW", receipt, position: getPosition() });
}
