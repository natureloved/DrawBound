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
 *   status <vaultRef>      — read-only locked-VTXO status from the Tachi daemon.
 *   fund-help              — print the (operator-only) funding + live-write procedure.
 *
 * Environment:
 *   OPERATOR_PRIVATE_KEY   hex (32 bytes) of the vault user key [ownership]
 *   OPERATOR_MNEMONIC      BIP-39 mnemonic [derive, export-key]
 *   OPERATOR_PUBKEY        33-byte compressed hex [derive, alternative to mnemonic]
 *   OPERATOR_DERIVATION_PATH  override the export-key path (default m/84'/1'/0'/0/0)
 *   TACHI_NETWORK          signet (default) | regtest
 *   TACHI_BASE_URL         daemon base URL (default: public signet endpoint)
 *   SMOKE_BASE / BASE_URL  DrawBound API base (default http://127.0.0.1:3107)
 *
 * DrawBound NEVER holds these keys. This script is operator-side tooling only:
 * it derives addresses, signs challenges, and reads public state. Funding the
 * vault and building credit-transition transactions stay with the operator
 * (see `fund-help` and docs/tachi-integration.md).
 */
import { Address, Signer } from "bip322-js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { createVault, userInternalKeyFromWallet } from "@tachibtc/taurus-vault-core";
import { WalletAggregator, BitcoinCoreRpcClient } from "@tachibtc/taurus-wallet-aggregator";
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

interface LockedVtxosResponse { vault: string; count: number; vtxos: Array<{ id: string; amount: number; spent?: boolean }> }

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

async function getLockedVtxos(vaultRef: string): Promise<LockedVtxosResponse> {
  const response = await fetch(`${DAEMON_BASE}/tachi_vtxoLocked?vault=${encodeURIComponent(vaultRef)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Daemon read failed (${response.status}) for ${vaultRef}`);
  return (await response.json()) as LockedVtxosResponse;
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
  const locked = await getLockedVtxos(vaultRef);
  const lockedSats = locked.vtxos.reduce((total, vtxo) => total + (vtxo.amount || 0), 0);
  console.log(JSON.stringify({
    vaultRef,
    network: NETWORK,
    vtxoCount: locked.vtxos.length,
    lockedSats,
    funded: lockedSats > 0,
    vtxos: locked.vtxos.map((v) => ({ id: v.id, amount: v.amount, spent: v.spent ?? false })),
  }, null, 2));
}

function fundHelp(): void {
  console.log(`Live write procedure (operator-only, disposable signet vault):
1. Derive:  OPERATOR_MNEMONIC=... pnpm exec tsx scripts/operator-live.mts derive
   -> use vaultP2tr as TACHI_VAULT_REF + ALLOWED_VAULT_REFS in .env
2. Fund:    a signet faucet sends tBTC to the vault P2TR, OR use
   @tachibtc/taurus-vault-core depositToVault({vault, userWallet, rpcClient}) from
   a funded P2WPKH aggregator wallet (SegWit funding is required by the protocol).
3. Verify:  pnpm exec tsx scripts/operator-live.mts status <vaultP2tr>
4. Connect: the ownership command needs the vault user key as 32-byte hex, which
   derive does not print (the aggregator never exposes private keys). Export it first:
     OPERATOR_MNEMONIC=... pnpm exec tsx scripts/operator-live.mts export-key
   -> use privateKeyHex as OPERATOR_PRIVATE_KEY, then:
     OPERATOR_PRIVATE_KEY=... pnpm exec tsx scripts/operator-live.mts ownership <vaultRef>
   Confirm the ownershipAddress matches the one derive printed, then connect with
   the ownership proof in the terminal UI.
5. Transition: build the TachiTx credit transition with
   @tachibtc/taurus-vault-core (buildTachiTxTransfer / signTachiTx /
   encodeTachiTxBase64) using the vault's VTXOs, paste the encoded transaction
   into the terminal's Advanced box, and draw. DrawBound broadcasts it via
   /tachi_txBroadcastSync and records the returned hash.

DrawBound never holds keys and never funds vaults. See docs/tachi-integration.md.`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const vaultRef = arg(1);
  switch (command) {
    case "derive":
      await deriveVault();
      break;
    case "ownership":
      if (!vaultRef) { console.error("usage: operator-live.mts ownership <vaultRef>"); process.exitCode = 1; return; }
      await signOwnership(vaultRef);
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
      console.log("usage: operator-live.mts <derive|export-key|ownership <vaultRef>|status <vaultRef>|fund-help>");
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
