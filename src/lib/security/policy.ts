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
    return env.proofMode();
  },
};

/**
 * Write-policy gates.
 *
 * The network is read from validated env inside the function, never from the
 * caller: a caller-supplied network string is what let an unvalidated value skip
 * the mainnet check. The first parameter is retained only for call-site
 * compatibility.
 */
export function assertWritePolicy(_network: string, collateralSats: number): void {
  if (policy.network === "mainnet" && !policy.mainnetAllowed) throw new Error("Mainnet writes are disabled");
  if (!Number.isInteger(collateralSats) || collateralSats <= 0) throw new Error("Collateral must be a positive whole number of sats");
  // The test collateral cap is a testnet guard; a mainnet deployment that has
  // explicitly allowed mainnet is not sandboxed by it.
  if (policy.network !== "mainnet" && collateralSats > policy.maxTestSats) {
    throw new Error("Test collateral cap exceeded");
  }
}
