import { describe, expect, it } from "vitest";
import {
  canonicalTransitionMessage,
  generateSessionKeypair,
  isHex,
  signCanonical,
  verifyCanonical,
} from "@/lib/wallet/canonical";

describe("canonical transition messages", () => {
  it("produces the exact documented wire format", () => {
    const message = canonicalTransitionMessage({
      positionId: "pos_abc",
      vaultRef: "tb1pvault",
      action: "DRAW",
      amount: 250,
      nonce: 3,
    });
    expect(message).toBe("DrawBound:v1:pos_abc:tb1pvault:DRAW:250:3");
  });

  it("rejects fields that could ambiguate the colon-separated format", () => {
    expect(() =>
      canonicalTransitionMessage({ positionId: "pos:evil", vaultRef: "tb1p", action: "DRAW", amount: 1, nonce: 0 }),
    ).toThrow(/positionId/);
    expect(() =>
      canonicalTransitionMessage({ positionId: "pos", vaultRef: "tb1p x", action: "DRAW", amount: 1, nonce: 0 }),
    ).toThrow(/vaultRef/);
    // Fixture-style vault refs with colons are allowed (server-built, never parsed).
    expect(
      canonicalTransitionMessage({ positionId: "pos_x", vaultRef: "vault:taurus:signet:demo", action: "DRAW", amount: 1, nonce: 0 }),
    ).toBe("DrawBound:v1:pos_x:vault:taurus:signet:demo:DRAW:1:0");
    expect(() =>
      canonicalTransitionMessage({ positionId: "pos", vaultRef: "tb1p", action: "DRAW", amount: -1, nonce: 0 }),
    ).toThrow(/amount/);
    expect(() =>
      canonicalTransitionMessage({ positionId: "pos", vaultRef: "tb1p", action: "DRAW", amount: 1.5, nonce: 0 }),
    ).toThrow(/amount/);
  });
});

describe("session keypairs and Schnorr signatures", () => {
  it("generates 32-byte x-only keys", () => {
    const { privateKey, publicKey } = generateSessionKeypair();
    expect(isHex(privateKey, 32)).toBe(true);
    expect(isHex(publicKey, 32)).toBe(true);
    // Two keygens must not collide.
    expect(generateSessionKeypair().privateKey).not.toBe(privateKey);
  });

  it("signs and verifies a message round-trip", () => {
    const { privateKey, publicKey } = generateSessionKeypair();
    const message = canonicalTransitionMessage({ positionId: "p", vaultRef: "v", action: "UNLOCK", amount: 0, nonce: 9 });
    const signature = signCanonical(message, privateKey);
    expect(isHex(signature, 64)).toBe(true);
    expect(verifyCanonical(message, signature, publicKey)).toBe(true);
  });

  it("fails closed on tampering", () => {
    const { privateKey, publicKey } = generateSessionKeypair();
    const other = generateSessionKeypair();
    const message = canonicalTransitionMessage({ positionId: "p", vaultRef: "v", action: "DRAW", amount: 100, nonce: 0 });
    const signature = signCanonical(message, privateKey);

    expect(verifyCanonical(message.replace("100", "101"), signature, publicKey)).toBe(false);
    expect(verifyCanonical(message, signature, other.publicKey)).toBe(false);
    expect(verifyCanonical(message, "ff".repeat(64), publicKey)).toBe(false);
    expect(verifyCanonical(message, "not-hex", publicKey)).toBe(false);
    expect(verifyCanonical(message, signature, "shortkey")).toBe(false);
  });

  it("rejects malformed private keys when signing", () => {
    expect(() => signCanonical("msg", "00ff")).toThrow(/32-byte hex/);
  });
});
