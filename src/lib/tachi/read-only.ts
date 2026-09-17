import {
  fetchConsensusQuorum,
  type ConsensusQuorum,
  type FetchConsensusQuorumOptions,
} from "@tachibtc/taurus-vault-core";
import {
  type LockedVTXOsResponse,
  type LiveValidatorsResponse,
  type HealthResponse,
  type NodeInfoResponse,
  TachiClient,
} from "@tachibtc/tachi-sdk-ts";
import { tachiBaseUrl } from "./http-client";
import { createTachiSdkClient } from "./sdk-client";
import { env } from "../config/env";

export type TachiReadNetwork = "signet" | "regtest";

export interface TachiReadOnlySnapshot {
  observedAt: string;
  network: TachiReadNetwork;
  baseUrl: string;
  health: {
    status: string;
    advertisedValidators: number;
  };
  node: {
    chainId: string;
    network: string;
    version: string;
    syncStatus: string;
    latestBlockHeight: number;
    peers: number;
  };
  liveValidators: {
    connected: number;
    totalKnown: number;
  };
  quorum: {
    source: ConsensusQuorum["source"];
    threshold: number;
    validatorCount: number;
    secp256k1Count: number;
    totalConsensusValidators: number;
  };
  vault?: {
    address: string;
    lockedVtxoCount: number;
    lockedSats: number;
  };
  policy: {
    mode: string;
    liveReadsEnabled: true;
    liveWritesEnabled: boolean;
    killSwitch: boolean;
    mainnetAllowed: boolean;
  };
}

export type TachiReadClient = Pick<
  TachiClient,
  "getHealth" | "getNodeInfo" | "getLiveValidators" | "getLockedVtxos"
>;

export type TachiQuorumReader = (
  options: FetchConsensusQuorumOptions,
) => Promise<ConsensusQuorum>;

function configuredNetwork(value = process.env.TACHI_NETWORK): TachiReadNetwork {
  if (value === "regtest") return "regtest";
  return "signet";
}

function lockedSummary(address: string, result: LockedVTXOsResponse): TachiReadOnlySnapshot["vault"] {
  return {
    address,
    lockedVtxoCount: result.vtxos.length,
    lockedSats: result.vtxos.reduce((total, vtxo) => total + vtxo.amount, 0),
  };
}

export async function readTachiSnapshot(options: {
  network?: TachiReadNetwork;
  baseUrl?: string;
  vaultAddress?: string;
  client?: TachiReadClient;
  quorumReader?: TachiQuorumReader;
} = {}): Promise<TachiReadOnlySnapshot> {
  const network = options.network ?? configuredNetwork();
  const baseUrl = (options.baseUrl ?? tachiBaseUrl(network)).replace(/\/$/, "");
  const client = options.client ?? createTachiSdkClient({ baseUrl, timeoutMs: 15_000 });
  const quorumReader = options.quorumReader ?? fetchConsensusQuorum;

  const [health, node, liveValidators, quorum, locked] = await Promise.all([
    client.getHealth() as Promise<HealthResponse>,
    client.getNodeInfo() as Promise<NodeInfoResponse>,
    client.getLiveValidators() as Promise<LiveValidatorsResponse>,
    quorumReader({ baseUrl, expectedChainId: network }),
    options.vaultAddress
      ? (client.getLockedVtxos(options.vaultAddress) as Promise<LockedVTXOsResponse>)
      : Promise.resolve(undefined),
  ]);

  return {
    observedAt: new Date().toISOString(),
    network,
    baseUrl,
    health: {
      status: health.status,
      advertisedValidators: health.validators,
    },
    node: {
      chainId: node.chain_id,
      network: node.network,
      version: node.version,
      syncStatus: node.sync_status,
      latestBlockHeight: node.latest_block_height,
      peers: node.peers,
    },
    liveValidators: {
      connected: liveValidators.count,
      totalKnown: liveValidators.total_known,
    },
    quorum: {
      source: quorum.source,
      threshold: quorum.threshold,
      validatorCount: quorum.validators.length,
      secp256k1Count: quorum.secp256k1Count,
      totalConsensusValidators: quorum.totalValidators,
    },
    ...(locked && options.vaultAddress
      ? { vault: lockedSummary(options.vaultAddress, locked) }
      : {}),
    policy: {
      // Read through the validated env module so these flags always agree with
      // the gates in ../security/policy.ts. This block previously reimplemented
      // the parsing: it hardcoded `liveWritesEnabled: false` (so an armed
      // deployment reported disarmed), dropped the LIVE_TACHI_ENABLED + kill
      // switch conjunction from `mainnetAllowed`, and surfaced the raw
      // `APP_MODE` string unvalidated.
      mode: env.liveEnabled() ? "live" : "fixture",
      liveReadsEnabled: true,
      liveWritesEnabled: env.liveEnabled() && !env.killSwitch(),
      killSwitch: env.killSwitch(),
      mainnetAllowed: env.mainnetAllowed(),
    },
  };
}
