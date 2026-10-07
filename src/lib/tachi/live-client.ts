/**
 * The live chain client used by the signet execution path.
 *
 * WHY WRAP THE SDK RATHER THAN USE `TachiHttpClient`?
 * `TachiHttpClient` is a dependency-free fallback that happens to speak the same
 * routes. The official `@tachibtc/tachi-sdk-ts` client is the supported surface,
 * and for real value movement the difference matters: it enforces a response-size
 * cap (a hostile or buggy daemon cannot OOM the server), refuses to send an API key
 * over cleartext, tags every transport failure with the endpoint that failed, and
 * documents which methods report rejection in the BODY rather than the status line.
 *
 * This module is the only place that touches the SDK for writes. It returns
 * `unknown` on purpose: the daemon's JSON is parsed defensively in
 * `./signet.ts` (`summarizeLockedVtxos`, `parseBroadcastOutcome`, `parseCommitOutcome`)
 * so an upstream field rename surfaces as a refused operation, never as a silent
 * zero.
 */
import type { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { createTachiSdkClient } from "./sdk-client";
import { tachiBaseUrl } from "./http-client";
import { env } from "@/lib/config/env";
import type { NodeInfoReader } from "./signet";

/**
 * Everything the live adapter needs from a daemon. Read methods are safe to retry.
 *
 * `decodeTransaction`/`getTransaction` are optional in the type because an injected
 * minimal client (a stub, a stripped proxy) may not provide them — and the adapter
 * then REFUSES to broadcast rather than broadcasting without a pre-check or a
 * confirmation. The real SDK-backed client built below always provides both.
 */
export interface LiveChainClient extends NodeInfoReader {
  /** Base URL the client talks to; also the key for the network-attestation cache. */
  readonly baseUrl: string;
  getLockedVtxos(vault: string): Promise<unknown>;
  broadcastTxSync(tx: string): Promise<unknown>;
  decodeTransaction?(txHex: string): Promise<unknown>;
  getTransaction?(hash: string): Promise<unknown>;
}

export interface LiveChainClientOptions {
  baseUrl?: string;
  /** Inject an already-built SDK client (tests, or a daemon needing custom transport). */
  client?: TachiClient;
  timeoutMs?: number;
}

/** Build the live client over the official SDK. Server-side only — never import from browser code. */
export function createLiveChainClient(options: LiveChainClientOptions = {}): LiveChainClient {
  const baseUrl = (options.baseUrl ?? tachiBaseUrl()).replace(/\/+$/, "");
  const sdk =
    options.client ??
    createTachiSdkClient({ baseUrl, timeoutMs: options.timeoutMs ?? env.liveRequestTimeoutMs() });

  return {
    baseUrl,
    getNodeInfo: async () => await sdk.getNodeInfo(),
    getLockedVtxos: async (vault: string) => await sdk.getLockedVtxos(vault),
    // `/tachi_txDecode` takes `hex`, not `tx`; the SDK keeps that quirk for us.
    decodeTransaction: async (txHex: string) => await sdk.decodeTransaction(txHex),
    broadcastTxSync: async (tx: string) => await sdk.broadcastTxSync(tx),
    getTransaction: async (hash: string) => await sdk.getTransaction(hash),
  };
}
