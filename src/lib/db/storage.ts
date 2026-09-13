import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreditPosition, DecisionReceipt, LoanHealthProof } from "../domain/types";
import { fixtureProof } from "../proofs/fixtures";

export interface DatabaseState {
  positions: Record<string, CreditPosition>;
  receipts: DecisionReceipt[];
  processedDraws: Record<string, DecisionReceipt>;
  proofs: Record<string, LoanHealthProof>;
}

const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const DB_FILE = path.join(DEFAULT_DATA_DIR, "drawbound.json");

export class StorageRepository {
  private memoryState: DatabaseState;
  private isLoaded = false;
  private savePromise: Promise<void> | null = null;

  constructor() {
    this.memoryState = {
      positions: {
        pos_demo_01: {
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
        },
      },
      receipts: [],
      processedDraws: {},
      proofs: {},
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.isLoaded) return;
    try {
      await fs.mkdir(DEFAULT_DATA_DIR, { recursive: true });
      const data = await fs.readFile(DB_FILE, "utf-8");
      const parsed = JSON.parse(data) as Partial<DatabaseState>;
      if (parsed.positions) this.memoryState.positions = parsed.positions;
      if (parsed.receipts) this.memoryState.receipts = parsed.receipts;
      if (parsed.processedDraws) this.memoryState.processedDraws = parsed.processedDraws;
      if (parsed.proofs) this.memoryState.proofs = parsed.proofs;
    } catch {
      // File doesn't exist yet or invalid JSON, initialize with defaults
      await this.save();
    }
    this.isLoaded = true;
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(DEFAULT_DATA_DIR, { recursive: true });
      const tempPath = `${DB_FILE}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(this.memoryState, null, 2), "utf-8");
      await fs.rename(tempPath, DB_FILE);
    } catch (err) {
      console.error("[storage] Failed to persist database state:", err);
    }
  }

  private queueSave(): void {
    if (!this.savePromise) {
      this.savePromise = Promise.resolve().then(async () => {
        await this.save();
        this.savePromise = null;
      });
    }
  }

  // --- Positions ---

  async getPosition(positionId = "pos_demo_01"): Promise<CreditPosition | null> {
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
    this.queueSave();
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
    this.queueSave();
  }

  // --- Idempotency / Processed Draws ---

  async getProcessedDraw(fingerprint: string): Promise<DecisionReceipt | undefined> {
    await this.ensureLoaded();
    const r = this.memoryState.processedDraws[fingerprint];
    return r ? structuredClone(r) : undefined;
  }

  async rememberProcessedDraw(fingerprint: string, receipt: DecisionReceipt): Promise<void> {
    await this.ensureLoaded();
    this.memoryState.processedDraws[fingerprint] = structuredClone(receipt);
    this.queueSave();
  }

  // --- Proofs ---

  async saveProof(proof: LoanHealthProof): Promise<void> {
    await this.ensureLoaded();
    this.memoryState.proofs[proof.digest] = structuredClone(proof);
    this.queueSave();
  }

  // --- State Reset (for test / demo admin) ---

  async reset(): Promise<void> {
    this.memoryState.positions = {
      pos_demo_01: {
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
      },
    };
    this.memoryState.receipts = [];
    this.memoryState.processedDraws = {};
    this.memoryState.proofs = {};
    await this.save();
  }
}

export const db = new StorageRepository();
