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
  quorum_keyset?: string;
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

export function tachiBaseUrl(network = process.env.TACHI_NETWORK || "signet"): string {
  if (process.env.TACHI_BASE_URL) return process.env.TACHI_BASE_URL.replace(/\/$/, "");
  return DEFAULT_BASE_URLS[network as keyof typeof DEFAULT_BASE_URLS] || DEFAULT_BASE_URLS.signet;
}

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
    const controller = new AbortController();
    const timeout = this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const body = await response.text();
      let parsed: unknown;
      try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = { raw: body }; }
      if (!response.ok) throw new Error(`Tachi request failed (${response.status}) ${path}`);
      return parsed as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`Tachi request timed out: ${path}`);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
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
}
