import { NextResponse } from "next/server";
import { getPosition, listPositions, positionIdForVault, savePosition } from "@/lib/store";
import { assertWritePolicy } from "@/lib/security/policy";
import { getTachiAdapter, isLiveMode } from "@/lib/tachi";
import { resolveSession, guardRateLimit, readJsonBody, badRequest, forbidden } from "@/app/api/_lib/http";
import { calculateCreditLimit } from "@/lib/domain/covenant";
import { env } from "@/lib/config/env";
import type { CreditPosition } from "@/lib/domain/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/positions
 *   - With a session token: returns that session's position as `position`.
 *   - With ?vault= or ?id=: returns that position as `position`.
 *   - Always includes the full public `positions` list (no secrets) and adapterMode.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const vault = url.searchParams.get("vault");
  const id = url.searchParams.get("id");
  const positions = await listPositions();

  let position: CreditPosition | null = null;
  const session = resolveSession(request);
  if (session) position = await getPosition(session.positionId);
  if (!position && id) position = await getPosition(id);
  if (!position && vault) position = await getPosition(positionIdForVault(vault));

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
