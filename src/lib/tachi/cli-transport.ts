import type { TachiTransport } from "./transport";

export class CliTransport implements TachiTransport {
  mode = "cli" as const;
  constructor(private readonly cliPath = process.env.TACHI_CLI_PATH) {}
  async readState(_ref: string): Promise<unknown> { if (!this.cliPath) throw new Error("TACHI_CLI_PATH is not configured"); throw new Error("Live CLI transport pending official command verification"); }
  async submitTransition(_input: unknown): Promise<{ transitionRef: string }> { if (!this.cliPath) throw new Error("TACHI_CLI_PATH is not configured"); throw new Error("Live CLI transport pending official command verification"); }
}
