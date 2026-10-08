/**
 * DrawBound operator tooling — build and sign a LIVE SatVM credit transition (Phase D).
 *
 * Usage:
 *   OPERATOR_MNEMONIC=... pnpm exec tsx scripts/build-transition.mts <fundingTxid> <amountSats> [vout] [feeSats] [recipient] [inputSats]
 *   OPERATOR_PRIVATE_KEY=... pnpm exec tsx scripts/build-transition.mts <fundingTxid> <amountSats>
 *
 * Environment:
 *   TACHI_NETWORK        signet (default) | regtest
 *   TACHI_BASE_URL       daemon base URL (default: the public endpoint for the network)
 *   TACHI_VAULT_REF      optional; when set, the derived vault address MUST equal it
 *   OPERATOR_MNEMONIC    BIP-39 mnemonic (12+ words) — preferred
 *   OPERATOR_PRIVATE_KEY 32-byte x-only hex — alternative, no mnemonic in the shell
 *   OPERATOR_VTXO_ID     ledger VTXO to spend; REQUIRED unless one is found on the daemon
 *   OPERATOR_INPUT_SATS  value of that VTXO; required with an explicit OPERATOR_VTXO_ID
 *                      (OPERATOR_VTXO_AMOUNT, the name `operator-live.mts register`
 *                      uses, is accepted as an alias)
 *   OPERATOR_RPC_URL     bitcoind RPC for the funding wallet (default http://127.0.0.1:38332)
 *   FINALIZE_PSBT        "1" to also attempt finalizeVtxoPsbt (cooperative path only)
 *
 * Output: JSON with the signed `txHex`, the daemon-verified `txHash`, and the vault
 * the transaction belongs to. Paste `txHex` into the DrawBound terminal's Advanced
 * box (or POST it as `txHex`) — DrawBound broadcasts it, then waits for the daemon
 * to report it committed.
 *
 * This script fails closed on purpose. It never guesses an input, never signs with a
 * fallback nonce, and refuses to print a transaction the daemon cannot decode,
 * because every one of those shortcuts ends with a real testnet transaction that
 * either fails obscurely or spends a nonce for nothing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

if (typeof process.loadEnvFile === "function" && existsSync(".env")) {
  process.loadEnvFile();
}

import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import {
  createVault,
  buildVtxoPsbt,
  verifyVtxoPsbt,
  signVtxoPsbtAsUser,
  finalizeVtxoPsbt,
  buildTachiTxTransfer,
  signTachiTx,
  encodeTachiTx,
  decodeTachiTxOnDaemon,
  getAddressVtxos,
  getAccountNonce,
  getFeeEstimate,
  assertDaemonChainId,
  chainIdForWalletChain,
  type TaprootSigner,
} from "@tachibtc/taurus-vault-core";
import { WalletAggregator, BitcoinCoreRpcClient, Keystore, getNetwork } from "@tachibtc/taurus-wallet-aggregator";

const NETWORK = (process.env.TACHI_NETWORK === "regtest" ? "regtest" : "signet") as "signet" | "regtest";
const DAEMON_BASE = (process.env.TACHI_BASE_URL || `https://rpc-${NETWORK}.tachibtc.com`).replace(/\/+$/, "");
const OPERATOR_RPC_URL = process.env.OPERATOR_RPC_URL ?? "http://127.0.0.1:38332";

function fail(message: string, hint?: string): never {
  console.error(`ERROR: ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Every daemon call goes through these options. Plaintext is allowed only for a
 * genuinely local `http://` daemon — for anything else the vendor's https
 * requirement stays on, so a mistyped `http://rpc-signet…` fails loudly instead of
 * sending a key-bearing request over the wire in the clear.
 */
const QUERY_OPTIONS = {
  baseUrl: DAEMON_BASE,
  ...(DAEMON_BASE.startsWith("http://") ? { allowInsecureHttp: true } : {}),
} as const;

