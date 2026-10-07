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
import { chainIdMatches, expectedChainId, summarizeLockedVtxos } from "./signet";
import { env } from "../config/env";

/**
 * Which chain a read is for. `mainnet` is included because silently re-labelling a
 * mainnet configuration as signet would put the wrong network name on every number
 * the terminal and the draw gate then reason about; a mainnet read has to name the
 * endpoint explicitly (tachiBaseUrl throws when it cannot).
 */
export type TachiReadNetwork = "signet" | "regtest" | "mainnet";

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
    /** False when the daemon answered with a shape this build cannot read. */
    readComplete: boolean;
    reason: string;
  };
  /**
   * Network binding: what this deployment believes the chain is, what the daemon
   * says it is, and whether they agree. The quorum read enforces the same rule, but
   * surfacing it is what lets an operator see a mislabelled daemon instead of
   * trusting a number that came from somewhere else.
   */
  binding: {
    expectedChainId?: string;
    advertisedChainId: string;
    matched: boolean;
    detail: string;
  };
  policy: {
    mode: string;
    liveReadsEnabled: true;
    liveWritesEnabled: boolean;
    killSwitch: boolean;
    mainnetAllowed: boolean;
    liveReadRequired: boolean;
    networkAttestationRequired: boolean;
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
  if (value === undefined || value === "" || value === "signet") return "signet";
  if (value === "regtest" || value === "mainnet") return value;
  // validateEnv() rejects this at boot; the guard is here for callers that build a
  // snapshot from an explicit, unvalidated value.
  throw new Error(`unknown TACHI_NETWORK "${value}"`);
}

/**
 * Sum a locked-VTXO response tolerantly.
 *
 * `result.vtxos.reduce((t, v) => t + v.amount, 0)` looked fine and was not: a daemon
 * that names the field `amount_sat` (or answers with strings) made every funded
 * vault read as 0 sats, which in live mode is simultaneously "no collateral" and
 * "no credit limit" — an outcome indistinguishable from an unfunded vault. The
 * shared parser reports incompleteness instead, and callers refuse to decide.
 */
function lockedSummary(address: string, result: LockedVTXOsResponse): TachiReadOnlySnapshot["vault"] {
  const summary = summarizeLockedVtxos(result);
  return {
    address,
    lockedVtxoCount: summary.count,
    lockedSats: summary.sats,
    readComplete: summary.complete,
    reason: summary.reason,
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

  const expected = expectedChainId(network);
  const [health, node, liveValidators, quorum, locked] = await Promise.all([
    client.getHealth() as Promise<HealthResponse>,
    client.getNodeInfo() as Promise<NodeInfoResponse>,
    client.getLiveValidators() as Promise<LiveValidatorsResponse>,
    // The bare network name is accepted by the vendor's token-match rule, so a
    // daemon advertising "tachi-signet-1" for TACHI_NETWORK=signet passes and a
    // regtest daemon answering the same query does not.
    quorumReader({ baseUrl, expectedChainId: expected ?? network }),
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
    binding: (() => {
      const advertised = node.chain_id || node.network || "";
      const matched = expected ? chainIdMatches(advertised, expected) : false;
      return {
        expectedChainId: expected,
        advertisedChainId: advertised,
        matched,
        detail: !expected
          ? `no expected chain id for network "${network}"; set TACHI_EXPECTED_CHAIN_ID`
          : matched
            ? `daemon chain id "${advertised}" matches "${expected}"`
            : `daemon chain id "${advertised || "(none)"}" is not "${expected}"`,
      };
    })(),
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
      liveReadRequired: env.liveRequiresChainRead(),
      networkAttestationRequired: env.liveRequiresChainAttestation(),
    },
  };
}
