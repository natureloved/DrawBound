import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";

/**
 * Canonical transition messages and BIP-340 Schnorr session signing.
 *
 * Browser-safe: uses only @noble/curves (pure JS) and WebCrypto — no node:crypto —
 * so the exact same code runs in the vault terminal (signing) and in API routes
 * (verification).
 *
 * Message format (single line, colon-separated, no escaping needed because every
 * field is server-validated to contain no colons or whitespace):
 *
 *   DrawBound:v1:<positionId>:<vaultRef>:<action>:<amount>:<nonce>
 *
 * The session key is an ephemeral browser-generated keypair, NOT a Bitcoin key.
 * It authenticates the browser session that connected a vault; it does not prove
 * ownership of the vault itself. Real vault-key authorization happens in the
 * operator-supplied, Taurus-signed txHex that live mode broadcasts.
 */

export interface CanonicalTransitionFields {
  positionId: string;
  vaultRef: string;
  action: "DRAW" | "REPAY" | "UNLOCK";
  amount: number;
  nonce: number;
}

const ID_PATTERN = /^[A-Za-z0-9_]+$/;
// Vault refs may contain colons (fixture refs like vault:taurus:signet:demo); the
// message is only ever BUILT from server-side state and compared as exact bytes,
// never parsed, so field colons cannot create ambiguity. Whitespace/control
// characters are still refused to keep signatures copy-paste stable.
const VAULT_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;

export function canonicalTransitionMessage(fields: CanonicalTransitionFields): string {
  if (typeof fields.positionId !== "string" || !ID_PATTERN.test(fields.positionId)) {
    throw new Error("Canonical message field positionId must be alphanumeric/underscore");
  }
  if (typeof fields.vaultRef !== "string" || !VAULT_PATTERN.test(fields.vaultRef)) {
    throw new Error("Canonical message field vaultRef must be a non-empty string without whitespace or control characters");
  }
  if (!Number.isInteger(fields.amount) || fields.amount < 0) {
    throw new Error("Canonical message amount must be a non-negative integer");
  }
  if (!Number.isInteger(fields.nonce) || fields.nonce < 0) {
    throw new Error("Canonical message nonce must be a non-negative integer");
  }
  return `DrawBound:v1:${fields.positionId}:${fields.vaultRef}:${fields.action}:${fields.amount}:${fields.nonce}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isHex(value: string, expectedBytes?: number): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0) return false;
  if (!/^[0-9a-fA-F]+$/.test(value)) return false;
  return expectedBytes === undefined || value.length === expectedBytes * 2;
}

/** Generate an ephemeral session keypair (x-only public key, hex encoded). */
export function generateSessionKeypair(): { privateKey: string; publicKey: string } {
  const privateKey = new Uint8Array(32);
  crypto.getRandomValues(privateKey);
  // Ensure the scalar is valid for secp256k1 (nonzero, < curve order) by retrying.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const publicKey = schnorr.getPublicKey(privateKey);
      return { privateKey: bytesToHex(privateKey), publicKey: bytesToHex(publicKey) };
    } catch {
      crypto.getRandomValues(privateKey);
    }
  }
  throw new Error("Failed to generate a valid session keypair");
}

/** Sign a canonical message with a session private key; returns 64-byte hex signature. */
export function signCanonical(message: string, privateKeyHex: string): string {
  if (!isHex(privateKeyHex, 32)) throw new Error("Session private key must be 32-byte hex");
  return bytesToHex(schnorr.sign(new TextEncoder().encode(message), hexToBytes(privateKeyHex)));
}

/** Verify a canonical message signature against an x-only public key (fail-closed). */
export function verifyCanonical(message: string, signatureHex: string, publicKeyHex: string): boolean {
  if (!isHex(signatureHex, 64) || !isHex(publicKeyHex, 32)) return false;
  try {
    return schnorr.verify(hexToBytes(signatureHex), new TextEncoder().encode(message), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}
