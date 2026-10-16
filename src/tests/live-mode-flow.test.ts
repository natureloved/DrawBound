import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Live-mode end-to-end flow through the real routes with a stubbed daemon.
 *
 * This is the test that pins the two properties that distinguish "signet
 * integrated" from "signet mentioned":
 *
 *  1. a live position is sized by what the daemon reported — never by the
 *     fixture-mode 5,000-sat rehearsal default;
 *  2. a transition is only recorded as executed once the daemon has confirmed
 *     it, and an ambiguous broadcast is journaled with its hash so a retry
 *     cannot submit the same transaction twice.
 */

// A valid signet P2TR address: the live path rejects anything else, so the
// fixtures here have to be real addresses rather than placeholders.
const VAULT = "tb1p9kkv8c66zf8qsz9kd9nq2n3fxrytcrde8cae8qzu9ahwlfv92fyqa4mzx3";
const ENV_KEYS = [
  "LIVE_TACHI_ENABLED",
  "PROOF_MODE",
  "KILL_SWITCH",
  "TACHI_VAULT_REF",
  "ALLOWED_VAULT_REFS",
  "TACHI_NETWORK",
  "HAT_ORACLE_URL",
  "PROOF_RELAY_PUBLIC_KEYS",
  "LIVE_REQUIRE_CHAIN_READ",
  "MAX_TEST_SATS",
  "CREDIT_UNIT_SATS",
  "ADMIN_TOKEN",
] as const;

const daemon = vi.hoisted(() => ({
  lockedSats: 0,
  readComplete: true,
  chainMatched: true,
  unreachable: false,
  broadcastCode: 0,
  broadcastHash: "cafe1234deadbeef",
  commitStates: [] as Array<{ state: string; blockhash?: string; epoch?: number; code?: number }>,
  calls: [] as string[],
}));

vi.mock("@/lib/tachi/read-only", () => ({
  readTachiSnapshot: vi.fn(async () => {
    daemon.calls.push("snapshot");
    if (daemon.unreachable) throw new Error("GET /tachi_vtxoLocked request failed: ECONNREFUSED");
    return {
      observedAt: new Date().toISOString(),
      network: "signet",
      baseUrl: "https://stub-daemon.test",
      health: { status: "ok", advertisedValidators: 7 },
      node: { chainId: "tachi-signet-1", network: "signet", version: "0.39.0", syncStatus: "synced", latestBlockHeight: 322642, peers: 5 },
      liveValidators: { connected: 7, totalKnown: 7 },
      quorum: { source: "consensus", threshold: 5, validatorCount: 7, secp256k1Count: 7, totalConsensusValidators: 7 },
      vault: {
        address: VAULT,
        lockedVtxoCount: daemon.lockedSats > 0 ? 1 : 0,
        lockedSats: daemon.lockedSats,
        readComplete: daemon.readComplete,
        reason: "1 locked VTXO(s)",
      },
      binding: {
        expectedChainId: "tachi-signet-1",
        advertisedChainId: "tachi-signet-1",
        matched: daemon.chainMatched,
        detail: daemon.chainMatched ? 'daemon chain id "tachi-signet-1" matches' : 'daemon chain id "tachi-regtest-1" is not "tachi-signet-1"',
      },
      policy: {
        mode: "live",
        liveReadsEnabled: true,
        liveWritesEnabled: true,
        killSwitch: false,
        mainnetAllowed: false,
        liveReadRequired: true,
        networkAttestationRequired: true,
      },
    };
  }),
}));

vi.mock("@/lib/tachi/live-client", () => ({
  createLiveChainClient: () => ({
    baseUrl: "https://stub-daemon.test",
    getNodeInfo: async () => ({ chain_id: "tachi-signet-1", network: "signet", version: "0.39.0", latest_block_height: 322642, sync_status: "synced" }),
    getLockedVtxos: async () => {
      daemon.calls.push("locked");
      return { vault: VAULT, count: 1, vtxos: [{ id: "vtxo1", amount: daemon.lockedSats }] };
    },
    decodeTransaction: async (txHex: string) => {
      daemon.calls.push(`decode:${txHex.slice(0, 8)}`);
      return { tx_hash: daemon.broadcastHash, type: "transfer", nonce: 0, fee: 500, vin: [{}], vout: [{}, {}] };
    },
    broadcastTxSync: async (txHex: string) => {
      daemon.calls.push(`broadcast:${txHex.slice(0, 8)}`);
      if (daemon.broadcastCode !== 0) return { result: { code: daemon.broadcastCode, log: "nonce too low" } };
      return { result: { code: 0, hash: daemon.broadcastHash, log: "" } };
    },
    getTransaction: async () => {
      daemon.calls.push("status");
      const state = daemon.commitStates.shift() ?? { state: "committed", blockhash: "block-9", epoch: 9 };
      return { ...state, blockhash: state.blockhash ?? "", epoch: state.epoch ?? 0, log: "" };
    },
  }),
}));

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "drawbound-live-flow-"));

