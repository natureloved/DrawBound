import { NextResponse } from "next/server";
import { isLiveMode } from "@/lib/tachi";
import { configReadiness } from "@/lib/tachi/readiness";
import { env } from "@/lib/config/env";
import { listPositions } from "@/lib/store";
import { sessionCount } from "@/lib/auth/sessions";

export const dynamic = "force-dynamic";

const startedAt = Date.now();

/** Liveness/readiness probe for orchestrators and uptime checks. */
export async function GET() {
  const positions = await listPositions();
  return NextResponse.json(
    {
      status: "ok",
      version: "0.2.0",
      mode: isLiveMode() ? "live" : "fixture",
      network: env.network(),
      policy: {
        killSwitch: env.killSwitch(),
        mainnetAllowed: env.mainnetAllowed(),
        strictProofs: env.proofRelayPublicKeys().length > 0,
        maxTestSats: env.maxTestSats(),
      },
      // Live-execution readiness from configuration only (no daemon call): a probe
      // belongs on /api/tachi/diagnostics?probe=1, not on a liveness endpoint that
      // an orchestrator polls.
      live: (() => {
        const report = configReadiness();
        return {
          mode: report.mode,
          network: report.network,
          expectedChainId: report.expectedChainId,
          writesEnabled: isLiveMode() && !env.killSwitch(),
          executionReady: report.executionReady,
          blockedBy: report.blocking,
        };
      })(),
      counts: {
        positions: positions.length,
        sessions: sessionCount(),
      },
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
