import { NextResponse } from "next/server";
import { getReceipts } from "@/lib/store";
import { resolveSession, guardRateLimit, unauthorized, hasAdminToken } from "@/app/api/_lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/receipts
 *   - With a session token: receipts for the session's own position.
 *   - With ?positionId=: only when the caller's session owns that position, or
 *     the caller is an admin.
 *
 * Without a session or admin token the request is refused: receipts bind
 * position ids, proof digests and transition refs, so an open listing would let
 * anyone trace every decision on every position.
 */
export async function GET(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const url = new URL(request.url);
  const session = resolveSession(request);
  const requested = url.searchParams.get("positionId");
  const admin = hasAdminToken(request);

  if (!session && !admin) {
    return unauthorized("A session token or admin token is required to read receipts");
  }

  // An ordinary session may only read its own position's receipts.
  if (requested && session && requested !== session.positionId && !admin) {
    return NextResponse.json({ error: "Forbidden", detail: "Session does not own this position" }, { status: 403 });
  }

  const positionId = session?.positionId ?? (admin ? (requested ?? undefined) : undefined);
  return NextResponse.json(
    { receipts: await getReceipts(positionId) },
    { headers: { "cache-control": "no-store" } },
  );
}
