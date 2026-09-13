import type { CreditPosition, DecisionReceipt, LoanHealthProof } from "./domain/types";
import { fixtureProof } from "./proofs/fixtures";
import { db } from "./db/storage";

/** Deterministic position id derived from a vault ref (alphanumerics only). */
export function positionIdForVault(vaultRef: string): string {
  return `pos_${vaultRef.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16)}`;
}

// In-memory cache synced with persistent storage
const position: CreditPosition = {
  id: "pos_demo_01",
  vaultRef: process.env.TACHI_VAULT_REF?.trim() || "vault:taurus:signet:drawbound-demo",
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

// Initialize memory from storage if present
void db.getPosition("pos_demo_01").then((stored) => {
  if (stored) Object.assign(position, stored);
});
void db.getReceipts().then((storedReceipts) => {
  if (storedReceipts.length > 0) {
    receipts.length = 0;
    receipts.push(...storedReceipts.reverse());
  }
});

export function getPosition(positionId = "pos_demo_01"): CreditPosition {
  return structuredClone(position);
}

export function setPosition(next: CreditPosition): void {
  Object.assign(position, next);
  void db.savePosition(next);
}

export function getReceipts(positionId?: string): DecisionReceipt[] {
  const list = positionId ? receipts.filter((r) => r.positionId === positionId) : receipts;
  return structuredClone(list).reverse();
}

export function addReceipt(receipt: DecisionReceipt): void {
  receipts.push(receipt);
  void db.addReceipt(receipt);
}

export function getProcessedDraw(fingerprint: string): DecisionReceipt | undefined {
  return processedDraws.get(fingerprint);
}

export function rememberProcessedDraw(fingerprint: string, receipt: DecisionReceipt): void {
  processedDraws.set(fingerprint, receipt);
  void db.rememberProcessedDraw(fingerprint, receipt);
}

export function setProof(proof: LoanHealthProof): void {
  position.latestProof = proof;
  void db.savePosition(position);
  void db.saveProof(proof);
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
  void db.reset();
  return getPosition();
}

/**
 * Connect a vault and establish or retrieve its self-custodial position.
 * When `proof` is supplied (e.g. a live-derived HAT/RIP attestation from the verifier),
 * it is bound to the position; otherwise a fixture-healthy proof is minted as a fallback.
 */
export function connectVault(
  vaultRef: string,
  collateralSats: number,
  positionId?: string,
  proof?: LoanHealthProof,
): CreditPosition {
  const id = positionId || positionIdForVault(vaultRef);
  Object.assign(position, {
    id,
    vaultRef,
    collateralSats: collateralSats > 0 ? collateralSats : position.collateralSats || 5000,
    debtUnits: 0,
    state: "COLLATERALIZED",
    latestProof: proof ?? fixtureProof("healthy", { positionId: id, collateralRef: vaultRef }),
    exitStatus: "LOCKED",
    drawCount: 0,
    nonce: 0,
  });
  receipts.length = 0;
  processedDraws.clear();
  void db.savePosition(position);
  return getPosition();
}
