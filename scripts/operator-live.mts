/**
 * DrawBound operator tooling for LIVE mode (signet/regtest).
 *
 * Subcommands:
 *   derive <vaultRef?>     — derive a TAURUS vault P2TR from an operator key and
 *                            print the BIP-322 ownership address for the same key.
 *   export-key             — derive the vault user key (hex + WIF) from
 *                            OPERATOR_MNEMONIC, for use as OPERATOR_PRIVATE_KEY.
 *   ownership <vaultRef>   — request a challenge from the DrawBound API, sign it
 *                            with the operator key, print a ready-to-use connect body.
 *   register <txid> [vout] — register a confirmed L1 funding UTXO on the Tachi
 *                            ledger via TxVaultOpen so it becomes spendable VTXOs.
 *   status <vaultRef>      — read-only locked-VTXO status from the Tachi daemon.
 *   fund-help              — print the (operator-only) funding + live-write procedure.
 *
 * Environment:
 *   OPERATOR_PRIVATE_KEY   hex (32 bytes) of the vault user key [ownership, register]
 *   OPERATOR_MNEMONIC      BIP-39 mnemonic [derive, export-key, register]
 *   OPERATOR_PUBKEY        33-byte compressed hex [derive, alternative to mnemonic]
 *   OPERATOR_DERIVATION_PATH  override the export-key path (default m/84'/1'/0'/0/0)
 *   TACHI_NETWORK          signet (default) | regtest
 *   TACHI_BASE_URL         daemon base URL (default: public signet endpoint)
 *   VAULT_NAME             optional vault label for registration (default: drawbound-collateral)
 *   OPERATOR_VTXO_ID       optional existing ledger vtxoId for open fee
 *   OPERATOR_VTXO_AMOUNT   optional vtxo amount in sats for initial open spend (default: 100000)
 *   SMOKE_BASE / BASE_URL  DrawBound API base (default http://127.0.0.1:3107)
 *
 * DrawBound NEVER holds these keys. This script is operator-side tooling only:
 * it derives addresses, signs challenges, registers vaults, and reads public state.
 * Funding the vault and building credit-transition transactions stay with the operator
 * (see `fund-help` and docs/tachi-integration.md).
 */
import { existsSync } from "node:fs";

if (typeof process.loadEnvFile === "function" && existsSync(".env")) {
  process.loadEnvFile();
}

import { Address, Signer } from "bip322-js";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  createVault,
  registerVault,
  verifyVaultP2tr,
  userInternalKeyFromWallet,
  type TaprootSigner,
  buildTachiTxDeposit,
  signTachiTx,
  broadcastTachiTx,
  vtxoIdFromDeposit,
  getAddressVtxos,
  getFeeEstimate,
  getAccountNonce,
  waitForVtxoCommit,
  listVaults,
  getLockedVtxos,
} from "@tachibtc/taurus-vault-core";
import {
  WalletAggregator,
  BitcoinCoreRpcClient,
  Keystore,
  getNetwork,
} from "@tachibtc/taurus-wallet-aggregator";
// Shared with src/tests/bip32.test.ts. Imported as `.mts` on purpose: this file
// is ESM, and project `.ts` files are CommonJS (no "type" in package.json), so
// importing one would only expose a default export.
import { DEFAULT_DERIVATION_PATH, privateKeyAtPath } from "../src/lib/wallet/bip32.mts";

const NETWORK = (process.env.TACHI_NETWORK === "regtest" ? "regtest" : "signet") as "signet" | "regtest";
// bip322-js has no "signet" bucket: signet and testnet share the tb1 prefix, so
// signet maps onto "testnet". Regtest is genuinely different (bcrt1), and getting
// this wrong yields a valid-looking address that no wallet will accept.
const ADDRESS_NETWORK: "testnet" | "regtest" = NETWORK === "regtest" ? "regtest" : "testnet";
const API_BASE = process.env.SMOKE_BASE ?? process.env.BASE_URL ?? "http://127.0.0.1:3107";
const DAEMON_BASE = (process.env.TACHI_BASE_URL || `https://rpc-${NETWORK}.tachibtc.com`).replace(/\/$/, "");
const DUMMY_RPC_URL = process.env.OPERATOR_RPC_URL ?? "http://127.0.0.1:38332";

