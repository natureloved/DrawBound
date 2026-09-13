import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Minimal base58check + WIF encoding for operator tooling (BIP-322 signing
 * libraries expect WIF-encoded keys). Pure JS via @noble/hashes; testnet WIF
 * uses version byte 0xef, mainnet 0x80, and the compressed flag 0x01.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function base58check(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array([...payload, ...checksum]);
  let value = BigInt(`0x${toHex(full)}`);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  // Leading zero bytes encode as '1'.
  for (const byte of full) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

export function privateKeyToWif(privateKeyHex: string, network: "mainnet" | "testnet" = "testnet"): string {
  const clean = privateKeyHex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error("Private key must be 32 bytes of hex");
  }
  const version = network === "mainnet" ? 0x80 : 0xef;
  const payload = new Uint8Array([version, ...new Uint8Array(Buffer.from(clean, "hex")), 0x01]);
  return base58check(payload);
}
