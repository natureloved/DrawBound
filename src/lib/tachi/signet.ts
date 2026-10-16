/**
 * Signet network binding for the live execution path.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `TACHI_NETWORK=signet` alone does not put this app on signet. It only picks a
 * default base URL. Before this module, a live deployment would happily:
 *   - point `TACHI_BASE_URL` at a regtest (or hostile) daemon and call the
 *     result "signet collateral",
 *   - accept a `bc1p…` mainnet vault address in `ALLOWED_VAULT_REFS` while
 *     configured for signet,
 *   - trust a locked-VTXO payload whose value fields it did not understand
 *     (reading 0 sats and reporting it as a real balance).
 *
 * Everything here is the fix for that class of bug: the chain id the daemon
 * itself advertises (`GET /tachi_nodeInfo`), the bech32 network prefix of every
 * configured vault ref, and tolerant parsing of the daemon's JSON, all in one
 * place so the read path, the write path and the diagnostics route agree.
 *
 * The chain-id rule mirrors the vendor SDK's own (`assertDaemonChainId` in
 * `@tachibtc/taurus-vault-core`): exact match after case folding, with one
 * deliberate allowance — a bare bitcoin network name (`"signet"`) matches a
 * chain id that carries it as a token (`"tachi-signet-1"`).
 */
import { chainIdForWalletChain } from "@tachibtc/taurus-vault-core";
import { decodeSegwitAddress } from "@/lib/wallet/bech32";
import { env } from "@/lib/config/env";
import { TachiLiveError } from "./errors";

export type TachiLiveNetwork = "signet" | "regtest" | "mainnet";

/** bech32 human-readable prefix per network. signet and testnet share `tb`. */
export const BECH32_HRP: Record<TachiLiveNetwork, string> = {
  signet: "tb",
  regtest: "bcrt",
  mainnet: "bc",
};

/** Fixture-style vault references (`vault:taurus:signet:…`) — never a chain address. */
export function isFixtureVaultRef(ref: string): boolean {
  return ref.startsWith("vault:") || ref.includes("drawbound-demo") || ref.startsWith("tb1pdemo");
}

/**
 * The chain id a daemon must advertise for `network`.
 *
 * signet/regtest come from the vendor's own constant so a hosted-daemon rename
 * is a package update, not a hunt through this repo. Mainnet has no default: an
 * operator who has truly opted into mainnet must state the chain id explicitly.
 */
