import { NextResponse } from "next/server";
import { revokeSession } from "@/lib/auth/sessions";
import { guardRateLimit, readJsonBody, sessionTokenFromRequest } from "@/app/api/_lib/http";

export const dynamic = "force-dynamic";

/** POST /api/wallet/disconnect — revoke the presented session token (idempotent). */
export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const token = sessionTokenFromRequest(request, body);
  revokeSession(token);
  return NextResponse.json({ ok: true });
}
