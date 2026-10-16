/**
 * Live-execution readiness: why a real signet broadcast would be refused, before
 * anybody spends a nonce finding out.
 *
 * `configReadiness()` is synchronous and network-free, so it is safe on a hot path
 * (the health endpoint, the terminal's banner). `probeReadiness()` additionally
 * talks to the daemon and is what an operator runs before arming live writes.
 */
import { env } from "@/lib/config/env";
import { policy } from "@/lib/security/policy";
import { checkVaultRef, expectedChainId, attestDaemonNetwork, summarizeLockedVtxos, type DaemonAttestation } from "./signet";
import { createLiveChainClient, type LiveChainClient } from "./live-client";

export interface ReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  /** False for informational checks that do not block a broadcast. */
  blocking: boolean;
  detail: string;
  fix?: string;
}

export interface ReadinessReport {
  mode: "live" | "fixture";
  network: string;
  baseUrl: string;
  expectedChainId?: string;
  /** True when every blocking gate passes, i.e. a signed txHex would be broadcast. */
  executionReady: boolean;
  /** Human-readable list of what currently blocks live execution. */
  blocking: string[];
  checks: ReadinessCheck[];
  attestation?: DaemonAttestation;
  vault?: { address: string; lockedSats: number; lockedVtxoCount: number; funded: boolean };
}

function check(input: Omit<ReadinessCheck, "blocking"> & { blocking?: boolean }): ReadinessCheck {
  return { blocking: true, ...input };
}

/** Configuration gates only — no network calls. */
export function configReadiness(): ReadinessReport {
  const network = env.network();
  const checks: ReadinessCheck[] = [];

  checks.push(
    check({
      id: "live-enabled",
      label: "Live mode enabled",
      ok: env.liveEnabled(),
      detail: env.liveEnabled() ? "LIVE_TACHI_ENABLED / PROOF_MODE=live is on" : "running in fixture mode: transitions are simulated",
      fix: "set LIVE_TACHI_ENABLED=true (and PROOF_MODE=live)",
    }),
  );

  checks.push(
    check({
      id: "kill-switch",
      label: "Kill switch disarmed",
      ok: !env.killSwitch(),
      detail: env.killSwitch() ? "KILL_SWITCH=true blocks every broadcast" : "KILL_SWITCH=false; broadcasts are permitted",
      fix: "set KILL_SWITCH=false when you intend to broadcast",
    }),
  );

  const mainnet = network === "mainnet";
  checks.push(
    check({
      id: "network",
      label: "Testnet-only",
      ok: !mainnet || policy.mainnetAllowed,
      blocking: mainnet,
      detail: mainnet
        ? policy.mainnetAllowed
          ? "mainnet explicitly allowed"
          : "mainnet requires ALLOW_MAINNET=true alongside LIVE_TACHI_ENABLED and a disarmed kill switch"
        : `TACHI_NETWORK=${network}`,
      fix: mainnet && !policy.mainnetAllowed ? "point TACHI_NETWORK at signet or regtest for testing" : undefined,
    }),
  );

  const vaultRef = process.env.TACHI_VAULT_REF?.trim() ?? "";
  const vaultCheck = vaultRef ? checkVaultRef(vaultRef, network) : { ok: false, reason: "TACHI_VAULT_REF is not set" };
  checks.push(
    check({
      id: "vault-ref",
      label: "Operator vault configured",
      ok: vaultCheck.ok,
      detail: vaultCheck.ok ? `${vaultRef} is a valid ${network} P2TR address` : vaultCheck.reason,
      fix: "set TACHI_VAULT_REF to your funded TAURUS vault address",
    }),
  );

  const allowed = env.allowedVaultRefs();
  const unbound = allowed.filter((ref) => !checkVaultRef(ref, network).ok);
  checks.push(
    check({
      id: "allowlist",
      label: "Vault allowlist",
      ok: allowed.length > 0 && unbound.length === 0,
      detail:
        allowed.length === 0
          ? "ALLOWED_VAULT_REFS is empty; live connect/read/transition would be unbounded"
          : unbound.length > 0
            ? `not valid for ${network}: ${unbound.join(", ")}`
            : `${allowed.length} vault(s) allowlisted`,
      fix: "list the vault addresses live mode may touch, comma-separated",
    }),
  );

  const hasOracle = Boolean(process.env.HAT_ORACLE_URL?.trim());
  const hasKeys = env.proofRelayPublicKeys().length > 0;
  checks.push(
    check({
      id: "proof-anchor",
      label: "Health proof anchor",
      ok: hasOracle || hasKeys,
      detail: hasOracle && hasKeys
        ? "oracle configured and strict signed proofs required"
        : hasOracle
          ? "HAT_ORACLE_URL configured"
          : hasKeys
            ? "PROOF_RELAY_PUBLIC_KEYS require a signed attestation"
            : "health would be self-attested by this server",
      fix: "set HAT_ORACLE_URL and/or PROOF_RELAY_PUBLIC_KEYS",
      // Not blocking: a live process that lacks an anchor cannot boot at all
      // (validatePolicy refuses it), so this is reported for the record.
      blocking: false,
    }),
  );

  checks.push(
    check({
      id: "chain-read",
      label: "Live chain read required",
      ok: env.liveRequiresChainRead(),
      detail: env.liveRequiresChainRead()
        ? "a failed chain read refuses the decision instead of falling back to modeled collateral"
        : "LIVE_REQUIRE_CHAIN_READ=false lets a failed read fall back to modeled collateral",
      fix: "set LIVE_REQUIRE_CHAIN_READ=true",
    }),
  );

  checks.push(
    check({
      id: "attestation",
      label: "Daemon network attestation",
      ok: env.liveRequiresChainAttestation(),
      blocking: !env.liveRequiresChainAttestation(),
      detail: env.liveRequiresChainAttestation()
        ? `daemon must advertise chain id ${expectedChainId(network) ?? "(unset)"}`
        : "LIVE_REQUIRE_CHAIN_ATTESTATION=false: the daemon is never asked which chain it runs",
      fix: "set LIVE_REQUIRE_CHAIN_ATTESTATION=true (or TACHI_EXPECTED_CHAIN_ID for a private daemon)",
    }),
  );

  checks.push(
    check({
      id: "exposure-cap",
      label: "Exposure cap",
      ok: env.maxTestSats() > 0,
      blocking: false,
      detail: `a live transition may commit at most ${env.maxTestSats()} sats of obligation (amount × CREDIT_UNIT_SATS=${env.creditUnitSats()})`,
      fix: "raise MAX_TEST_SATS for a larger funded vault",
    }),
  );

  const blocking = checks.filter((entry) => entry.blocking && !entry.ok);
  return {
    mode: env.liveEnabled() ? "live" : "fixture",
    network,
    baseUrl: env.tachiBaseUrl() ?? `https://rpc-${network}.tachibtc.com`,
    expectedChainId: expectedChainId(network),
    executionReady: blocking.length === 0,
    blocking: blocking.map((entry) => `${entry.label}: ${entry.detail}`),
    checks,
  };
}

