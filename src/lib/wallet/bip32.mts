/**
 * Minimal BIP-39 / BIP-32 private-key derivation, for operator tooling only.
 *
 * Why this lives in a `.mts` file rather than a `.ts` one:
 * `package.json` has no `"type"` field, so `.ts` files in this project are
 * treated as CommonJS. An ESM `.mts` script importing them therefore only sees
 * a synthetic `default` export and fails with "does not provide an export named
 * X". `.mts` -> `.mts` imports resolve correctly, so a shared `.mts` module is
 * the one shape that both `scripts/operator-live.mts` (via tsx) and the vitest
 * suite can consume.
 *
 * This module deliberately stops at the private key. Turning a key into an
 * address, a WIF, or an ownership proof is the caller's job.
 *
 * SECURITY: DrawBound itself never imports this. It exists so an operator can
 * go from a mnemonic to the 32-byte key that the ownership-proof flow demands.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";

/** Child indices at or above this value are hardened (BIP-32). */
export const HARDENED_OFFSET = 0x80000000;

/** BIP-84 P2WPKH account 0, external chain, first key. Matches the aggregator. */
export const DEFAULT_DERIVATION_PATH = "m/84'/1'/0'/0/0";

// @noble/curves v2 removed the top-level `secp256k1.CURVE`; the params hang off Point.
const CURVE_ORDER = secp256k1.Point.CURVE().n;

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/** BIP-39: mnemonic -> 64-byte seed (PBKDF2-HMAC-SHA512, 2048 rounds, NFKD). */
export function mnemonicToSeed(mnemonic: string, passphrase = ""): Uint8Array {
  const encoder = new TextEncoder();
  return pbkdf2(
    sha512,
    encoder.encode(mnemonic.normalize("NFKD")),
    encoder.encode(`mnemonic${passphrase.normalize("NFKD")}`),
    { c: 2048, dkLen: 64 },
  );
}

/** BIP-32: seed -> master private key + chain code (HMAC-SHA512, key "Bitcoin seed"). */
export function masterKeyFromSeed(seed: Uint8Array): { key: Uint8Array; chainCode: Uint8Array } {
  const digest = hmac(sha512, new TextEncoder().encode("Bitcoin seed"), seed);
  const key = digest.slice(0, 32);
  if (bytesToBigInt(key) === 0n || bytesToBigInt(key) >= CURVE_ORDER) {
    throw new Error("BIP-32 seed produced an invalid master key");
  }
  return { key, chainCode: digest.slice(32) };
}

/** Parse "m/84'/1'/0'/0/0" into BIP-32 child indices. `m` alone yields []. */
export function parseDerivationPath(path: string): number[] {
  const segments = path.trim().split("/");
  if (segments[0] !== "m") throw new Error(`Derivation path must start with "m/": ${path}`);
  return segments.slice(1).map((segment) => {
    const hardened = /['hH]$/.test(segment);
    const body = hardened ? segment.slice(0, -1) : segment;
    const index = Number(body);
    if (!/^\d+$/.test(body) || index >= HARDENED_OFFSET) {
      throw new Error(`Invalid derivation path segment: ${segment}`);
    }
    return hardened ? index + HARDENED_OFFSET : index;
  });
}

/** BIP-32 CKDpriv: one hardened or normal child step. */
export function deriveChildKey(
  key: Uint8Array,
  chainCode: Uint8Array,
  index: number,
): { key: Uint8Array; chainCode: Uint8Array } {
  // CKDpriv hashes `ser256(k_par) || ser32(i)` for a normal child and
  // `0x00 || ser256(k_par) || ser32(i)` for a hardened one. The 0x00 pad sits at
  // OFFSET 0, so the 32-byte key occupies bytes 1..32.
  //
  // Getting this wrong is silent: writing the key at offset 0 and leaving
  // data[32] as the implicit zero produces `key || 0x00 || index` instead of
  // `0x00 || key || index` — a different 37-byte string that yields a
  // well-formed but entirely wrong key. See src/tests/bip32.test.ts.
  const data = new Uint8Array(37);
  if (index >= HARDENED_OFFSET) {
    data[0] = 0x00;
    data.set(key, 1);
  } else {
    data.set(secp256k1.getPublicKey(key, true), 0);
  }
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;

  const digest = hmac(sha512, chainCode, data);
  const child = (bytesToBigInt(digest.slice(0, 32)) + bytesToBigInt(key)) % CURVE_ORDER;
  if (child === 0n) throw new Error("BIP-32 derivation produced an invalid child key");
  return { key: bigIntToBytes(child, 32), chainCode: digest.slice(32) };
}

/** Derive the private key at `path` from a BIP-39 mnemonic. */
export function privateKeyAtPath(mnemonic: string, path: string): Uint8Array {
  let node = masterKeyFromSeed(mnemonicToSeed(mnemonic));
  for (const index of parseDerivationPath(path)) {
    node = deriveChildKey(node.key, node.chainCode, index);
  }
  return node.key;
}
