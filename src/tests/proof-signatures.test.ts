import { describe, expect, it, afterEach } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { normalizeProof } from "@/lib/proofs/normalize";
import { verifyNormalizedProof, verifyProofSignature } from "@/lib/proofs/verify";
import { deriveHealthProof } from "@/lib/proofs/derive";

const toHex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

function makeOracle() {
  const priv = randomBytes(32);
  return { priv, pub: toHex(schnorr.getPublicKey(priv)) };
}

function signedProof(oracle: { priv: Uint8Array; pub: string }, overrides: Record<string, unknown> = {}) {
  const base = normalizeProof({
    positionId: "pos_signed_01",
    network: "signet",
    collateralRef: "tb1pvault",
    covenantVersion: "drawbound-v1",
    healthBps: 20000,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    verification: "VERIFIED",
    source: "oracle",
    ...overrides,
  });
  const signature = toHex(schnorr.sign(hexToBytes(base.digest), oracle.priv));
  return { ...base, signature, oraclePubkey: oracle.pub };
}

describe("signed loan-health proofs", () => {
  afterEach(() => {
    delete process.env.PROOF_RELAY_PUBLIC_KEYS;
  });

  it("preserves signature fields through normalization", () => {
    const oracle = makeOracle();
    const proof = signedProof(oracle);
    const renormalized = normalizeProof(proof);
    expect(renormalized.signature).toBe(proof.signature);
    expect(renormalized.oraclePubkey).toBe(oracle.pub);
    expect(renormalized.source).toBe("oracle");
    expect(renormalized.digest).toBe(proof.digest);
  });

  it("accepts a valid signature and rejects a forged one (non-strict)", () => {
    const oracle = makeOracle();
    const proof = signedProof(oracle);
    expect(verifyNormalizedProof(proof)).toBe(true);
    expect(verifyProofSignature(proof)).toBe(true);

    const forged = { ...proof, signature: toHex(schnorr.sign(hexToBytes(proof.digest), makeOracle().priv)) };
    expect(verifyNormalizedProof(forged)).toBe(false);
  });

  it("rejects a tampered envelope even with the original signature", () => {
    const oracle = makeOracle();
    const proof = signedProof(oracle);
    const tampered = normalizeProof({ ...proof, healthBps: 99999 });
    expect(verifyNormalizedProof({ ...tampered, signature: proof.signature, oraclePubkey: proof.oraclePubkey })).toBe(false);
  });

  it("strict mode: requires an allowlisted signature; unsigned derived proofs fail closed", () => {
    const oracle = makeOracle();
    const impostor = makeOracle();
    const proof = signedProof(oracle);
    const impostorProof = signedProof(impostor);
    const derived = deriveHealthProof({ id: "pos_signed_01", vaultRef: "tb1pvault", collateralSats: 5000, debtUnits: 100 });

    process.env.PROOF_RELAY_PUBLIC_KEYS = oracle.pub;
    expect(verifyNormalizedProof(proof)).toBe(true);
    expect(verifyNormalizedProof(impostorProof)).toBe(false); // signed but not allowlisted
    expect(verifyNormalizedProof(derived)).toBe(false); // server self-attestation refused
  });

  it("labels derived proofs with their source and keeps them debt-aware", () => {
    const healthy = deriveHealthProof({ id: "p", vaultRef: "v", collateralSats: 5000, debtUnits: 0 });
    expect(healthy.source).toBe("derived");
    expect(healthy.healthBps).toBe(65000); // ceiling, no debt

    const leveraged = deriveHealthProof({ id: "p", vaultRef: "v", collateralSats: 5000, debtUnits: 400 });
    expect(leveraged.healthBps).toBe(12500); // exactly at the covenant minimum
  });
});
