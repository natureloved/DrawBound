import { NextResponse } from "next/server";
import { readTachiSnapshot } from "@/lib/tachi/read-only";
import { configReadiness, probeReadiness } from "@/lib/tachi/readiness";
import { guardRateLimit } from "@/app/api/_lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/tachi/diagnostics — read-only Tachi network inspection.
 *
 * `?readiness=1` (default) adds the config-only live-execution checklist: which
 * gate would refuse a broadcast right now, and how to open it. `?probe=1`
 * additionally asks the daemon for its chain id and the vault's locked value —
 * that is two more upstream requests per call, so the route is rate limited and
 * the probe is opt-in rather than the default.
 */
function validVaultQuery(value: string): boolean {
  return value.length <= 200 && !/[\u0000-\u0020\u007f]/.test(value);
}

export async function GET(request: Request) {
  // This route reaches out to the daemon on the caller's behalf; without a limit it
  // is an unauthenticated amplifier against the network the operator trusts.
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const params = new URL(request.url).searchParams;
  const vault = params.get("vault") ?? undefined;
  if (vault && !validVaultQuery(vault)) {
    return NextResponse.json({ error: "Invalid vault address" }, { status: 400 });
  }
  const probe = params.get("probe") === "1" || params.get("probe") === "true";

  if (probe) {
    try {
      const report = await probeReadiness({ vaultRef: vault ?? undefined });
      return NextResponse.json({ readiness: report, probed: true }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return NextResponse.json(
        {
          error: "Live readiness probe failed",
          detail: error instanceof Error ? error.message : "probe error",
          readiness: configReadiness(),
        },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }
  }

  try {
    const snapshot = await readTachiSnapshot({ vaultAddress: vault });
    return NextResponse.json(
      { ...snapshot, readiness: configReadiness() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Tachi read-only diagnostics unavailable",
        detail: error instanceof Error ? error.message : "Unknown Tachi error",
        // The checklist is configuration-derived, so it is still meaningful (and
        // usually points at the real cause) when the daemon read fails.
        readiness: configReadiness(),
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
