import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attestDaemonNetwork,
  assertAttested,
  chainIdMatches,
  checkVaultRef,
  expectedChainId,
  normalizeNodeInfo,
  parseBroadcastOutcome,
  parseCommitOutcome,
  parseDecodedTx,
  resetNetworkAttestationCache,
  summarizeLockedVtxos,
  vtxoSats,
} from "@/lib/tachi/signet";

const SIGNET_P2TR = "tb1p9kkv8c66zf8qsz9kd9nq2n3fxrytcrde8cae8qzu9ahwlfv92fyqa4mzx3";
const MAINNET_P2TR = "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";
const REGTEST_P2TR = "bcrt1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqm3usuw";

describe("chain id matching", () => {
  it("accepts the exact id in either case", () => {
    expect(chainIdMatches("tachi-signet-1", "tachi-signet-1")).toBe(true);
    expect(chainIdMatches("TACHI-Signet-1", "tachi-signet-1")).toBe(true);
  });

  it("accepts a bare network name against a token-bearing chain id, both directions", () => {
    expect(chainIdMatches("signet", "tachi-signet-1")).toBe(true);
    expect(chainIdMatches("tachi-signet-1", "signet")).toBe(true);
  });

  it("never confuses signet with regtest or mainnet", () => {
    expect(chainIdMatches("tachi-regtest-1", "tachi-signet-1")).toBe(false);
    expect(chainIdMatches("bitcoin-mainnet-1", "tachi-signet-1")).toBe(false);
    expect(chainIdMatches("", "tachi-signet-1")).toBe(false);
  });

  it("derives the expected id from the network and honors the override", () => {
    delete process.env.TACHI_EXPECTED_CHAIN_ID;
    expect(expectedChainId("signet")).toBe("tachi-signet-1");
    expect(expectedChainId("regtest")).toBe("tachi-regtest-1");
    // Mainnet has no published default on purpose: an operator has to state it.
    expect(expectedChainId("mainnet")).toBeUndefined();
    process.env.TACHI_EXPECTED_CHAIN_ID = "my-private-chain";
    expect(expectedChainId("signet")).toBe("my-private-chain");
    delete process.env.TACHI_EXPECTED_CHAIN_ID;
  });
});

