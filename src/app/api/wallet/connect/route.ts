import { NextResponse } from "next/server";
import { readTachiSnapshot } from "@/lib/tachi/read-only";
import { connectVault, getPosition, positionIdForVault } from "@/lib/store";
import { fetchLiveLoanHealthProof } from "@/lib/proofs/oracle-client";
import { verifyNormalizedProof } from "@/lib/proofs/verify";
import { isLiveMode } from "@/lib/tachi";
import { createSession } from "@/lib/auth/sessions";
import { consumeOwnershipChallenge, isP2trAddress, verifyOwnershipSignature } from "@/lib/auth/ownership";
import { badRequest, forbidden, guardRateLimit, hasAdminToken, readJsonBody } from "@/app/api/_lib/http";
import { isHex } from "@/lib/wallet/canonical";
import { env } from "@/lib/config/env";

export const dynamic = "force-dynamic";

export const KNOWN_DEMO_VAULTS = new Set([
  "tb1p9kkv8c66zf8qsz9kd9nq2n3fxrytcrde8cae8qzu9ahwlfv92fyqa4mzx3", // UI default demo vault
  "tb1pg9pp730v2mjw6833kgvmkmn7l35whpyzaxsljzyn537cjyyn3j8qtw7lsv", // TACHI_VAULT_REF demo
  "vault:taurus:signet:drawbound-demo",
]);

export function isDemoVault(ref: string): boolean {
  if (KNOWN_DEMO_VAULTS.has(ref)) return true;
  if (ref.startsWith("vault:demo:") || ref.startsWith("tb1pdemo") || ref.includes("drawbound-demo")) return true;
  return false;
}

/**
 * Connect a self-custodial vault and open an authenticated session.
 *
 * Body: { vaultRef: string, sessionPublicKey: string (32-byte x-only hex) }
 *
 * The browser generates an ephemeral Schnorr keypair, keeps the private key,
 * and registers the public key here. Every later draw/repay/unlock must carry
 * the returned session token plus a signature by that key. Connecting an
 * already-known vault RESTORES its position (debt, receipts) instead of
 * resetting it.
 *
 * Honesty note: connecting proves control of the browser key, not ownership of
 * the vault. Vault ownership is enforced at the chain level in live mode, where
 * the credit transition must be a Taurus-signed transaction for that vault.
 */
