import {
  createVault,
  describeTapscript,
  verifyVaultP2tr,
} from "@tachibtc/taurus-vault-core";
import {
  BitcoinCoreRpcClient,
  WalletAggregator,
} from "@tachibtc/taurus-wallet-aggregator";

const NETWORK = "signet" as const;
const VALIDATORS_ENDPOINT = "https://rpc-signet.tachibtc.com/tachi_validators";
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * This RPC client is only required by the aggregator's wallet shape. The spike
 * intentionally never calls sync, balance, signing, deposit, or broadcast APIs.
 */
const rpc = new BitcoinCoreRpcClient({ url: "http://127.0.0.1:38332" });

async function main(): Promise<void> {
  console.log("Drawbound Taurus offline verification spike");
  console.log(`Network: ${NETWORK}`);
  console.log(`Validators endpoint: ${VALIDATORS_ENDPOINT}`);

  try {
    const aggregator = WalletAggregator.fromMnemonic(TEST_MNEMONIC, {
      network: NETWORK,
      rpc,
    });
    const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });

    const vault = await createVault({
      network: NETWORK,
      userWallet,
      validators: {
        endpoint: VALIDATORS_ENDPOINT,
        expectedChainId: NETWORK,
      },
    });

    verifyVaultP2tr(vault.p2tr);

    const descriptor = vault.userKey.descriptor;
    const publicMetadata = {
      vaultP2tr: vault.p2tr.address,
      validatorCount: vault.nodeKeys.length,
      threshold: vault.p2tr.cooperativeLeaf.threshold,
      exitCsvBlocks: vault.p2tr.exitLeaf.csvBlocks,
      userKey: {
        derivationPath: vault.userKey.derivationPath ?? descriptor?.path ?? null,
        address: vault.userKey.address ?? descriptor?.address ?? null,
        addressType: descriptor?.addressType ?? "p2wpkh",
        scheme: descriptor?.scheme ?? null,
        masterFingerprint: descriptor?.masterFingerprint ?? null,
      },
      scripts: {
        cooperative: describeTapscript(vault.p2tr.cooperativeLeaf.script),
        exit: describeTapscript(vault.p2tr.exitLeaf.script),
      },
    };

    console.log(JSON.stringify(publicMetadata, null, 2));
    console.log(
      "Offline Taurus verification passed. No wallet sync, vault funding, registration, or transaction broadcast was attempted.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

void main();
