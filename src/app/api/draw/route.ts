import { NextResponse } from "next/server";
import { creditGate } from "@/lib/contracts/credit-gate";
import { assertPositionInvariants } from "@/lib/domain/invariants";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import { getTachiAdapter, isLiveMode } from "@/lib/tachi";
import { deriveHealthProof } from "@/lib/proofs/derive";
import { fetchLiveLoanHealthProof } from "@/lib/proofs/oracle-client";
import { verifyNormalizedProof } from "@/lib/proofs/verify";
import { env } from "@/lib/config/env";
import { authenticateAction } from "@/lib/auth/action-auth";
import { badRequest, guardRateLimit, nonceConflict, readJsonBody } from "@/app/api/_lib/http";
import {
  addReceipt,
  archiveProof,
  commitTransition,
  getPosition,
  getProcessedDraw,
  rememberProcessedDraw,
  savePosition,
  setProof,
  transitionFingerprint,
  withPositionLock,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const auth = await authenticateAction(request, body, "DRAW");
  if (!auth.ok) return auth.response;
  const { position: before, amount, nonce } = auth.value;

  if (amount <= 0) return badRequest("Draw amount must be a positive whole unit");

  // Idempotency keys on the transition identity (position + action + amount +
  // nonce + signer), which is time-independent, so a retried signed request
  // returns the original receipt. The whole gate runs under the per-position
  // lock: read -> evaluate -> write is a single atomic step, so two concurrent
  // approved draws cannot both pass the checks and clobber each other.
  const fingerprint = transitionFingerprint(before.id, "DRAW", amount, nonce, auth.value.session.publicKey);

  return withPositionLock(before.id, async () => {
  const previousReceipt = await getProcessedDraw(fingerprint);
  if (previousReceipt) {
    return NextResponse.json({ decision: "ALLOW", receipt: previousReceipt, position: before, idempotent: true });
  }

  // RE-READ inside the lock: `before` was resolved before any concurrent
  // request on this position could mutate it, so its nonce and debt are a
  // stale snapshot and must not gate the decision.
  const current = (await getPosition(before.id)) ?? before;

  const stale = nonceConflict(nonce, current.nonce);
  if (stale) return stale;

  // Refresh a current, debt-aware health attestation so the gate evaluates the position's
  // REAL present health (collateral vs drawn debt), not a stale snapshot from connect/refresh.
  // Live mode and strict signed-proof mode fetch through the oracle/chain-read path; plain
  // fixture mode derives locally (fast, no network).
  const strictProofs = env.proofRelayPublicKeys().length > 0;
  const freshProof =
    isLiveMode() || strictProofs
      ? await fetchLiveLoanHealthProof({
          vaultRef: current.vaultRef,
          positionId: current.id,
          network: env.network(),
          debtUnits: current.debtUnits,
          collateralSats: current.collateralSats,
        })
      : deriveHealthProof(current);
  const decision = verifyNormalizedProof(freshProof)
    ? creditGate(current, freshProof, amount, nonce)
    : { allowed: false, reason: "Loan-health proof failed verification", resultingState: "FROZEN" as const };

  if (!decision.allowed) {
    const next = { ...current, state: "FROZEN" as const };
    await savePosition(next);
    await setProof(current.id, freshProof);
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: current.id,
      action: "DRAW",
      requestedAmount: amount,
      proofDigest: freshProof.digest,
      previousState: current.state,
      result: "DENY",
      reason: decision.reason,
      resultingState: next.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason: decision.reason, receipt, position: next });
  }

  const txHex = typeof body.txHex === "string" && body.txHex.trim() ? body.txHex.trim() : undefined;
  if (isLiveMode() && !txHex) {
    const reason = "Live mode requires a real Taurus-signed txHex to broadcast";
    const next = { ...current, state: "FROZEN" as const };
    await savePosition(next);
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: current.id,
      action: "DRAW",
      requestedAmount: amount,
      proofDigest: freshProof.digest,
      previousState: current.state,
      result: "DENY",
      reason,
      resultingState: next.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: next });
  }

  let transition: { transitionRef: string };
  try {
    transition = await getTachiAdapter().submitCreditTransition({
      positionId: current.id,
      action: "DRAW",
      amount,
      proofDigest: freshProof.digest,
      txHex,
    });
  } catch (error) {
    const next = { ...current, state: "FROZEN" as const };
    await savePosition(next);
    const reason = error instanceof Error ? error.message : "Live credit transition failed";
    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: current.id,
      action: "DRAW",
      requestedAmount: amount,
      proofDigest: freshProof.digest,
      previousState: current.state,
      result: "DENY",
      reason,
      resultingState: next.state,
      createdAt: new Date().toISOString(),
    });
    await addReceipt(receipt);
    return NextResponse.json({ decision: "DENY", reason, receipt, position: next });
  }

  const next = {
    ...current,
    debtUnits: current.debtUnits + amount,
    state: "ACTIVE" as const,
    exitStatus: "LOCKED" as const,
    drawCount: current.drawCount + 1,
    nonce: current.nonce + 1,
  };
  assertPositionInvariants(next);
  // Keep the attestation current with the post-draw debt so the next gate sees real health,
  // and return the position WITH that proof so the UI never shows a stale ratio.
  const postDrawProof = deriveHealthProof(next);
  next.latestProof = postDrawProof;
  await archiveProof(freshProof);
  await archiveProof(postDrawProof);

  const receipt = createReceipt({
    id: createReceiptId(),
    positionId: current.id,
    action: "DRAW",
    requestedAmount: amount,
    proofDigest: freshProof.digest,
    previousState: current.state,
    result: "ALLOW",
    reason: decision.reason,
    resultingState: next.state,
    transitionRef: transition.transitionRef,
    createdAt: new Date().toISOString(),
  });
  // Position + receipt commit atomically: the debt that was actually drawn and
  // the receipt documenting it can never disagree.
  await commitTransition(next, receipt);
  await rememberProcessedDraw(fingerprint, receipt);
  return NextResponse.json({ decision: "ALLOW", receipt, position: next });
  });
}
