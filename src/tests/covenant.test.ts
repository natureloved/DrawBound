import { describe, expect, it } from "vitest";
import { evaluateDraw } from "@/lib/domain/covenant";
import { fixtureProof } from "@/lib/proofs/fixtures";
import type { CreditPosition } from "@/lib/domain/types";

const position: CreditPosition = {
  id: "pos_demo_01", vaultRef: "vault:taurus:signet:drawbound-demo", collateralSats: 5000,
  debtUnits: 0, creditLimitUnits: 500, minHealthBps: 12500, state: "COLLATERALIZED", exitStatus: "LOCKED", drawCount: 0, nonce: 0,
};
const now = new Date();

describe("draw covenant", () => {
  it("allows a fresh healthy proof within limit", () => {
    expect(evaluateDraw({ position, proof: fixtureProof("healthy"), requestedAmount: 100, now }).allowed).toBe(true);
  });

  it.each([
    ["unhealthy", "Loan health is below covenant threshold"],
    ["stale", "Proof is stale"],
    ["invalid", "Proof is not verified"],
  ] as const)("denies %s proof", (kind, reason) => {
    expect(evaluateDraw({ position, proof: fixtureProof(kind), requestedAmount: 100, now })).toMatchObject({ allowed: false, reason });
  });

  it("denies a proof bound to another vault", () => {
    const proof = { ...fixtureProof("healthy"), collateralRef: "vault:other" };
    expect(evaluateDraw({ position, proof, requestedAmount: 100, now }).reason).toContain("another TAURUS vault");
  });

  it("denies at the exact expiry boundary", () => {
    const proof = fixtureProof("healthy");
    expect(evaluateDraw({ position, proof, requestedAmount: 100, now: new Date(proof.expiresAt) }).allowed).toBe(false);
  });
});
