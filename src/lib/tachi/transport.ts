export type TachiTransportMode = "sdk" | "rpc" | "cli";

export interface TachiTransport {
  mode: TachiTransportMode;
  readState(ref: string): Promise<unknown>;
  submitTransition(input: unknown): Promise<{ transitionRef: string }>;
}
