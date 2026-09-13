import type { Action, CreditPosition, DecisionReceipt, LoanHealthProof } from "./domain/types";
import { calculateCreditLimit } from "./domain/covenant";
import { fixtureProof } from "./proofs/fixtures";
import { db, seedDemoPosition } from "./db/storage";
import { env } from "./config/env";

/**
 * Multi-position credit store.
 *
 * Positions are keyed by a deterministic id derived from the vault ref, so
 * reconnecting the same vault RESTORES its position (debt, state, receipts)
 * instead of clobbering it. Different vaults no longer interfere: the old
 * single-global-position prototype behavior is gone.
 *
 * All persistence is awaited (no fire-and-forget writes): when a route returns
 * a decision, the receipt and position update are durably queued to disk.
 */

/** Deterministic position id derived from a vault ref (alphanumerics only). */
export function positionIdForVault(vaultRef: string): string {
  return `pos_${vaultRef.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32)}`;
}

const positions = new Map<string, CreditPosition>();
const processedDraws = new Map<string, DecisionReceipt>();
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const stored = await db.listPositions();
      if (stored.length === 0) {
        const seed = seedDemoPosition();
        await db.savePosition(seed);
        positions.set(seed.id, structuredClone(seed));
      } else {
        for (const pos of stored) positions.set(pos.id, pos);
      }
      const draws = await db.getAllProcessedDraws();
      for (const [fingerprint, receipt] of Object.entries(draws)) processedDraws.set(fingerprint, receipt);
    })();
  }
  await loadPromise;
}

/** Stable idempotency key for a transition attempt (time-independent). */
export function transitionFingerprint(positionId: string, action: Action, amount: number, nonce: number): string {
  return `${positionId}:${action}:${amount}:${nonce}`;
}

// --- Positions ---

export async function getPosition(positionId: string): Promise<CreditPosition | null> {
  await ensureLoaded();
  const pos = positions.get(positionId);
  return pos ? structuredClone(pos) : null;
}

export class PositionNotFoundError extends Error {
  constructor(positionId: string) {
    super(`Unknown position: ${positionId}`);
    this.name = "PositionNotFoundError";
  }
}

export async function requirePosition(positionId: string): Promise<CreditPosition> {
  const pos = await getPosition(positionId);
  if (!pos) throw new PositionNotFoundError(positionId);
  return pos;
}

export async function listPositions(): Promise<CreditPosition[]> {
  await ensureLoaded();
  return structuredClone([...positions.values()]);
}

export async function savePosition(next: CreditPosition): Promise<CreditPosition> {
  await ensureLoaded();
  positions.set(next.id, structuredClone(next));
  await db.savePosition(next);
  return structuredClone(next);
}

// --- Receipts (db is the single source of truth) ---

export async function getReceipts(positionId?: string): Promise<DecisionReceipt[]> {
  return db.getReceipts(positionId);
}

export async function addReceipt(receipt: DecisionReceipt): Promise<void> {
  await db.addReceipt(receipt);
}

// --- Idempotency ---

export async function getProcessedDraw(fingerprint: string): Promise<DecisionReceipt | undefined> {
  await ensureLoaded();
  const receipt = processedDraws.get(fingerprint);
  return receipt ? structuredClone(receipt) : undefined;
}

export async function rememberProcessedDraw(fingerprint: string, receipt: DecisionReceipt): Promise<void> {
  await ensureLoaded();
  processedDraws.set(fingerprint, structuredClone(receipt));
  await db.rememberProcessedDraw(fingerprint, receipt);
}

// --- Proofs ---

export async function setProof(positionId: string, proof: LoanHealthProof): Promise<void> {
  await ensureLoaded();
  const pos = positions.get(positionId);
  if (!pos) throw new PositionNotFoundError(positionId);
  pos.latestProof = proof;
  await db.savePosition(pos);
  await db.saveProof(proof);
}

/** Archive a proof artifact without touching position state (audit trail). */
export async function archiveProof(proof: LoanHealthProof): Promise<void> {
  await db.saveProof(proof);
}

// --- Connect / reset ---

/**
 * Connect a vault: create its position or RESTORE the existing one.
 *
 * - Existing position: collateral is refreshed from the live read when one was
 *   observed, debt/state/receipts are preserved (a reconnect is not a reset).
 * - New position: seeded at the observed (or modeled) collateral with a credit
 *   limit derived from the shared sats-per-unit model.
 */
export async function connectVault(
  vaultRef: string,
  collateralSats: number,
  proof?: LoanHealthProof,
): Promise<CreditPosition> {
  await ensureLoaded();
  const id = positionIdForVault(vaultRef);
  const existing = positions.get(id);

  if (existing) {
    if (collateralSats > 0) {
      existing.collateralSats = collateralSats;
      // Keep the invariant debt <= limit holdable even if the live read shrinks collateral.
      existing.creditLimitUnits = Math.max(calculateCreditLimit(collateralSats), existing.debtUnits);
    }
    if (proof) existing.latestProof = proof;
    await savePosition(existing);
    return structuredClone(existing);
  }

  const collateral = collateralSats > 0 ? collateralSats : 5000;
  const fresh: CreditPosition = {
    id,
    vaultRef,
    collateralSats: collateral,
    debtUnits: 0,
    creditLimitUnits: calculateCreditLimit(collateral),
    minHealthBps: env.minHealthBps(),
    state: "COLLATERALIZED",
    latestProof: proof ?? fixtureProof("healthy", { positionId: id, collateralRef: vaultRef }),
    exitStatus: "LOCKED",
    drawCount: 0,
    nonce: 0,
  };
  await savePosition(fresh);
  return structuredClone(fresh);
}

/** Admin/demo only: wipe every position and receipt back to the seeded demo. */
export async function resetStore(): Promise<CreditPosition> {
  await ensureLoaded();
  positions.clear();
  processedDraws.clear();
  await db.reset();
  loadPromise = null;
  await ensureLoaded();
  const seed = positions.get("pos_demo_01") ?? seedDemoPosition();
  return structuredClone(seed);
}
