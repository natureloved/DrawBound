import { NextResponse } from "next/server";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { getTachiAdapter } from "@/lib/tachi";
import { addReceipt, getPosition, setPosition } from "@/lib/store";

const tachi = getTachiAdapter();

export async function POST(request: Request) {
  const before = getPosition();
  if (before.debtUnits !== 0) {
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: before.id,
      action: "UNLOCK",
      requestedAmount: 0,
      previousState: before.state,
      result: "DENY",
      reason: "Collateral remains locked while debt is nonzero",
      resultingState: before.state,
      createdAt: new Date().toISOString(),
    });
    addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", receipt, position: before });
  }
  const body = await request.json().catch(() => ({})) as { txHex?: unknown };
  const txHex = typeof body.txHex === "string" ? body.txHex : undefined;
  let transition: { transitionRef: string };
  try {
    transition = await tachi.submitCreditTransition({ positionId: before.id, action: "UNLOCK", amount: 0, txHex });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Live credit transition failed";
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: before.id,
      action: "UNLOCK",
      requestedAmount: 0,
      previousState: before.state,
      result: "DENY",
      reason,
      resultingState: before.state,
      createdAt: new Date().toISOString(),
    });
    addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: before });
  }
  const next = { ...before, state: "EXITED" as const, exitStatus: "EXITED" as const };
  setPosition(next);
  const receipt = createReceipt({
    id: createReceiptId(),
    positionId: before.id,
    action: "UNLOCK",
    requestedAmount: 0,
    previousState: before.state,
    result: "ALLOW",
    reason: "Debt is zero; TAURUS unilateral exit path is available",
    resultingState: next.state,
    transitionRef: transition.transitionRef,
    createdAt: new Date().toISOString(),
  });
  addReceipt(receipt);
  return NextResponse.json({ decision: "ALLOW", receipt, position: getPosition() });
}
