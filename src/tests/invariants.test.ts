import { describe, expect, it } from "vitest";
import { assertPositionInvariants } from "@/lib/domain/invariants";
import type { CreditPosition } from "@/lib/domain/types";

const base: CreditPosition = { id: "p", vaultRef: "v", collateralSats: 1, debtUnits: 0, creditLimitUnits: 10, minHealthBps: 1, state: "COLLATERALIZED", exitStatus: "LOCKED", drawCount: 0, nonce: 0 };

describe("position invariants", () => {
  it("rejects negative debt", () => expect(() => assertPositionInvariants({ ...base, debtUnits: -1 })).toThrow());
  it("rejects debt over limit", () => expect(() => assertPositionInvariants({ ...base, debtUnits: 11 })).toThrow());
  it("rejects an available exit with debt", () => expect(() => assertPositionInvariants({ ...base, debtUnits: 1, exitStatus: "AVAILABLE" })).toThrow());
});
