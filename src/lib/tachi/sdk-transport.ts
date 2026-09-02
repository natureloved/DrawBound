import type { TachiTransport } from "./transport";

export interface TachiSdkClient {
  getLockedVtxos(vault: string): Promise<{ vault: string; count: number; vtxos: Array<{ amount: number }> }>;
  broadcastTxSync(tx: string): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class SdkTransport implements TachiTransport {
  mode = "sdk" as const;
  constructor(private readonly client?: TachiSdkClient) {}

  async readState(ref: string): Promise<unknown> {
    if (!this.client) throw new Error("Official Tachi SDK is not configured");
    return this.client.getLockedVtxos(ref);
  }

  async submitTransition(input: unknown): Promise<{ transitionRef: string }> {
    if (!this.client) throw new Error("Official Tachi SDK is not configured");
    if (!input || typeof input !== "object" || typeof (input as { txHex?: unknown }).txHex !== "string") {
      throw new Error("Tachi credit transition requires a verified txHex payload");
    }
    const result = await this.client.broadcastTxSync((input as { txHex: string }).txHex);
    if (!isRecord(result)) throw new Error("Tachi SDK broadcast returned no response");

    const payload = isRecord(result.result) ? result.result : result;
    const code = typeof payload.code === "number" ? payload.code : undefined;
    if (code !== undefined && code !== 0) {
      const log = typeof payload.log === "string" ? `: ${payload.log}` : "";
      throw new Error(`Tachi SDK rejected credit transition (code ${code})${log}`);
    }

    const hash = typeof payload.hash === "string" && payload.hash.length > 0 ? payload.hash : undefined;
    if (!hash) throw new Error("Tachi SDK broadcast did not return a transaction hash");
    return { transitionRef: hash };
  }
}
