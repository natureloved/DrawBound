import { env } from "@/lib/config/env";

export interface TachiHealthResponse {
  status: string;
  validators: number;
}

export interface TachiLiveValidatorsResponse {
  count: number;
  total_known: number;
  validators: Array<{ peer_id: string; host: string; p2p_port: number }>;
}

export interface TachiVtxo {
  id: string;
  owner?: string;
  amount: number;
  /** Alternate spellings seen across daemon builds; read tolerantly via `vtxoSats`. */
  amount_sat?: number | string;
  value?: number | string;
  spent?: boolean;
  locked?: boolean;
  vault_address?: string;
}

export interface TachiLockedVtxosResponse {
  vault: string;
  count: number;
  vtxos: TachiVtxo[];
}

export interface TachiVaultListItem {
  vault_id: string;
  name?: string;
  state?: string;
  latest_state_num?: number;
  funding_txid?: string;
  funding_vout?: number;
  address: string;
  csv_delay?: number;
  threshold?: number;
  /** The daemon returns an array of compressed node keys, not a string. */
  quorum_keyset?: string[];
  user_key?: string;
}

export interface TachiListVaultsResponse {
  vaults: TachiVaultListItem[];
  total: number;
  page?: number;
  page_size?: number;
  total_pages?: number;
}

export interface BitcoinRpcResponse<T = unknown> {
  result: T;
  error: null | { code: number; message: string };
  id?: string;
}

export interface TachiHttpClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URLS = {
  regtest: "https://rpc-regtest.tachibtc.com",
  signet: "https://rpc-signet.tachibtc.com",
} as const;

/**
 * Resolve the daemon base URL.
 *
 * `TACHI_BASE_URL` wins, then the per-network default. The network is read
 * through the validated env module rather than `process.env` directly: this is
 * the function that decides which chain every live read and broadcast talks to,
 * so an unvalidated `TACHI_NETWORK=tsetnet` must be a boot error (it is), not a
 * silent fall through to the signet URL.
 */
export function tachiBaseUrl(network?: string): string {
  const override = env.tachiBaseUrl();
  if (override) return override;
  const resolved = (network as TachiNetworkName | undefined) ?? env.network();
  return DEFAULT_BASE_URLS[resolved as keyof typeof DEFAULT_BASE_URLS] ?? DEFAULT_BASE_URLS.signet;
}

type TachiNetworkName = "regtest" | "signet" | "mainnet";

export class TachiHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TachiHttpClientOptions = {}) {
    this.baseUrl = (options.baseUrl || tachiBaseUrl()).replace(/\/$/, "");
    this.apiKey = options.apiKey || process.env.TACHI_API_KEY;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("X-Api-Key", this.apiKey);

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
        const body = await response.text();
        let parsed: unknown;
        try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = { raw: body }; }
        if (!response.ok) {
          if (attempt < maxAttempts && (response.status === 502 || response.status === 503 || response.status === 504)) {
            await new Promise((res) => setTimeout(res, 500 * attempt));
            continue;
          }
          throw new Error(`Tachi request failed (${response.status}) ${path}`);
        }
        return parsed as T;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error(`Tachi request timed out: ${path}`);
        if (attempt === maxAttempts) throw error;
        await new Promise((res) => setTimeout(res, 500 * attempt));
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    throw new Error(`Tachi request failed: ${path}`);
  }

  getHealth(): Promise<TachiHealthResponse> {
    return this.request<TachiHealthResponse>("/health");
  }

  getLiveValidators(): Promise<TachiLiveValidatorsResponse> {
    return this.request<TachiLiveValidatorsResponse>("/tachi_validators/live");
  }

  getLockedVtxos(vault: string): Promise<TachiLockedVtxosResponse> {
    return this.request<TachiLockedVtxosResponse>(`/tachi_vtxoLocked?vault=${encodeURIComponent(vault)}`);
  }

  listVaults(user: string, page = 1, pageSize = 50): Promise<TachiListVaultsResponse> {
    return this.request<TachiListVaultsResponse>(`/tachi_listVaults?user=${encodeURIComponent(user)}&page=${page}&page_size=${pageSize}`);
  }

  bitcoinRPC<T = unknown>(method: string, params: unknown[] = []): Promise<BitcoinRpcResponse<T>> {
    return this.request<BitcoinRpcResponse<T>>("/", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "1.0", id: "drawbound", method, params }),
    });
  }

  broadcastTxSync(tx: string): Promise<unknown> {
    return this.request("/tachi_txBroadcastSync", { method: "POST", body: JSON.stringify({ tx }) });
  }

  /**
   * Which chain this daemon is on. The live path uses this to refuse to read or
   * broadcast against a daemon that is not the configured network.
   */
  getNodeInfo(): Promise<unknown> {
    return this.request("/tachi_nodeInfo");
  }

  /**
   * Daemon-side decode of a raw transaction, without broadcasting it.
   *
   * Note the body key: the decode/validate endpoints take `hex`, while the
   * broadcast endpoints take `tx`. That asymmetry is the daemon's, not a typo —
   * getting it wrong is an opaque 400 at the moment a real transaction is at stake.
   */
  decodeTransaction(txHex: string): Promise<unknown> {
    return this.request("/tachi_txDecode", { method: "POST", body: JSON.stringify({ hex: txHex }) });
  }

  /** Post-broadcast status lookup: pending vs committed, with the block hash. */
  getTransaction(hash: string): Promise<unknown> {
    return this.request(`/tachi_tx?hash=${encodeURIComponent(hash)}`);
  }

  /** Chain-wide counters, used by the readiness report to detect a stalled daemon. */
  getStats(): Promise<unknown> {
    return this.request("/tachi_stats");
  }
}