/**
 * Configuration gates plus a live daemon probe: chain id, and the vault's real
 * locked value. Never throws — a failure is reported as a failed check so an
 * operator can read the whole picture at once.
 */
export async function probeReadiness(options: { client?: LiveChainClient; vaultRef?: string } = {}): Promise<ReadinessReport> {
  const report = configReadiness();
  const client = options.client ?? createLiveChainClient({ baseUrl: report.baseUrl, timeoutMs: env.liveRequestTimeoutMs() });
  const checks = [...report.checks];

  let attestation: DaemonAttestation;
  try {
    attestation = await attestDaemonNetwork(client, {
      baseUrl: client.baseUrl,
      network: env.network(),
      disabled: !env.liveRequiresChainAttestation(),
    });
  } catch (error) {
    attestation = {
      baseUrl: client.baseUrl,
      expectedChainId: expectedChainId(env.network()),
      advertisedChainId: "",
      version: "",
      height: NaN,
      syncStatus: "",
      network: env.network(),
      ok: false,
      status: "unreachable",
      reason: error instanceof Error ? error.message : "attestation failed",
      observedAt: new Date().toISOString(),
    };
  }
  checks.push(
    check({
      id: "daemon-attested",
      label: "Daemon attested network",
      ok: attestation.ok,
      detail: attestation.reason,
      fix: "point TACHI_BASE_URL at a daemon for TACHI_NETWORK, or set TACHI_EXPECTED_CHAIN_ID",
    }),
  );

  const vaultRef = (options.vaultRef ?? process.env.TACHI_VAULT_REF ?? "").trim();
  if (vaultRef && attestation.ok) {
    try {
      const summary = summarizeLockedVtxos(await client.getLockedVtxos(vaultRef));
      checks.push(
        check({
          id: "vault-funded",
          label: "Vault holds locked value",
          ok: summary.complete && summary.sats > 0,
          detail: !summary.complete
            ? summary.reason
            : summary.sats > 0
              ? `${summary.count} locked VTXO(s), ${summary.sats} sats`
              : "the daemon reports no locked VTXOs for this vault; register the L1 funding outpoint first (docs/tachi-integration.md)",
          fix: "fund the vault on-chain and register it (scripts/operator-live.mts register)",
        }),
      );
      report.vault = { address: vaultRef, lockedSats: summary.sats, lockedVtxoCount: summary.count, funded: summary.complete && summary.sats > 0 };
    } catch (error) {
      checks.push(
        check({
          id: "vault-funded",
          label: "Vault holds locked value",
          ok: false,
          detail: error instanceof Error ? error.message : "locked-VTXO read failed",
          fix: "verify the daemon is reachable and the vault address is correct",
        }),
      );
    }
  }

  const blocking = checks.filter((entry) => entry.blocking && !entry.ok);
  return {
    ...report,
    checks,
    attestation,
    executionReady: blocking.length === 0,
    blocking: blocking.map((entry) => `${entry.label}: ${entry.detail}`),
  };
}
