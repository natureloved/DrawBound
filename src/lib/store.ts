import type { CreditPosition, DecisionReceipt, LoanHealthProof } from "./domain/types";
import { fixtureProof } from "./proofs/fixtures";

const position: CreditPosition = {
  id: "pos_demo_01",
  vaultRef: "vault:taurus:signet:drawbound-demo",
  collateralSats: 5000,
  debtUnits: 0,
  creditLimitUnits: 500,
  minHealthBps: 12500,
  state: "COLLATERALIZED",
  latestProof: fixtureProof("healthy"),
  exitStatus: "LOCKED",
  drawCount: 0,
  nonce: 0,
};

const receipts: DecisionReceipt[] = [];
const processedDraws = new Map<string, DecisionReceipt>();

export function getPosition(): CreditPosition {
  return structuredClone(position);
}

export function setPosition(next: CreditPosition): void {
  Object.assign(position, next);
}

export function getReceipts(): DecisionReceipt[] {
  return structuredClone(receipts).reverse();
}

export function addReceipt(receipt: DecisionReceipt): void {
  receipts.push(receipt);
}

export function getProcessedDraw(fingerprint: string): DecisionReceipt | undefined {
  return processedDraws.get(fingerprint);
}

export function rememberProcessedDraw(fingerprint: string, receipt: DecisionReceipt): void {
  processedDraws.set(fingerprint, receipt);
}

export function setProof(proof: LoanHealthProof): void {
  position.latestProof = proof;
}

export function resetDemo(): CreditPosition {
  Object.assign(position, {
    debtUnits: 0,
    state: "COLLATERALIZED",
    latestProof: fixtureProof("healthy"),
    exitStatus: "LOCKED",
    drawCount: 0,
    nonce: 0,
  });
  receipts.length = 0;
  processedDraws.clear();
  return getPosition();
}
