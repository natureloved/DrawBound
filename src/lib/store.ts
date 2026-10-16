import { createHash } from "node:crypto";
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

/**
 * Deterministic position id derived from the vault ref.
 *
 * A full SHA-256 over the raw ref is used rather than sanitizing + truncating:
 * the old form mapped distinct refs onto the same id (`vault:taurus:signet:demo`
 * and `vault-taurus-signet-demo` both became `pos_vaulttaurussignetdemo`), which
 * let one caller connect a colliding ref and act on another caller's position.
 * Hashing the whole ref makes collisions require a SHA-256 preimage.
 */
export function positionIdForVault(vaultRef: string): string {
  return `pos_${createHash("sha256").update(vaultRef, "utf8").digest("hex").slice(0, 32)}`;
}

const positions = new Map<string, CreditPosition>();
const processedDraws = new Map<string, DecisionReceipt>();
let loadPromise: Promise<void> | null = null;

/**
 * Per-position transition lock.
 *
 * The credit gate is a read-modify-write (read position -> evaluate covenant ->
 * save position). Without serialization, two concurrent approved transitions can
 * both pass the nonce/credit-limit checks and the later save overwrites the
 * earlier one — a double draw beyond the credit limit with a divergent receipt.
 * Routing every transition through `withPositionLock` makes each one atomic by
 * construction; the nonce check still rejects a stale request, just later.
 */
const positionLocks = new Map<string, Promise<unknown>>();

export async function withPositionLock<T>(positionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = positionLocks.get(positionId) ?? Promise.resolve();
  // Swallow the predecessor's failure so one rejected transition cannot poison
  // the lock for every later one on this position.
  const run = previous.then(fn, fn);
  positionLocks.set(positionId, run);
  try {
    return await run;
  } finally {
    if (positionLocks.get(positionId) === run) positionLocks.delete(positionId);
  }
}

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

/**
 * Stable idempotency key for a transition attempt.
 *
 * Time-independent, so a retried signed request returns the original receipt.
 *
 * The signer's public key is folded in rather than the raw signature bytes:
 * BIP-340 signing is randomized, so re-signing the same message produces a
 * DIFFERENT signature each time — hashing the signature would defeat idempotency
 * for every legitimate retry. The public key is stable across retries and still
 * binds the record to the identity that signed it, so a receipt recorded by one
 * key is never served to a request presenting another.
 */
export function transitionFingerprint(
  positionId: string,
  action: Action,
  amount: number,
  nonce: number,
  signerPublicKey?: string,
): string {
  const base = `${positionId}:${action}:${amount}:${nonce}`;
  if (!signerPublicKey) return base;
  return `${base}:${createHash("sha256").update(signerPublicKey, "utf8").digest("hex").slice(0, 16)}`;
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

/**
 * Record an approved transition: the new position state and its receipt land
 * together. Used by every path that mutates debt/state, so a crash can never
 * show a position that advanced without its receipt (or a receipt the position
 * never recorded).
 */
export async function commitTransition(position: CreditPosition, receipt: DecisionReceipt): Promise<void> {
  await db.commitTransition(position, receipt);
  positions.set(position.id, structuredClone(position));
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
    // Live mode applies the read even when it reports zero: a drained or exited
    // vault must not keep the credit limit it had while it was funded. A *failed*
    // read never reaches here — live callers refuse the connect instead, so that a
    // network blip cannot overwrite real state with an artifact of the blip.
    if (collateralSats > 0 || env.liveEnabled()) {
      existing.collateralSats = collateralSats;
      // The credit limit tracks the collateral-derived limit ONLY. Deriving it as
      // max(derive(collateral), debtUnits) permanently widened borrowing capacity
      // whenever the on-chain read shrank below the debt, so a drained vault kept
      // a high limit. When collateral no longer supports the debt, the position
      // freezes instead of raising the limit.
      const derived = calculateCreditLimit(collateralSats);
      existing.creditLimitUnits = derived;
      if (existing.debtUnits > derived) {
        existing.state = "FROZEN";
      }
    }
    if (proof) existing.latestProof = proof;
    await savePosition(existing);
    return structuredClone(existing);
  }

  // The 5,000-sat default is a fixture-mode rehearsal convenience. In live mode a
  // vault with nothing observed gets zero collateral — and therefore a zero credit
  // limit — because inventing collateral for a real vault is exactly how a
  // self-custodial protocol loses money. Live callers are expected to have refused
  // earlier when the read failed; this is the backstop.
  const collateral = collateralSats > 0 ? collateralSats : env.liveEnabled() ? 0 : 5000;
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
