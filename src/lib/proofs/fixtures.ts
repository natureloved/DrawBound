import type { LoanHealthProof } from "../domain/types";
import { normalizeProof } from "./normalize";

/**
 * Build an official-shaped fixture proof (source: "fixture"). `now` is evaluated
 * at call time (not module load) so a freshly loaded "healthy" proof is always
 * within its freshness window for as long as the server runs.
 *
 * Fixtures are deterministic rehearsal artifacts with NO claim of proof
 * security; they exist to exercise the same covenant gate as real attestations.
 */
export function fixtureProof(
  kind: "healthy" | "unhealthy" | "stale" | "invalid",
  overrides: Partial<{
    positionId: string;
    network: string;
    collateralRef: string;
    covenantVersion: string;
    observedAt: string;
  }> = {},
): LoanHealthProof {
  const now = Date.now();
  const raw = {
    positionId: "pos_demo_01",
    network: "signet",
    collateralRef: "vault:taurus:signet:drawbound-demo",
    covenantVersion: "drawbound-v1",
    observedAt: new Date(now - 30_000).toISOString(),
    ...overrides,
    healthBps: kind === "unhealthy" ? 11000 : 15000,
    expiresAt: new Date(kind === "stale" ? now - 1000 : now + 240_000).toISOString(),
    verification: kind === "invalid" ? ("INVALID" as const) : ("VERIFIED" as const),
    source: "fixture" as const,
  };
  return normalizeProof(raw);
}

export function fixtureCatalog(): Record<"healthy" | "unhealthy" | "stale", LoanHealthProof> {
  return {
    healthy: fixtureProof("healthy"),
    unhealthy: fixtureProof("unhealthy"),
    stale: fixtureProof("stale"),
  };
}
