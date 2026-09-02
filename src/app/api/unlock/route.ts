import { NextResponse } from "next/server";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { FixtureTachiAdapter } from "@/lib/tachi/fixture-adapter";
import { addReceipt, getPosition, setPosition } from "@/lib/store";

const tachi = new FixtureTachiAdapter();

export async function POST() {
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
  const transition = await tachi.submitCreditTransition({ positionId: before.id, action: "UNLOCK", amount: 0 });
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
