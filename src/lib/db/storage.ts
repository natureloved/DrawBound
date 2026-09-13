import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreditPosition, DecisionReceipt, LoanHealthProof } from "../domain/types";
import { fixtureProof } from "../proofs/fixtures";

/**
 * JSON-file persistence for the single-instance deployment.
 *
 * Guarantees:
 * - Atomic writes (tmp file + rename).
 * - No lost writes: a dirty flag re-pumps the writer after every mutation, so a
 *   change that lands while a save is in flight is always persisted afterwards.
 * - Full state reload on first access (positions, receipts, processed draws).
 *
 * Production swap path: this class is the only place that touches storage; a
 * SQLite/Postgres implementation of the same method surface can replace it
 * without any route or domain changes (see docs/deployment.md).
 */

export interface DatabaseState {
  positions: Record<string, CreditPosition>;
  receipts: DecisionReceipt[];
  processedDraws: Record<string, DecisionReceipt>;
  proofs: Record<string, LoanHealthProof>;
}

function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), ".data");
}

function dbFile(): string {
  return path.join(dataDir(), "drawbound.json");
}

export function seedDemoPosition(): CreditPosition {
  return {
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
}

export class StorageRepository {
  private memoryState: DatabaseState;
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;
  private lastWriteError: unknown = null;

  constructor() {
    this.memoryState = {
      positions: { pos_demo_01: seedDemoPosition() },
      receipts: [],
      processedDraws: {},
      proofs: {},
    };
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          await fs.mkdir(dataDir(), { recursive: true });
          const data = await fs.readFile(dbFile(), "utf-8");
          const parsed = JSON.parse(data) as Partial<DatabaseState>;
          if (parsed.positions && Object.keys(parsed.positions).length > 0) this.memoryState.positions = parsed.positions;
          if (parsed.receipts) this.memoryState.receipts = parsed.receipts;
          if (parsed.processedDraws) this.memoryState.processedDraws = parsed.processedDraws;
          if (parsed.proofs) this.memoryState.proofs = parsed.proofs;
        } catch {
          // No file yet (or unreadable): persist the seeded defaults.
          await this.save();
        }
      })();
    }
    return this.loadPromise;
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(dataDir(), { recursive: true });
      const tempPath = `${dbFile()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(this.memoryState, null, 2), "utf-8");
      await fs.rename(tempPath, dbFile());
      this.lastWriteError = null;
    } catch (err) {
      this.lastWriteError = err;
      console.error("[storage] Failed to persist database state:", err);
    }
  }

  /**
   * Serialize every write through a single promise chain. Concurrent mutations
   * coalesce (the dirty flag), in-flight writes never overlap on the tmp file,
   * and awaiting the result means the HTTP response is only sent after the
   * decision is durably on disk.
   */
  private persist(): Promise<void> {
    this.dirty = true;
    this.writeChain = this.writeChain.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await this.save();
    });
    return this.writeChain;
  }

  /** Await all pending writes (used before process exit or in tests). */
  async flush(): Promise<void> {
    await this.writeChain;
    if (this.dirty) await this.flush();
  }

  writeError(): unknown {
    return this.lastWriteError;
  }

  // --- Positions ---

  async getPosition(positionId: string): Promise<CreditPosition | null> {
    await this.ensureLoaded();
    const pos = this.memoryState.positions[positionId];
    return pos ? structuredClone(pos) : null;
  }

  async getPositionByVault(vaultRef: string): Promise<CreditPosition | null> {
    await this.ensureLoaded();
    const pos = Object.values(this.memoryState.positions).find((p) => p.vaultRef === vaultRef);
    return pos ? structuredClone(pos) : null;
  }

  async listPositions(): Promise<CreditPosition[]> {
    await this.ensureLoaded();
    return structuredClone(Object.values(this.memoryState.positions));
  }

  async savePosition(position: CreditPosition): Promise<CreditPosition> {
    await this.ensureLoaded();
    this.memoryState.positions[position.id] = structuredClone(position);
    await this.persist();
    return structuredClone(position);
  }

  // --- Receipts ---

  async getReceipts(positionId?: string): Promise<DecisionReceipt[]> {
    await this.ensureLoaded();
    const list = positionId
      ? this.memoryState.receipts.filter((r) => r.positionId === positionId)
      : this.memoryState.receipts;
    return structuredClone(list).reverse();
  }

  async addReceipt(receipt: DecisionReceipt): Promise<void> {
    await this.ensureLoaded();
    this.memoryState.receipts.push(structuredClone(receipt));
    await this.persist();
  }

  // --- Idempotency / Processed Draws ---

  async getProcessedDraw(fingerprint: string): Promise<DecisionReceipt | undefined> {
    await this.ensureLoaded();
    const r = this.memoryState.processedDraws[fingerprint];
    return r ? structuredClone(r) : undefined;
  }

  async getAllProcessedDraws(): Promise<Record<string, DecisionReceipt>> {
    await this.ensureLoaded();
    return structuredClone(this.memoryState.processedDraws);
  }

  async rememberProcessedDraw(fingerprint: string, receipt: DecisionReceipt): Promise<void> {
    await this.ensureLoaded();
    this.memoryState.processedDraws[fingerprint] = structuredClone(receipt);
    await this.persist();
  }

  // --- Proofs ---

  async saveProof(proof: LoanHealthProof): Promise<void> {
    await this.ensureLoaded();
    this.memoryState.proofs[proof.digest] = structuredClone(proof);
    await this.persist();
  }

  // --- State Reset (admin/demo only; route is token-gated) ---

  async reset(): Promise<void> {
    await this.ensureLoaded();
    this.memoryState.positions = { pos_demo_01: seedDemoPosition() };
    this.memoryState.receipts = [];
    this.memoryState.processedDraws = {};
    this.memoryState.proofs = {};
    await this.persist();
  }
}

export const db = new StorageRepository();
