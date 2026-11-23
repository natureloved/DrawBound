import { NextResponse } from "next/server";
import { readTachiSnapshot, type TachiReadOnlySnapshot } from "@/lib/tachi/read-only";
import { configReadiness, probeReadiness } from "@/lib/tachi/readiness";
import { guardRateLimit, hasAdminToken, resolveSession, unauthorized } from "@/app/api/_lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/tachi/diagnostics — read-only Tachi network inspection.
 *
 * The daemon fingerprint (chain id, version, block height, peers, validator
 * set, quorum) used to be public to anyone who asked, and every hit proxied
 * straight to the shared public daemon with no caching. Now:
 *
 * - Unauthenticated callers get a redacted subset only: `{ status, network,
 *   synced, observedAt }` plus the config-only readiness checklist.
 * - The full snapshot, a `?vault=` lookup (locked amounts are position data),
 *   and `?probe=1` require a session token or an admin token.
 * - The default (no-vault) snapshot is memoised server-side for 15s, so a
 *   burst of callers costs one upstream read instead of one per hit.
 *
 * `?probe=1` additionally asks the daemon for its chain id and the vault's
 * locked value — that is two more upstream requests per call, so the route is
 * rate limited and the probe is opt-in rather than the default.
 */
function validVaultQuery(value: string): boolean {
  return value.length <= 200 && !/[\u0000-\u0020\u007f]/.test(value);
}

/** Public subset of a snapshot: enough to say "the network is up", nothing that fingerprints the deployment. */
export function redactDiagnosticsSnapshot(snapshot: TachiReadOnlySnapshot): {
  status: string;
  network: string;
  synced: boolean;
  observedAt: string;
} {
  return {
    status: snapshot.health.status,
    network: snapshot.network,
    synced: snapshot.node.syncStatus === "synced",
    observedAt: snapshot.observedAt,
  };
}

const SNAPSHOT_TTL_MS = 15_000;
let cachedSnapshot: { at: number; snapshot: TachiReadOnlySnapshot } | null = null;

async function cachedDefaultSnapshot(): Promise<TachiReadOnlySnapshot> {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshot.at < SNAPSHOT_TTL_MS) return cachedSnapshot.snapshot;
  const snapshot = await readTachiSnapshot({});
  cachedSnapshot = { at: now, snapshot };
  return snapshot;
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

  const authorized = resolveSession(request) !== null || hasAdminToken(request);

  if (probe) {
    if (!authorized) {
      return unauthorized("A session token or admin token is required for a live readiness probe");
    }
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

  if (vault && !authorized) {
    return unauthorized("A session token or admin token is required to inspect a vault");
  }

  try {
    const snapshot = vault ? await readTachiSnapshot({ vaultAddress: vault }) : await cachedDefaultSnapshot();
    if (!authorized) {
      return NextResponse.json(
        { ...redactDiagnosticsSnapshot(snapshot), readiness: configReadiness() },
        { headers: { "cache-control": "no-store" } },
      );
    }
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
