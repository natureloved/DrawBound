import { describe, expect, it, afterEach } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import { buildSignedHealthAttestation, oraclePublicKey } from "@/lib/proofs/oracle-service";
import { verifyNormalizedProof } from "@/lib/proofs/verify";
import { normalizeProof } from "@/lib/proofs/normalize";

const toHex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

describe("reference oracle signing service", () => {
  afterEach(() => {
    delete process.env.PROOF_RELAY_PUBLIC_KEYS;
  });

  const oracleKey = toHex(randomBytes(32));

  it("derives the public key deterministically from the private key", () => {
    expect(oraclePublicKey(oracleKey)).toBe(oraclePublicKey(`0x${oracleKey.toUpperCase()}`));
    expect(oraclePublicKey(oracleKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => oraclePublicKey("nope")).toThrow(/32-byte hex/);
  });

  it("produces a signed oracle attestation that passes strict verification", () => {
    const proof = buildSignedHealthAttestation(
      {
        vaultRef: "tb1pvault",
        positionId: "pos_oracle_01",
        network: "signet",
        debtUnits: 200,
        collateralSats: 5000,
      },
      { privateKeyHex: oracleKey },
    );

    expect(proof.source).toBe("oracle");
    expect(proof.verification).toBe("VERIFIED");
    expect(proof.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(proof.oraclePubkey).toBe(oraclePublicKey(oracleKey));
    // 5000 sats vs 2000 sats obligation = 250%.
    expect(proof.healthBps).toBe(25000);

    process.env.PROOF_RELAY_PUBLIC_KEYS = proof.oraclePubkey!;
    expect(verifyNormalizedProof(proof)).toBe(true);
  });

  it("strict mode rejects the attestation after any envelope tampering", () => {
    const proof = buildSignedHealthAttestation(
      {
        vaultRef: "tb1pvault",
        positionId: "pos_oracle_01",
        network: "signet",
        debtUnits: 0,
        collateralSats: 5000,
      },
      { privateKeyHex: oracleKey },
    );

    process.env.PROOF_RELAY_PUBLIC_KEYS = proof.oraclePubkey!;
    // Tamper: recompute the digest for the new envelope, keep the old signature.
    const tampered = normalizeProof({ ...proof, healthBps: 10000 });
    expect(verifyNormalizedProof({ ...tampered, signature: proof.signature, oraclePubkey: proof.oraclePubkey })).toBe(false);
  });

  it("strict mode rejects the signed attestation under a different allowlist", () => {
    const proof = buildSignedHealthAttestation(
      { vaultRef: "tb1pvault", positionId: "pos_oracle_01", network: "signet", debtUnits: 0, collateralSats: 5000 },
      { privateKeyHex: oracleKey },
    );
    process.env.PROOF_RELAY_PUBLIC_KEYS = toHex(randomBytes(32)); // different oracle
    expect(verifyNormalizedProof(proof)).toBe(false);
  });
});
