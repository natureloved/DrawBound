import type { TachiAdapter } from "./adapter";
import { FixtureTachiAdapter } from "./fixture-adapter";
import { LiveTachiAdapter } from "./live-adapter";
import { resetNetworkAttestationCache } from "./signet";
import { env } from "@/lib/config/env";

export type { TachiAdapter, TachiTransitionReceipt } from "./adapter";
export { LiveTachiAdapter, type LiveTransitionReceipt, type LiveVaultRead } from "./live-adapter";
export { createLiveChainClient, type LiveChainClient } from "./live-client";
export {
  attestDaemonNetwork,
  assertVaultRefNetwork,
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
  type DaemonAttestation,
  type LockedVtxoSummary,
  type TachiLiveNetwork,
  type VaultRefCheck,
} from "./signet";
export { TachiLiveError, isTachiLiveError, type TachiLiveErrorCode } from "./errors";

export function isLiveMode(): boolean {
  return env.liveEnabled();
}

/** Build the adapter for the current configuration. */
export function createTachiAdapter(): TachiAdapter {
  return isLiveMode() ? new LiveTachiAdapter() : new FixtureTachiAdapter();
}

let cached: TachiAdapter | null = null;

/**
 * Process-scoped adapter singleton. Callers should use this so the chosen mode is
 * stable for the life of the server process. Restart the server to change modes.
 */
export function getTachiAdapter(): TachiAdapter {
  if (!cached) cached = createTachiAdapter();
  return cached;
}

/**
 * Test/ops helper: drop the cached adapter so mode flips take effect.
 *
 * It also drops the cached network attestations on purpose: an operator who
 * repoints `TACHI_BASE_URL` at another daemon must not keep executing against a
 * chain id this process verified for the previous one.
 */
export function resetTachiAdapterCache(): void {
  cached = null;
  resetNetworkAttestationCache();
}
