import { describe, expect, it } from "vitest";
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
    expect(snapshot.policy.liveWritesEnabled).toBe(false);
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
});
