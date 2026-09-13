import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreditPosition, DecisionReceipt, LoanHealthProof } from "../domain/types";
import { seedDemoPosition } from "./storage";

/**
 * SQLite storage backend (Node 24 built-in `node:sqlite`, zero dependencies).
 *
 * Selected with DB_BACKEND=sqlite. Records are stored as JSON documents inside
 * normal tables — the schema stays flexible while SQL provides durability,
 * atomic transactions, and indexed lookups. On first open, an existing JSON
 * store (drawbound.json) in the same DATA_DIR is imported automatically and
 * renamed to drawbound.json.imported, so switching backends never loses state.
 */

export interface DatabaseStateLike {
  positions: Record<string, CreditPosition>;
  receipts: DecisionReceipt[];
  processedDraws: Record<string, DecisionReceipt>;
  proofs: Record<string, LoanHealthProof>;
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), ".data");
}

function dbFile(): string {
  return path.join(dataDir(), "drawbound.db");
}

function jsonFile(): string {
  return path.join(dataDir(), "drawbound.json");
}

export class SqliteStorageRepository {
  private openPromise: Promise<DatabaseSyncLike> | null = null;

  private async open(): Promise<DatabaseSyncLike> {
    if (!this.openPromise) {
      this.openPromise = (async () => {
        const { DatabaseSync } = await import("node:sqlite");
        await fs.mkdir(dataDir(), { recursive: true });
        const database = new DatabaseSync(dbFile()) as unknown as DatabaseSyncLike;
        database.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = FULL;
          CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS receipts (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            position_id TEXT NOT NULL,
            json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS receipts_position ON receipts (position_id, seq);
          CREATE TABLE IF NOT EXISTS processed_draws (fingerprint TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS proofs (digest TEXT PRIMARY KEY, json TEXT NOT NULL);
        `);
        await this.migrateFromJson(database);
        return database;
      })();
    }
    return this.openPromise;
  }

  /** One-time import of a legacy JSON store; the file is archived after import. */
  private async migrateFromJson(database: DatabaseSyncLike): Promise<void> {
    const positionCount = (database.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number }).n;
    if (positionCount > 0) return;
    let raw: string;
    try {
      raw = await fs.readFile(jsonFile(), "utf-8");
    } catch {
      await this.seedIfEmpty(database);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DatabaseStateLike>;
      if (parsed.positions && Object.keys(parsed.positions).length > 0) {
        database.exec("BEGIN");
        try {
          const putPosition = database.prepare("INSERT OR REPLACE INTO positions (id, json) VALUES (?, ?)");
          for (const position of Object.values(parsed.positions)) putPosition.run(position.id, JSON.stringify(position));
          const putReceipt = database.prepare("INSERT OR REPLACE INTO receipts (id, position_id, json) VALUES (?, ?, ?)");
          for (const receipt of parsed.receipts ?? []) putReceipt.run(receipt.id, receipt.positionId, JSON.stringify(receipt));
          const putDraw = database.prepare("INSERT OR REPLACE INTO processed_draws (fingerprint, json) VALUES (?, ?)");
          for (const [fingerprint, receipt] of Object.entries(parsed.processedDraws ?? {})) putDraw.run(fingerprint, JSON.stringify(receipt));
          const putProof = database.prepare("INSERT OR REPLACE INTO proofs (digest, json) VALUES (?, ?)");
          for (const [digest, proof] of Object.entries(parsed.proofs ?? {})) putProof.run(digest, JSON.stringify(proof));
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      await fs.rename(jsonFile(), `${jsonFile()}.imported`);
      console.log("[storage] Migrated JSON store into SQLite; archived as drawbound.json.imported");
    } catch (error) {
      console.error("[storage] JSON migration failed; starting from seeded state:", error);
      await this.seedIfEmpty(database);
    }
  }

  private async seedIfEmpty(database: DatabaseSyncLike): Promise<void> {
    const positionCount = (database.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number }).n;
    if (positionCount > 0) return;
    const seed = seedDemoPosition();
    database.prepare("INSERT OR REPLACE INTO positions (id, json) VALUES (?, ?)").run(seed.id, JSON.stringify(seed));
  }

  private transaction<T>(database: DatabaseSyncLike, fn: () => T): T {
    database.exec("BEGIN");
    try {
      const result = fn();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  // --- Positions ---

  async getPosition(positionId: string): Promise<CreditPosition | null> {
    const database = await this.open();
    const row = database.prepare("SELECT json FROM positions WHERE id = ?").get(positionId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as CreditPosition) : null;
  }

  async getPositionByVault(vaultRef: string): Promise<CreditPosition | null> {
    const database = await this.open();
    const rows = database.prepare("SELECT json FROM positions").all() as Array<{ json: string }>;
    for (const row of rows) {
      const position = JSON.parse(row.json) as CreditPosition;
      if (position.vaultRef === vaultRef) return position;
    }
    return null;
  }

  async listPositions(): Promise<CreditPosition[]> {
    const database = await this.open();
    const rows = database.prepare("SELECT json FROM positions ORDER BY id").all() as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as CreditPosition);
  }

  async savePosition(position: CreditPosition): Promise<CreditPosition> {
    const database = await this.open();
    database.prepare("INSERT OR REPLACE INTO positions (id, json) VALUES (?, ?)").run(position.id, JSON.stringify(position));
    return structuredClone(position);
  }

  // --- Receipts ---

  async getReceipts(positionId?: string): Promise<DecisionReceipt[]> {
    const database = await this.open();
    const rows = positionId
      ? (database.prepare("SELECT json FROM receipts WHERE position_id = ? ORDER BY seq DESC").all(positionId) as Array<{ json: string }>)
      : (database.prepare("SELECT json FROM receipts ORDER BY seq DESC").all() as Array<{ json: string }>);
    return rows.map((row) => JSON.parse(row.json) as DecisionReceipt);
  }

  async addReceipt(receipt: DecisionReceipt): Promise<void> {
    const database = await this.open();
    database.prepare("INSERT INTO receipts (id, position_id, json) VALUES (?, ?, ?)").run(receipt.id, receipt.positionId, JSON.stringify(receipt));
  }

  // --- Idempotency / Processed Draws ---

  async getProcessedDraw(fingerprint: string): Promise<DecisionReceipt | undefined> {
    const database = await this.open();
    const row = database.prepare("SELECT json FROM processed_draws WHERE fingerprint = ?").get(fingerprint) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as DecisionReceipt) : undefined;
  }

  async getAllProcessedDraws(): Promise<Record<string, DecisionReceipt>> {
    const database = await this.open();
    const rows = database.prepare("SELECT fingerprint, json FROM processed_draws").all() as Array<{ fingerprint: string; json: string }>;
    const out: Record<string, DecisionReceipt> = {};
    for (const row of rows) out[row.fingerprint] = JSON.parse(row.json) as DecisionReceipt;
    return out;
  }

  async rememberProcessedDraw(fingerprint: string, receipt: DecisionReceipt): Promise<void> {
    const database = await this.open();
    database.prepare("INSERT OR REPLACE INTO processed_draws (fingerprint, json) VALUES (?, ?)").run(fingerprint, JSON.stringify(receipt));
  }

  // --- Proofs ---

  async saveProof(proof: LoanHealthProof): Promise<void> {
    const database = await this.open();
    database.prepare("INSERT OR REPLACE INTO proofs (digest, json) VALUES (?, ?)").run(proof.digest, JSON.stringify(proof));
  }

  // --- Reset / maintenance ---

  async reset(): Promise<void> {
    const database = await this.open();
    this.transaction(database, () => {
      database.exec("DELETE FROM positions");
      database.exec("DELETE FROM receipts");
      database.exec("DELETE FROM processed_draws");
      database.exec("DELETE FROM proofs");
    });
    await this.seedIfEmpty(database);
  }

  async flush(): Promise<void> {
    // DatabaseSync writes synchronously; nothing to await.
  }

  writeError(): unknown {
    return null;
  }
}
