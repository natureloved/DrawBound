import { createTachiSdkClient } from "../src/lib/tachi/sdk-client";
import { tachiBaseUrl } from "../src/lib/tachi/http-client";

const network = process.env.TACHI_NETWORK || "signet";
const client = createTachiSdkClient();

async function main(): Promise<void> {
  console.log(`Drawbound Tachi read-only spike`);
  console.log(`Network: ${network}`);
  console.log(`Base URL: ${tachiBaseUrl(network)}`);

  try {
    const health = await client.getHealth();
    console.log(`Health: ${health.status}; validators: ${health.validators}`);

    const live = await client.getLiveValidators();
    console.log(`Live validators: ${live.count}/${live.total_known}`);
    for (const validator of live.validators.slice(0, 5)) {
      console.log(`  ${validator.peer_id.slice(0, 20)}... @ ${validator.host}:${validator.p2p_port}`);
    }

    const chain = await client.bitcoinRPC<{ chain?: string; blocks?: number }>({ method: "getblockchaininfo" });
    if (chain.error) throw new Error(`Bitcoin RPC ${chain.error.code}: ${chain.error.message}`);
    console.log(`Bitcoin chain: ${chain.result.chain ?? "unknown"}; blocks: ${chain.result.blocks ?? "unknown"}`);
    console.log("Read-only spike passed. No vault, VTXO, or transaction write was attempted.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

void main();
