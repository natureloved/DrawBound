/**
 * DrawBound operator tooling: Build and sign a live SatVM credit transition (Phase D).
 *
 * Usage:
 *   OPERATOR_MNEMONIC=... pnpm exec tsx scripts/build-transition.mts <fundingTxid> <amountSats> [vout] [feeSats]
 *
 * Output:
 *   Outputs the signed txHex ready to paste into DrawBound's Advanced drawer or API body.
 */
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import {
  createVault,
  buildVtxoPsbt,
  verifyVtxoPsbt,
  signVtxoPsbtAsUser,
  buildTachiTxTransfer,
  signTachiTx,
  encodeTachiTx,
  type TaprootSigner,
  getLockedVtxos,
  getAddressVtxos,
  getAccountNonce,
} from "@tachibtc/taurus-vault-core";
import {
  WalletAggregator,
  BitcoinCoreRpcClient,
  Keystore,
  getNetwork,
} from "@tachibtc/taurus-wallet-aggregator";

const NETWORK = (process.env.TACHI_NETWORK === "regtest" ? "regtest" : "signet") as "signet" | "regtest";
const DAEMON_BASE = (process.env.TACHI_BASE_URL || `https://rpc-${NETWORK}.tachibtc.com`).replace(/\/$/, "");
const DUMMY_RPC_URL = process.env.OPERATOR_RPC_URL ?? "http://127.0.0.1:38332";

