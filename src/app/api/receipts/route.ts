import { NextResponse } from "next/server";
import { getReceipts } from "@/lib/store";
import { resolveSession } from "@/app/api/_lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/receipts
 *   - With a session token: receipts for the session's position.
 *   - With ?positionId=: receipts for that position.
 *   - Otherwise: all receipts (public, independently hash-verifiable).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = resolveSession(request);
  const positionId = session?.positionId ?? url.searchParams.get("positionId") ?? undefined;
  return NextResponse.json(
    { receipts: await getReceipts(positionId) },
    { headers: { "cache-control": "no-store" } },
  );
}
