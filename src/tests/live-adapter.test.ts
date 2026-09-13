import { describe, expect, it, afterEach } from "vitest";
import { LiveTachiAdapter, type VaultReader } from "@/lib/tachi/live-adapter";
import { FixtureTachiAdapter } from "@/lib/tachi/fixture-adapter";
import { createTachiAdapter, isLiveMode, resetTachiAdapterCache } from "@/lib/tachi";
import { buildDemoTransition, isSyntheticTransition } from "@/lib/wallet/transition-builder";

function stubReader(over: { lockedSats?: number; broadcastHash?: string } = {}): VaultReader {
  return {
    getLockedVtxos: async () => ({ vault: "tb1pstub", count: 1, vtxos: [{ id: "vtxo1", amount: over.lockedSats ?? 4200 }] }),
    broadcastTxSync: async () => ({ hash: over.broadcastHash ?? "deadbeefcafe" }),
  };
}

// A plausibly-sized serialized transaction (>= MIN_REAL_TX_HEX_LENGTH, even hex).
const REAL_TX_HEX = `02000000000101${"ab".repeat(80)}`;

describe("LiveTachiAdapter", () => {
  afterEach(() => {
    delete process.env.TACHI_VAULT_REF;
    delete process.env.ALLOWED_VAULT_REFS;
    delete process.env.KILL_SWITCH;
  });

  it("reads real vault state from the live daemon", async () => {
    const adapter = new LiveTachiAdapter({ reader: stubReader({ lockedSats: 4200 }) });
    const state = await adapter.getVaultState("tb1pstub");
    expect(state.collateralSats).toBe(4200);
    expect(state.exitStatus).toBe("LOCKED");
  });

  it("reports AVAILABLE exit when the vault holds no locked sats", async () => {
    const adapter = new LiveTachiAdapter({ reader: stubReader({ lockedSats: 0 }) });
    const state = await adapter.getVaultState("tb1pstub");
    expect(state.exitStatus).toBe("AVAILABLE");
  });

  it("fails closed when no signed txHex is supplied for a credit transition", async () => {
    process.env.KILL_SWITCH = "false";
    const adapter = new LiveTachiAdapter({ reader: stubReader({}) });
    await expect(
      adapter.submitCreditTransition({ positionId: "pos_demo_01", action: "DRAW", amount: 100, proofDigest: "d".repeat(40) }),
    ).rejects.toThrow(/signed txHex/);
  });

  it("refuses to broadcast the synthetic demo payload", async () => {
    process.env.KILL_SWITCH = "false";
    const adapter = new LiveTachiAdapter({ reader: stubReader({}) });
    const demo = buildDemoTransition({ action: "DRAW", positionId: "pos_demo_01", vaultRef: "tb1pstub", amount: 100, nonce: 0 });
    expect(isSyntheticTransition(demo.txHex)).toBe(true);
    await expect(
      adapter.submitCreditTransition({ positionId: "pos_demo_01", action: "DRAW", amount: 100, txHex: demo.txHex }),
    ).rejects.toThrow(/Synthetic demo transition rejected/);
  });

  it("rejects an implausibly short txHex", async () => {
    process.env.KILL_SWITCH = "false";
    const adapter = new LiveTachiAdapter({ reader: stubReader({}) });
    await expect(
      adapter.submitCreditTransition({ positionId: "pos_demo_01", action: "DRAW", amount: 100, txHex: "0200000001abcd" }),
    ).rejects.toThrow(/plausible serialized Bitcoin transaction/);
  });

  it("fails closed while the kill switch is engaged", async () => {
    process.env.KILL_SWITCH = "true";
    const adapter = new LiveTachiAdapter({ reader: stubReader({}) });
    await expect(
      adapter.submitCreditTransition({ positionId: "pos_demo_01", action: "DRAW", amount: 100, txHex: REAL_TX_HEX }),
    ).rejects.toThrow(/Kill switch/);
  });

  it("broadcasts a real signed txHex and records the transition hash", async () => {
    process.env.KILL_SWITCH = "false";
    const adapter = new LiveTachiAdapter({ reader: stubReader({ broadcastHash: "abc123" }) });
    const result = await adapter.submitCreditTransition({
      positionId: "pos_demo_01",
      action: "DRAW",
      amount: 100,
      proofDigest: "d".repeat(40),
      txHex: REAL_TX_HEX,
    });
    expect(result.transitionRef).toContain("satvm:live:draw:abc123");
  });

  it("resolves a configured vault ref instead of creating one", async () => {
    process.env.TACHI_VAULT_REF = "tb1pconfigured";
    const adapter = new LiveTachiAdapter({ reader: stubReader({}) });
    const vault = await adapter.createVault({ owner: "demo", collateralSats: 1000 });
    expect(vault.vaultRef).toBe("tb1pconfigured");
  });

  it("refuses to create a vault when none is configured", async () => {
    delete process.env.TACHI_VAULT_REF;
    const adapter = new LiveTachiAdapter({ reader: stubReader({}) });
    await expect(adapter.createVault({ owner: "demo", collateralSats: 1000 })).rejects.toThrow(/TACHI_VAULT_REF/);
  });

  it("rejects a vault that is not in ALLOWED_VAULT_REFS", async () => {
    process.env.ALLOWED_VAULT_REFS = "tb1ppermitted";
    const adapter = new LiveTachiAdapter({ reader: stubReader({}) });
    await expect(adapter.getVaultState("tb1pnotpermitted")).rejects.toThrow(/ALLOWED_VAULT_REFS/);
  });
});

describe("adapter factory", () => {
  afterEach(() => {
    delete process.env.LIVE_TACHI_ENABLED;
    delete process.env.PROOF_MODE;
    delete process.env.KILL_SWITCH;
    resetTachiAdapterCache();
  });

  it("returns the fixture adapter by default", () => {
    process.env.LIVE_TACHI_ENABLED = "false";
    process.env.PROOF_MODE = "fixture";
    resetTachiAdapterCache();
    expect(createTachiAdapter()).toBeInstanceOf(FixtureTachiAdapter);
    expect(isLiveMode()).toBe(false);
  });

  it("returns the live adapter when enabled", () => {
    process.env.LIVE_TACHI_ENABLED = "true";
    process.env.KILL_SWITCH = "false";
    resetTachiAdapterCache();
    expect(createTachiAdapter()).toBeInstanceOf(LiveTachiAdapter);
    expect(isLiveMode()).toBe(true);
  });
});