export function expectedChainId(network = env.network() as TachiLiveNetwork): string | undefined {
  const override = env.expectedChainId();
  if (override) return override;
  if (network === "signet" || network === "regtest") return chainIdForWalletChain(network);
  return undefined;
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * True when `advertised` is the chain id `expected` names.
 *
 * Accepts the exact string, or a bare network name matching a token of the
 * full chain id (either direction), matching the vendor's rule.
 */
export function chainIdMatches(advertised: string, expected: string): boolean {
  const a = advertised.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  if (!a || !e) return false;
  if (a === e) return true;
  const aTokens = tokens(a);
  const eTokens = tokens(e);
  if (aTokens.length === 1) return eTokens.includes(aTokens[0]);
  if (eTokens.length === 1) return aTokens.includes(eTokens[0]);
  return false;
}

// ── Node info ─────────────────────────────────────────────────────────────────

export interface DaemonNodeInfo {
  chainId: string;
  network: string;
  version: string;
  height: number;
  syncStatus: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  if (typeof value === "bigint") return Number(value);
  return NaN;
}

/** Tolerant read of `GET /tachi_nodeInfo`, which has shipped under several field spellings. */
export function normalizeNodeInfo(payload: unknown): DaemonNodeInfo {
  const record = (payload ?? {}) as Record<string, unknown>;
  const chainId = str(record.chain_id) || str(record.chainId) || str(record.network);
  return {
    chainId,
    network: str(record.network) || chainId,
    version: str(record.version),
    height: int(record.latest_block_height ?? record.latestBlockHeight ?? record.height),
    syncStatus: str(record.sync_status) || str(record.syncStatus),
  };
}

// ── Network attestation ───────────────────────────────────────────────────────

export interface DaemonAttestation {
  baseUrl: string;
  expectedChainId?: string;
  advertisedChainId: string;
  version: string;
  height: number;
  syncStatus: string;
  network: TachiLiveNetwork;
  /** True when the daemon's advertised chain id matches the configured network. */
  ok: boolean;
  /** Why it is not ok (or why the check was skipped). */
  reason: string;
  /** "attested" | "mismatch" | "unreachable" | "skipped" */
  status: "attested" | "mismatch" | "unreachable" | "skipped";
  observedAt: string;
}

export interface NodeInfoReader {
  getNodeInfo(): Promise<unknown>;
}

/**
 * Attestations are cached per daemon base URL: every live read and every
 * broadcast would otherwise pay an extra round trip, and the answer does not
 * change while the process runs. Entries expire after `env.liveAttestationTtlMs()`
 * so an operator who repoints the daemon (or restarts it on another chain) is
 * picked up without a restart.
 */
const ATTESTATIONS = new Map<string, { at: number; record: DaemonAttestation }>();

/** Test/ops helper: drop cached attestations so the next live call re-checks. */
export function resetNetworkAttestationCache(): void {
  ATTESTATIONS.clear();
}

function loopbackHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export interface AttestOptions {
  baseUrl: string;
  network: TachiLiveNetwork;
  /** Skip the check entirely (documented escape hatch for private daemons). */
  disabled?: boolean;
  now?: number;
}

/**
 * Ask the daemon which chain it is on and compare it with the configured
 * network. Never throws: a failure is reported in the returned record so the
 * caller decides how loudly to be. The write path throws (see
 * `assertAttested`); the diagnostics path reports.
 */
export async function attestDaemonNetwork(client: NodeInfoReader, options: AttestOptions): Promise<DaemonAttestation> {
  const now = options.now ?? Date.now();
  const cached = ATTESTATIONS.get(options.baseUrl);
  if (cached && now - cached.at < env.liveAttestationTtlMs()) return cached.record;

  const base = {
    baseUrl: options.baseUrl,
    expectedChainId: expectedChainId(options.network),
    network: options.network,
    observedAt: new Date(now).toISOString(),
  } satisfies Omit<DaemonAttestation, "advertisedChainId" | "version" | "height" | "syncStatus" | "ok" | "reason" | "status">;

  if (options.disabled) {
    const record: DaemonAttestation = {
      ...base,
      advertisedChainId: "",
      version: "",
      height: NaN,
      syncStatus: "",
      ok: true,
      status: "skipped",
      reason: "network attestation disabled by LIVE_REQUIRE_CHAIN_ATTESTATION=false; the daemon was not asked which chain it runs",
    };
    ATTESTATIONS.set(options.baseUrl, { at: now, record });
    return record;
  }

  let info: DaemonNodeInfo;
  try {
    info = normalizeNodeInfo(await client.getNodeInfo());
  } catch (error) {
    // Failures are deliberately NOT cached: a blip must not disable live
    // execution for the rest of the TTL.
    return {
      ...base,
      advertisedChainId: "",
      version: "",
      height: NaN,
      syncStatus: "",
      ok: false,
      status: "unreachable",
      reason: error instanceof Error ? `daemon nodeInfo unreachable: ${error.message}` : "daemon nodeInfo unreachable",
    };
  }

  const expected = base.expectedChainId;
  let ok: boolean;
  let reason: string;
  if (!expected) {
    ok = false;
    reason = `no expected chain id for network "${options.network}"; set TACHI_EXPECTED_CHAIN_ID to the chain id your daemon advertises`;
  } else if (!info.chainId) {
    // The vendor rule: a daemon that advertises nothing fails the check, unless
    // it is an opt-in loopback node (a stripped-down local regtest build).
    ok = loopbackHost(options.baseUrl) && options.network === "regtest";
    reason = ok
      ? `daemon advertises no chain id; accepted because ${options.baseUrl} is a loopback regtest endpoint`
      : `daemon advertises no chain id, expected "${expected}"`;
  } else {
    ok = chainIdMatches(info.chainId, expected);
    reason = ok ? `daemon chain id "${info.chainId}" matches "${expected}"` : `daemon chain id "${info.chainId}" is not "${expected}"`;
  }

  const record: DaemonAttestation = {
    ...base,
    advertisedChainId: info.chainId,
    version: info.version,
    height: info.height,
    syncStatus: info.syncStatus,
    ok,
    status: ok ? "attested" : "mismatch",
    reason,
  };
  if (ok) ATTESTATIONS.set(options.baseUrl, { at: now, record });
  return record;
}

/** Throw the fail-closed error every live operation starts from. */
export function assertAttested(record: DaemonAttestation): void {
  if (record.ok) return;
  throw new TachiLiveError(
    record.status === "unreachable"
      ? `Refusing live execution: ${record.reason}. The daemon at ${record.baseUrl} must be reachable and attest chain id "${record.expectedChainId ?? "?"}" before any read or broadcast.`
      : `Refusing live execution on an unverified network: ${record.reason} (configured TACHI_NETWORK=${record.network}).`,
    { code: "ATTESTATION", details: { baseUrl: record.baseUrl, status: record.status } },
  );
}

// ── Vault reference binding ───────────────────────────────────────────────────

export interface VaultRefCheck {
  ok: boolean;
  kind: "p2tr" | "fixture" | "unknown";
  /** bech32 prefix observed on the address ("tb" | "bcrt" | "bc"). */
  hrp?: string;
  reason: string;
}

/**
 * Validate a vault reference against the configured network.
 *
 * A P2TR address is only *meaningful* on the chain its bech32 prefix names, and
 * the Tachi daemon keys locked-VTXO lookups on the exact address string, so a
 * mainnet address pasted into a signet deployment is not a typo to be tolerated:
 * it is a query that can never match, or (worse) an allowlist entry that
 * authorizes the wrong chain's coins. `live` mode additionally refuses
 * fixture-style refs, which name no chain at all.
 */
export function checkVaultRef(ref: string, network: TachiLiveNetwork, mode: "live" | "fixture" = "live"): VaultRefCheck {
  const value = ref.trim();
  if (!value) return { ok: false, kind: "unknown", reason: "vault reference is empty" };

  if (isFixtureVaultRef(value)) {
    if (mode === "live") {
      return {
        ok: false,
        kind: "fixture",
        reason: `"${value}" is a fixture vault reference and names no chain address; live mode requires a real TAURUS P2TR address`,
      };
    }
    return { ok: true, kind: "fixture", reason: "fixture vault reference (no chain binding)" };
  }

  // Full validation (charset, checksum, witness version, program length) rather
  // than the prefix sniff bip322-js's isP2TR performs — it happily calls
  // "tb1pINVALID…" a taproot address, which is not a thing a vault can be.
  const decoded = decodeSegwitAddress(value);
  if (!decoded) {
    return { ok: false, kind: "unknown", reason: `"${value}" is not a valid bech32m segwit address (charset, length or checksum)` };
  }
  if (decoded.witnessVersion !== 1) {
    return {
      ok: false,
      kind: "unknown",
      hrp: decoded.hrp,
      reason: `"${value}" is a witness v${decoded.witnessVersion} output; a TAURUS vault is P2TR (witness v1)`,
    };
  }

  const hrp = decoded.hrp;
  const expectedHrp = BECH32_HRP[network];
  if (hrp !== expectedHrp) {
    return {
      ok: false,
      kind: "p2tr",
      hrp,
      reason: `"${value}" is a ${hrp || "foreign-network"} taproot address but TACHI_NETWORK=${network} expects the "${expectedHrp}" prefix`,
    };
  }
  return { ok: true, kind: "p2tr", hrp, reason: `P2TR address valid for ${network}` };
}

/**
 * Refuse a vault ref that does not belong to the configured network. Used by
 * every live operation; `TACHI_VAULT_REF` / `ALLOWED_VAULT_REFS` are additionally
 * checked at boot so a misconfiguration is a startup error, not a surprise.
 */
export function assertVaultRefNetwork(ref: string, network: TachiLiveNetwork, label = "vault reference"): void {
  const check = checkVaultRef(ref, network);
  if (check.ok) return;
  throw new TachiLiveError(`${label} rejected: ${check.reason}`, { code: "POLICY", details: { network } });
}

// ── Daemon payload parsing ────────────────────────────────────────────────────

/**
 * Sats of one VTXO, tolerant of every spelling the daemon family has used.
 *
 * `NaN` means "this entry could not be read", which callers must treat as a
 * failed read: silently summing an unknown field as 0 is how a funded vault
 * becomes a zero-collateral vault and how a live draw gets a wrong health ratio.
 */
export function vtxoSats(record: unknown): number {
  if (typeof record !== "object" || record === null) return NaN;
  const source = record as Record<string, unknown>;
  for (const key of ["amount", "amount_sat", "amount_sats", "amountSats", "value", "value_sats", "valueSats"]) {
    const raw = source[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = typeof raw === "bigint" ? Number(raw) : typeof raw === "number" ? raw : Number(String(raw));
    if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
    return NaN;
  }
  return NaN;
}

export interface LockedVtxoSummary {
  /** Total locked sats. Only trustworthy when `complete` is true. */
  sats: number;
  count: number;
  /** True when every entry parsed; false means the read must be refused. */
  complete: boolean;
  /** True when the response carried no VTXOs at all (a genuinely empty vault). */
  empty: boolean;
  reason: string;
}

/** Sum the locked VTXOs of a `/tachi_vtxoLocked` response, failing loudly on unknown shapes. */
export function summarizeLockedVtxos(payload: unknown): LockedVtxoSummary {
  if (typeof payload !== "object" || payload === null) {
    return { sats: 0, count: 0, complete: false, empty: false, reason: "locked-VTXO response was not an object" };
  }
  const record = payload as Record<string, unknown>;
  const raw = record.vtxos ?? record.vtxos_locked ?? record.locked_vtxos;
  if (!Array.isArray(raw)) {
    // A response without a vtxos list is ambiguous: an empty vault or a changed
    // API. Only `count: 0` with no list is treated as genuinely empty.
    const count = int(record.count);
    if (count === 0) return { sats: 0, count: 0, complete: true, empty: true, reason: "daemon reports zero locked VTXOs" };
    return { sats: 0, count: 0, complete: false, empty: false, reason: "locked-VTXO response has no vtxos array" };
  }
  if (raw.length === 0) return { sats: 0, count: 0, complete: true, empty: true, reason: "no locked VTXOs for this vault" };

  let total = 0;
  for (const entry of raw) {
    const sats = vtxoSats(entry);
    if (!Number.isFinite(sats)) {
      return {
        sats: 0,
        count: raw.length,
        complete: false,
        empty: false,
        reason: `locked-VTXO entry has no readable amount field (saw: ${Object.keys((entry as object) ?? {}).join(",") || "none"})`,
      };
    }
    total += sats;
  }
  return { sats: total, count: raw.length, complete: true, empty: false, reason: `${raw.length} locked VTXO(s)` };
}

export interface BroadcastOutcome {
  /** CheckTx code; non-zero means the mempool refused the transaction. */
  code: number;
  /** Daemon-reported hash. `undefined` when the daemon did not return one. */
  hash?: string;
  log: string;
  raw: Record<string, unknown>;
}

/**
 * Parse the `/tachi_txBroadcastSync` envelope.
 *
 * It is a raw CometBFT proxy: acceptance is reported as HTTP 200 with
 * `result.code`, so a resolved promise proves nothing. The `result` wrapper may
 * or may not be present depending on daemon build, hence the two-level lookup.
 */
export function parseBroadcastOutcome(payload: unknown): BroadcastOutcome {
  const outer = (payload ?? {}) as Record<string, unknown>;
  const inner = typeof outer.result === "object" && outer.result !== null ? (outer.result as Record<string, unknown>) : outer;
  const codeRaw = inner.code ?? inner.Code;
  const code = codeRaw === undefined || codeRaw === null || codeRaw === "" ? 0 : int(codeRaw);
  const hash = str(inner.hash) || str(inner.txid) || str(inner.txHash) || str(outer.hash);
  const log = str(inner.log) || str(inner.Log);
  if (!Number.isFinite(code)) {
    return { code: -1, hash: hash || undefined, log: log || "daemon reported a non-numeric broadcast code", raw: outer };
  }
  return { code, hash: hash || undefined, log, raw: outer };
}

export interface CommitOutcome {
  /** False while the daemon has not indexed the hash yet (HTTP 404 / empty body). */
  found: boolean;
  /** True when the transaction is durably committed. */
  committed: boolean;
  /** True when the daemon reported a terminal failure for this hash. */
  failed: boolean;
  code: number;
  state: string;
  blockHash: string;
  epoch: number;
  log: string;
}

const FAILED_STATE_TOKENS = ["failed", "invalid", "rejected", "absent"];

/**
 * Interpret `GET /tachi_tx?hash=` for the confirmation poll.
 *
 * A `code: 0` broadcast only means the MEMPOOL admitted the transaction;
 * quorum/threshold and fee-balance validation run at FinalizeBlock, so a tx can
 * pass broadcast and still never commit. This is the only place that distinguishes
 * "not yet" from "never", and the live path must not record an ALLOW before it does.
 */
export function parseCommitOutcome(payload: unknown): CommitOutcome {
  const record = (payload ?? {}) as Record<string, unknown>;
  const status = typeof record.status === "object" && record.status !== null ? (record.status as Record<string, unknown>) : {};
  const codeRaw = record.code ?? status.code;
  const code = codeRaw === undefined || codeRaw === null || codeRaw === "" ? 0 : int(codeRaw);
  const state = (str(record.state) || str(status.state)).toLowerCase();
  const blockHash = str(record.blockhash) || str(record.block_hash) || str(record.blockHash);
  const epoch = int(record.epoch);
  const found = Object.keys(record).length > 0 && record.found !== false;
  const failed = found && ((Number.isFinite(code) && code !== 0) || FAILED_STATE_TOKENS.some((token) => state.includes(token)));
  const committed = found && !failed && (Boolean(blockHash) || state === "committed" || (Number.isFinite(epoch) && epoch > 0));
  return {
    found,
    committed,
    failed,
    code: Number.isFinite(code) ? code : -1,
    state,
    blockHash,
    epoch: Number.isFinite(epoch) ? epoch : 0,
    log: str(record.log) || str(status.log),
  };
}

/**
 * The daemon's own reading of a tx, from `POST /tachi_txDecode`.
 *
 * `inputs`/`outputs` are `undefined` when the daemon does not report them, which
 * is deliberately distinct from `0` (a decoded transaction with no inputs is a
 * reason to refuse; a daemon that omits the field is not).
 */
export function parseDecodedTx(payload: unknown): {
  txHash: string;
  type: string;
  nonce: number;
  feeSats: number;
  inputs?: number;
  outputs?: number;
} {
  const record = (payload ?? {}) as Record<string, unknown>;
  const fee = record.fee ?? record.fee_sats ?? record.feeSats;
  return {
    txHash: str(record.tx_hash) || str(record.txHash) || str(record.hash),
    type: str(record.type),
    nonce: int(record.nonce),
    feeSats: Number.isFinite(int(fee)) ? Math.abs(int(fee)) : NaN,
    inputs: Array.isArray(record.vin) ? record.vin.length : undefined,
    outputs: Array.isArray(record.vout) ? record.vout.length : undefined,
  };
}
