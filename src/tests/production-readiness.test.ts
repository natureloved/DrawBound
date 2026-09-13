import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Isolate persistence so tests never touch the developer's real .data store.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "drawbound-readiness-"));

import { StorageRepository } from "../lib/db/storage";
import { buildDemoTransition, isSyntheticTransition, signTransitionRequest } from "../lib/wallet/transition-builder";
import { generateSessionKeypair, canonicalTransitionMessage, verifyCanonical } from "../lib/wallet/canonical";
import { verifyNormalizedProof } from "../lib/proofs/verify";
import { fixtureProof } from "../lib/proofs/fixtures";
import { calculateCreditLimit, evaluateDraw } from "../lib/domain/covenant";

describe("Production Readiness & Live Integration Tests", () => {
  it("persists and retrieves positions and receipts through the StorageRepository", async () => {
    const repo = new StorageRepository();
    const pos = await repo.getPosition("pos_demo_01");
    expect(pos).not.toBeNull();
    expect(pos?.id).toBe("pos_demo_01");

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
    expect(receipts.some((r) => r.id === "rcpt_test_01")).toBe(true);
  });

  it("builds a self-labelled synthetic demo transition and never mistakes it for real", () => {
    const transition = buildDemoTransition({
      action: "DRAW",
      positionId: "pos_demo_01",
      vaultRef: "vault:taurus:signet:drawbound-demo",
      amount: 100,
      nonce: 1,
    });

    expect(transition.txHex.length).toBeGreaterThan(64);
    expect(transition.txid).toBeDefined();
    // The demo payload must be detectable so the live adapter can refuse it.
    expect(isSyntheticTransition(transition.txHex)).toBe(true);
    expect(isSyntheticTransition("02000000000101abcd")).toBe(false);
  });

  it("signs and verifies a canonical transition with a real Schnorr session key", () => {
    const { privateKey, publicKey } = generateSessionKeypair();
    const fields = {
      positionId: "pos_demo_01",
      vaultRef: "vault:taurus:signet:drawbound-demo",
      action: "REPAY" as const,
      amount: 50,
      nonce: 2,
    };
    const signature = signTransitionRequest(privateKey, fields);
    const message = canonicalTransitionMessage(fields);

    expect(verifyCanonical(message, signature, publicKey)).toBe(true);
    // A signature must not validate against a different amount.
    const tampered = canonicalTransitionMessage({ ...fields, amount: 51 });
    expect(verifyCanonical(tampered, signature, publicKey)).toBe(false);
  });

  it("verifies normalized cryptographic proofs and rejects corruption", () => {
    const proof = fixtureProof("healthy");
    expect(verifyNormalizedProof(proof)).toBe(true);

    const corruptedProof = { ...proof, digest: "corrupted_hash" };
    expect(verifyNormalizedProof(corruptedProof)).toBe(false);
  });

  it("calculates dynamic credit limits and evaluates covenant decisions with nonce binding", () => {
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
      nonce: 7,
    };

    const healthyProof = fixtureProof("healthy", { positionId: pos.id, collateralRef: pos.vaultRef });
    const decision = evaluateDraw({ position: pos, proof: healthyProof, requestedAmount: 500, expectedNonce: 7 });
    expect(decision.allowed).toBe(true);
    expect(decision.resultingState).toBe("ACTIVE");

    // A stale/replayed nonce fails closed.
    const replayed = evaluateDraw({ position: pos, proof: healthyProof, requestedAmount: 500, expectedNonce: 6 });
    expect(replayed.allowed).toBe(false);
    expect(replayed.reason).toMatch(/nonce/i);
  });
});
