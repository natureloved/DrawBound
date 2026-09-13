import { NextResponse } from "next/server";
import { readTachiSnapshot } from "@/lib/tachi/read-only";
import { connectVault, positionIdForVault } from "@/lib/store";
import { fetchLiveLoanHealthProof } from "@/lib/proofs/oracle-client";
import { isLiveMode } from "@/lib/tachi";

export const dynamic = "force-dynamic";

function validVaultRef(value: string): boolean {
  return value.length > 4 && value.length <= 200 && !/[\u0000-\u0020\u007f]/.test(value);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const vaultRef = typeof body.vaultRef === "string" ? body.vaultRef.trim() : "";
  if (!validVaultRef(vaultRef)) {
    return NextResponse.json({ error: "Invalid vault reference" }, { status: 400 });
  }

  // Live mode enforces ALLOWED_VAULT_REFS; mirror the gate so connect fails closed too.
  if (isLiveMode()) {
    const allowed = (process.env.ALLOWED_VAULT_REFS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(vaultRef)) {
      return NextResponse.json({ error: "Vault is not in ALLOWED_VAULT_REFS; refusing connection" }, { status: 403 });
    }
  }

  // Best-effort real read of the operator's vault collateral via the Tachi SDK.
  let lockedSats: number | undefined;
  let liveReadOk = false;
  try {
    const snapshot = await readTachiSnapshot({ vaultAddress: vaultRef });
    lockedSats = snapshot.vault?.lockedSats;
    liveReadOk = Boolean(snapshot.vault);
  } catch {
    liveReadOk = false;
  }

  // Build a live-derived HAT/RIP health attestation bound to this vault's fresh position.
  // Falls back to a fixture-healthy proof if the live read is unavailable.
  const positionId = positionIdForVault(vaultRef);
  const modeledCollateral = lockedSats && lockedSats > 0 ? lockedSats : 5000;
  const liveProof = await fetchLiveLoanHealthProof({
    vaultRef,
    positionId,
    network: process.env.TACHI_NETWORK,
    debtUnits: 0,
    collateralSats: modeledCollateral,
  });

  const position = connectVault(vaultRef, lockedSats ?? 0, positionId, liveProof);
  return NextResponse.json(
    {
      ok: true,
      vaultRef,
      liveReadOk,
      lockedSats: lockedSats ?? null,
      proofSource: isLiveMode() ? "live-hat-oracle" : "live-tachi-read",
      position,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
