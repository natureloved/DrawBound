import { NextResponse } from "next/server";
import { getPosition, setPosition } from "@/lib/store";
import { assertWritePolicy } from "@/lib/security/policy";
import { FixtureTachiAdapter } from "@/lib/tachi/fixture-adapter";

const tachi = new FixtureTachiAdapter();

export async function GET() {
  return NextResponse.json({ position: getPosition(), adapterMode: process.env.APP_MODE || "fixture" });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const collateralSats = Number(body.collateralSats);
  assertWritePolicy(process.env.TACHI_NETWORK || "signet", collateralSats);
  const { vaultRef } = await tachi.createVault({ owner: String(body.owner || "demo"), collateralSats });
  const current = getPosition();
  const next = { ...current, id: String(body.id || `pos_${Date.now()}`), vaultRef, collateralSats, debtUnits: 0, state: "COLLATERALIZED" as const, latestProof: undefined, exitStatus: "LOCKED" as const, drawCount: 0, nonce: 0 };
  setPosition(next);
  return NextResponse.json({ position: getPosition(), adapterMode: "FIXTURE" });
}
