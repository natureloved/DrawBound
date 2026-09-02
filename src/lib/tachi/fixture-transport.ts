import type { TachiTransport } from "./transport";

export const fixtureTransport: TachiTransport = {
  mode: "rpc",
  async readState(ref) { return { ref, network: "signet", status: "LOCKED" }; },
  async submitTransition(input) { return { transitionRef: `satvm:fixture:${JSON.stringify(input).length}` }; },
};
