import type { TachiTransport } from "./transport";

export class RpcTransport implements TachiTransport {
  mode = "rpc" as const;
  constructor(private readonly rpcUrl = process.env.TACHI_RPC_URL) {}
  async readState(_ref: string): Promise<unknown> { if (!this.rpcUrl) throw new Error("TACHI_RPC_URL is not configured"); throw new Error("Live RPC transport pending official method verification"); }
  async submitTransition(_input: unknown): Promise<{ transitionRef: string }> { if (!this.rpcUrl) throw new Error("TACHI_RPC_URL is not configured"); throw new Error("Live RPC transport pending official method verification"); }
}
