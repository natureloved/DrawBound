import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  DEFAULT_DERIVATION_PATH,
  HARDENED_OFFSET,
  bigIntToBytes,
  bytesToBigInt,
  deriveChildKey,
  masterKeyFromSeed,
  mnemonicToSeed,
  parseDerivationPath,
  privateKeyAtPath,
} from "@/lib/wallet/bip32.mts";

/**
 * BIP-39 / BIP-32 derivation contract.
 *
 * Regression guard for a real bug found while building `export-key` in
 * scripts/operator-live.mts. CKDpriv hashes `0x00 || ser256(k_par) || ser32(i)`
 * for a hardened child, with the 0x00 pad at OFFSET 0. The original code wrote
 * the key at offset 0 and left data[32] as the implicit zero, producing
 * `key || 0x00 || index`. That is a different 37-byte string, so it derived a
 * well-formed but wrong private key — silently, with no error and no way to
 * notice short of comparing addresses.
 *
 * The vectors below are BIP-32 Test vector 1 plus the BIP-39 reference mnemonic.
 * They were verified against the canonical `xprv` strings by base58check-decoding
 * them, so the expected values are ground truth rather than transcribed guesses.
 */

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** BIP-32 Test vector 1 seed. */
const VECTOR_1_SEED = Uint8Array.from(Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"));

/** The canonical BIP-39 test mnemonic ("all-zero entropy"). */
const TEST_MNEMONIC = Array.from({ length: 11 }, () => "abandon").concat("about").join(" ");

/** BIP-32 Test vector 1 private keys, straight from the canonical xprv strings. */
const VECTOR_1_KEYS: Array<[string, string]> = [
  ["m", "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35"],
  ["m/0'", "edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea"],
  ["m/0'/1", "3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368"],
  ["m/0'/1/2'", "cbce0d719ecf7431d88e6a89fa1483e02e35092af60c042b1df2ff59fa424dca"],
  ["m/0'/1/2'/2", "0f479245fb19a38a1954c5c7c0ebab2f9bdfd96a17563ef28a6a4b1a2a764ef4"],
  ["m/0'/1/2'/2/1000000000", "471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8"],
];

describe("BIP-32 derivation", () => {
  it("derives the master key and chain code from the test-vector seed", () => {
    const master = masterKeyFromSeed(VECTOR_1_SEED);
    expect(hex(master.key)).toBe("e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35");
    expect(hex(master.chainCode)).toBe("873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508");
  });

  it.each(VECTOR_1_KEYS)("derives the documented private key for %s", (path, expected) => {
    let node = masterKeyFromSeed(VECTOR_1_SEED);
    for (const index of parseDerivationPath(path)) {
      node = deriveChildKey(node.key, node.chainCode, index);
    }
    expect(hex(node.key)).toBe(expected);
  });

  it("covers both hardened and normal steps (the paths above mix both)", () => {
    // Guards against a vector set that accidentally only exercises one branch.
    const indices = parseDerivationPath("m/0'/1/2'/2/1000000000");
    expect(indices.some((i) => i >= HARDENED_OFFSET)).toBe(true);
    expect(indices.some((i) => i < HARDENED_OFFSET)).toBe(true);
  });

  it("puts the 0x00 hardened pad at offset 0, not after the key", () => {
    // The exact byte string CKDpriv must hash for m/0'. This is the assertion
    // that would have caught the original off-by-one immediately.
    const master = masterKeyFromSeed(VECTOR_1_SEED);
    const wrong = new Uint8Array(37);
    wrong.set(master.key, 0); // key || 0x00 || index — the old, buggy layout
    const correct = new Uint8Array(37);
    correct[0] = 0x00;
    correct.set(master.key, 1); // 0x00 || key || index — BIP-32
    for (const buffer of [wrong, correct]) {
      buffer[33] = 0x80;
      buffer[36] = 0x00;
    }
    expect(hex(correct)).toBe(
      `00${hex(master.key)}80000000`,
    );
    expect(hex(wrong)).not.toBe(hex(correct));

    // And only the correct layout yields the documented child.
    const child = deriveChildKey(master.key, master.chainCode, HARDENED_OFFSET);
    expect(hex(child.key)).toBe("edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea");
    expect(hex(child.chainCode)).toBe("47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141");
  });
});

describe("BIP-39 seed derivation", () => {
  it("matches the reference mnemonic seed", () => {
    expect(hex(mnemonicToSeed(TEST_MNEMONIC))).toBe(
      "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
    );
  });

  it("folds an optional passphrase into the salt", () => {
    expect(hex(mnemonicToSeed(TEST_MNEMONIC, "TREZOR"))).not.toBe(hex(mnemonicToSeed(TEST_MNEMONIC)));
  });

  it("derives the default operator path that the vault aggregator expects", () => {
    // This is the key `export-key` hands to the ownership-proof flow. The pubkey
    // is asserted too because it is what the aggregator derives independently,
    // and it is what `derive` turns into the vault ownership address.
    const privateKey = privateKeyAtPath(TEST_MNEMONIC, DEFAULT_DERIVATION_PATH);
    expect(hex(privateKey)).toBe("a9c4134b73560f43fc5c081e5c1daa7ce068adc806d80e1f37cb658e0fea4c8d");
    expect(hex(secp256k1.getPublicKey(privateKey, true))).toBe(
      "02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319",
    );
  });
});

describe("derivation path parsing", () => {
  it("accepts apostrophe, h and H hardened markers", () => {
    const expected = [HARDENED_OFFSET + 84, HARDENED_OFFSET + 1, HARDENED_OFFSET, 0, 0];
    expect(parseDerivationPath("m/84'/1'/0'/0/0")).toEqual(expected);
    expect(parseDerivationPath("m/84h/1h/0h/0/0")).toEqual(expected);
    expect(parseDerivationPath("m/84H/1H/0H/0/0")).toEqual(expected);
  });

  it("treats `m` alone as the master key", () => {
    expect(parseDerivationPath("m")).toEqual([]);
  });

  it("rejects malformed paths", () => {
    expect(() => parseDerivationPath("84'/1'/0'")).toThrow(/must start with/);
    expect(() => parseDerivationPath("m/x")).toThrow(/Invalid derivation path segment/);
    expect(() => parseDerivationPath("m/")).toThrow(/Invalid derivation path segment/);
    // A raw index that already carries the hardened bit is ambiguous, so reject it.
    expect(() => parseDerivationPath("m/2147483648")).toThrow(/Invalid derivation path segment/);
  });
});

describe("byte conversion helpers", () => {
  it("round-trips big-endian values", () => {
    for (const value of [0n, 1n, 255n, 256n, 0x80000000n, 2n ** 256n - 1n]) {
      expect(bytesToBigInt(bigIntToBytes(value, 32))).toBe(value);
    }
  });

  it("left-pads short values to the requested length", () => {
    expect(hex(bigIntToBytes(1n, 32))).toBe("00".repeat(31) + "01");
  });
});
