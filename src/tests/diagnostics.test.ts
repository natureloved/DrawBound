import { describe, expect, it, vi } from "vitest";
import { GET, redactDiagnosticsSnapshot } from "@/app/api/tachi/diagnostics/route";
import { clearSessions, createSession, SESSION_HEADER } from "@/lib/auth/sessions";
import type { TachiReadOnlySnapshot } from "@/lib/tachi/read-only";

vi.mock("@/lib/tachi/read-only", () => ({
  readTachiSnapshot: vi.fn(async () => snapshotFixture()),
}));

function snapshotFixture(): TachiReadOnlySnapshot {
  return {
    observedAt: "2026-11-22T10:00:00.000Z",
    network: "signet",
    baseUrl: "https://rpc-signet.tachibtc.com",
    health: { status: "ok", advertisedValidators: 1 },
    node: {
      chainId: "tachi-signet-1",
      network: "tachi-signet-1",
      version: "0.39.0",
      syncStatus: "synced",
      latestBlockHeight: 1869363,
      peers: 6,
    },
    liveValidators: { connected: 7, totalKnown: 7 },
    quorum: { source: "consensus", threshold: 5, validatorCount: 7, secp256k1Count: 7, totalConsensusValidators: 7 },
    binding: {
      expectedChainId: "tachi-signet-1",
      advertisedChainId: "tachi-signet-1",
      matched: true,
      detail: "daemon chain id matches",
    },
    policy: {
      mode: "fixture",
      liveReadsEnabled: true,
      liveWritesEnabled: false,
      killSwitch: true,
      mainnetAllowed: false,
      liveReadRequired: true,
      networkAttestationRequired: true,
    },
  };
}

function req(url: string, token?: string): Request {
  return new Request(url, token ? { headers: { [SESSION_HEADER]: token } } : undefined);
}

describe("diagnostics redaction", () => {
  it("redacts a snapshot to status/network/synced/observedAt only", () => {
    expect(redactDiagnosticsSnapshot(snapshotFixture())).toEqual({
      status: "ok",
      network: "signet",
      synced: true,
      observedAt: "2026-11-22T10:00:00.000Z",
    });
  });

  it("serves only the redacted subset to unauthenticated callers", async () => {
    clearSessions();
    const res = await GET(req("https://drawbound.test/api/tachi/diagnostics"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.network).toBe("signet");
    expect(body.synced).toBe(true);
    expect(body.node).toBeUndefined();
    expect(body.quorum).toBeUndefined();
    expect(body.baseUrl).toBeUndefined();
    expect(body.liveValidators).toBeUndefined();
  });

  it("refuses the live probe and vault lookups without a session", async () => {
    clearSessions();
    expect((await GET(req("https://drawbound.test/api/tachi/diagnostics?probe=1"))).status).toBe(401);
    expect((await GET(req("https://drawbound.test/api/tachi/diagnostics?vault=tb1ptest"))).status).toBe(401);
  });

  it("serves the full snapshot to an authenticated session", async () => {
    clearSessions();
    const session = createSession({
      vaultRef: "tb1pdiagnostics",
      positionId: "pos_diagnostics",
      publicKey: "aa".repeat(32),
    });
    const res = await GET(req("https://drawbound.test/api/tachi/diagnostics", session.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.node).toBeDefined();
    expect(body.quorum).toBeDefined();
  });
});
