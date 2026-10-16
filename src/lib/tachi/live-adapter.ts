import type { TachiAdapter } from "./adapter";
import { createLiveChainClient, type LiveChainClient } from "./live-client";
import { env } from "@/lib/config/env";
import { policy } from "@/lib/security/policy";
import { redactSecret } from "@/lib/security/redact";
import { isSyntheticTransition } from "@/lib/wallet/transition-builder";
import { TachiLiveError, isTachiLiveError, errorMessage } from "./errors";
import {
  assertAttested,
  attestDaemonNetwork,
  checkVaultRef,
  parseBroadcastOutcome,
  parseCommitOutcome,
  parseDecodedTx,
  summarizeLockedVtxos,
  type DaemonAttestation,
  type LockedVtxoSummary,
} from "./signet";

/**
 * Real Tachi signet/regtest adapter — the live execution path.
 *
 * Safety, in the order it is enforced (every step fails closed):
 *
 *  1. **Network gates** — mainnet needs the full explicit conjunction; the kill
 *     switch blocks every broadcast.
 *  2. **Vault binding** — the ref must be in `ALLOWED_VAULT_REFS` and be a P2TR
 *     address *on the configured network*; fixture-style refs are refused, and so
 *     is a transition that does not say which vault it moves value for.
 *  3. **Exposure cap** — the obligation a live transition creates
 *     (`amount × CREDIT_UNIT_SATS`) must fit `MAX_TEST_SATS` on testnet.
 *  4. **Payload shape** — hex, plausible size, and never the synthetic `dbdemo01`
 *     rehearsal artifact.
 *  5. **Network attestation** — the daemon must itself advertise the chain id
 *     matching `TACHI_NETWORK` (`GET /tachi_nodeInfo`). Without this, "signet" is
 *     only a base-URL guess.
 *  6. **Daemon decode** — `POST /tachi_txDecode` must read the envelope the way the
 *     builder wrote it, and its fee must be inside `LIVE_MAX_FEE_SATS`. This is the
 *     vendor-recommended pre-broadcast check; `/tachi_txValidate` is explicitly NOT,
 *     because current daemons reject transactions they themselves have committed.
 *  7. **Broadcast** — `POST /tachi_txBroadcastSync`. A resolved call is NOT
 *     acceptance: the daemon answers HTTP 200 with a non-zero `result.code`.
 *  8. **Commit confirmation** — poll `GET /tachi_tx?hash=` until the daemon reports a
 *     terminal answer. A mempool acceptance can still be dropped at `FinalizeBlock`
 *     (quorum/threshold and fee-balance checks run only there), so a receipt
 *     claiming a transition happens is written after the daemon says it committed.
 *
 * The adapter performs no key handling, builds no transaction, creates no vault and
 * funds nothing: `txHex` must be a real Taurus-signed transaction supplied by the
 * operator (docs/tachi-integration.md). If confirmation cannot complete, the
 * daemon-reported hash is surfaced rather than a locally derived hash being passed
 * off as a chain reference — and the caller journals it so a retry cannot
 * re-broadcast blind.
 */

/** A real Bitcoin transaction is at least ~100 bytes; refuse anything token-sized. */
const MIN_REAL_TX_HEX_LENGTH = 120;
/** And refuse absurd payloads: 32 KiB serialized is far beyond a VTXO transfer. */
const MAX_REAL_TX_HEX_LENGTH = 65_536;

export interface LiveTransitionReceipt {
  transitionRef: string;
  /** Daemon-reported transaction hash (CometBFT hash), never a local guess. */
  txHash?: string;
  /** True only when the daemon reported the transaction committed. */
  confirmed: boolean;
  /** Tachi epoch the transaction committed in, when reported. */
  epoch?: number;
  blockHash?: string;
  /** Chain id the daemon attested, so a receipt records which chain it moved value on. */
  chainId?: string;
  /** Daemon log line for a rejection, verbatim — this is the useful part. */
  daemonLog?: string;
  /** "committed" is the only value that reaches a successful return. */
  status: "committed";
}

export interface LiveVaultRead {
  vaultRef: string;
  collateralSats: number;
  vtxoCount: number;
  /** True when the daemon answered and every VTXO entry parsed. */
  readOk: true;
  /** False when the vault holds nothing (a real answer, not a failure). */
  funded: boolean;
  reason: string;
  network: string;
  attestation: DaemonAttestation;
}

/**
 * @deprecated name for `LiveChainClient`. It used to be the two-method reader
 * surface (`getLockedVtxos` + `broadcastTxSync`) — which is precisely the shape
 * that let a live broadcast happen with no network verification, no decode check
 * and no confirmation, so the alias now names the full surface instead.
 */
