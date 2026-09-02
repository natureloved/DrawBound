import { describe, expect, it } from "vitest";
import { createReceipt } from "@/lib/receipts/create";
import { verifyReceipt } from "@/lib/receipts/verify";

describe("decision receipts", () => {
  it("verify independently from UI state", () => {
    const receipt = createReceipt({ id: "r", positionId: "p", action: "DRAW", requestedAmount: 100, previousState: "COLLATERALIZED", result: "ALLOW", reason: "ok", resultingState: "ACTIVE", transitionRef: "satvm:1", createdAt: "2026-09-01T12:00:00Z" });
    expect(verifyReceipt(receipt)).toBe(true);
    expect(verifyReceipt({ ...receipt, reason: "tampered" })).toBe(false);
  });
});
