import { NextResponse } from "next/server";
import { assertPositionInvariants } from "@/lib/domain/invariants";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { FixtureTachiAdapter } from "@/lib/tachi/fixture-adapter";
import { addReceipt, getPosition, setPosition } from "@/lib/store";

const tachi = new FixtureTachiAdapter();

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const requestedAmount = Number(body.amount);
  const before = getPosition();
  const amount = Math.max(0, Math.min(before.debtUnits, Number.isFinite(requestedAmount) ? requestedAmount : 0));
  const transition = await tachi.submitCreditTransition({ positionId: before.id, action: "REPAY", amount });
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
