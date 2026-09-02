import { NextResponse } from "next/server";
import { readTachiSnapshot } from "@/lib/tachi/read-only";

export const dynamic = "force-dynamic";

function validVaultQuery(value: string): boolean {
  return value.length <= 200 && !/[\u0000-\u0020\u007f]/.test(value);
}

export async function GET(request: Request) {
  const vault = new URL(request.url).searchParams.get("vault") ?? undefined;
  if (vault && !validVaultQuery(vault)) {
    return NextResponse.json({ error: "Invalid vault address" }, { status: 400 });
  }

  try {
    const snapshot = await readTachiSnapshot({ vaultAddress: vault });
    return NextResponse.json(snapshot, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Tachi read-only diagnostics unavailable",
        detail: error instanceof Error ? error.message : "Unknown Tachi error",
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
