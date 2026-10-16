import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveTachiAdapter } from "@/lib/tachi/live-adapter";
import { FixtureTachiAdapter } from "@/lib/tachi/fixture-adapter";
import { createTachiAdapter, isLiveMode, resetTachiAdapterCache } from "@/lib/tachi";
import { resetNetworkAttestationCache } from "@/lib/tachi/signet";
import { isTachiLiveError } from "@/lib/tachi/errors";
import type { LiveChainClient } from "@/lib/tachi/live-client";
import { buildDemoTransition, isSyntheticTransition } from "@/lib/wallet/transition-builder";

/** Valid signet (tb1p) P2TR address; the live adapter rejects anything else. */
const VAULT = "tb1p9kkv8c66zf8qsz9kd9nq2n3fxrytcrde8cae8qzu9ahwlfv92fyqa4mzx3";
/** Valid mainnet (bc1p) P2TR address — must never be accepted for signet. */
const MAINNET_VAULT = "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";

/** A plausibly-sized serialized transaction (>= 120 hex chars, even length). */
const REAL_TX_HEX = `02000000000101${"ab".repeat(80)}`;

interface StubOptions {
  lockedSats?: number;
  lockedPayload?: unknown;
  chainId?: string;
  broadcastHash?: string;
  broadcastCode?: number;
  broadcastLog?: string;
  broadcastPayload?: unknown;
  decodePayload?: unknown;
  decodeThrows?: boolean;
  commitStates?: Array<{ found?: boolean; state?: string; blockhash?: string; epoch?: number; code?: number; log?: string }>;
  capabilities?: Partial<Record<"decodeTransaction" | "getTransaction" | "getNodeInfo", boolean>>;
}

function stubClient(options: StubOptions = {}) {
  const calls: string[] = [];
  const capabilities = options.capabilities ?? {};
  const commitStates = options.commitStates ?? [{ state: "committed", blockhash: "block-1", epoch: 7 }];
  let commitIndex = 0;
  const client: LiveChainClient = {
    baseUrl: "https://stub-daemon.test",
    getLockedVtxos: async (vault: string) => {
      calls.push(`locked:${vault}`);
      if (options.lockedPayload !== undefined) return options.lockedPayload;
      const sats = options.lockedSats ?? 4200;
      return { vault, count: sats > 0 ? 1 : 0, vtxos: sats > 0 ? [{ id: "vtxo1", amount: sats }] : [] };
    },
    broadcastTxSync: async (tx: string) => {
      calls.push(`broadcast:${tx.slice(0, 12)}`);
      if (options.broadcastPayload !== undefined) return options.broadcastPayload;
      return {
        result: {
          code: options.broadcastCode ?? 0,
          log: options.broadcastLog ?? "",
          ...(options.broadcastHash === undefined ? {} : { hash: options.broadcastHash }),
        },
      };
    },
    getNodeInfo: async () => {
      calls.push("nodeInfo");
      // An empty chainId models a daemon that advertises nothing at all, which is
      // a distinct case from one advertising the wrong chain.
      if (options.chainId === "") return {};
      return {
        chain_id: options.chainId ?? "tachi-signet-1",
        network: "signet",
        version: "0.39.0",
        latest_block_height: 322642,
        sync_status: "synced",
      };
    },
    decodeTransaction: capabilities.decodeTransaction === false ? undefined : async (txHex: string) => {
      calls.push(`decode:${txHex.slice(0, 12)}`);
      if (options.decodeThrows) throw new Error("failed to decode transaction: input 0 sigscript: EOF");
      if (options.decodePayload !== undefined) return options.decodePayload;
      return { tx_hash: "daemonhash0000000000000000000000000000000000000000000000000000", type: "transfer", nonce: 0, fee: 500, vin: [{}], vout: [{}, {}] };
    },
    getTransaction: capabilities.getTransaction === false ? undefined : async () => {
      const state = commitStates[Math.min(commitIndex, commitStates.length - 1)];
      commitIndex += 1;
      return state;
    },
  };
  return { client, calls };
}

function adapterFor(options: StubOptions) {
  const stub = stubClient(options);
  const adapter = new LiveTachiAdapter({ client: stub.client, sleep: async () => {} });
  return { adapter, ...stub };
}

