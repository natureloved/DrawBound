import { NextResponse } from "next/server";
import { getPosition, listPositions, positionIdForVault, savePosition } from "@/lib/store";
import { assertWritePolicy } from "@/lib/security/policy";
import { getTachiAdapter, isLiveMode } from "@/lib/tachi";
import { resolveSession, guardRateLimit, readJsonBody, badRequest, forbidden, unauthorized, hasAdminToken } from "@/app/api/_lib/http";
import { calculateCreditLimit } from "@/lib/domain/covenant";
import { env } from "@/lib/config/env";
import type { CreditPosition } from "@/lib/domain/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/positions
 *   - With a session token: returns that session's position as `position`.
 *   - With ?vault= or ?id=: returns that position — only when the caller's
 *     session owns it (otherwise 403), so position data is not enumerable.
 *   - The full `positions` list requires admin authorization.
 *
 * A position carries collateral, debt, proof digests and transition refs, so an
 * anonymous listing would expose every caller's credit standing.
 */
export async function GET(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const url = new URL(request.url);
  const vault = url.searchParams.get("vault");
  const id = url.searchParams.get("id");
  const session = resolveSession(request);
  const admin = hasAdminToken(request);

  let position: CreditPosition | null = null;

  if (id || vault) {
    // A position addressed explicitly is only readable by its owner or an admin.
    if (!session && !admin) {
      return unauthorized("A session token or admin token is required to read a specific position");
    }
    if (id) position = await getPosition(id);
    if (!position && vault) position = await getPosition(positionIdForVault(vault));
    if (position && session && position.id !== session.positionId && !admin) {
      return forbidden("Session does not own this position");
    }
  } else if (session) {
    position = await getPosition(session.positionId);
  }

  // The full list is admin-only; an ordinary caller gets only their own position.
  const positions = admin ? await listPositions() : [];

  return NextResponse.json(
    {
      position,
      positions,
      adapterMode: isLiveMode() ? "live" : "fixture",
      ownershipVerified: session?.ownershipVerified ?? null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * POST /api/positions — open a new (testnet-capped) position via the adapter.
 * Primarily a demo/seed path; the production onboarding route is /api/wallet/connect.
 */
export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  // Creating a position establishes borrowable capacity, so it must come from an
  // authenticated session (or an operator), not from an anonymous caller.
  if (!resolveSession(request) && !hasAdminToken(request)) {
    return unauthorized("A session token or admin token is required to create a position");
  }

  const body = await readJsonBody(request);
  const collateralSats = Number(body.collateralSats);
  try {
    assertWritePolicy(env.network(), collateralSats);
  } catch (error) {
    return forbidden(error instanceof Error ? error.message : "Write policy rejected");
  }

  const owner = typeof body.owner === "string" && body.owner.trim() ? body.owner.trim() : "demo";
  const { vaultRef } = await getTachiAdapter().createVault({ owner, collateralSats });
  const id = positionIdForVault(vaultRef);
  if (await getPosition(id)) return badRequest("A position already exists for this vault");

  const position: CreditPosition = {
    id,
    vaultRef,
    collateralSats,
    debtUnits: 0,
    creditLimitUnits: calculateCreditLimit(collateralSats),
    minHealthBps: env.minHealthBps(),
    state: "COLLATERALIZED",
    exitStatus: "LOCKED",
    drawCount: 0,
    nonce: 0,
  };
  await savePosition(position);
  return NextResponse.json({ position, adapterMode: isLiveMode() ? "live" : "fixture" });
}
