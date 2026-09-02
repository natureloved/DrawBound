import type { LoanHealthProof } from "../domain/types";
import { normalizeProof } from "./normalize";

const now = Date.now();
const base = {
  positionId: "pos_demo_01",
  network: "signet",
  collateralRef: "vault:taurus:signet:drawbound-demo",
  covenantVersion: "drawbound-v1",
  observedAt: new Date(now - 30_000).toISOString(),
};

export function fixtureProof(kind: "healthy" | "unhealthy" | "stale" | "invalid", overrides: Partial<typeof base> = {}): LoanHealthProof {
  const raw = {
    ...base,
    ...overrides,
    healthBps: kind === "unhealthy" ? 11000 : 15000,
    expiresAt: new Date(kind === "stale" ? now - 1_000 : now + 240_000).toISOString(),
    verification: kind === "invalid" ? "INVALID" : "VERIFIED",
  };
  return normalizeProof(raw);
}

export const fixtureCatalog = {
  healthy: fixtureProof("healthy"),
  unhealthy: fixtureProof("unhealthy"),
  stale: fixtureProof("stale"),
};
