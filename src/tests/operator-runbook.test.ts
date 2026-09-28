import { describe, expect, it } from "vitest";
import {
  Keystore,
  getNetwork,
} from "@tachibtc/taurus-wallet-aggregator";
import {
  buildTachiTxDeposit,
  signTachiTx,
  vtxoIdFromDeposit,
  deriveVaultId,
  type TaprootSigner,
} from "@tachibtc/taurus-vault-core";
import { schnorr } from "@noble/curves/secp256k1.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("Operator Runbook & Registration Helpers", () => {
  it("derives a TaprootSigner with Schnorr capabilities from Keystore", () => {
    const keystore = Keystore.fromMnemonic(TEST_MNEMONIC, "", getNetwork("regtest"), "p2wpkh", 0);
    const node = keystore.signerFor(false, 0);

    const userSigner: TaprootSigner = {
      publicKey: Buffer.from(node.publicKey),
      sign: (h) => Buffer.from(node.sign(h)),
      signSchnorr: (h) => Buffer.from(node.signSchnorr!(h)),
    };

    expect(userSigner.publicKey.length).toBe(33);
    expect(typeof userSigner.sign).toBe("function");
    expect(typeof userSigner.signSchnorr).toBe("function");

    const messageHash = Buffer.alloc(32, 7);
    const sig = userSigner.signSchnorr!(messageHash);
    expect(Buffer.isBuffer(sig)).toBe(true);
    expect(sig.length).toBe(64);

    // Verify Schnorr signature against the x-only public key
    const xOnly = userSigner.publicKey.subarray(1);
    const isValid = schnorr.verify(new Uint8Array(sig), new Uint8Array(messageHash), new Uint8Array(xOnly));
    expect(isValid).toBe(true);
  });

  it("converts L1 funding txid to internal byte order for VaultID derivation", () => {
    const l1Txid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const internalTxid = Buffer.from(l1Txid, "hex").reverse();
    expect(internalTxid.length).toBe(32);

    const vaultId = deriveVaultId(internalTxid, 0);
    expect(Buffer.isBuffer(vaultId)).toBe(true);
    expect(vaultId.length).toBe(32);
    expect(vaultId.toString("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds, signs, and computes vtxoId for an onboarding TxDeposit", async () => {
    const keystore = Keystore.fromMnemonic(TEST_MNEMONIC, "", getNetwork("regtest"), "p2wpkh", 0);
    const node = keystore.signerFor(false, 0);
    const userSigner: TaprootSigner = {
      publicKey: Buffer.from(node.publicKey),
      sign: (h) => Buffer.from(node.sign(h)),
      signSchnorr: (h) => Buffer.from(node.signSchnorr!(h)),
    };

    const xOnly = Buffer.from(node.publicKey.subarray(1));
    const depositTx = buildTachiTxDeposit({
      userXOnly: xOnly,
      amountSats: 100_000n,
      nonce: 0n,
      feeSats: 0n,
    });

    expect(depositTx.outputs[0].amount).toBe(100_000n);
    expect(depositTx.fee).toBe(0n);

    const signedDeposit = await signTachiTx(depositTx, userSigner);
    expect(signedDeposit.signature.length).toBe(64);

    const vtxoId = vtxoIdFromDeposit(signedDeposit);
    expect(Buffer.isBuffer(vtxoId)).toBe(true);
    expect(vtxoId.length).toBe(32);
  });
});
