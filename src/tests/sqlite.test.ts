import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorageRepository } from "@/lib/db/sqlite";
import { seedDemoPosition } from "@/lib/db/storage";
import { fixtureProof } from "@/lib/proofs/fixtures";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";
import type { CreditPosition, DecisionReceipt } from "@/lib/domain/types";

let dataDir: string;

function openRepository(): SqliteStorageRepository {
  return new SqliteStorageRepository();
}

function sampleReceipt(positionId: string, id = createReceiptId()): DecisionReceipt {
  return createReceipt({
    id,
    positionId,
    action: "DRAW",
    requestedAmount: 100,
    previousState: "COLLATERALIZED",
    result: "ALLOW",
    reason: "ok",
    resultingState: "ACTIVE",
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "drawbound-sqlite-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

describe("SQLite storage backend", () => {
  it("seeds and round-trips positions, receipts, draws, and proofs", async () => {
    const repo = openRepository();

    const seeded = await repo.getPosition("pos_demo_01");
    expect(seeded?.id).toBe("pos_demo_01");

    const updated: CreditPosition = { ...(seeded as CreditPosition), debtUnits: 250, nonce: 4, state: "ACTIVE" };
    await repo.savePosition(updated);
    expect((await repo.getPosition("pos_demo_01"))?.debtUnits).toBe(250);

    const foundByVault = await repo.getPositionByVault((seeded as CreditPosition).vaultRef);
    expect(foundByVault?.id).toBe("pos_demo_01");

    await repo.addReceipt(sampleReceipt("pos_demo_01", "rcpt_sqlite_1"));
    await repo.addReceipt(sampleReceipt("pos_demo_01", "rcpt_sqlite_2"));
    const receipts = await repo.getReceipts("pos_demo_01");
    expect(receipts.map((r) => r.id)).toEqual(["rcpt_sqlite_2", "rcpt_sqlite_1"]); // newest first

    await repo.rememberProcessedDraw("pos_demo_01:DRAW:100:0", receipts[0]);
    expect((await repo.getProcessedDraw("pos_demo_01:DRAW:100:0"))?.id).toBe("rcpt_sqlite_2");
    expect(Object.keys(await repo.getAllProcessedDraws())).toContain("pos_demo_01:DRAW:100:0");

    const proof = fixtureProof("healthy", { positionId: "pos_demo_01" });
    await repo.saveProof(proof);

    // A NEW instance sees the same durable state (that is the point of SQLite).
    const second = openRepository();
    expect((await second.getPosition("pos_demo_01"))?.nonce).toBe(4);
    expect((await second.getReceipts("pos_demo_01")).length).toBe(2);
    expect((await second.getProcessedDraw("pos_demo_01:DRAW:100:0"))?.id).toBe("rcpt_sqlite_2");
  });

  it("imports an existing JSON store on first open and archives the file", async () => {
    // Write a legacy JSON store first.
    const legacyPosition: CreditPosition = { ...seedDemoPosition(), debtUnits: 123, nonce: 9 };
    const legacyReceipt = sampleReceipt(legacyPosition.id, "rcpt_legacy_1");
    const legacyProof = fixtureProof("healthy", { positionId: legacyPosition.id });
    writeFileSync(
      path.join(dataDir, "drawbound.json"),
      JSON.stringify({
        positions: { [legacyPosition.id]: legacyPosition },
        receipts: [legacyReceipt],
        processedDraws: { "pos_demo_01:DRAW:100:5": legacyReceipt },
        proofs: { [legacyProof.digest]: legacyProof },
      }),
      "utf-8",
    );

    const repo = openRepository();
    const migrated = await repo.getPosition("pos_demo_01");
    expect(migrated?.debtUnits).toBe(123);
    expect(migrated?.nonce).toBe(9);
    expect((await repo.getReceipts("pos_demo_01")).some((r) => r.id === "rcpt_legacy_1")).toBe(true);
    expect((await repo.getProcessedDraw("pos_demo_01:DRAW:100:5"))?.id).toBe("rcpt_legacy_1");

    // JSON file is archived, not deleted.
    expect(existsSync(path.join(dataDir, "drawbound.json.imported"))).toBe(true);
    expect(existsSync(path.join(dataDir, "drawbound.json"))).toBe(false);
    const archived = JSON.parse(readFileSync(path.join(dataDir, "drawbound.json.imported"), "utf-8"));
    expect(archived.positions.pos_demo_01.debtUnits).toBe(123);
  });

  it("resets to the seeded demo state", async () => {
    const repo = openRepository();
    const seeded = await repo.getPosition("pos_demo_01");
    await repo.savePosition({ ...(seeded as CreditPosition), debtUnits: 500, state: "FROZEN" });
    await repo.reset();
    const after = await repo.getPosition("pos_demo_01");
    expect(after?.debtUnits).toBe(0);
    expect(after?.state).toBe("COLLATERALIZED");
    expect(await repo.getReceipts("pos_demo_01")).toEqual([]);
  });

  it("flush resolves and writeError stays null on healthy writes", async () => {
    const repo = openRepository();
    await repo.addReceipt(sampleReceipt("pos_demo_01"));
    await repo.flush();
    expect(repo.writeError()).toBeNull();
    expect(existsSync(path.join(dataDir, "drawbound.db"))).toBe(true);
  });
});
