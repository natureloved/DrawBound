/**
 * DrawBound operator tooling: Fund vault from operator SegWit wallet (Phase B & C).
 *
 * Spends from the funded P2WPKH address (e.g. tb1q...) into the derived vault P2TR (tb1p...),
 * then registers the vault on the Tachi ledger so VTXOs become active and spendable.
 *
 * Usage:
 *   OPERATOR_MNEMONIC=... pnpm exec tsx scripts/fund-vault.mts [amountSats]
 */
import {
  createVault,
  depositToVault,
  registerVault,
  verifyVaultP2tr,
  type TaprootSigner,
  buildTachiTxDeposit,
  signTachiTx,
  broadcastTachiTx,
  vtxoIdFromDeposit,
} from "@tachibtc/taurus-vault-core";
import {
  WalletAggregator,
  BitcoinCoreRpcClient,
  Keystore,
  getNetwork,
} from "@tachibtc/taurus-wallet-aggregator";

const NETWORK = (process.env.TACHI_NETWORK === "regtest" ? "regtest" : "signet") as "signet" | "regtest";
const DAEMON_BASE = (process.env.TACHI_BASE_URL || `https://rpc-${NETWORK}.tachibtc.com`).replace(/\/$/, "");

async function main(): Promise<void> {
  const mnemonic = process.env.OPERATOR_MNEMONIC?.trim();
  if (!mnemonic) {
    console.error("Set OPERATOR_MNEMONIC (12+ words) to fund the vault from your wallet.");
    process.exitCode = 1;
    return;
  }

  const amountSatsStr = process.argv[2] ?? "50000";
  const amountSats = BigInt(amountSatsStr);

  const rpc = new BitcoinCoreRpcClient({ url: DAEMON_BASE });
  const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: NETWORK, rpc });
  const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });

  console.log(`Wallet address: ${userWallet.receiveAddress}`);
  console.log("Syncing wallet UTXOs from Bitcoin node...");

  try {
    await userWallet.sync();
  } catch (err) {
    console.log("Sync notice:", err instanceof Error ? err.message : err);
  }

  const balance = userWallet.balance;
  console.log(`Wallet balance: ${balance.confirmed} confirmed, ${balance.unconfirmed} unconfirmed sats`);

  // Build the vault
  const vault = await createVault({
    network: NETWORK,
    userWallet,
    validators: {
      endpoint: `${DAEMON_BASE}/tachi_validators`,
      expectedChainId: NETWORK,
    },
  });
  verifyVaultP2tr(vault.p2tr);
  console.log(`Vault P2TR address: ${vault.p2tr.address}`);

  console.log(`Depositing ${amountSats} sats from wallet to vault P2TR...`);
  const deposit = await depositToVault({
    vault,
    userWallet,
    rpc,
    amountSats,
    feeRateSatVb: 2,
  });

  console.log(`Deposit broadcast successful! L1 TxID: ${deposit.txid}`);

  // Build TaprootSigner for registration
  const keystore = Keystore.fromMnemonic(mnemonic, "", getNetwork(NETWORK), "p2wpkh", 0);
  const node = keystore.signerFor(false, 0);
  const userSigner: TaprootSigner = {
    publicKey: Buffer.from(node.publicKey),
    sign: (h: Uint8Array) => Buffer.from(node.sign(h)),
    signSchnorr: (h: Uint8Array) => Buffer.from(node.signSchnorr!(h)),
  };

  const userXOnly = vault.userKey.xOnly;
  console.log("Onboarding initial VTXO for 0-fee open spend...");
  const onboardTx = buildTachiTxDeposit({
    userXOnly: Buffer.from(userXOnly),
    amountSats: 10_000n,
    nonce: 0n,
    feeSats: 0n,
  });
  const signedOnboard = await signTachiTx(onboardTx, userSigner);
  await broadcastTachiTx(signedOnboard, { url: `${DAEMON_BASE}/tachi_txBroadcastSync` });
  const vtxoId = vtxoIdFromDeposit(signedOnboard);

  console.log("Registering vault on Tachi ledger (TxVaultOpen)...");
  const reg = await registerVault({
    vault,
    outpoint: {
      fundingTxid: Buffer.from(deposit.txid, "hex").reverse(),
      fundingVout: 0,
    },
    userSigner,
    inputs: [{ vtxoId, valueSats: 10_000n }],
    outputs: [{ owner: Buffer.from(userXOnly), amount: 10_000n }],
    feeSats: 0n,
    broadcast: { url: `${DAEMON_BASE}/tachi_txBroadcastSync` },
    confirm: { baseUrl: DAEMON_BASE },
    name: "drawbound-collateral",
  });

  console.log(JSON.stringify({
    status: "FUNDED_AND_REGISTERED",
    network: NETWORK,
    vaultRef: vault.p2tr.address,
    vaultIdHex: reg.vaultIdHex,
    depositTxid: deposit.txid,
    amountSats: amountSats.toString(),
    next: [
      `1. Set TACHI_VAULT_REF=${vault.p2tr.address} in .env`,
      `2. Set ALLOWED_VAULT_REFS=${vault.p2tr.address} in .env`,
      `3. Build transition: npx tsx scripts/build-transition.mts ${deposit.txid} 1000`,
    ],
  }, null, 2));
}

main().catch((err) => {
  console.error("Funding error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