// Inlined utilities (kept identical to src/lib/auth/ownership.ts and
// src/lib/wallet/key-encoding.ts): .mts scripts cannot import project .ts
// modules under this toolchain, so the operator script is self-contained.

function deriveOwnershipAddress(
  compressedPubkey: Uint8Array,
  network: "mainnet" | "testnet" | "regtest" = "testnet",
): string {
  const addresses = Address.convertPubKeyIntoAddress(Buffer.from(compressedPubkey), "p2tr");
  return addresses[network];
}

function isP2trAddress(value: string): boolean {
  try {
    return Address.isP2TR(value);
  } catch {
    return false;
  }
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58check(payload: Uint8Array): string {
  const toHex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array([...payload, ...checksum]);
  let value = BigInt(`0x${toHex(full)}`);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of full) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

function privateKeyToWif(privateKeyHex: string, network: "mainnet" | "testnet" = "testnet"): string {
  const clean = privateKeyHex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("Private key must be 32 bytes of hex");
  // Regtest shares the testnet WIF prefix (0xef), so "testnet" covers signet too.
  const version = network === "mainnet" ? 0x80 : 0xef;
  const payload = new Uint8Array([version, ...new Uint8Array(Buffer.from(clean, "hex")), 0x01]);
  return base58check(payload);
}

// ── BIP-39 / BIP-32 key export ────────────────────────────────────────────────
// `ownership` requires OPERATOR_PRIVATE_KEY, but `derive` only accepts a mnemonic
// and the wallet aggregator deliberately never hands back private keys (its
// DerivedKey carries address/scriptPubKey/publicKey only). So without this there
// is no built-in way to get from a mnemonic to the key `ownership` demands, and
// the live-write procedure dead-ends at step 4. The derivation itself lives in
// src/lib/wallet/bip32.mts so it can be covered by the test suite.

async function exportKey(): Promise<void> {
  const mnemonic = (process.env.OPERATOR_MNEMONIC ?? "").trim();
  if (!mnemonic) {
    console.error("Set OPERATOR_MNEMONIC (12+ words) to export its vault user key.");
    process.exitCode = 1;
    return;
  }
  const path = (process.env.OPERATOR_DERIVATION_PATH ?? "").trim() || DEFAULT_DERIVATION_PATH;
  const privateKey = privateKeyAtPath(mnemonic, path);
  const privateKeyHex = Buffer.from(privateKey).toString("hex");
  const compressed = secp256k1.getPublicKey(privateKey, true);

  console.log(JSON.stringify({
    network: NETWORK,
    derivationPath: path,
    privateKeyHex,
    privateKeyWif: privateKeyToWif(privateKeyHex),
    compressedPubkey: Buffer.from(compressed).toString("hex"),
    ownershipAddress: deriveOwnershipAddress(new Uint8Array(compressed), ADDRESS_NETWORK),
    next: `OPERATOR_PRIVATE_KEY=${privateKeyHex} pnpm exec tsx scripts/operator-live.mts ownership <vaultRef>`,
    crossCheck: "Run `derive` with the same mnemonic and confirm ownershipAddress matches this one.",
    warning: "This output contains a private key. Never commit it, paste it into a chat, or use it with real funds.",
  }, null, 2));
}

function arg(index: number): string | undefined {
  const value = process.argv[2 + index];
  return value && !value.startsWith("--") ? value : undefined;
}

async function deriveVault(): Promise<void> {
  const mnemonic = process.env.OPERATOR_MNEMONIC?.trim();
  const pubkeyHex = process.env.OPERATOR_PUBKEY?.trim().toLowerCase();
  const userPubkey =
    mnemonic && mnemonic.split(/\s+/).length >= 12
      ? undefined
      : pubkeyHex && /^[0-9a-f]{66}$/.test(pubkeyHex)
        ? pubkeyHex
        : undefined;

  if (!mnemonic && !userPubkey) {
    console.error("Set OPERATOR_MNEMONIC (12+ words) or OPERATOR_PUBKEY (66-char compressed hex).");
    process.exitCode = 1;
    return;
  }

  // A wallet-shaped aggregator is only needed for derivation metadata; the RPC
  // client is never called on the derive path.
  const rpc = new BitcoinCoreRpcClient({ url: DUMMY_RPC_URL });
  let userKeyForOwnership: { compressed?: Uint8Array; xOnly: Uint8Array };
  let walletContext: Record<string, unknown> = {};

  let vault;
  if (mnemonic && !userPubkey) {
    const aggregator = WalletAggregator.fromMnemonic(mnemonic, { network: NETWORK, rpc });
    const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });
    const internal = userInternalKeyFromWallet(userWallet);
    vault = await createVault({
      network: NETWORK,
      userWallet,
      validators: {
        endpoint: `${DAEMON_BASE}/tachi_validators`,
        expectedChainId: NETWORK,
      },
    });
    userKeyForOwnership = {
      compressed: internal.compressedHex ? new Uint8Array(Buffer.from(internal.compressedHex, "hex")) : undefined,
      xOnly: new Uint8Array(Buffer.from(String(internal.xOnly), "hex")),
    };
    walletContext = { derivationPath: internal.derivationPath ?? null, userReceiveAddress: internal.address ?? null };
  } else {
    const pub = new Uint8Array(Buffer.from(userPubkey!, "hex"));
    vault = await createVault({
      network: NETWORK,
      userPubkey: Buffer.from(pub),
      validators: {
        endpoint: `${DAEMON_BASE}/tachi_validators`,
        expectedChainId: NETWORK,
      },
    });
    userKeyForOwnership = { compressed: pub, xOnly: pub.slice(1) };
  }

  const ownershipAddress = userKeyForOwnership.compressed
    ? deriveOwnershipAddress(userKeyForOwnership.compressed, ADDRESS_NETWORK)
    : null;

  console.log(JSON.stringify({
    network: NETWORK,
    vaultP2tr: vault.p2tr.address,
    validatorCount: vault.nodeKeys.length,
    threshold: vault.p2tr.cooperativeLeaf.threshold,
    exitCsvBlocks: vault.p2tr.exitLeaf.csvBlocks,
    ownershipAddress,
    ownershipNote: ownershipAddress
      ? "Sign the BIP-322 challenge with THIS key (the vault user key); present this address with the signature on connect."
      : "Ownership address requires the compressed pubkey (set OPERATOR_PUBKEY or use mnemonic mode).",
    ...walletContext,
  }, null, 2));
}

