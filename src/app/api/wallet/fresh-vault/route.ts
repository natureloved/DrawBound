import { NextResponse } from "next/server";
import { Address } from "bip322-js";
import { schnorr } from "@noble/curves/secp256k1.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/wallet/fresh-vault
 *
 * Generate a fresh, valid signet P2TR address derived from an ephemeral key.
 * Gives each judge / tester an isolated vault position with clean state
 * (0 debt, 0 draws, fresh 5,000 sats collateral) so multiple visitors never
 * collide on the shared demo vault.
 */
export async function GET() {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  const pub = schnorr.getPublicKey(priv);
  const addresses = Address.convertPubKeyIntoAddress(Buffer.from(pub), "p2tr");
  const vaultRef = addresses.testnet;

  return NextResponse.json(
    {
      vaultRef,
      network: "signet",
      type: "p2tr",
      label: "Fresh Signet Demo Vault",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
