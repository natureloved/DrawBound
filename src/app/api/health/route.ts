import { NextResponse } from "next/server";
import { isLiveMode } from "@/lib/tachi";
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
      counts: {
        positions: positions.length,
        sessions: sessionCount(),
      },
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
