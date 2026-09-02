import { NextResponse } from "next/server";
import { evaluateDraw } from "@/lib/domain/covenant";
import { assertPositionInvariants } from "@/lib/domain/invariants";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { FixtureTachiAdapter } from "@/lib/tachi/fixture-adapter";
import { addReceipt, getPosition, getProcessedDraw, rememberProcessedDraw, setPosition } from "@/lib/store";

const tachi = new FixtureTachiAdapter();

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  const before = getPosition();
  const fingerprint = `${before.id}:${amount}:${before.latestProof?.digest ?? "none"}`;
  const previousReceipt = getProcessedDraw(fingerprint);
  if (previousReceipt) return NextResponse.json({ decision: "ALLOW", receipt: previousReceipt, position: before, idempotent: true });
  const decision = evaluateDraw({ position: before, proof: before.latestProof, requestedAmount: amount });
  if (!decision.allowed) {
    const next = { ...before, state: "FROZEN" as const };
    setPosition(next);
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: before.id,
      action: "DRAW",
      requestedAmount: amount,
      proofDigest: before.latestProof?.digest,
      previousState: before.state,
      result: "DENY",
      reason: decision.reason,
      resultingState: next.state,
      createdAt: new Date().toISOString(),
    });
    addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason: decision.reason, receipt, position: getPosition() });
  }
  const transition = await tachi.submitCreditTransition({ positionId: before.id, action: "DRAW", amount, proofDigest: before.latestProof?.digest });
  const next = { ...before, debtUnits: before.debtUnits + amount, state: "ACTIVE" as const, exitStatus: "LOCKED" as const, drawCount: before.drawCount + 1, nonce: before.nonce + 1 };
  assertPositionInvariants(next);
  setPosition(next);
  const receipt = createReceipt({
    id: createReceiptId(),
    positionId: before.id,
    action: "DRAW",
    requestedAmount: amount,
    proofDigest: before.latestProof?.digest,
    previousState: before.state,
    result: "ALLOW",
    reason: decision.reason,
    resultingState: next.state,
    transitionRef: transition.transitionRef,
    createdAt: new Date().toISOString(),
  });
  addReceipt(receipt);
  rememberProcessedDraw(fingerprint, receipt);
  return NextResponse.json({ decision: "ALLOW", receipt, position: getPosition() });
}
