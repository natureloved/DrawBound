import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConsensusQuorum } from "@tachibtc/taurus-vault-core";
import { readTachiSnapshot, type TachiReadClient } from "@/lib/tachi/read-only";

const quorum: ConsensusQuorum = {
  source: "consensus",
  threshold: 5,
  nodePubkeys: ["02a", "02b"],
  validators: [
    { pubkeyHex: "aa", compressedHex: "02a" },
    { pubkeyHex: "bb", compressedHex: "02b" },
  ],
  secp256k1Count: 2,
  totalValidators: 2,
};

function stubClient(calls: string[]): TachiReadClient {
  return {
    getHealth: async () => ({ status: "ok", validators: 2 }),
    getNodeInfo: async () => ({
      node_id: "node",
      moniker: "fixture",
      network: "tachi-signet-1",
      chain_id: "tachi-signet-1",
      version: "test",
      latest_block_height: 42,
      latest_block_time: 1,
      epoch_blocks: 10,
      peers: 3,
      sync_status: "synced",
    }),
    getLiveValidators: async () => ({ count: 2, total_known: 2, validators: [] }),
    getLockedVtxos: async (address) => {
      calls.push(address);
      return {
        vault: address,
        count: 2,
        vtxos: [
          { id: "a", owner: "owner", amount: 1200, script: "", height: 1, spent: false },
          { id: "b", owner: "owner", amount: 800, script: "", height: 2, spent: false },
        ],
      };
    },
  };
}

describe("Tachi read-only probe", () => {
  it("normalizes public node and quorum metadata and summarizes locked value", async () => {
    const calls: string[] = [];
    const snapshot = await readTachiSnapshot({
      network: "signet",
      baseUrl: "https://example.test",
      vaultAddress: "tb1ptest",
      client: stubClient(calls),
      quorumReader: async () => quorum,
    });

    expect(snapshot.node.chainId).toBe("tachi-signet-1");
    expect(snapshot.quorum).toMatchObject({ source: "consensus", threshold: 5, validatorCount: 2 });
    expect(snapshot.vault).toMatchObject({ address: "tb1ptest", lockedVtxoCount: 2, lockedSats: 2000 });
    expect(calls).toEqual(["tb1ptest"]);
  });

  it("does not query vault state when no vault address is supplied", async () => {
    const calls: string[] = [];
    const snapshot = await readTachiSnapshot({
      network: "signet",
      baseUrl: "https://example.test",
      client: stubClient(calls),
      quorumReader: async () => quorum,
    });

    expect(snapshot.vault).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  /**
   * The snapshot's policy block feeds `/api/tachi/diagnostics` and the terminal's
   * "Inspect Live Network" panel, so a wrong answer here misinforms the operator
   * about whether writes are armed. It used to hardcode `liveWritesEnabled: false`
   * and drop the conjunction from `mainnetAllowed`.
   */
  describe("policy reporting", () => {
    const KEYS = ["LIVE_TACHI_ENABLED", "PROOF_MODE", "KILL_SWITCH", "ALLOW_MAINNET"] as const;
    let saved: Record<string, string | undefined>;

    const read = () =>
      readTachiSnapshot({
        network: "signet",
        baseUrl: "https://example.test",
        client: stubClient([]),
        quorumReader: async () => quorum,
      });

    beforeEach(() => {
      saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
      for (const key of KEYS) delete process.env[key];
    });

    afterEach(() => {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it("reports fixture and disarmed by default", async () => {
      const { policy } = await read();
      expect(policy.mode).toBe("fixture");
      expect(policy.liveWritesEnabled).toBe(false);
      expect(policy.killSwitch).toBe(true);
      expect(policy.mainnetAllowed).toBe(false);
    });

    it("reports live writes as armed when live is on and the kill switch is off", async () => {
      process.env.LIVE_TACHI_ENABLED = "true";
      process.env.KILL_SWITCH = "false";
      const { policy } = await read();
      expect(policy.mode).toBe("live");
      expect(policy.liveWritesEnabled).toBe(true);
    });

    it("reports live writes as disarmed while the kill switch is engaged", async () => {
      process.env.LIVE_TACHI_ENABLED = "true";
      process.env.KILL_SWITCH = "true";
      const { policy } = await read();
      expect(policy.mode).toBe("live");
      expect(policy.liveWritesEnabled).toBe(false);
    });

    it("requires the full conjunction before reporting mainnet as allowed", async () => {
      // ALLOW_MAINNET on its own must never report mainnet as allowed.
      process.env.ALLOW_MAINNET = "true";
      expect((await read()).policy.mainnetAllowed).toBe(false);

      process.env.LIVE_TACHI_ENABLED = "true";
      process.env.KILL_SWITCH = "false";
      expect((await read()).policy.mainnetAllowed).toBe(true);

      process.env.KILL_SWITCH = "true";
      expect((await read()).policy.mainnetAllowed).toBe(false);
    });
  });
});