async function main(): Promise<void> {
  const fundingTxid = (process.argv[2] ?? process.env.FUNDING_TXID ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(fundingTxid)) {
    console.error("usage: build-transition.mts <fundingTxid> <amountSats> [vout] [feeSats] [recipientAddress]");
    console.error("fundingTxid must be the 64-char hex txid of your confirmed L1 deposit.");
    process.exitCode = 1;
    return;
  }

  const amountSatsStr = process.argv[3] ?? "1000";
  const amountSats = BigInt(amountSatsStr);
  if (amountSats <= 0n) {
    console.error("amountSats must be greater than 0");
    process.exitCode = 1;
    return;
  }

  const vout = Number.parseInt(process.argv[4] ?? "0", 10);
  const feeSats = BigInt(process.argv[5] ?? "1000");

  const mnemonic = process.env.OPERATOR_MNEMONIC?.trim();
  const privHex = process.env.OPERATOR_PRIVATE_KEY?.trim().toLowerCase().replace(/^0x/, "");

  if (!mnemonic && (!privHex || !/^[0-9a-f]{64}$/.test(privHex))) {
    console.error("Set OPERATOR_MNEMONIC (12+ words) or OPERATOR_PRIVATE_KEY (32-byte hex).");
    process.exitCode = 1;
    return;
  }

  const rpc = new BitcoinCoreRpcClient({ url: DUMMY_RPC_URL });
  let vault;
  let userSigner: TaprootSigner;

  if (mnemonic) {
    const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: NETWORK, rpc });
    const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });
    vault = await createVault({
      network: NETWORK,
      userWallet,
      validators: {
        endpoint: `${DAEMON_BASE}/tachi_validators`,
        expectedChainId: NETWORK,
      },
    });
    const keystore = Keystore.fromMnemonic(mnemonic, "", getNetwork(NETWORK), "p2wpkh", 0);
    const node = keystore.signerFor(false, 0);
    userSigner = {
      publicKey: Buffer.from(node.publicKey),
      sign: (h: Uint8Array) => Buffer.from(node.sign(h)),
      signSchnorr: (h: Uint8Array) => Buffer.from(node.signSchnorr!(h)),
    };
  } else {
    const privBytes = new Uint8Array(Buffer.from(privHex!, "hex"));
    const pubKeyBytes = secp256k1.getPublicKey(privBytes, true);
    vault = await createVault({
      network: NETWORK,
      userPubkey: Buffer.from(pubKeyBytes),
      validators: {
        endpoint: `${DAEMON_BASE}/tachi_validators`,
        expectedChainId: NETWORK,
      },
    });
    userSigner = {
      publicKey: Buffer.from(pubKeyBytes),
      sign: (h: Uint8Array) => Buffer.from(secp256k1.sign(h, privBytes)),
      signSchnorr: (h: Uint8Array) => Buffer.from(schnorr.sign(h, privBytes)),
    };
  }

  // Determine total input value and active VTXO id from ledger
  let inputValSats = 100_000n;
  let inputVtxoId: Buffer | undefined;

  if (process.env.OPERATOR_VTXO_ID) {
    inputVtxoId = Buffer.from(process.env.OPERATOR_VTXO_ID.trim().replace(/^0x/, ""), "hex");
    if (process.env.OPERATOR_INPUT_SATS) {
      inputValSats = BigInt(process.env.OPERATOR_INPUT_SATS);
    }
  } else {
    try {
      const addressQuery = Buffer.from(vault.userKey.xOnly).toString("hex");
      const vtxoList = await getAddressVtxos(addressQuery, { baseUrl: DAEMON_BASE });
      const activeVtxo = vtxoList.vtxos.find((v) => !v.spent && !v.locked && v.amountSats > (amountSats + feeSats));
      if (activeVtxo) {
        inputVtxoId = Buffer.from(activeVtxo.id, "hex");
        inputValSats = activeVtxo.amountSats;
      }
    } catch {
      // Daemon fallback
    }
  }

  // Fallback to initial onboarded deposit VTXO
  if (!inputVtxoId) {
    inputVtxoId = Buffer.from("f1b32f43beac3e607ad95f6f729d5224f7044dcffea04caaf63d75ea3cb93872", "hex");
    inputValSats = 100_000n;
  }

  if (process.argv[7]) {
    inputValSats = BigInt(process.argv[7]);
  }

  const changeSats = inputValSats - amountSats - feeSats;
  const recipientAddr = process.argv[6] || vault.p2tr.address;

  console.log(`Building VTXO PSBT for vault ${vault.p2tr.address}...`);
  console.log(`Input: ${inputValSats} sats (vtxo ${inputVtxoId.toString("hex")}), Draw: ${amountSats} sats, Fee: ${feeSats} sats, Change: ${changeSats} sats`);

  const psbtInputs = [{
    txid: fundingTxid,
    vout,
    valueSats: inputValSats,
    scriptPubKey: Buffer.from(vault.p2tr.output).toString("hex"),
    vtxoId: inputVtxoId,
  }];
  const psbtOutputs = [
    { address: recipientAddr, valueSats: amountSats },
    { address: vault.p2tr.address, valueSats: changeSats },
  ];

  const built = buildVtxoPsbt({
    vault,
    inputs: psbtInputs,
    outputs: psbtOutputs,
    feeSats,
  });

  const verifyOpts = { maxFeeSats: feeSats * 2n };
  verifyVtxoPsbt(built.psbt, vault, verifyOpts);
  await signVtxoPsbtAsUser(built.psbt, userSigner, vault, verifyOpts);

  let nonce = 0n;
  try {
    nonce = await getAccountNonce(Buffer.from(vault.userKey.xOnly), { baseUrl: DAEMON_BASE });
  } catch {
    // Daemon fallback
  }

  const draft = buildTachiTxTransfer({
    vault,
    inputs: psbtInputs,
    outputs: psbtOutputs,
    feeSats,
    nonce,
    psbt: built.psbt,
  });

  const signed = await signTachiTx(draft, userSigner);
  const txHex = Buffer.from(encodeTachiTx(signed)).toString("hex");

  console.log(JSON.stringify({
    status: "READY",
    network: NETWORK,
    vaultRef: vault.p2tr.address,
    fundingTxid,
    fundingVout: vout,
    drawAmountSats: amountSats.toString(),
    feeSats: feeSats.toString(),
    txHex,
    instructions: "Copy txHex into the DrawBound Terminal Advanced box, then click 'Execute Draw'.",
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
