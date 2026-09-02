import { describe, expect, it } from "vitest";
import { SdkTransport } from "@/lib/tachi/sdk-transport";

const emptyVtxos = async () => ({ vault: "v", count: 0, vtxos: [] });

describe("SDK transport", () => {
  it("only accepts a real SDK broadcast hash", async () => {
    const accepted = new SdkTransport({
      getLockedVtxos: emptyVtxos,
      broadcastTxSync: async () => ({ result: { code: 0, hash: "abc123" } }),
    });
    await expect(accepted.submitTransition({ txHex: "deadbeef" })).resolves.toEqual({ transitionRef: "abc123" });

    const rejected = new SdkTransport({
      getLockedVtxos: emptyVtxos,
      broadcastTxSync: async () => ({ result: { code: 7, log: "invalid tx" } }),
    });
    await expect(rejected.submitTransition({ txHex: "deadbeef" })).rejects.toThrow("invalid tx");
  });
});
