import { describe, expect, it } from "vitest";
import { StorageRepository } from "../lib/db/storage";
import { buildSatvmCreditTransition, signTransitionClientSide } from "../lib/wallet/transition-builder";
import { verifyNormalizedProof } from "../lib/proofs/verify";
import { fixtureProof } from "../lib/proofs/fixtures";
import { calculateCreditLimit, evaluateDraw } from "../lib/domain/covenant";

describe("Production Readiness & Live Integration Tests", () => {
  it("persists and retrieves positions and receipts through the StorageRepository", async () => {
    const repo = new StorageRepository();
    const pos = await repo.getPosition("pos_demo_01");
    expect(pos).not.toBeNull();
    expect(pos?.id).toBe("pos_demo_01");

    // Add a receipt
    const testReceipt = {
      id: "rcpt_test_01",
      positionId: "pos_demo_01",
      action: "DRAW" as const,
      requestedAmount: 100,
      previousState: "COLLATERALIZED" as const,
      result: "ALLOW" as const,
      reason: "Fresh proof satisfies covenant",
      resultingState: "ACTIVE" as const,
      createdAt: new Date().toISOString(),
      receiptDigest: "abc123digest",
    };

    await repo.addReceipt(testReceipt);
    const receipts = await repo.getReceipts("pos_demo_01");
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    expect(receipts[0].id).toBe("rcpt_test_01");
  });

  it("builds valid SatVM client-side transaction transitions without manual raw hex copy-pasting", async () => {
    const transition = buildSatvmCreditTransition({
      action: "DRAW",
      positionId: "pos_demo_01",
      vaultRef: "vault:taurus:signet:drawbound-demo",
      amount: 100,
      nonce: 1,
    });

    expect(transition.txHex).toBeDefined();
    expect(transition.txHex.length).toBeGreaterThan(64);
    expect(transition.txid).toBeDefined();

    const signed = await signTransitionClientSide({
      action: "REPAY",
      positionId: "pos_demo_01",
      vaultRef: "vault:taurus:signet:drawbound-demo",
      amount: 50,
      nonce: 2,
    });
    expect(signed).toBeDefined();
    expect(typeof signed).toBe("string");
  });

  it("verifies normalized cryptographic proofs", () => {
    const proof = fixtureProof("healthy");
    expect(verifyNormalizedProof(proof)).toBe(true);

    const corruptedProof = { ...proof, digest: "corrupted_hash" };
    expect(verifyNormalizedProof(corruptedProof)).toBe(false);
  });

  it("calculates dynamic credit limits and evaluates covenant decisions", () => {
    expect(calculateCreditLimit(50000)).toBe(5000);
    expect(calculateCreditLimit(5000)).toBe(500);

    const pos = {
      id: "pos_demo_01",
      vaultRef: "vault:taurus:signet:drawbound-demo",
      collateralSats: 10000,
      debtUnits: 0,
      creditLimitUnits: 1000,
      minHealthBps: 12500,
      state: "COLLATERALIZED" as const,
      exitStatus: "LOCKED" as const,
      drawCount: 0,
      nonce: 0,
    };

    const healthyProof = fixtureProof("healthy", { positionId: pos.id, collateralRef: pos.vaultRef });
    const decision = evaluateDraw({
      position: pos,
      proof: healthyProof,
      requestedAmount: 500,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.resultingState).toBe("ACTIVE");
  });
});