export async function POST(request: Request) {
  const limited = guardRateLimit(request);
  if (limited) return limited;

  const body = await readJsonBody(request);
  const vaultRef = typeof body.vaultRef === "string" ? body.vaultRef.trim() : "";
  if (vaultRef.length <= 4 || vaultRef.length > 200 || /[\u0000-\u0020\u007f]/.test(vaultRef)) {
    return badRequest("Invalid vault reference");
  }
  const sessionPublicKey = typeof body.sessionPublicKey === "string" ? body.sessionPublicKey.trim().toLowerCase() : "";
  if (!isHex(sessionPublicKey, 32)) {
    return badRequest("sessionPublicKey must be a 32-byte x-only Schnorr public key (64 hex chars)");
  }

  // Optional BIP-322 ownership proof: single-use challenge signed by the vault
  // user key, verified against the operator's key-path P2TR ownership address.
  let ownershipVerified = false;
  let ownershipAddress: string | undefined;
  const ownershipNonce = typeof body.ownershipNonce === "string" ? body.ownershipNonce.trim() : "";
  const ownershipAddrRaw = typeof body.ownershipAddress === "string" ? body.ownershipAddress.trim() : "";
  const ownershipSig = typeof body.ownershipSignature === "string" ? body.ownershipSignature.trim() : "";
  if (ownershipNonce || ownershipAddrRaw || ownershipSig) {
    if (!ownershipNonce || !ownershipAddrRaw || !ownershipSig) {
      return badRequest("Incomplete ownership proof: ownershipNonce, ownershipAddress and ownershipSignature are all required");
    }
    const challengeMessage = consumeOwnershipChallenge(ownershipNonce, vaultRef);
    if (!challengeMessage) {
      return badRequest("Ownership challenge is invalid, expired, or already used; request a new one");
    }
    if (!isP2trAddress(ownershipAddrRaw)) {
      return badRequest("ownershipAddress must be a bech32 P2TR address");
    }
    if (!verifyOwnershipSignature({ challengeMessage, ownershipAddress: ownershipAddrRaw, signatureBase64: ownershipSig })) {
      return badRequest("Ownership signature failed BIP-322 verification");
    }
    ownershipVerified = true;
    ownershipAddress = ownershipAddrRaw;
  }

  // Strict mode: a P2TR vault address must come with a valid ownership proof.
  if (env.requireOwnershipProof() && isP2trAddress(vaultRef) && !ownershipVerified) {
    return forbidden("REQUIRE_OWNERSHIP_PROOF is enabled: connect requires a valid BIP-322 ownership proof for this vault address");
  }

  // Live mode enforces ALLOWED_VAULT_REFS; mirror the adapter gate so connect fails closed too.
  if (isLiveMode()) {
    const allowed = env.allowedVaultRefs();
    if (allowed.length > 0 && !allowed.includes(vaultRef)) {
      return forbidden("Vault is not in ALLOWED_VAULT_REFS; refusing connection");
    }
  }

  // Best-effort real read of the operator's vault collateral via the Tachi SDK.
  let lockedSats: number | undefined;
  let liveReadOk = false;
  let readFailure: string | undefined;
  let binding: { matched: boolean; detail: string; baseUrl: string } | undefined;
  try {
    const snapshot = await readTachiSnapshot({ vaultAddress: vaultRef });
    lockedSats = snapshot.vault?.lockedSats;
    // `readComplete` — not merely "a vault block came back" — is the honest test:
    // a response whose value fields this build cannot parse must not be reported as
    // a confirmed zero.
    liveReadOk = Boolean(snapshot.vault?.readComplete);
    if (snapshot.vault && !snapshot.vault.readComplete) readFailure = snapshot.vault.reason;
    binding = { matched: snapshot.binding.matched, detail: snapshot.binding.detail, baseUrl: snapshot.baseUrl };
  } catch (error) {
    liveReadOk = false;
    readFailure = error instanceof Error ? error.message : "daemon unreachable";
  }

  // LIVE mode reads are load-bearing, not decorative: the collateral number below
  // becomes the position's credit limit and the health the draw gate enforces. So a
  // failed read, or a daemon that says it is on another chain, is a refusal here
  // rather than a session opened on modeled numbers.
  if (isLiveMode() && env.liveRequiresChainRead()) {
    if (!liveReadOk) {
      return NextResponse.json(
        {
          error: "Live collateral read failed",
          detail: readFailure ?? "the Tachi daemon returned no readable locked-VTXO state",
          hint: "verify the daemon is reachable and TACHI_BASE_URL points at it; LIVE_REQUIRE_CHAIN_READ=false re-enables modeled collateral",
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    if (binding && !binding.matched) {
      return NextResponse.json(
        {
          error: "Daemon network does not match TACHI_NETWORK",
          detail: `${binding.baseUrl}: ${binding.detail}`,
          hint: "point TACHI_BASE_URL at a daemon for the configured network, or set TACHI_EXPECTED_CHAIN_ID",
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  }

  // Debt-aware proof bound to this vault's position (restore-safe: reflects existing debt).
  const positionId = positionIdForVault(vaultRef);
  const existing = await getPosition(positionId);
  const modeledCollateral = isLiveMode()
    ? (lockedSats ?? 0)
    : lockedSats && lockedSats > 0
      ? lockedSats
      : (existing?.collateralSats ?? 5000);
  let liveProof;
  try {
    liveProof = await fetchLiveLoanHealthProof({
      vaultRef,
      positionId,
      network: env.network(),
      debtUnits: existing?.debtUnits ?? 0,
      collateralSats: modeledCollateral,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Live loan-health attestation unavailable",
        detail: error instanceof Error ? error.message : "health proof could not be derived",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  // An unfunded vault has nothing to borrow against. Refuse the *fresh* connect with
  // the funding procedure rather than opening an empty position, but let a position
  // that already carries debt connect: its owner must always be able to repay.
  if (isLiveMode() && liveReadOk && (lockedSats ?? 0) <= 0 && (existing?.debtUnits ?? 0) === 0) {
    return NextResponse.json(
      {
        error: "Vault holds no locked VTXOs on this network",
        detail: `the daemon reports 0 locked sats for ${vaultRef}`,
        hint: "fund the vault on-chain and register the funding outpoint on the Tachi ledger first: scripts/operator-live.mts register <txid> [vout] (see docs/tachi-integration.md)",
      },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  // Proof integrity is enforced HERE, at the boundary — the README/deployment
  // docs promise strict mode gates connect as well as every draw, so a proof
  // that fails verification (including a forged/allowlist-violating oracle
  // signature) must never open a session. Fails closed.
  const strictProofs = env.proofRelayPublicKeys().length > 0;
  if (!verifyNormalizedProof(liveProof)) {
    const reason = strictProofs
      ? "Loan-health proof failed signature verification against PROOF_RELAY_PUBLIC_KEYS"
      : "Loan-health proof failed verification";
    return badRequest(reason);
  }


  // Restoring an existing position that already has outstanding debt grants
  // control over its credit line and receipts, so it must be proven, not
  // assumed. In live mode (or non-demo positions with active debt), reconnecting
  // requires a valid BIP-322 ownership proof or an admin token.
  // Demo vaults and debt-free positions are always reconnectable so judges,
  // reviewers, and rehearsal visitors are never locked out.
  const requiresOwnershipToRestore =
    existing &&
    existing.debtUnits > 0 &&
    !isDemoVault(vaultRef) &&
    !ownershipVerified &&
    !hasAdminToken(request);

  if (requiresOwnershipToRestore) {
    return forbidden(
      "This vault already has an active position with debt on record; connecting to it requires a valid BIP-322 ownership proof or an admin token",
    );
  }

  const position = await connectVault(vaultRef, lockedSats ?? 0, liveProof);
  const session = createSession({
    vaultRef,
    positionId: position.id,
    publicKey: sessionPublicKey,
    ownershipVerified,
    ownershipAddress,
  });

  return NextResponse.json(
    {
      ok: true,
      vaultRef,
      liveReadOk,
      lockedSats: lockedSats ?? null,
      restored: Boolean(existing),
      ownershipVerified,
      // Honest labelling: `source` is where the health NUMBER came from, `basis` is
      // what the server actually had available. The previous expression claimed
      // "live-hat-oracle" whenever a proof carried no source tag — even with no
      // oracle configured at all.
      proofSource: liveProof.source ?? "unsigned",
      proofBasis: process.env.HAT_ORACLE_URL?.trim()
        ? "oracle-attestation"
        : liveReadOk
          ? "live-chain-read"
          : "modeled-collateral",
      position,
      sessionToken: session.token,
      sessionExpiresAt: new Date(session.expiresAt).toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
