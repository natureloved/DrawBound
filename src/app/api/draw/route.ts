import { NextResponse } from "next/server";
import { creditGate } from "@/lib/contracts/credit-gate";
import { assertPositionInvariants } from "@/lib/domain/invariants";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { getTachiAdapter } from "@/lib/tachi";
import { deriveHealthProof } from "@/lib/proofs/derive";
import { addReceipt, getPosition, getProcessedDraw, rememberProcessedDraw, setProof, setPosition } from "@/lib/store";

const tachi = getTachiAdapter();

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  const before = getPosition();
  // Refresh a current, debt-aware health attestation so the gate evaluates the position's
  // REAL present health (collateral vs drawn debt), not a stale snapshot from connect/refresh.
  const freshProof = deriveHealthProof(before);
  // Idempotency keys on the transition itself (stable position + amount, or the signed txHex
  // for live writes) : NOT the freshly-derived proof digest, which is time-dependent.
  const fingerprint = `${before.id}:${amount}:${typeof body.txHex === "string" && body.txHex ? body.txHex : before.debtUnits}`;
  const previousReceipt = getProcessedDraw(fingerprint);
  if (previousReceipt) return NextResponse.json({ decision: "ALLOW", receipt: previousReceipt, position: before, idempotent: true });
  const decision = creditGate(before, freshProof, amount);
  if (!decision.allowed) {
    const next = { ...before, state: "FROZEN" as const };
    setPosition(next);
    setProof(freshProof);
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: before.id,
      action: "DRAW",
      requestedAmount: amount,
      proofDigest: freshProof.digest,
      previousState: before.state,
      result: "DENY",
      reason: decision.reason,
      resultingState: next.state,
      createdAt: new Date().toISOString(),
    });
    addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason: decision.reason, receipt, position: getPosition() });
  }
  const txHex = typeof body.txHex === "string" ? body.txHex : undefined;
  let transition: { transitionRef: string };
  try {
    transition = await tachi.submitCreditTransition({
      positionId: before.id,
      action: "DRAW",
      amount,
      proofDigest: freshProof.digest,
      txHex,
    });
  } catch (error) {
    const next = { ...before, state: "FROZEN" as const };
    setPosition(next);
    const reason = error instanceof Error ? error.message : "Live credit transition failed";
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: before.id,
      action: "DRAW",
      requestedAmount: amount,
      proofDigest: before.latestProof?.digest,
      previousState: before.state,
      result: "DENY",
      reason,
      resultingState: next.state,
      createdAt: new Date().toISOString(),
    });
    addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: getPosition() });
  }
  const next = { ...before, debtUnits: before.debtUnits + amount, state: "ACTIVE" as const, exitStatus: "LOCKED" as const, drawCount: before.drawCount + 1, nonce: before.nonce + 1 };
  assertPositionInvariants(next);
  setPosition(next);
  // Keep the attestation current with the post-draw debt so the next gate sees real health.
  setProof(deriveHealthProof(next));
  const receipt = createReceipt({
    id: createReceiptId(),
    positionId: before.id,
    action: "DRAW",
    requestedAmount: amount,
    proofDigest: freshProof.digest,
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
