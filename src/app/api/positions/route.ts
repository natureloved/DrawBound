import { NextResponse } from "next/server";
import { connectVault, getPosition, listPositions, positionIdForVault, savePosition } from "@/lib/store";
import { assertWritePolicy } from "@/lib/security/policy";
import { getTachiAdapter, isLiveMode } from "@/lib/tachi";
import { readTachiSnapshot } from "@/lib/tachi/read-only";
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
  let rehydrationFailed = false;

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
    if (!position && session.vaultRef) {
      // Serverless container cold-start fallback: re-hydrate the position for this
      // authenticated session. The collateral must come from the same source the
      // rest of the protocol uses: in live mode that is a real chain read, and a
      // read that fails yields NO position rather than one invented at 5,000 sats
      // (which would hand the session a 500-unit credit limit for collateral that
      // was never observed).
      let collateral = 5000;
      if (isLiveMode()) {
        try {
          const snapshot = await readTachiSnapshot({ vaultAddress: session.vaultRef });
          if (!snapshot.vault?.readComplete) collateral = 0;
          else collateral = snapshot.vault.lockedSats;
        } catch {
          collateral = 0;
          rehydrationFailed = true;
        }
      }
      // A failed live read must not mint a fresh zero-collateral position either:
      // there is nothing to restore, so report the degradation instead.
      if (!rehydrationFailed) position = await connectVault(session.vaultRef, collateral);
    }
  }

  // The full list is admin-only; an ordinary caller gets only their own position.
  const positions = admin ? await listPositions() : [];

  return NextResponse.json(
    {
      position,
      positions,
      adapterMode: isLiveMode() ? "live" : "fixture",
      ownershipVerified: session?.ownershipVerified ?? null,
      ...(rehydrationFailed
        ? { notice: "position could not be re-hydrated: the Tachi daemon did not answer the collateral read" }
        : {}),
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
