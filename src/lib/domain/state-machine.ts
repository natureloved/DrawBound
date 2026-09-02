import type { Action, CreditState } from "./types";

const transitions: Record<CreditState, Partial<Record<Action, CreditState>>> = {
  EMPTY: {},
  COLLATERALIZED: { DRAW: "ACTIVE", REPAY: "COLLATERALIZED", UNLOCK: "UNLOCKABLE" },
  CREDIT_OPEN: { DRAW: "ACTIVE", REPAY: "CREDIT_OPEN", UNLOCK: "UNLOCKABLE" },
  ACTIVE: { DRAW: "ACTIVE", REPAY: "ACTIVE", UNLOCK: "ACTIVE" },
  FROZEN: { DRAW: "FROZEN", REPAY: "FROZEN", UNLOCK: "FROZEN" },
  REPAID: { DRAW: "ACTIVE", REPAY: "REPAID", UNLOCK: "UNLOCKABLE" },
  UNLOCKABLE: { UNLOCK: "EXITED", REPAY: "UNLOCKABLE" },
  EXITED: {},
};

export function canTransition(state: CreditState, action: Action): boolean {
  return transitions[state][action] !== undefined;
}

export function transitionState(state: CreditState, action: Action): CreditState {
  const next = transitions[state][action];
  if (!next) throw new Error(`Illegal transition: ${state} -> ${action}`);
  return next;
}

export function stateLabel(state: CreditState): string {
  return state.replaceAll("_", " ");
}