export type VaultReader = LiveChainClient;

function looksLikeRealTransaction(txHex: string): boolean {
  return (
    txHex.length >= MIN_REAL_TX_HEX_LENGTH &&
    txHex.length <= MAX_REAL_TX_HEX_LENGTH &&
    txHex.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(txHex) &&
    !isSyntheticTransition(txHex)
  );
}

/** Tolerate copy/paste artifacts, but nothing that changes the bytes being hashed. */
function normalizeTxHex(raw: string): string {
  return raw.trim().replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
}

export class LiveTachiAdapter implements TachiAdapter {
  private readonly client: LiveChainClient;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    options: {
      baseUrl?: string;
      /** Injected daemon client (tests, or a daemon needing custom transport). */
      client?: LiveChainClient;
      /** @deprecated alias of `client`, kept for existing call sites. */
      reader?: LiveChainClient;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    if (policy.network === "mainnet" && !policy.mainnetAllowed) {
      throw new Error("Live Tachi writes are disabled on mainnet");
    }
    this.client =
      options.client ??
      options.reader ??
      createLiveChainClient({ baseUrl: options.baseUrl, timeoutMs: env.liveRequestTimeoutMs() });
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  get baseUrl(): string {
    return this.client.baseUrl;
  }

  private get network(): "signet" | "regtest" | "mainnet" {
    return policy.network;
  }

  /** Step 5. Cached per daemon URL, so this is not an extra round trip per call. */
  private async attest(): Promise<DaemonAttestation> {
    const record = await attestDaemonNetwork(this.client, {
      baseUrl: this.client.baseUrl,
      network: this.network,
      disabled: !env.liveRequiresChainAttestation(),
    });
    assertAttested(record);
    return record;
  }

  /** Steps 1-2 for reads: the kill switch does not apply, mainnet and binding do. */
  private assertVaultBinding(vaultRef: string | undefined): void {
    if (this.network === "mainnet" && !policy.mainnetAllowed) {
      throw new TachiLiveError("Live mainnet operation is disabled", { code: "POLICY" });
    }
    if (!vaultRef) {
      throw new TachiLiveError("Live operation requires the transition's vaultRef so the allowlist can bind it", { code: "POLICY" });
    }
    const allowed = env.allowedVaultRefs();
    if (allowed.length > 0 && !allowed.includes(vaultRef)) {
      throw new TachiLiveError(`Vault ${vaultRef} is not in ALLOWED_VAULT_REFS; refusing live operation`, { code: "POLICY" });
    }
    // An allowlisted-but-foreign address is the mistake this catches: the daemon
    // indexes locked VTXOs by exact address string, so it can only ever answer 0.
    const check = checkVaultRef(vaultRef, this.network, "live");
    if (!check.ok) {
      throw new TachiLiveError(`Vault reference rejected for ${this.network}: ${check.reason}`, { code: "POLICY" });
    }
  }

  /**
   * Read the vault's real locked value.
   *
   * A failed read throws rather than returning zeros: `readOk: false` ("the daemon
   * did not tell us") and `funded: false` ("the vault is genuinely empty") are
   * different facts with different remedies, and collapsing them is how a live
   * position ends up sized on a number nobody read.
   */
  async readVault(vaultRef: string): Promise<LiveVaultRead> {
    this.assertVaultBinding(vaultRef);
    const attestation = await this.attest();
    let payload: unknown;
    try {
      payload = await this.client.getLockedVtxos(vaultRef);
    } catch (error) {
      throw new TachiLiveError(`Live vault read failed: ${errorMessage(error, "daemon unreachable")}`, {
        code: "CHAIN_READ",
        details: { vaultRef },
      });
    }
    const summary: LockedVtxoSummary = summarizeLockedVtxos(payload);
    if (!summary.complete) {
      throw new TachiLiveError(`Live vault read unusable: ${summary.reason}`, { code: "CHAIN_READ", details: { vaultRef } });
    }
    return {
      vaultRef,
      collateralSats: summary.sats,
      vtxoCount: summary.count,
      readOk: true,
      funded: summary.sats > 0,
      reason: summary.reason,
      network: this.network,
      attestation,
    };
  }

  async createVault(input: { owner: string; collateralSats: number }): Promise<{ vaultRef: string }> {
    const configured = process.env.TACHI_VAULT_REF?.trim();
    if (!configured) {
      throw new TachiLiveError(
        "Live vault creation requires a funded signet vault. Set TACHI_VAULT_REF to a real TAURUS P2TR address; " +
          "DrawBound will not create or fund vaults automatically.",
        { code: "POLICY" },
      );
    }
    this.assertVaultBinding(configured);
    if (!Number.isInteger(input.collateralSats) || input.collateralSats <= 0) {
      throw new TachiLiveError("collateralSats must be a positive whole number of sats", { code: "POLICY" });
    }
    // Live mode never mints a vault: the operator's funded address is the only
    // acceptable answer, and it is reported as-is so the terminal cannot be told a
    // different address was created.
    return { vaultRef: configured };
  }

  async getVaultState(vaultRef: string): Promise<{ collateralSats: number; exitStatus: string }> {
    const read = await this.readVault(vaultRef);
    return {
      collateralSats: read.collateralSats,
      exitStatus: read.collateralSats > 0 ? "LOCKED" : "AVAILABLE",
    };
  }

  private assertWriteGates(input: { vaultRef?: string; action: string; amount: number }): void {
    if (this.network === "mainnet" && !policy.mainnetAllowed) {
      throw new TachiLiveError("Live mainnet credit transitions are disabled", { code: "POLICY" });
    }
    if (env.killSwitch()) {
      throw new TachiLiveError("Kill switch is engaged (KILL_SWITCH=true); live credit transitions are disabled", { code: "POLICY" });
    }
    this.assertVaultBinding(input.vaultRef);

    // Exposure cap. `amount` is in credit UNITS; the sats a transition commits is
    // amount × CREDIT_UNIT_SATS, which is what MAX_TEST_SATS bounds. Testnet only:
    // a mainnet deployment that opted in is not sandboxed by a test cap.
    if (this.network !== "mainnet") {
      const obligationSats = Math.abs(Math.trunc(input.amount)) * env.creditUnitSats();
      if (obligationSats > env.maxTestSats()) {
        throw new TachiLiveError(
          `Live ${input.action} would commit ${obligationSats} sats of obligation, above MAX_TEST_SATS=${env.maxTestSats()}. ` +
            "Raise MAX_TEST_SATS deliberately for a funded vault.",
          { code: "POLICY", details: { obligationSats, maxTestSats: env.maxTestSats() } },
        );
      }
    }
  }

  async submitCreditTransition(input: {
    positionId: string;
    action: "DRAW" | "REPAY" | "UNLOCK";
    amount: number;
    proofDigest?: string;
    txHex?: string;
    /** The position's vault. Required in live mode: it is what the allowlist binds. */
    vaultRef?: string;
  }): Promise<LiveTransitionReceipt> {
    const suffix = input.proofDigest?.slice(0, 12) ?? "no-proof";
    this.assertWriteGates({ vaultRef: input.vaultRef, action: input.action, amount: input.amount });

    if (!input.txHex || typeof input.txHex !== "string" || input.txHex.trim().length === 0) {
      throw new TachiLiveError(
        "Live credit transition requires a signed txHex built via the Taurus wallet tooling; " +
          "DrawBound will not broadcast an unsigned transition (fail closed).",
        { code: "PAYLOAD" },
      );
    }
    const txHex = normalizeTxHex(input.txHex);
    if (isSyntheticTransition(txHex)) {
      throw new TachiLiveError(
        "Synthetic demo transition rejected: live mode broadcasts real Bitcoin transactions only. " +
          "Build and sign the txHex with the Taurus wallet tooling (docs/tachi-integration.md).",
        { code: "PAYLOAD" },
      );
    }
    if (!looksLikeRealTransaction(txHex)) {
      throw new TachiLiveError(
        `txHex is not a plausible serialized transaction (even-length hex, ${MIN_REAL_TX_HEX_LENGTH}-${MAX_REAL_TX_HEX_LENGTH} chars); refusing to broadcast`,
        { code: "PAYLOAD" },
      );
    }

    // The daemon-side decode and the status lookup are both mandatory: without them
    // this adapter cannot tell "committed" from "never seen", so it will not
    // broadcast on a handshake it cannot finish.
    const decode = typeof this.client.decodeTransaction === "function" ? this.client.decodeTransaction.bind(this.client) : undefined;
    const txStatus = typeof this.client.getTransaction === "function" ? this.client.getTransaction.bind(this.client) : undefined;
    if (!decode || !txStatus) {
      throw new TachiLiveError(
        "The configured Tachi client cannot decode transactions or look up commit status; live execution requires both",
        { code: "POLICY" },
      );
    }

    const attestation = await this.attest();
    let daemonHash: string | undefined;

    try {
      const decoded = parseDecodedTx(await decode(txHex));
      if (decoded.txHash) daemonHash = decoded.txHash;
      if (Number.isFinite(decoded.feeSats) && decoded.feeSats > env.liveMaxFeeSats()) {
        throw new TachiLiveError(
          `Refusing broadcast: the daemon reads a fee of ${decoded.feeSats} sats, above LIVE_MAX_FEE_SATS=${env.liveMaxFeeSats()}`,
          { code: "PAYLOAD", details: { feeSats: decoded.feeSats } },
        );
      }
      if (decoded.inputs === 0 || decoded.outputs === 0) {
        throw new TachiLiveError(
          `Refusing broadcast: the daemon decoded ${decoded.inputs} input(s) and ${decoded.outputs} output(s), ` +
            "which is not the transfer this protocol signs",
          { code: "PAYLOAD" },
        );
      }
    } catch (error) {
      if (isTachiLiveError(error)) throw error;
      throw new TachiLiveError(
        `Refusing broadcast: the daemon could not decode this transaction (${errorMessage(error, "decode failed")}). ` +
          "Nothing was submitted and no nonce was spent.",
        { code: "PAYLOAD" },
      );
    }

    if (process.env.DEBUG_TACHI === "true") {
      console.log(`[tachi] broadcasting ${input.action} transition for ${input.positionId} tx=${redactSecret(txHex)}`);
    }

    let outcome: ReturnType<typeof parseBroadcastOutcome>;
    try {
      outcome = parseBroadcastOutcome(await this.client.broadcastTxSync(txHex));
    } catch (error) {
      throw new TachiLiveError(`Live broadcast failed: ${errorMessage(error, "daemon unreachable")}`, { code: "REJECTED" });
    }
    if (outcome.code !== 0) {
      throw new TachiLiveError(
        `Tachi mempool rejected the transaction (code=${outcome.code})${outcome.log ? `: ${outcome.log}` : ""}`,
        { code: "REJECTED", txHash: outcome.hash ?? daemonHash, details: { code: outcome.code } },
      );
    }

    // The hash must come from the daemon. A locally derived hash proves nothing
    // about acceptance and must never be recorded as a chain reference.
    const txHash = outcome.hash ?? daemonHash;
    if (!txHash) {
      throw new TachiLiveError(
        "Broadcast was accepted but the daemon returned no transaction hash; reconcile on-chain before retrying " +
          "so the same transition is not submitted twice",
        { code: "UNCONFIRMED" },
      );
    }

    const confirmed = await this.waitForCommit(txHash, txStatus);
    if (confirmed.failed) {
      throw new TachiLiveError(
        `Tachi rejected the transaction after accepting it (code=${confirmed.code}` +
          `${confirmed.state ? `, state=${confirmed.state}` : ""})${confirmed.log ? `: ${confirmed.log}` : ""}. ` +
          "The ledger transition did not happen.",
        { code: "REJECTED", txHash, details: { state: confirmed.state } },
      );
    }
    if (!confirmed.committed) {
      throw new TachiLiveError(
        `Broadcast accepted but not observed committed within ${env.liveConfirmTimeoutMs()}ms (tx ${txHash}); ` +
          "the transaction may still commit — reconcile it before submitting another transition for this position",
        { code: "UNCONFIRMED", txHash },
      );
    }

    return {
      transitionRef: `satvm:live:${input.action.toLowerCase()}:${txHash}:${suffix}`,
      txHash,
      confirmed: true,
      status: "committed",
      epoch: confirmed.epoch || undefined,
      blockHash: confirmed.blockHash || undefined,
      chainId: attestation.advertisedChainId || undefined,
    };
  }

  /** Poll `GET /tachi_tx?hash=` until the daemon reports a terminal answer. */
  private async waitForCommit(
    txHash: string,
    txStatus: (hash: string) => Promise<unknown>,
  ): Promise<ReturnType<typeof parseCommitOutcome>> {
    const deadline = Date.now() + env.liveConfirmTimeoutMs();
    const interval = env.livePollIntervalMs();
    let last = parseCommitOutcome(null);
    for (;;) {
      try {
        last = parseCommitOutcome(await txStatus(txHash));
        if (last.committed || last.failed) return last;
      } catch (error) {
        // A 404 here is the normal answer moments after broadcast ("not indexed
        // yet"), so it keeps polling; the message is kept for the diagnostics trail.
        last = { ...last, log: errorMessage(error, "status lookup failed") };
      }
      const remaining = deadline - Date.now();
      if (remaining <= interval) return last;
      await this.sleep(Math.min(interval, remaining));
    }
  }
}