import { POST as connectPost } from "@/app/api/wallet/connect/route";
import { POST as drawPost } from "@/app/api/draw/route";
import { GET as healthGet } from "@/app/api/health/route";
import { clearSessions, SESSION_HEADER } from "@/lib/auth/sessions";
import { clearRateLimits } from "@/lib/security/rate-limit";
import { generateSessionKeypair } from "@/lib/wallet/canonical";
import { signTransitionRequest } from "@/lib/wallet/transition-builder";
import { positionIdForVault, resetStore } from "@/lib/store";
import { resetTachiAdapterCache } from "@/lib/tachi";
import { resetNetworkAttestationCache } from "@/lib/tachi/signet";

const REAL_TX_HEX = `02000000000101${"ab".repeat(80)}`;

function jsonRequest(url: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers[SESSION_HEADER] = token;
  return new Request(`http://localhost${url}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function connectLiveSession() {
  const kp = generateSessionKeypair();
  const response = await connectPost(jsonRequest("/api/wallet/connect", { vaultRef: VAULT, sessionPublicKey: kp.publicKey }));
  const data = await response.json();
  return { response, data, privateKey: kp.privateKey, publicKey: kp.publicKey };
}

describe("live mode against a stubbed signet daemon", () => {
  beforeEach(async () => {
    process.env.LIVE_TACHI_ENABLED = "true";
    process.env.PROOF_MODE = "live";
    process.env.KILL_SWITCH = "false";
    process.env.TACHI_NETWORK = "signet";
    process.env.TACHI_VAULT_REF = VAULT;
    process.env.ALLOWED_VAULT_REFS = VAULT;
    process.env.LIVE_REQUIRE_CHAIN_READ = "true";
    process.env.MAX_TEST_SATS = "5000";
    process.env.CREDIT_UNIT_SATS = "10";
    delete process.env.HAT_ORACLE_URL;
    delete process.env.PROOF_RELAY_PUBLIC_KEYS;

    daemon.lockedSats = 5000;
    daemon.readComplete = true;
    daemon.chainMatched = true;
    daemon.unreachable = false;
    daemon.broadcastCode = 0;
    daemon.broadcastHash = "cafe1234deadbeef";
    daemon.commitStates = [];
    daemon.calls = [];

    await resetStore();
    clearSessions();
    clearRateLimits();
    resetTachiAdapterCache();
    resetNetworkAttestationCache();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    clearSessions();
    await resetStore();
    resetTachiAdapterCache();
    resetNetworkAttestationCache();
  });

  it("refuses to open a session when the collateral read fails", async () => {
    daemon.unreachable = true;
    const { response, data } = await connectLiveSession();
    expect(response.status).toBe(503);
    expect(data.error).toMatch(/read failed/i);
    expect(data.detail).toMatch(/ECONNREFUSED/);
  });

  it("refuses to open a session when the daemon is not on the configured chain", async () => {
    daemon.chainMatched = false;
    const { response, data } = await connectLiveSession();
    expect(response.status).toBe(503);
    expect(data.error).toMatch(/network does not match/i);
  });

  it("refuses an unfunded vault with the funding procedure, and invents no collateral", async () => {
    daemon.lockedSats = 0;
    const { response, data } = await connectLiveSession();
    expect(response.status).toBe(409);
    expect(data.error).toMatch(/no locked VTXOs/i);
    expect(data.hint).toMatch(/operator-live.mts register/);
  });

  it("sizes the position from the real locked sats", async () => {
    daemon.lockedSats = 5000;
    const { response, data } = await connectLiveSession();
    expect(response.status).toBe(200);
    expect(data.lockedSats).toBe(5000);
    expect(data.liveReadOk).toBe(true);
    expect(data.position.collateralSats).toBe(5000);
    expect(data.position.creditLimitUnits).toBe(500);
    expect(data.proofSource).toBe("derived");
    expect(data.proofBasis).toBe("live-chain-read");
  });

  it("broadcasts a signed transition only after the daemon confirms it, and records the daemon hash", async () => {
    const { data, privateKey } = await connectLiveSession();
    const token = data.sessionToken as string;
    const positionId = data.position.id as string;

    const signature = signTransitionRequest(privateKey, { positionId, vaultRef: VAULT, action: "DRAW", amount: 100, nonce: 0 });
    const response = await drawPost(jsonRequest("/api/draw", { amount: 100, nonce: 0, signature, txHex: REAL_TX_HEX }, token));
    const result = await response.json();

    expect(result.decision).toBe("ALLOW");
    expect(result.transition).toMatchObject({ txHash: "cafe1234deadbeef", confirmed: true, chainId: "tachi-signet-1" });
    expect(result.receipt.transitionRef).toBe(`satvm:live:draw:cafe1234deadbeef:${result.receipt.proofDigest.slice(0, 12)}`);
    expect(result.position.debtUnits).toBe(100);
    // decode runs before broadcast; the status poll runs after. Order matters: a
    // broadcast without a decode check spends a nonce on an envelope nobody read.
    const decodeAt = daemon.calls.findIndex((call) => call.startsWith("decode:"));
    const broadcastAt = daemon.calls.findIndex((call) => call.startsWith("broadcast:"));
    const statusAt = daemon.calls.findIndex((call) => call === "status");
    expect(decodeAt).toBeGreaterThan(-1);
    expect(broadcastAt).toBeGreaterThan(decodeAt);
    expect(statusAt).toBeGreaterThan(broadcastAt);
  });

  it("refuses to broadcast the fixture synthetic payload even in live mode", async () => {
    const { data, privateKey } = await connectLiveSession();
    const signature = signTransitionRequest(privateKey, {
      positionId: data.position.id,
      vaultRef: VAULT,
      action: "DRAW",
      amount: 100,
      nonce: 0,
    });
    const demoTx = `dbdemo01${"ab".repeat(80)}`;
    const result = await (
      await drawPost(jsonRequest("/api/draw", { amount: 100, nonce: 0, signature, txHex: demoTx }, data.sessionToken))
    ).json();
    expect(result.decision).toBe("DENY");
    expect(result.reason).toMatch(/Synthetic demo transition rejected/);
    expect(daemon.calls.some((call) => call.startsWith("broadcast:"))).toBe(false);
  });

  it("journals an unconfirmed broadcast so the same transition is never re-submitted", async () => {
    const { data, privateKey } = await connectLiveSession();
    const token = data.sessionToken as string;
    const positionId = data.position.id as string;
    // The daemon accepts the transaction but never reports it committed.
    daemon.commitStates = [{ state: "pending" }, { state: "pending" }, { state: "pending" }];
    process.env.LIVE_CONFIRM_TIMEOUT_MS = "1000";
    process.env.LIVE_POLL_INTERVAL_MS = "5000";

    const body = {
      amount: 100,
      nonce: 0,
      signature: signTransitionRequest(privateKey, { positionId, vaultRef: VAULT, action: "DRAW", amount: 100, nonce: 0 }),
      txHex: REAL_TX_HEX,
    };
    const first = await (await drawPost(jsonRequest("/api/draw", body, token))).json();
    expect(first.decision).toBe("DENY");
    expect(first.reconcile).toBe(true);
    expect(first.pendingTxHash).toBe("cafe1234deadbeef");
    expect(first.position.debtUnits).toBe(0);
    expect(first.receipt.transitionRef).toBe("satvm:live:pending:cafe1234deadbeef");

    const broadcastsAfterFirst = daemon.calls.filter((call) => call.startsWith("broadcast:")).length;
    const retry = await (await drawPost(jsonRequest("/api/draw", body, token))).json();
    expect(retry.receipt.receiptDigest).toBe(first.receipt.receiptDigest);
    expect(daemon.calls.filter((call) => call.startsWith("broadcast:")).length).toBe(broadcastsAfterFirst);
    delete process.env.LIVE_CONFIRM_TIMEOUT_MS;
    delete process.env.LIVE_POLL_INTERVAL_MS;
  });

  it("reports a mempool rejection without inventing a transaction reference", async () => {
    const { data, privateKey } = await connectLiveSession();
    daemon.broadcastCode = 4;
    const signature = signTransitionRequest(privateKey, {
      positionId: data.position.id,
      vaultRef: VAULT,
      action: "DRAW",
      amount: 100,
      nonce: 0,
    });
    const result = await (
      await drawPost(jsonRequest("/api/draw", { amount: 100, nonce: 0, signature, txHex: REAL_TX_HEX }, data.sessionToken))
    ).json();
    expect(result.decision).toBe("DENY");
    expect(result.reason).toMatch(/mempool rejected the transaction \(code=4\): nonce too low/);
    expect(result.receipt.transitionRef ?? "").not.toMatch(/sha256|local/);
    expect(result.position.debtUnits).toBe(0);
  });

  it("reports live readiness (and what blocks execution) on the health endpoint", async () => {
    const payload = await (await healthGet()).json();
    expect(payload.mode).toBe("live");
    expect(payload.live).toMatchObject({ mode: "live", network: "signet", writesEnabled: true, executionReady: true, expectedChainId: "tachi-signet-1" });
    expect(payload.live.blockedBy).toEqual([]);

    process.env.KILL_SWITCH = "true";
    const blocked = await (await healthGet()).json();
    expect(blocked.live.executionReady).toBe(false);
    expect(blocked.live.blockedBy.join(" ")).toMatch(/kill switch/i);
  });

  it("keeps position ids bound to the vault the session connected", async () => {
    const { data } = await connectLiveSession();
    expect(data.position.id).toBe(positionIdForVault(VAULT));
  });
});
