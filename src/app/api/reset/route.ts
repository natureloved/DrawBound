import { NextResponse } from "next/server";
import { resetStore } from "@/lib/store";
import { clearSessions } from "@/lib/auth/sessions";
import { guardRateLimit, requireAdmin } from "@/app/api/_lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/reset — destructive demo/admin reset.
 *
 * Gate: with ADMIN_TOKEN configured, a matching `x-admin-token` header is
 * required; without one, reset is only available in fixture mode (live
 * deployments must configure ADMIN_TOKEN or the route stays shut).
 */
export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const denied = requireAdmin(request);
  if (denied) return denied;

  clearSessions();
  const position = await resetStore();
  return NextResponse.json({ position, receipts: [] });
}