async function main(): Promise<void> {
  const fundingTxid = (process.argv[2] ?? process.env.FUNDING_TXID ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(fundingTxid)) {
    fail(
      "usage: build-transition.mts <fundingTxid> <amountSats> [vout] [feeSats] [recipient] [inputSats]",
      "fundingTxid must be the 64-char hex txid of your confirmed L1 deposit (see `operator-live.mts fund-help`).",
    );
  }

  const amountSatsStr = process.argv[3] ?? "";
  if (!/^\d+$/.test(amountSatsStr)) fail("amountSats is required and must be a positive integer of sats");
  const amountSats = BigInt(amountSatsStr);
  if (amountSats <= 0n) fail("amountSats must be greater than 0");

  const vout = Number.parseInt(process.argv[4] ?? "0", 10);
  if (!Number.isInteger(vout) || vout < 0) fail("vout must be a non-negative integer");

  const mnemonic = process.env.OPERATOR_MNEMONIC?.trim();
  const privHex = process.env.OPERATOR_PRIVATE_KEY?.trim().toLowerCase().replace(/^0x/, "");
  if (!mnemonic && !/^[0-9a-f]{64}$/.test(privHex ?? "")) {
    fail(
      "set OPERATOR_MNEMONIC (12+ words) or OPERATOR_PRIVATE_KEY (32-byte hex)",
      "Derive the key with: OPERATOR_MNEMONIC=... pnpm exec tsx scripts/operator-live.mts export-key",
    );
  }

  // 0. Which chain is this daemon actually on? Building a vault against a daemon
  //    that is on another network produces an address that exists nowhere, and a
  //    transaction nobody will relay.
  const expectedChainId = chainIdForWalletChain(NETWORK);
  try {
    // The vendor's own preflight: throws ChainIdMismatchError when the daemon
    // advertises a different chain, or nothing at all (loopback daemons excepted,
    // since a stripped local dev build legitimately omits the field).
    const info = await assertDaemonChainId(expectedChainId, { ...QUERY_OPTIONS });
    console.error(`daemon ok: ${DAEMON_BASE} chain=${info.chainId} height=${info.latestBlockHeight} version=${info.version}`);
  } catch (error) {
    fail(
      `could not verify the daemon's chain id: ${error instanceof Error ? error.message : String(error)}`,
      "Fix connectivity or TACHI_BASE_URL before building a transaction — never build blind.",
    );
  }

  // 1. Vault + signer.
  const rpc = new BitcoinCoreRpcClient({ url: OPERATOR_RPC_URL });
  let vault;
  let userSigner: TaprootSigner;

  if (mnemonic) {
    const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: NETWORK, rpc });
    const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });
    vault = await createVault({
      network: NETWORK,
      userWallet,
      validators: { endpoint: `${DAEMON_BASE}/tachi_validators`, expectedChainId: NETWORK },
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
      validators: { endpoint: `${DAEMON_BASE}/tachi_validators`, expectedChainId: NETWORK },
    });
    userSigner = {
      publicKey: Buffer.from(pubKeyBytes),
      sign: (h: Uint8Array) => Buffer.from(secp256k1.sign(h, privBytes)),
      signSchnorr: (h: Uint8Array) => Buffer.from(schnorr.sign(h, privBytes)),
    };
  }

  // 2. The key that derives this vault must be the key the operator configured.
  //    A wrong mnemonic produces a valid-looking vault that holds nothing.
  const configuredVault = process.env.TACHI_VAULT_REF?.trim();
  if (configuredVault && configuredVault !== vault.p2tr.address) {
    fail(
      `derived vault ${vault.p2tr.address} does not match TACHI_VAULT_REF ${configuredVault}`,
      "Use the mnemonic that registered this vault, or update TACHI_VAULT_REF.",
    );
  }

  // 3. Fee: prefer the daemon's own estimate to a stale hand-typed number.
  let feeSats = process.argv[5] ? BigInt(process.argv[5]) : 0n;
  if (feeSats === 0n) {
    try {
      const estimate = await getFeeEstimate({ ...QUERY_OPTIONS });
      feeSats = BigInt(Math.max(estimate.recommendedFeeSats ?? 1000, 1000));
      console.error(`fee from daemon estimate: ${feeSats} sats`);
    } catch (error) {
      fail(
        `could not read a fee estimate (${error instanceof Error ? error.message : String(error)}) and none was given`,
        "Pass the fee explicitly as the 4th argument.",
      );
    }
  }

  // 4. The input to spend. No guesses: an invented vtxoId produces a transaction the
  //    daemon rejects with "vtxo not found" *after* a nonce has been consumed, which
  //    is the worst possible failure mode for an operator walking this runbook.
  let inputVtxoId: Buffer | undefined;
  let inputValSats: bigint | undefined;
  // `operator-live.mts register` calls the mint size OPERATOR_VTXO_AMOUNT; accept either
  // name so an operator does not have to remember which spelling belongs to which script.
  const inputSatsEnv = process.env.OPERATOR_INPUT_SATS ?? process.env.OPERATOR_VTXO_AMOUNT;
  const explicitVtxo = process.env.OPERATOR_VTXO_ID?.trim().replace(/^0x/, "");
  if (explicitVtxo) {
    if (!/^[0-9a-f]{64}$/.test(explicitVtxo)) fail("OPERATOR_VTXO_ID must be 64-char hex");
    if (!inputSatsEnv) fail("OPERATOR_INPUT_SATS (or OPERATOR_VTXO_AMOUNT) is required when OPERATOR_VTXO_ID is supplied");
    inputVtxoId = Buffer.from(explicitVtxo, "hex");
    inputValSats = BigInt(inputSatsEnv);
  } else {
    try {
      const addressQuery = Buffer.from(vault.userKey.xOnly).toString("hex");
      const vtxoList = await getAddressVtxos(addressQuery, { ...QUERY_OPTIONS });
      const needed = amountSats + feeSats;
      const candidate = vtxoList.vtxos.find((v) => !v.spent && !v.locked && v.amountSats >= needed);
      if (candidate) {
        inputVtxoId = Buffer.from(candidate.id, "hex");
        inputValSats = candidate.amountSats;
        console.error(`input from daemon: vtxo ${candidate.id} (${candidate.amountSats} sats)`);
      }
    } catch (error) {
      console.error(`note: could not list ledger VTXOs (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (!inputVtxoId || inputValSats === undefined) {
    fail(
      "no spendable ledger VTXO found for this vault key",
      "Onboard one first: pnpm exec tsx scripts/operator-live.mts register <fundingTxid> [vout] (that command mints the VTXO and waits for it to commit).",
    );
  }
  if (process.argv[7]) inputValSats = BigInt(process.argv[7]);
  if (inputValSats < amountSats + feeSats) {
    fail(`input ${inputValSats} sats cannot cover ${amountSats} sats + ${feeSats} sats fee`);
  }

  const changeSats = inputValSats - amountSats - feeSats;
  const recipientAddr = process.argv[6] || vault.p2tr.address;

  console.error(`building for vault ${vault.p2tr.address}: ${amountSats} sats out, ${changeSats} change, ${feeSats} fee`);

  const psbtInputs = [
    {
      txid: fundingTxid,
      vout,
      valueSats: inputValSats,
      scriptPubKey: Buffer.from(vault.p2tr.output).toString("hex"),
      vtxoId: inputVtxoId,
    },
  ];
  const psbtOutputs = [
    { address: recipientAddr, valueSats: amountSats },
    { address: vault.p2tr.address, valueSats: changeSats },
  ];

  const built = buildVtxoPsbt({ vault, inputs: psbtInputs, outputs: psbtOutputs, feeSats });
  const verifyOpts = { maxFeeSats: feeSats * 2n };
  verifyVtxoPsbt(built.psbt, vault, verifyOpts);
  await signVtxoPsbtAsUser(built.psbt, userSigner, vault, verifyOpts);

  // `finalizeVtxoPsbt` builds the BIP-341 script-path witness from the user's
  // signature PLUS the M-of-N quorum cosignatures, which only exist on the
  // cooperative path. The ledger spend here is authorized by the TachiTx signature
  // below, so finalization is opt-in rather than assumed.
  let finalizedHex: string | undefined;
  if (process.env.FINALIZE_PSBT === "1") {
    try {
      finalizedHex = finalizeVtxoPsbt(built.psbt, vault, verifyOpts);
    } catch (error) {
      console.error(`note: finalizeVtxoPsbt failed as expected without quorum cosignatures (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  // 5. The account nonce is what makes the transition replay-protected. Reading it
  //    wrong is not a recoverable detail, so a failed read stops the build.
  let nonce: bigint;
  try {
    nonce = await getAccountNonce(Buffer.from(vault.userKey.xOnly), { ...QUERY_OPTIONS });
  } catch (error) {
    return fail(
      `could not read the account nonce: ${error instanceof Error ? error.message : String(error)}`,
      "Signing with a guessed nonce would either be rejected or double-spend the previous transition.",
    );
  }

  const draft = buildTachiTxTransfer({
    vault,
    inputs: psbtInputs,
    outputs: psbtOutputs,
    feeSats,
    nonce,
    psbt: built.psbt,
  });
  // `chainId` is deliberately omitted: binding the signature to a chain id is the
  // right long-term answer to cross-network replay, but a stock daemon only accepts
  // the plain sighash today and would reject a bound signature outright.
  const signed = await signTachiTx(draft, userSigner);
  const txHex = Buffer.from(encodeTachiTx(signed)).toString("hex");

  // 6. Ask the daemon to read the envelope back before it is worth anything. This is
  //    the vendor-recommended pre-broadcast check (`/tachi_txDecode`); `/tachi_txValidate`
  //    is deliberately NOT used, because current daemons reject transactions they
  //    themselves committed. Nothing is submitted here.
  let decoded: Awaited<ReturnType<typeof decodeTachiTxOnDaemon>>;
  try {
    decoded = await decodeTachiTxOnDaemon(signed, { ...QUERY_OPTIONS });
  } catch (error) {
    fail(
      `the daemon could not decode this transaction: ${error instanceof Error ? error.message : String(error)}`,
      "Do not broadcast it. Re-check the vault registration and the VTXO input.",
    );
  }
  // The decode response is the only place the daemon echoes what it read. If the
  // nonce or fee came back different, the envelope you built is not the envelope
  // the ledger would apply — stop here rather than find out after broadcast.
  if (decoded.nonce !== nonce) fail(`daemon read nonce ${decoded.nonce}, expected ${nonce}; the envelope did not survive encoding intact`);
  if (decoded.feeSats !== feeSats) fail(`daemon read a fee of ${decoded.feeSats} sats, expected ${feeSats}`);
  if (decoded.vin.length !== psbtInputs.length) fail(`daemon read ${decoded.vin.length} input(s), expected ${psbtInputs.length}`);
  if (decoded.vout.length !== psbtOutputs.length) fail(`daemon read ${decoded.vout.length} output(s), expected ${psbtOutputs.length}`);
  if (decoded.vin.some((input) => input.valueSats < amountSats)) {
    fail("a decoded input is smaller than the amount being moved");
  }
  // sha256 of the wire bytes, for comparing the hex you built with the hex you
  // pasted into the terminal. This is NOT the txid: the daemon assigns that on
  // broadcast, and DrawBound reports it on the transition.
  const hexFingerprint = createHash("sha256").update(Buffer.from(txHex, "hex")).digest("hex");

  console.log(
    JSON.stringify(
      {
        status: "READY",
        network: NETWORK,
        daemon: DAEMON_BASE,
        vaultRef: vault.p2tr.address,
        fundingTxid,
        fundingVout: vout,
        inputVtxoId: inputVtxoId.toString("hex"),
        inputSats: inputValSats,
        drawAmountSats: amountSats,
        changeSats,
        feeSats,
        nonce,
        daemonDecode: {
          // Informational: daemons disagree on `type` and it is never a gate.
          type: decoded.type,
          feeSats: decoded.feeSats,
          nonce: decoded.nonce,
          inputs: decoded.vin.map((input) => ({ vtxoId: input.vtxoId, valueSats: input.valueSats })),
          outputs: decoded.vout.map((output) => ({ owner: output.owner, amountSats: output.amountSats })),
        },
        hexFingerprint,
        ...(finalizedHex ? { finalizedWireHex: finalizedHex } : {}),
        txHex,
        instructions:
          "Paste txHex into the DrawBound terminal's Advanced box and execute the action. DrawBound decodes it again, broadcasts, and only then waits for the daemon to report it committed.",
      },
      bigintReplacer,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
