import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { Signer as Bip322Signer } from "bip322-js";
import {
  clearOwnershipChallenges,
  consumeOwnershipChallenge,
  deriveOwnershipAddress,
  isP2trAddress,
  issueOwnershipChallenge,
  OWNERSHIP_CHALLENGE_TTL_MS,
  ownershipChallengeMessage,
  verifyOwnershipSignature,
} from "@/lib/auth/ownership";
import { privateKeyToWif } from "@/lib/wallet/key-encoding";
import { createSession, clearSessions, SESSION_HEADER } from "@/lib/auth/sessions";

const VAULT_REF = "tb1pvaultownership0000000000000000000000000000000000000000000000qxqz9";

function makeOperator() {
  const priv = randomBytes(32);
  const pub = secp256k1.getPublicKey(priv, true);
  const address = deriveOwnershipAddress(pub, "testnet");
  return { priv, pub, address, wif: privateKeyToWif(Buffer.from(priv).toString("hex"), "testnet") };
}

describe("ownership challenges", () => {
  beforeEach(() => clearOwnershipChallenges());

  it("formats the canonical challenge message", () => {
    expect(ownershipChallengeMessage("tb1pvault", "ab".repeat(16))).toBe(
      `DrawBound:v1:ownership:tb1pvault:${"ab".repeat(16)}`,
    );
    expect(() => ownershipChallengeMessage("tb1p vault", "ab".repeat(16))).toThrow(/vaultRef/);
    expect(() => ownershipChallengeMessage("tb1pvault", "short")).toThrow(/nonce/);
  });

  it("issues single-use challenges bound to the vault ref", () => {
    const issued = issueOwnershipChallenge(VAULT_REF);
    expect(issued.challenge).toContain(VAULT_REF);
    expect(issued.challenge).toContain(issued.nonce);

    expect(consumeOwnershipChallenge(issued.nonce, VAULT_REF)).toBe(issued.challenge);
    // Second consume fails (single use).
    expect(consumeOwnershipChallenge(issued.nonce, VAULT_REF)).toBeNull();
  });

  it("rejects a challenge consumed for a different vault ref", () => {
    const issued = issueOwnershipChallenge(VAULT_REF);
    expect(consumeOwnershipChallenge(issued.nonce, "tb1pother")).toBeNull();
    // Still unconsumed for the right ref.
    expect(consumeOwnershipChallenge(issued.nonce, VAULT_REF)).not.toBeNull();
  });

  it("expires stale challenges", () => {
    const issued = issueOwnershipChallenge(VAULT_REF, Date.now() - OWNERSHIP_CHALLENGE_TTL_MS - 1_000);
    const consumed = consumeOwnershipChallenge(issued.nonce, VAULT_REF);
    expect(consumed).toBeNull();
  });
});

describe("BIP-322 ownership signatures", () => {
  beforeEach(() => clearOwnershipChallenges());

  it("classifies P2TR addresses", () => {
    expect(isP2trAddress("tb1p9kkv8c66zf8qsz9kd9nq2n3fxrytcrde8cae8qzu9ahwlfv92fyqa4mzx3")).toBe(true);
    expect(isP2trAddress("bc1p5fep2l66jldtqtk4qdz00hle6sqvhmf7m2j7emu59nfylktrnxcqt620xq")).toBe(true);
    expect(isP2trAddress("vault:taurus:signet:drawbound-demo")).toBe(false);
    expect(isP2trAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080")).toBe(false); // P2WPKH
  });

  it("round-trips a real BIP-322 signature end to end", () => {
    const operator = makeOperator();
    const issued = issueOwnershipChallenge(VAULT_REF);
    const signature = Bip322Signer.sign(operator.wif, operator.address, issued.challenge);

    // Verify exactly as the connect route does.
    const consumed = consumeOwnershipChallenge(issued.nonce, VAULT_REF);
    expect(consumed).toBe(issued.challenge);
    expect(verifyOwnershipSignature({ challengeMessage: consumed!, ownershipAddress: operator.address, signatureBase64: signature })).toBe(true);
  });

  it("rejects tampered messages, wrong addresses, and foreign keys", () => {
    const operator = makeOperator();
    const foreign = makeOperator();
    const issued = issueOwnershipChallenge(VAULT_REF);
    const signature = Bip322Signer.sign(operator.wif, operator.address, issued.challenge);

    const tampered = issued.challenge.replace("ownership", "ownershipX");
    expect(verifyOwnershipSignature({ challengeMessage: tampered, ownershipAddress: operator.address, signatureBase64: signature })).toBe(false);
    expect(verifyOwnershipSignature({ challengeMessage: issued.challenge, ownershipAddress: foreign.address, signatureBase64: signature })).toBe(false);
    expect(verifyOwnershipSignature({ challengeMessage: issued.challenge, ownershipAddress: operator.address, signatureBase64: "not-base64!!" })).toBe(false);
  });

  it("derives different ownership addresses per network", () => {
    const operator = makeOperator();
    const mainnet = deriveOwnershipAddress(operator.pub, "mainnet");
    expect(mainnet.startsWith("bc1p")).toBe(true);
    expect(operator.address.startsWith("tb1p")).toBe(true);
    expect(mainnet).not.toBe(operator.address);
  });
});

describe("sessions carry ownership state", () => {
  beforeEach(() => clearSessions());
  afterEach(() => clearSessions());

  it("stores and reports ownership verification", () => {
    const plain = createSession({ vaultRef: VAULT_REF, positionId: "pos_x", publicKey: "ab".repeat(32) });
    expect(plain.ownershipVerified).toBe(false);
    expect(plain.ownershipAddress).toBeUndefined();

    const verified = createSession({
      vaultRef: VAULT_REF,
      positionId: "pos_x",
      publicKey: "ab".repeat(32),
      ownershipVerified: true,
      ownershipAddress: "tb1ptest",
    });
    expect(verified.ownershipVerified).toBe(true);
    expect(verified.ownershipAddress).toBe("tb1ptest");
    expect(SESSION_HEADER).toBe("x-drawbound-session");
  });
});
