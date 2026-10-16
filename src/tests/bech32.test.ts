import { describe, expect, it } from "vitest";
import { decodeSegwitAddress, isP2trAddress } from "@/lib/wallet/bech32";

/**
 * Bech32/bech32m vectors. The valid entries are cross-checked against an
 * independent reference implementation of BIP-173/BIP-350, because this decoder is
 * what decides "this vault address can exist" for both the ownership-proof gate and
 * the live vault binding — a decoder that is merely self-consistent is worthless.
 */
const VALID = [
  "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", // v0 P2WPKH (bech32)
  "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", // v0 P2WSH
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", // v1 P2TR
  "tb1pmm0dahk7mm0dahk7mm0dahk7mm0dahk7mm0dahk7mm0dahk7mm0q3pqcxf",
  "bcrt1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqm3usuw",
];

const INVALID = [
  "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", // bad checksum
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", // bad checksum
  "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y", // v0 program, v1 length
  "BC1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3T5", // mixed case
  "1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8xx0gs", // empty hrp
  "bc1pj6n0edqz0qwx", // too short
  // Not in the bech32 charset at all — exactly what a prefix sniff accepts:
  "tb1pINVALIDINVALIDINVALIDINVALIDINVALIDINVALIDINVALIDINVALIDx",
  "not-an-address",
  "vault:taurus:signet:demo",
];

describe("bech32/bech32m segwit decoder", () => {
  it("decodes every valid vector", () => {
    for (const address of VALID) {
      expect(decodeSegwitAddress(address), address).not.toBeNull();
    }
  });

  it("reads hrp, witness version, program and spec", () => {
    expect(decodeSegwitAddress("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0")).toMatchObject({
      hrp: "bc",
      witnessVersion: 1,
      spec: "bech32m",
      // The BIP-341 generator point's x-only key, which is what this vector encodes.
      programHex: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    });
    expect(decodeSegwitAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toMatchObject({
      hrp: "bc",
      witnessVersion: 0,
      spec: "bech32",
    });
  });

  it("rejects every invalid vector", () => {
    for (const address of INVALID) {
      expect(decodeSegwitAddress(address), address).toBeNull();
    }
  });

  it("is case insensitive but not case mixing", () => {
    const lower = "tb1p9kkv8c66zf8qsz9kd9nq2n3fxrytcrde8cae8qzu9ahwlfv92fyqa4mzx3";
    expect(decodeSegwitAddress(lower)).not.toBeNull();
    expect(decodeSegwitAddress(lower.toUpperCase())).not.toBeNull();
    expect(decodeSegwitAddress(lower.slice(0, 10) + lower.slice(10).toUpperCase())).toBeNull();
  });

  it("separates 'a real address' from 'a taproot address on this network'", () => {
    const p2trMainnet = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
    const p2trSignet = "tb1pmm0dahk7mm0dahk7mm0dahk7mm0dahk7mm0dahk7mm0dahk7mm0q3pqcxf";
    expect(isP2trAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(false); // v0 is not P2TR
    expect(isP2trAddress(p2trMainnet)).toBe(true);
    expect(isP2trAddress(p2trMainnet, "tb")).toBe(false); // right type, wrong chain
    expect(isP2trAddress(p2trSignet, "tb")).toBe(true);
    expect(isP2trAddress(p2trSignet, "bcrt")).toBe(false);
  });

  it("accepts the vault addresses this repo ships", () => {
    // The UI's default demo vault and the TACHI_VAULT_REF demo vault must survive
    // the stricter check, or live mode would reject its own documented defaults.
    expect(isP2trAddress("tb1p9kkv8c66zf8qsz9kd9nq2n3fxrytcrde8cae8qzu9ahwlfv92fyqa4mzx3", "tb")).toBe(true);
    expect(isP2trAddress("tb1pg9pp730v2mjw6833kgvmkmn7l35whpyzaxsljzyn537cjyyn3j8qtw7lsv", "tb")).toBe(true);
  });
});
