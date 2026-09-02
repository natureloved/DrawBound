export const policy = {
  network: process.env.TACHI_NETWORK || "signet",
  maxTestSats: Number(process.env.MAX_TEST_SATS || 5000),
  maxDrawsPerPosition: Number(process.env.MAX_DRAWS_PER_POSITION || 3),
  mainnetAllowed: process.env.ALLOW_MAINNET === "true" && process.env.LIVE_TACHI_ENABLED === "true" && process.env.KILL_SWITCH !== "true",
  adapterMode: process.env.PROOF_MODE || "fixture",
};

export function assertWritePolicy(network: string, collateralSats: number): void {
  if (network === "mainnet" && !policy.mainnetAllowed) throw new Error("Mainnet writes are disabled");
  if (!Number.isInteger(collateralSats) || collateralSats <= 0) throw new Error("Collateral must be a positive whole number of sats");
  if (collateralSats > policy.maxTestSats) throw new Error("Test collateral cap exceeded");
}
