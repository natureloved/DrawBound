import { randomBytes } from "node:crypto";
import { Address, Signer, Verifier } from "bip322-js";

/**
 * BIP-322 vault ownership proof.
 *
 * A connect request MAY prove control of the vault's user key: the operator
 * requests a single-use challenge, signs it with the vault user key (BIP-322
 * simple signature, single-key-spend P2TR path), and presents the signature
 * plus the ownership address (the key-path P2TR of that key).
 *
 * What this proves: the signer holds the private key behind `ownershipAddress`.
 * The challenge message embeds the vaultRef, so the proof attests that THIS key
 * claims THAT vault. Deriving both the vault address and the ownership address
 * from the same user key (scripts/operator-live.mts `derive`) makes the binding
 * by construction; deriving them independently makes it an attestation.
 * Verify with `Verifier.verifySignature(..., true)` — strict, no loose BIP-137.
 */

export const OWNERSHIP_CHALLENGE_TTL_MS = 10 * 60_000;

const CHALLENGES = new Map<string, { vaultRef: string; expiresAt: number }>();
const MAX_TRACKED_CHALLENGES = 10_000;

export function ownershipChallengeMessage(vaultRef: string, nonce: string): string {
  if (!vaultRef || /[\s\u0000-\u001f\u007f]/.test(vaultRef)) {
    throw new Error("vaultRef must be a non-empty string without whitespace or control characters");
  }
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) {
    throw new Error("ownership nonce must be 8-32 bytes of hex");
  }
  return `DrawBound:v1:ownership:${vaultRef}:${nonce}`;
}

function sweepExpired(now = Date.now()): void {
  for (const [nonce, record] of CHALLENGES) {
    if (record.expiresAt <= now) CHALLENGES.delete(nonce);
  }
}

export interface IssuedChallenge {
  challenge: string;
  nonce: string;
  expiresAt: string;
}

/** Issue a single-use ownership challenge bound to a vault ref. */
export function issueOwnershipChallenge(vaultRef: string, now = Date.now()): IssuedChallenge {
  sweepExpired(now);
  if (CHALLENGES.size >= MAX_TRACKED_CHALLENGES) sweepExpired(now);
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = now + OWNERSHIP_CHALLENGE_TTL_MS;
  CHALLENGES.set(nonce, { vaultRef, expiresAt });
  return {
    challenge: ownershipChallengeMessage(vaultRef, nonce),
    nonce,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Consume a challenge: valid only for the same vault ref, unexpired, and once.
 * A wrong-vaultRef attempt does NOT burn the challenge; expired records are
 * dropped on access. Returns the canonical challenge message to verify
 * against, or null.
 */
export function consumeOwnershipChallenge(
  nonce: string,
  vaultRef: string,
  now = Date.now(),
): string | null {
  const record = CHALLENGES.get(nonce);
  if (!record) return null;
  if (record.expiresAt <= now) {
    CHALLENGES.delete(nonce);
    return null;
  }
  if (record.vaultRef !== vaultRef) return null;
  CHALLENGES.delete(nonce);
  return ownershipChallengeMessage(vaultRef, nonce);
}

/** Test helper: drop every issued challenge. */
export function clearOwnershipChallenges(): void {
  CHALLENGES.clear();
}

/**
 * Verify a BIP-322 simple signature (strict — loose BIP-137 is disabled) of a
 * challenge message against the claimed ownership address.
 */
export function verifyOwnershipSignature(input: {
  challengeMessage: string;
  ownershipAddress: string;
  signatureBase64: string;
}): boolean {
  try {
    return Verifier.verifySignature(
      input.ownershipAddress,
      input.challengeMessage,
      input.signatureBase64,
      true,
    );
  } catch {
    return false;
  }
}

/** True when the value is a bech32 P2TR address on mainnet/testnet/regtest. */
export function isP2trAddress(value: string): boolean {
  try {
    return Address.isP2TR(value);
  } catch {
    return false;
  }
}

/**
 * Derive the key-path (single-key-spend) P2TR ownership address for a pubkey.
 * This is the address whose key signs ownership challenges — NOT the vault
 * address itself (a Taurus vault P2TR commits to script leaves and cannot
 * produce BIP-322 simple signatures).
 */
export function deriveOwnershipAddress(
  compressedPubkey: Uint8Array | Buffer,
  network: "mainnet" | "testnet" | "regtest" = "testnet",
): string {
  const addresses = Address.convertPubKeyIntoAddress(Buffer.from(compressedPubkey), "p2tr");
  return addresses[network];
}

/**
 * Sign an ownership challenge with a private key (hex or WIF). Used by the
 * operator tooling; the server never sees the private key.
 */
export function signOwnershipChallenge(input: {
  challengeMessage: string;
  ownershipAddress: string;
  privateKeyWif: string;
}): string {
  return Signer.sign(input.privateKeyWif, input.ownershipAddress, input.challengeMessage);
}
