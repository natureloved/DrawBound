import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Isolate persistence before any store/db access.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "drawbound-store-"));

import {
  connectVault,
  getPosition,
  listPositions,
  positionIdForVault,
  rememberProcessedDraw,
  getProcessedDraw,
  savePosition,
  transitionFingerprint,
} from "@/lib/store";
import { createReceipt, createReceiptId } from "@/lib/receipts/create";

beforeAll(() => {
  // Ensure the module-level DATA_DIR is the temp dir even if env loading races.
  expect(process.env.DATA_DIR).toContain("drawbound-store-");
});

describe("multi-position store", () => {
  it("derives deterministic position ids from vault refs", () => {
    expect(positionIdForVault("tb1pABCxyz")).toBe("pos_tb1pABCxyz");
    expect(positionIdForVault("tb1p:colon-dash")).toBe("pos_tb1pcolondash");
  });

  it("creates independent positions for independent vaults", async () => {
    const a = await connectVault("tb1pvault-a", 5000);
    const b = await connectVault("tb1pvault-b", 20000);

    expect(a.id).not.toBe(b.id);
    expect(a.creditLimitUnits).toBe(500); // 5000 sats / 10
    expect(b.creditLimitUnits).toBe(2000); // 20000 sats / 10

    const all = await listPositions();
    const ids = all.map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("restores an existing position on reconnect instead of clobbering it", async () => {
    const first = await connectVault("tb1pvault-restore", 5000);
    const drawn = await savePosition({ ...first, debtUnits: 250, nonce: 2, state: "ACTIVE" });

    // Reconnect with a fresh live-read collateral value: debt/nonce must survive.
    const restored = await connectVault("tb1pvault-restore", 6000);
    expect(restored.id).toBe(drawn.id);
    expect(restored.debtUnits).toBe(250);
    expect(restored.nonce).toBe(2);
    expect(restored.state).toBe("ACTIVE");
    expect(restored.collateralSats).toBe(6000);
    // Limit follows collateral but never drops below outstanding debt.
    expect(restored.creditLimitUnits).toBeGreaterThanOrEqual(250);
  });

  it("keeps a stable idempotency fingerprint and round-trips processed draws", async () => {
    const fingerprint = transitionFingerprint("pos_x", "DRAW", 100, 3);
    expect(fingerprint).toBe("pos_x:DRAW:100:3");
    expect(transitionFingerprint("pos_x", "DRAW", 100, 3)).toBe(fingerprint);

    const receipt = createReceipt({
      id: createReceiptId(),
      positionId: "pos_x",
      action: "DRAW",
      requestedAmount: 100,
      previousState: "COLLATERALIZED",
      result: "ALLOW",
      reason: "ok",
      resultingState: "ACTIVE",
      createdAt: new Date().toISOString(),
    });
    await rememberProcessedDraw(fingerprint, receipt);
    const found = await getProcessedDraw(fingerprint);
    expect(found?.id).toBe(receipt.id);
    expect(await getProcessedDraw("pos_x:DRAW:100:4")).toBeUndefined();
  });

  it("returns null for unknown positions", async () => {
    expect(await getPosition("pos_does_not_exist")).toBeNull();
  });
});
