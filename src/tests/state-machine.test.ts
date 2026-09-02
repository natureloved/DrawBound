import { describe, expect, it } from "vitest";
import { canTransition, transitionState } from "@/lib/domain/state-machine";

describe("credit state machine", () => {
  it("moves collateralized positions to active on an allowed draw", () => expect(transitionState("COLLATERALIZED", "DRAW")).toBe("ACTIVE"));
  it("allows repayment while frozen", () => expect(canTransition("FROZEN", "REPAY")).toBe(true));
  it("keeps unlock as an explicit guarded action from active", () => expect(canTransition("ACTIVE", "UNLOCK")).toBe(true));
  it("rejects transitions from exited", () => expect(() => transitionState("EXITED", "DRAW")).toThrow());
});