async function signOwnership(vaultRef: string): Promise<void> {
  if (!isP2trAddress(vaultRef)) {
    console.error(`vaultRef "${vaultRef}" is not a bech32 P2TR address; ownership proofs apply to real vault addresses.`);
    process.exitCode = 1;
    return;
  }
  const privHex = process.env.OPERATOR_PRIVATE_KEY?.trim().toLowerCase().replace(/^0x/, "");
  if (!privHex || !/^[0-9a-f]{64}$/.test(privHex)) {
    console.error("Set OPERATOR_PRIVATE_KEY (32-byte hex of the vault user key).");
    process.exitCode = 1;
    return;
  }
  const wif = privateKeyToWif(privHex, "testnet");
  const pub = secp256k1.getPublicKey(new Uint8Array(Buffer.from(privHex, "hex")), true);
  const ownershipAddress = deriveOwnershipAddress(new Uint8Array(pub), ADDRESS_NETWORK);

  const challengeRes = await fetch(`${API_BASE}/api/wallet/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vaultRef }),
  });
  const challenge = (await challengeRes.json()) as { challenge?: string; nonce?: string; detail?: string; error?: string };
  if (!challengeRes.ok || !challenge.challenge || !challenge.nonce) {
    console.error(`Challenge request failed (${challengeRes.status}):`, challenge.detail ?? challenge.error);
    process.exitCode = 1;
    return;
  }

  const signature = Signer.sign(wif, ownershipAddress, challenge.challenge);
  console.log(JSON.stringify({
    vaultRef,
    ownershipAddress,
    challenge: challenge.challenge,
    nonce: challenge.nonce,
    signature,
    connectBody: {
      vaultRef,
      sessionPublicKey: "<64-hex x-only session key from your browser session>",
      ownershipNonce: challenge.nonce,
      ownershipAddress,
      ownershipSignature: signature,
    },
    hint: "Paste ownershipNonce/ownershipAddress/ownershipSignature into the Vault Terminal connect panel (or include them in POST /api/wallet/connect).",
  }, null, 2));
}

async function vaultStatus(vaultRef: string): Promise<void> {
  const locked = await getLockedVtxos(vaultRef, { baseUrl: DAEMON_BASE });
  const lockedSats = locked.vtxos.reduce((total, vtxo) => total + BigInt(vtxo.amountSats ?? 0n), 0n);

  let vaultRecord: { vaultId?: string; state?: string; fundingTxid?: string; fundingVout?: number; name?: string } | undefined;
  try {
    const mnemonic = process.env.OPERATOR_MNEMONIC?.trim();
    if (mnemonic) {
      const keystore = Keystore.fromMnemonic(mnemonic, "", getNetwork(NETWORK), "p2wpkh", 0);
      const userPubkey = Buffer.from(keystore.signerFor(false, 0).publicKey).toString("hex");
      const list = await listVaults(userPubkey, { baseUrl: DAEMON_BASE });
      vaultRecord = list.vaults.find((v) => v.address.toLowerCase() === vaultRef.toLowerCase() || v.vaultId.toLowerCase() === vaultRef.toLowerCase());
    }
  } catch {
    // Optional list lookup
  }

  console.log(JSON.stringify({
    vaultRef,
    network: NETWORK,
    registered: !!vaultRecord,
    vaultState: vaultRecord?.state ?? "unknown",
    vaultIdHex: vaultRecord?.vaultId ?? undefined,
    vaultName: vaultRecord?.name ?? undefined,
    fundingTxid: vaultRecord?.fundingTxid ?? undefined,
    fundingVout: vaultRecord?.fundingVout ?? undefined,
    vtxoCount: locked.vtxos.length,
    lockedSats: lockedSats.toString(),
    funded: lockedSats > 0n || !!vaultRecord,
    vtxos: locked.vtxos.map((v) => ({ id: v.id, amountSats: v.amountSats.toString(), spent: v.spent ?? false })),
  }, null, 2));
}

async function registerVaultAction(fundingTxidArg?: string, fundingVoutArg?: string): Promise<void> {
  const fundingTxid = (fundingTxidArg ?? process.env.FUNDING_TXID ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(fundingTxid)) {
    console.error("usage: operator-live.mts register <fundingTxid> [vout]");
    console.error("fundingTxid must be a 64-character hex transaction ID of the confirmed L1 deposit.");
    process.exitCode = 1;
    return;
  }
  const fundingVout = Number.parseInt(fundingVoutArg ?? process.env.FUNDING_VOUT ?? "0", 10);
  if (Number.isNaN(fundingVout) || fundingVout < 0) {
    console.error("fundingVout must be a non-negative integer (default 0).");
    process.exitCode = 1;
    return;
  }

  const mnemonic = process.env.OPERATOR_MNEMONIC?.trim();
  const privHex = process.env.OPERATOR_PRIVATE_KEY?.trim().toLowerCase().replace(/^0x/, "");

  if (!mnemonic && (!privHex || !/^[0-9a-f]{64}$/.test(privHex))) {
    console.error("Set OPERATOR_MNEMONIC (12+ words) or OPERATOR_PRIVATE_KEY (32-byte hex) to sign the TxVaultOpen.");
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

  verifyVaultP2tr(vault.p2tr);

  const userXOnly = vault.userKey.xOnly;
  let feeSats = 10n;
  try {
    const feeEst = await getFeeEstimate({ baseUrl: DAEMON_BASE });
    if (feeEst.recommendedFeeSats) {
      feeSats = BigInt(Math.max(10, feeEst.recommendedFeeSats));
    }
  } catch {
    // Default 10n
  }

  const vtxoAmountSats = BigInt(process.env.OPERATOR_VTXO_AMOUNT || "100000");
  let inputVtxoId: Buffer;
  let inputValueSats = vtxoAmountSats;

  if (process.env.OPERATOR_VTXO_ID) {
    inputVtxoId = Buffer.from(process.env.OPERATOR_VTXO_ID.trim().replace(/^0x/, ""), "hex");
    if (process.env.OPERATOR_VTXO_AMOUNT) {
      inputValueSats = BigInt(process.env.OPERATOR_VTXO_AMOUNT);
    }
  } else {
    let existingVtxo: { id: string; amountSats: bigint } | undefined;
    try {
      const addressQuery = Buffer.from(userXOnly).toString("hex");
      const vtxoList = await getAddressVtxos(addressQuery, { baseUrl: DAEMON_BASE });
      existingVtxo = vtxoList.vtxos.find((v) => !v.spent && !v.locked && v.amountSats > feeSats);
    } catch (err) {
      console.warn(`Note: getAddressVtxos query notice: ${err instanceof Error ? err.message : err}`);
    }

    if (existingVtxo) {
      inputVtxoId = Buffer.from(existingVtxo.id, "hex");
      inputValueSats = existingVtxo.amountSats;
      console.log(`Using existing unspent VTXO ${existingVtxo.id} (${inputValueSats} sats) on ledger...`);
    } else {
      console.log(`No free VTXO found on ledger; onboarding initial deposit of ${vtxoAmountSats} sats (fee: ${feeSats} sats)...`);
      let depositNonce = 0n;
      try {
        depositNonce = await getAccountNonce(Buffer.from(userXOnly), { baseUrl: DAEMON_BASE });
      } catch {
        // Fallback to 0n
      }

      const depositTx = buildTachiTxDeposit({
        userXOnly: Buffer.from(userXOnly),
        amountSats: vtxoAmountSats,
        nonce: depositNonce,
        feeSats,
      });
      const signedDeposit = await signTachiTx(depositTx, userSigner);
      await broadcastTachiTx(signedDeposit, { url: `${DAEMON_BASE}/tachi_txBroadcastSync` });
      inputVtxoId = vtxoIdFromDeposit(signedDeposit);
      inputValueSats = vtxoAmountSats;
      console.log(`Onboarded initial deposit VTXO: ${inputVtxoId.toString("hex")}`);
      console.log("Waiting for deposit VTXO to commit on Tachi ledger...");
      try {
        await waitForVtxoCommit(inputVtxoId, { baseUrl: DAEMON_BASE, overallTimeoutMs: 30000 });
        console.log("Deposit VTXO confirmed committed on-ledger.");
      } catch (err) {
        console.warn(`Warning: waitForVtxoCommit: ${err instanceof Error ? err.message : err}. Proceeding with registration...`);
      }
    }
  }

  const outpoint = {
    fundingTxid: Buffer.from(fundingTxid, "hex").reverse(),
    fundingVout,
  };

  if (inputValueSats <= feeSats) {
    throw new Error(`Input VTXO value (${inputValueSats} sats) must be greater than fee (${feeSats} sats).`);
  }

  const inputs = [{ vtxoId: inputVtxoId, valueSats: inputValueSats }];
  const outputs = [{ owner: Buffer.from(userXOnly), amount: inputValueSats - feeSats }];
  const vaultName = (process.env.VAULT_NAME || "drawbound-collateral").trim();

  console.log(`Registering vault ${vault.p2tr.address} on Tachi ledger (outpoint ${fundingTxid}:${fundingVout}, fee: ${feeSats} sats)...`);
  const reg = await registerVault({
    vault,
    outpoint,
    userSigner,
    inputs,
    outputs,
    feeSats,
    account: { baseUrl: DAEMON_BASE },
    broadcast: { url: `${DAEMON_BASE}/tachi_txBroadcastSync` },
    confirm: { baseUrl: DAEMON_BASE },
    name: vaultName,
  });

  console.log(JSON.stringify({
    status: "REGISTERED",
    network: NETWORK,
    vaultRef: vault.p2tr.address,
    vaultIdHex: reg.vaultIdHex,
    fundingOutpoint: `${fundingTxid}:${fundingVout}`,
    nonce: reg.nonce.toString(),
    broadcast: reg.broadcast,
    commit: reg.commit,
    next: "Vault is registered on-ledger with spendable VTXOs. You can now connect in DrawBound and submit credit transitions.",
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function fundHelp(): void {
  console.log(`Live write procedure (operator-only, disposable signet/regtest vault):

THE TWO-DEPOSIT SUBTLETY (CRITICAL):
  1. On-chain funding (depositToVault / faucet): sends BTC to the vault P2TR on Bitcoin L1.
  2. Ledger registration (register): registers the confirmed L1 UTXO on the Tachi ledger
     via TxVaultOpen, assigning spendable vtxoId state.
  CRITICAL: A credit transition referencing an unregistered vault fails with 'vtxo not found'.

PHASE A — DERIVE VAULT:
  OPERATOR_MNEMONIC=... pnpm exec tsx scripts/operator-live.mts derive
  -> Set vaultP2tr in TACHI_VAULT_REF + ALLOWED_VAULT_REFS in .env

PHASE B — FUND (ON-CHAIN):
  Fund your P2WPKH wallet via signet/regtest faucet, then send sats to the vault P2TR:
  @tachibtc/taurus-vault-core depositToVault({ vault, userWallet, rpc, amountSats: 100000n, feeRateSatVb: 2 })
  -> Note the deposit txid (64-character hex fundingTxid).

PHASE C — REGISTER VAULT ON LEDGER (TxVaultOpen):
  OPERATOR_MNEMONIC=... pnpm exec tsx scripts/operator-live.mts register <fundingTxid> [vout]
  -> Submits TxVaultOpen to /tachi_txBroadcastSync and awaits commit.
  -> Mints spendable VTXO ledger state. Verify with:
     pnpm exec tsx scripts/operator-live.mts status <vaultP2tr>

CONNECT IN TERMINAL (BIP-322 Ownership Proof):
  Export private key:
    OPERATOR_MNEMONIC=... pnpm exec tsx scripts/operator-live.mts export-key
  Generate connect body:
    OPERATOR_PRIVATE_KEY=... pnpm exec tsx scripts/operator-live.mts ownership <vaultRef>
  Paste ownershipNonce/ownershipAddress/ownershipSignature into the DrawBound terminal.

PHASE D — CREDIT TRANSITION:
  Build and sign the SatVM credit-transition transaction offline with @tachibtc/taurus-vault-core:
  buildVtxoPsbt -> verifyVtxoPsbt -> signVtxoPsbtAsUser -> finalizeVtxoPsbt -> buildTachiTxTransfer -> signTachiTx
  Paste the serialized txHex into the DrawBound terminal's Advanced box, and execute Draw.
  DrawBound broadcasts via /tachi_txBroadcastSync and records the returned hash.

DrawBound never holds keys and never funds vaults. See docs/tachi-integration.md.`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const vaultRef = arg(1);
  const vout = arg(2);
  switch (command) {
    case "derive":
      await deriveVault();
      break;
    case "ownership":
      if (!vaultRef) { console.error("usage: operator-live.mts ownership <vaultRef>"); process.exitCode = 1; return; }
      await signOwnership(vaultRef);
      break;
    case "register":
      await registerVaultAction(vaultRef, vout);
      break;
    case "status":
      if (!vaultRef) { console.error("usage: operator-live.mts status <vaultRef>"); process.exitCode = 1; return; }
      await vaultStatus(vaultRef);
      break;
    case "fund-help":
      fundHelp();
      break;
    case "export-key":
      await exportKey();
      break;
    default:
      console.log("usage: operator-live.mts <derive|export-key|ownership <vaultRef>|register <txid> [vout]|status <vaultRef>|fund-help>");
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
