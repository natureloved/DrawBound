import type { CreditPosition } from "./types";

export function assertPositionInvariants(position: CreditPosition): void {
  if (position.debtUnits < 0) throw new Error("Debt cannot be negative");
  if (position.debtUnits > position.creditLimitUnits) throw new Error("Debt exceeds credit limit");
  if (position.collateralSats < 0) throw new Error("Collateral cannot be negative");
  if (position.exitStatus === "AVAILABLE" && position.debtUnits !== 0) {
    throw new Error("Collateral cannot be available while debt is nonzero");
  }
  if (position.state === "EXITED" && position.debtUnits !== 0) {
    throw new Error("Exited position cannot carry debt");
  }
}
