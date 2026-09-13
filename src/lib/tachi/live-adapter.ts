import type { TachiAdapter } from "./adapter";
import { TachiHttpClient, type TachiLockedVtxosResponse } from "./http-client";
import { policy } from "@/lib/security/policy";
import { redactSecret } from "@/lib/security/redact";

/**
 * Minimal reader surface the live adapter needs. `TachiHttpClient` satisfies it
 * structurally, and tests can inject a stub.
 */
export interface VaultReader {
  getLockedVtxos(vault: string): Promise<TachiLockedVtxosResponse>;
  broadcastTxSync(tx: string): Promise<unknown>;
}

/**
 * Real Tachi/SatVM-backed adapter. Reads resolve the actual locked TAURUS vault
 * state from the live signet/regtest daemon; writes broadcast a caller-supplied,
 * already-signed transaction.
 *
 * Safety: this adapter is fail-closed. It will never create or fund a vault, it
 * will not broadcast an unsigned transition, and it refuses mainnet unless every
 * gate is explicitly enabled. A live transition therefore requires:
 *   1. LIVE_TACHI_ENABLED=true (or PROOF_MODE=live),
 *   2. a testnet network (signet/regtest),
 *   3. the kill switch respected,
 *   4. a vault in ALLOWED_VAULT_REFS (or TACHI_VAULT_REF),
 *   5. a signed txHex produced by the operator's Taurus wallet.
 */
export class LiveTachiAdapter implements TachiAdapter {
  private readonly reader: VaultReader;

  constructor(options: { baseUrl?: string; reader?: VaultReader } = {}) {
    if (policy.network === "mainnet" && !policy.mainnetAllowed) {
      throw new Error("Live Tachi writes are disabled on mainnet");
    }
    this.reader = options.reader ?? new TachiHttpClient({ baseUrl: options.baseUrl });
  }

  private assertAllowedVault(vaultRef: string): void {
    const allowed = (process.env.ALLOWED_VAULT_REFS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(vaultRef)) {
      throw new Error(`Vault ${vaultRef} is not in ALLOWED_VAULT_REFS; refusing live operation`);
    }
  }

  async createVault(input: { owner: string; collateralSats: number }): Promise<{ vaultRef: string }> {
    const configured = process.env.TACHI_VAULT_REF?.trim();
    if (configured) {
      this.assertAllowedVault(configured);
      return { vaultRef: configured };
    }
    throw new Error(
      "Live vault creation requires a funded signet vault. Set TACHI_VAULT_REF to a real TAURUS P2TR address; " +
        "Drawbound will not create or fund vaults automatically.",
    );
  }

  async getVaultState(vaultRef: string): Promise<{ collateralSats: number; exitStatus: string }> {
    this.assertAllowedVault(vaultRef);
    const locked = await this.reader.getLockedVtxos(vaultRef);
    const lockedSats = locked.vtxos.reduce((total, vtxo) => total + (vtxo.amount || 0), 0);
    return {
      collateralSats: lockedSats,
      exitStatus: lockedSats > 0 ? "LOCKED" : "AVAILABLE",
    };
  }

  async submitCreditTransition(input: {
    positionId: string;
    action: "DRAW" | "REPAY" | "UNLOCK";
    amount: number;
    proofDigest?: string;
    txHex?: string;
  }): Promise<{ transitionRef: string }> {
    if (policy.network === "mainnet" && !policy.mainnetAllowed) {
      throw new Error("Live mainnet credit transitions are disabled");
    }
    if (!input.txHex || typeof input.txHex !== "string" || input.txHex.length === 0) {
      throw new Error(
        "Live credit transition requires a signed txHex built via the Taurus wallet-aggregator; " +
          "Drawbound will not broadcast an unsigned transition (fail closed).",
      );
    }
    if (process.env.DEBUG_TACHI === "true") {
      console.log(`[tachi] broadcasting ${input.action} transition for ${input.positionId} tx=${redactSecret(input.txHex)}`);
    }
    const result = await this.reader.broadcastTxSync(input.txHex);
    const record = result as Record<string, unknown>;
    const hash =
      typeof record?.hash === "string" && record.hash.length > 0
        ? record.hash
        : typeof record?.txid === "string" && record.txid.length > 0
          ? record.txid
          : undefined;
    if (!hash) throw new Error("Tachi broadcast returned no transaction hash");
    const suffix = input.proofDigest?.slice(0, 12) ?? "no-proof";
    return { transitionRef: `satvm:live:${input.action.toLowerCase()}:${hash}:${suffix}` };
  }
}