describe("LiveTachiAdapter", () => {
  beforeEach(() => {
    process.env.TACHI_NETWORK = "signet";
    process.env.ALLOWED_VAULT_REFS = VAULT;
    process.env.TACHI_VAULT_REF = VAULT;
    process.env.KILL_SWITCH = "false";
    process.env.LIVE_MAX_FEE_SATS = "5000";
    process.env.MAX_TEST_SATS = "5000";
    process.env.CREDIT_UNIT_SATS = "10";
    resetNetworkAttestationCache();
  });

  afterEach(() => {
    for (const key of [
      "TACHI_NETWORK",
      "TACHI_VAULT_REF",
      "ALLOWED_VAULT_REFS",
      "KILL_SWITCH",
      "LIVE_MAX_FEE_SATS",
      "MAX_TEST_SATS",
      "CREDIT_UNIT_SATS",
      "LIVE_REQUIRE_CHAIN_ATTESTATION",
      "LIVE_REQUIRE_CHAIN_READ",
      "TACHI_EXPECTED_CHAIN_ID",
    ]) {
      delete process.env[key];
    }
    delete process.env.TACHI_BASE_URL;
    delete process.env.HAT_ORACLE_URL;
    delete process.env.PROOF_RELAY_PUBLIC_KEYS;
    resetNetworkAttestationCache();
    resetTachiAdapterCache();
  });

  describe("reads", () => {
    it("reads real vault state from the live daemon after attesting the network", async () => {
      const { adapter, calls } = adapterFor({ lockedSats: 4200 });
      const state = await adapter.getVaultState(VAULT);
      expect(state).toEqual({ collateralSats: 4200, exitStatus: "LOCKED" });
      // The chain-id check is not optional in front of a live read that feeds a gate.
      expect(calls[0]).toBe("nodeInfo");
    });

    it("reports AVAILABLE when the vault genuinely holds nothing", async () => {
      const { adapter } = adapterFor({ lockedSats: 0 });
      const state = await adapter.getVaultState(VAULT);
      expect(state).toEqual({ collateralSats: 0, exitStatus: "AVAILABLE" });
    });

    it("counts every locked VTXO and tolerates the daemon's amount spellings", async () => {
      const { adapter } = adapterFor({
        lockedPayload: {
          vault: VAULT,
          count: 3,
          vtxos: [{ amount_sat: "1200" }, { amount: 800 }, { value: 50 }],
        },
      });
      const read = await adapter.readVault(VAULT);
      expect(read).toMatchObject({ readOk: true, funded: true, collateralSats: 2050, vtxoCount: 3 });
    });

    it("refuses a read whose amounts it cannot parse instead of reporting zero collateral", async () => {
      const { adapter } = adapterFor({ lockedPayload: { vault: VAULT, count: 1, vtxos: [{ id: "x", sats: 900 }] } });
      await expect(adapter.readVault(VAULT)).rejects.toThrow(/unusable/i);
    });

    it("refuses to read a vault on a daemon that is not on the configured network", async () => {
      const { adapter } = adapterFor({ chainId: "tachi-regtest-1" });
      await expect(adapter.readVault(VAULT)).rejects.toThrow(/chain id "tachi-regtest-1" is not "tachi-signet-1"/);
    });

    it("rejects a mainnet vault address in a signet deployment", async () => {
      process.env.ALLOWED_VAULT_REFS = MAINNET_VAULT;
      const { adapter } = adapterFor({});
      await expect(adapter.readVault(MAINNET_VAULT)).rejects.toThrow(
        /is a bc taproot address but TACHI_NETWORK=signet expects the "tb" prefix/,
      );
    });

    it("rejects a fixture-style vault reference in live mode", async () => {
      process.env.ALLOWED_VAULT_REFS = "vault:taurus:signet:drawbound-demo";
      const { adapter } = adapterFor({});
      await expect(adapter.readVault("vault:taurus:signet:drawbound-demo")).rejects.toThrow(/names no chain address/);
    });

    it("rejects a vault that is not in ALLOWED_VAULT_REFS", async () => {
      const { adapter } = adapterFor({});
      await expect(adapter.readVault("tb1p0000000000000000000000000000000000000000000000000000abcd")).rejects.toThrow(
        /ALLOWED_VAULT_REFS/,
      );
    });
  });

  describe("write gates", () => {
    it("fails closed when no signed txHex is supplied for a credit transition", async () => {
      const { adapter, calls } = adapterFor({});
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, vaultRef: VAULT, proofDigest: "d".repeat(40) }),
      ).rejects.toThrow(/signed txHex/);
      expect(calls.filter((c) => c.startsWith("broadcast"))).toHaveLength(0);
    });

    it("refuses a transition that does not name its vault", async () => {
      const { adapter } = adapterFor({});
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: REAL_TX_HEX }),
      ).rejects.toThrow(/requires the transition's vaultRef/);
    });

    it("refuses to broadcast the synthetic demo payload", async () => {
      const { adapter } = adapterFor({});
      const demo = buildDemoTransition({ action: "DRAW", positionId: "pos_1", vaultRef: VAULT, amount: 100, nonce: 0 });
      expect(isSyntheticTransition(demo.txHex)).toBe(true);
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: demo.txHex, vaultRef: VAULT }),
      ).rejects.toThrow(/Synthetic demo transition rejected/);
    });

    it("rejects an implausibly short txHex and tolerates copy/paste whitespace", async () => {
      const { adapter, calls } = adapterFor({ broadcastHash: "abc123" });
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: "0200000001abcd", vaultRef: VAULT }),
      ).rejects.toThrow(/plausible serialized transaction/);

      const padded = `  0x${REAL_TX_HEX.toUpperCase()}\n`;
      const result = await adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: padded, vaultRef: VAULT });
      expect(result.txHash).toBe("abc123");
      expect(calls.some((call) => call === `broadcast:${REAL_TX_HEX.slice(0, 12)}`)).toBe(true);
    });

    it("fails closed while the kill switch is engaged", async () => {
      const { adapter, calls } = adapterFor({});
      process.env.KILL_SWITCH = "true";
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: REAL_TX_HEX, vaultRef: VAULT }),
      ).rejects.toThrow(/Kill switch/);
      expect(calls).toHaveLength(0);
    });

    it("bounds a live transition by MAX_TEST_SATS of obligation", async () => {
      const { adapter, calls } = adapterFor({});
      // 1000 units × 10 sats/unit = 10,000 sats, above the 5,000-sat test cap.
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 1000, txHex: REAL_TX_HEX, vaultRef: VAULT }),
      ).rejects.toThrow(/above MAX_TEST_SATS=5000/);
      expect(calls).toHaveLength(0);
    });

    it("refuses to broadcast when the client cannot verify the outcome", async () => {
      const stub = stubClient({ capabilities: { getTransaction: false } });
      const adapter = new LiveTachiAdapter({ client: stub.client });
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: REAL_TX_HEX, vaultRef: VAULT }),
      ).rejects.toThrow(/cannot decode transactions or look up commit status/);
      expect(stub.calls.filter((c) => c.startsWith("broadcast"))).toHaveLength(0);
    });
  });

  describe("daemon decode check", () => {
    it("does not broadcast a transaction the daemon cannot decode", async () => {
      const { adapter, calls } = adapterFor({ decodeThrows: true });
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: REAL_TX_HEX, vaultRef: VAULT }),
      ).rejects.toThrow(/could not decode this transaction/);
      expect(calls.filter((c) => c.startsWith("broadcast"))).toHaveLength(0);
    });

    it("refuses a fee above LIVE_MAX_FEE_SATS", async () => {
      const { adapter, calls } = adapterFor({ decodePayload: { tx_hash: "h".repeat(32), fee: 9000, vin: [{}], vout: [{}] } });
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: REAL_TX_HEX, vaultRef: VAULT }),
      ).rejects.toThrow(/above LIVE_MAX_FEE_SATS=5000/);
      expect(calls.filter((c) => c.startsWith("broadcast"))).toHaveLength(0);
    });

    it("accepts a decode that omits vin/vout (not every daemon build reports them)", async () => {
      const { adapter } = adapterFor({ decodePayload: { tx_hash: "h".repeat(32), fee: 500 } });
      const result = await adapter.submitCreditTransition({
        positionId: "pos_1",
        action: "DRAW",
        amount: 100,
        txHex: REAL_TX_HEX,
        vaultRef: VAULT,
      });
      expect(result.confirmed).toBe(true);
    });
  });

  describe("broadcast and confirmation", () => {
    it("broadcasts, waits for commit, and records the daemon hash and epoch", async () => {
      const { adapter, calls } = adapterFor({ broadcastHash: "abc123", commitStates: [{ state: "pending" }, { state: "committed", blockhash: "blk", epoch: 42 }] });
      const result = await adapter.submitCreditTransition({
        positionId: "pos_1",
        action: "DRAW",
        amount: 100,
        proofDigest: "d".repeat(40),
        txHex: REAL_TX_HEX,
        vaultRef: VAULT,
      });
      expect(result).toMatchObject({
        txHash: "abc123",
        confirmed: true,
        status: "committed",
        epoch: 42,
        blockHash: "blk",
        chainId: "tachi-signet-1",
      });
      expect(result.transitionRef).toBe(`satvm:live:draw:abc123:${"d".repeat(12)}`);
      expect(calls.filter((c) => c === "nodeInfo")).toHaveLength(1);
    });

    it("treats a non-zero broadcast code as rejection, not success", async () => {
      const { adapter } = adapterFor({ broadcastCode: 2, broadcastLog: "tx already exists in cache" });
      let caught: unknown;
      try {
        await adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: REAL_TX_HEX, vaultRef: VAULT });
      } catch (error) {
        caught = error;
      }
      expect(isTachiLiveError(caught, "REJECTED")).toBe(true);
      expect((caught as Error).message).toMatch(/mempool rejected the transaction \(code=2\): tx already exists in cache/);
    });

    it("reports a terminal FinalizeBlock failure with the transaction hash", async () => {
      const { adapter } = adapterFor({ broadcastHash: "deadbeef", commitStates: [{ state: "failed", code: 5, log: "quorum threshold not met" }] });
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: REAL_TX_HEX, vaultRef: VAULT }),
      ).rejects.toThrow(/rejected the transaction after accepting it \(code=5, state=failed\)/);
    });

    it("surfaces an unconfirmed broadcast with the hash and never invents one", async () => {
      const { adapter } = adapterFor({ broadcastPayload: { result: { code: 0, log: "" } }, decodePayload: {} });
      let caught: unknown;
      try {
        await adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: REAL_TX_HEX, vaultRef: VAULT });
      } catch (error) {
        caught = error;
      }
      // No hash from decode and none from broadcast: refuse rather than record a
      // locally derived sha256 as if the daemon had confirmed it.
      expect(isTachiLiveError(caught, "UNCONFIRMED")).toBe(true);
      expect((caught as Error).message).toMatch(/no transaction hash/);
    });

    it("gives up on confirmation with a reconcile instruction rather than an ALLOW", async () => {
      // Poll interval above the timeout: the deadline is reached on the first miss.
      process.env.LIVE_CONFIRM_TIMEOUT_MS = "1000";
      process.env.LIVE_POLL_INTERVAL_MS = "5000";
      const { adapter } = adapterFor({ broadcastHash: "beef01", commitStates: [{ state: "pending" }] });
      await expect(
        adapter.submitCreditTransition({ positionId: "pos_1", action: "DRAW", amount: 100, txHex: REAL_TX_HEX, vaultRef: VAULT }),
      ).rejects.toThrow(/not observed committed[\s\S]*beef01/);
      delete process.env.LIVE_CONFIRM_TIMEOUT_MS;
      delete process.env.LIVE_POLL_INTERVAL_MS;
    });

    it("uses the daemon hash from the decode when the broadcast echoes none", async () => {
      const { adapter } = adapterFor({
        broadcastPayload: { result: { code: 0 } },
        decodePayload: { tx_hash: "decodedhash", fee: 100, vin: [{}], vout: [{}] },
      });
      const result = await adapter.submitCreditTransition({
        positionId: "pos_1",
        action: "UNLOCK",
        amount: 0,
        txHex: REAL_TX_HEX,
        vaultRef: VAULT,
      });
      expect(result.txHash).toBe("decodedhash");
    });
  });

  describe("vault creation", () => {
    it("resolves the configured vault ref instead of creating one", async () => {
      const { adapter } = adapterFor({});
      await expect(adapter.createVault({ owner: "demo", collateralSats: 1000 })).resolves.toEqual({ vaultRef: VAULT });
    });

    it("refuses to create a vault when none is configured", async () => {
      delete process.env.TACHI_VAULT_REF;
      const { adapter } = adapterFor({});
      await expect(adapter.createVault({ owner: "demo", collateralSats: 1000 })).rejects.toThrow(/TACHI_VAULT_REF/);
    });
  });

  describe("network attestation", () => {
    it("accepts the bare network name as a chain id token", async () => {
      const { adapter } = adapterFor({ chainId: "signet" });
      await expect(adapter.getVaultState(VAULT)).resolves.toMatchObject({ collateralSats: 4200 });
    });

    it("refuses a daemon that advertises no chain id on a public host", async () => {
      const { adapter } = adapterFor({ chainId: "" });
      await expect(adapter.getVaultState(VAULT)).rejects.toThrow(/advertises no chain id/);
    });

    it("honors an explicit TACHI_EXPECTED_CHAIN_ID for a private daemon", async () => {
      process.env.TACHI_EXPECTED_CHAIN_ID = "my-signet-1";
      const { adapter } = adapterFor({ chainId: "tachi-signet-1" });
      await expect(adapter.getVaultState(VAULT)).rejects.toThrow(/is not "my-signet-1"/);
      const ok = adapterFor({ chainId: "my-signet-1" });
      await expect(ok.adapter.getVaultState(VAULT)).resolves.toBeTruthy();
    });

    it("can be explicitly disabled and says so in the error path only when it fails", async () => {
      process.env.LIVE_REQUIRE_CHAIN_ATTESTATION = "false";
      const { adapter, calls } = adapterFor({ chainId: "tachi-regtest-1" });
      await expect(adapter.getVaultState(VAULT)).resolves.toMatchObject({ collateralSats: 4200 });
      expect(calls).not.toContain("nodeInfo");
    });
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
