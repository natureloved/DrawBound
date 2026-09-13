import { env } from "../config/env";

/**
 * Write-policy gates. Values are read through the validated env module so a
 * malformed configuration fails fast at boot and runtime flips are respected.
 */
export const policy = {
  get network() {
    return env.network();
  },
  get maxTestSats() {
    return env.maxTestSats();
  },
  get maxDrawsPerPosition() {
    return env.maxDrawsPerPosition();
  },
  get mainnetAllowed() {
    return env.mainnetAllowed();
  },
  get adapterMode() {
    return process.env.PROOF_MODE || "fixture";
  },
};

export function assertWritePolicy(network: string, collateralSats: number): void {
  if (network === "mainnet" && !policy.mainnetAllowed) throw new Error("Mainnet writes are disabled");
  if (!Number.isInteger(collateralSats) || collateralSats <= 0) throw new Error("Collateral must be a positive whole number of sats");
  if (collateralSats > policy.maxTestSats) throw new Error("Test collateral cap exceeded");
}