describe("vault reference binding", () => {
  it("accepts a P2TR address only on its own network", () => {
    expect(checkVaultRef(SIGNET_P2TR, "signet").ok).toBe(true);
    expect(checkVaultRef(MAINNET_P2TR, "signet", "live")).toMatchObject({ ok: false, kind: "p2tr" });
    expect(checkVaultRef(REGTEST_P2TR, "regtest").ok).toBe(true);
    expect(checkVaultRef(REGTEST_P2TR, "signet").reason).toMatch(/"tb" prefix/);
  });

  it("rejects non-taproot and malformed references", () => {
    expect(checkVaultRef("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "signet").reason).toMatch(/witness v0/);
    expect(checkVaultRef("not-an-address", "signet").reason).toMatch(/not a valid bech32m segwit address/);
    expect(checkVaultRef("   ", "signet").reason).toMatch(/empty/);
    // A signet-prefix string that is not a valid checksum is still refused.
    expect(checkVaultRef("tb1p0000000000000000000000000000000000000000000000000000abcd", "signet").ok).toBe(false);
  });

  it("treats fixture refs as fixture-only", () => {
    expect(checkVaultRef("vault:taurus:signet:demo", "signet", "fixture").ok).toBe(true);
    expect(checkVaultRef("vault:taurus:signet:demo", "signet", "live").ok).toBe(false);
    expect(checkVaultRef("vault:taurus:signet:demo", "signet", "live").reason).toMatch(/no chain address/);
  });
});

describe("daemon payload parsing", () => {
  it("reads VTXO values across the spellings the daemon family has used", () => {
    expect(vtxoSats({ amount: 1200 })).toBe(1200);
    expect(vtxoSats({ amount_sat: "800" })).toBe(800);
    expect(vtxoSats({ amountSats: 800n })).toBe(800);
    expect(vtxoSats({ value: "50" })).toBe(50);
    // Unknown field names are NaN, i.e. "unreadable", never 0.
    expect(vtxoSats({ sats: 900 })).toBeNaN();
    expect(vtxoSats({ amount: -5 })).toBeNaN();
    expect(vtxoSats(null)).toBeNaN();
  });

  it("sums locked VTXOs and flags an unreadable response instead of reporting zero", () => {
    expect(summarizeLockedVtxos({ vtxos: [{ amount: 10 }, { amount_sat: "20" }] })).toMatchObject({
      sats: 30,
      count: 2,
      complete: true,
      empty: false,
    });
    expect(summarizeLockedVtxos({ vtxos: [] })).toMatchObject({ sats: 0, complete: true, empty: true });
    expect(summarizeLockedVtxos({ count: 0 })).toMatchObject({ sats: 0, complete: true, empty: true });
    expect(summarizeLockedVtxos({ count: 2, vtxos: [{ sats: 5 }] })).toMatchObject({ complete: false });
    expect(summarizeLockedVtxos("nope").complete).toBe(false);
  });

  it("treats a 200-with-nonzero-code broadcast as a rejection", () => {
    expect(parseBroadcastOutcome({ result: { code: 0, hash: "abc", log: "" } })).toMatchObject({ code: 0, hash: "abc" });
    expect(parseBroadcastOutcome({ result: { code: 2, log: "tx already exists" } })).toMatchObject({ code: 2 });
    // Some builds answer at the top level, and use `txid` for the hash.
    expect(parseBroadcastOutcome({ code: 0, txid: "def" })).toMatchObject({ code: 0, hash: "def" });
    // A non-numeric code must not be mistaken for success.
    expect(parseBroadcastOutcome({ result: { code: "oops" } }).code).toBe(-1);
  });

  it("distinguishes pending from committed from failed", () => {
    expect(parseCommitOutcome({ state: "pending" })).toMatchObject({ found: true, committed: false, failed: false });
    expect(parseCommitOutcome({ state: "committed", blockhash: "b1", epoch: 9 })).toMatchObject({ committed: true, blockHash: "b1", epoch: 9 });
    expect(parseCommitOutcome({ state: "failed", code: 5, log: "quorum" })).toMatchObject({ failed: true, code: 5 });
    expect(parseCommitOutcome({})).toMatchObject({ found: false, committed: false });
    expect(parseCommitOutcome({ status: { code: 1 } }).failed).toBe(true);
  });

  it("reports a decoded fee and omits input counts the daemon did not send", () => {
    expect(parseDecodedTx({ tx_hash: "h", fee: 1000, vin: [{}], vout: [{}, {}] })).toMatchObject({
      txHash: "h",
      feeSats: 1000,
      inputs: 1,
      outputs: 2,
    });
    const missing = parseDecodedTx({ type: "transfer" });
    expect(missing.inputs).toBeUndefined();
    expect(missing.feeSats).toBeNaN();
  });

  it("normalizes node info field spellings", () => {
    expect(normalizeNodeInfo({ chainId: "tachi-signet-1", height: "42" })).toMatchObject({ chainId: "tachi-signet-1", height: 42 });
    expect(normalizeNodeInfo({ network: "tachi-regtest-1" })).toMatchObject({ chainId: "tachi-regtest-1" });
    expect(normalizeNodeInfo(undefined)).toMatchObject({ chainId: "", height: NaN });
  });
});

describe("network attestation", () => {
  const base = { baseUrl: "https://stub-daemon.test", network: "signet" as const };
  let nodeInfoCalls = 0;

  beforeEach(() => {
    resetNetworkAttestationCache();
    nodeInfoCalls = 0;
    delete process.env.TACHI_EXPECTED_CHAIN_ID;
    delete process.env.LIVE_REQUIRE_CHAIN_ATTESTATION;
  });

  afterEach(() => {
    resetNetworkAttestationCache();
  });

  const client = (chainId: string) => ({
    getNodeInfo: async () => {
      nodeInfoCalls += 1;
      return { chain_id: chainId };
    },
  });

  it("attests a matching daemon and caches the answer for the TTL", async () => {
    const first = await attestDaemonNetwork(client("tachi-signet-1"), base);
    expect(first).toMatchObject({ ok: true, status: "attested" });
    const second = await attestDaemonNetwork(client("tachi-signet-1"), base);
    expect(second.ok).toBe(true);
    expect(nodeInfoCalls).toBe(1);
  });

  it("does not cache a mismatch, so repointing the daemon is picked up", async () => {
    const bad = await attestDaemonNetwork(client("tachi-regtest-1"), base);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/is not "tachi-signet-1"/);
    await attestDaemonNetwork(client("tachi-signet-1"), base);
    expect(nodeInfoCalls).toBe(2);
  });

  it("reports an unreachable daemon instead of throwing", async () => {
    const record = await attestDaemonNetwork(
      {
        getNodeInfo: async () => {
          throw new Error("ETIMEDOUT");
        },
      },
      base,
    );
    expect(record).toMatchObject({ ok: false, status: "unreachable" });
    expect(record.reason).toMatch(/ETIMEDOUT/);
  });

  it("refuses a public daemon that advertises no chain id, but allows loopback regtest", async () => {
    const empty = { getNodeInfo: async () => ({}) };
    const publicHost = await attestDaemonNetwork(empty, base);
    expect(publicHost.ok).toBe(false);
    expect(() => assertAttested(publicHost)).toThrow(/Refusing live execution/);

    const loopback = await attestDaemonNetwork(empty, { baseUrl: "http://127.0.0.1:26658", network: "regtest" });
    expect(loopback.ok).toBe(true);
    expect(loopback.reason).toMatch(/loopback regtest endpoint/);
  });

  it("says why it skipped the check when attestation is disabled", async () => {
    const record = await attestDaemonNetwork(client("whatever"), { ...base, disabled: true });
    expect(record).toMatchObject({ ok: true, status: "skipped" });
    expect(record.reason).toMatch(/network attestation disabled/);
  });
});
