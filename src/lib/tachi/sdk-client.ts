import { TachiClient, type TachiClientOptions } from "@tachibtc/tachi-sdk-ts";
import { tachiBaseUrl } from "./http-client";

export type TachiSdkClientOptions = Omit<TachiClientOptions, "baseUrl"> & {
  baseUrl?: string;
};

/** Create the official SDK client without exposing it to browser code. */
export function createTachiSdkClient(options: TachiSdkClientOptions = {}): TachiClient {
  const network = process.env.TACHI_NETWORK || "signet";
  return new TachiClient({
    ...options,
    baseUrl: options.baseUrl || tachiBaseUrl(network),
  });
}
