# Tachi Integration Record

Status: official TypeScript SDK `0.2.1` installed and read-only spike wired; Taurus packages identified at `taurus-vault-core@0.3.4` and `taurus-wallet-aggregator@0.4.5`; reads are live against public signet; writes broadcast operator-supplied signed transactions only, and no live write has been executed yet (checked 2026-09-13).

The supplied Tachi docs identify `@tachibtc/tachi-sdk-ts` and the public daemon URLs `https://rpc-regtest.tachibtc.com` and `https://rpc-signet.tachibtc.com`. The TypeScript client exposes `getHealth`, `getLiveValidators`, `getLockedVtxos`, `listVaults`, `bitcoinRPC`, and `broadcastTxSync`. The supplied docs also identify `@tachibtc/taurus-vault-core` and `@tachibtc/taurus-wallet-aggregator` for P2TR vault creation, deposit, VTXO PSBT construction, and signing.

The `tachibtc` GitHub organization currently exposes the public source repositories [`tachibtc/tachi-sdk-ts`](https://github.com/tachibtc/tachi-sdk-ts) and [`tachibtc/tachi-sdk-go`](https://github.com/tachibtc/tachi-sdk-go), while its Packages tab shows no npm packages. A lookup for `@tachibtc/tachi-sdk-ts` at `https://npm.pkg.github.com` returned 404 on 2026-09-02, but the package is published publicly on npm at `0.2.1`. The public TypeScript repository has these tags: `v0.1.0` (`8ca99e621eb6e5b240099ecd4e6ddd896796ad13`) and `v0.2.1` (`b18b5ebfc8a2716b9961885c5d56ed5dea40634f`). Its `v0.2.1` package metadata reports version `0.2.1`, entrypoint `dist/index.js`, and a TypeScript build script. The Taurus packages are also published publicly on npm at `@tachibtc/taurus-vault-core@0.3.4` and `@tachibtc/taurus-wallet-aggregator@0.4.5`. Do not enable live writes based on package availability alone; verify the exact vault and transaction APIs first.

To verify whether the public TypeScript repository has a publishable release, run this read-only check outside the sandbox and record the output before installing anything:

```bash
git ls-remote --tags https://github.com/tachibtc/tachi-sdk-ts.git
```

Only install a tagged release or an explicitly reviewed commit. Before using the Git tag, confirm that the tag contains the built `dist/` entrypoint or that the package defines a supported prepare/build lifecycle. Do not depend on the moving default branch in a production or live-funds path.

## Adapter boundary

- `FixtureTachiAdapter` emits TAURUS-shaped vault references and SatVM-shaped transition references for rehearsal (default mode).
- `LiveTachiAdapter` is the real integration: `getVaultState` reads locked VTXOs for a real vault via `TachiHttpClient.getLockedVtxos`; `submitCreditTransition` broadcasts a signed `txHex` via `TachiHttpClient.broadcastTxSync` and records the real transaction hash. It is selected by `getTachiAdapter()` when `LIVE_TACHI_ENABLED=true` or `PROOF_MODE=live`.
- `fixtureTransport` preserves the `readState` / `submitTransition` contract expected by SDK, JSON-RPC, or CLI transports. `rpc-transport` / `cli-transport` / `sdk-transport` write paths remain intentional fail-closed stubs pending official method verification — they must never fake a broadcast.
- `TachiHttpClient` remains available as a dependency-free HTTP boundary for diagnostics and fallback.
- `createTachiSdkClient` constructs the official `@tachibtc/tachi-sdk-ts@0.2.1` client from `TACHI_BASE_URL` or the selected documented network.
- `scripts/spike-tachi.ts` uses the official SDK for read-only health, live-validator, and Bitcoin RPC checks; `scripts/spike-taurus.ts` checks the Taurus vault derivation and Signet validator quorum.

## Transaction authenticity policy

Drawbound distinguishes three transaction classes:

1. **Synthetic demo payload** — `buildDemoTransition()` produces a rehearsal artifact tagged with the magic prefix `dbdemo01`. It is NOT a Bitcoin transaction. The fixture adapter ignores txHex entirely; `LiveTachiAdapter` rejects this payload with an explicit error, as it rejects any hex that is not a plausibly-sized (< 120 hex chars), even-length, valid-hex serialization.
2. **Operator-signed transaction** — the only thing live mode broadcasts: a real transaction built and signed offline with `@tachibtc/taurus-wallet-aggregator` against the operator's funded vault, pasted into the terminal's Advanced box (or supplied via API `txHex`).
3. **Session signature** — independent of the above, every action authenticates with a BIP-340 Schnorr signature by the browser session key over the canonical message:

   ```
   DrawBound:v1:<positionId>:<vaultRef>:<action>:<amount>:<nonce>
   ```

   verified server-side against the public key registered at `/api/wallet/connect`. This authenticates the session; it does not authorize chain-level value movement (see threat model).

## Live write path (operator responsibilities)

`LiveTachiAdapter` performs no key handling and creates no vault. The operator workflow is scripted in `scripts/operator-live.mts` (`derive` / `export-key` / `ownership` / `register` / `status` / `fund-help`).

### The two-deposit subtlety (critical)

Tachi strictly distinguishes:
1. **On-chain funding (L1)**: `depositToVault` spends Bitcoin from a P2WPKH wallet into the vault's P2TR address on Bitcoin (L1), creating a confirmed funding outpoint (`txid:vout`).
2. **Ledger registration (Tachi)**: a `TxVaultOpen` (via `registerVault`) or `TxDeposit` registers that confirmed UTXO on the Tachi ledger, allocating a spendable `vtxoId`.

> [!WARNING]
> A credit transfer or transition referencing an unregistered vault fails immediately with **`vtxo not found`**. The on-chain deposit puts satoshis into the script, but Tachi consensus nodes will not recognise spendable VTXOs until the vault is registered on-ledger.

### Step-by-step API Runbook (regtest first, then signet)

#### Phase A — Wallet + Vault derivation
Derive the vault P2TR address from the operator key using the live KDHT validator quorum:

```typescript
import { BitcoinCoreRpcClient, WalletAggregator, Keystore, getNetwork } from "@tachibtc/taurus-wallet-aggregator";
import { createVault, verifyVaultP2tr } from "@tachibtc/taurus-vault-core";

const rpc = new BitcoinCoreRpcClient({ url: "https://rpc-regtest.tachibtc.com/" });
const aggregator = WalletAggregator.fromMnemonic(MNEMONIC, { network: "regtest", rpc });
const userWallet = aggregator.addAccount({ addressType: "p2wpkh" });

const vault = await createVault({
  network: "regtest",
  userWallet,
  validators: { endpoint: "https://rpc-regtest.tachibtc.com/tachi_validators" },
  // csvBlocks: 1008,
});
verifyVaultP2tr(vault.p2tr); // throws on derivation mismatch
```
*`scripts/operator-live.mts derive` automates this step.* List the resulting `vaultP2tr` in `TACHI_VAULT_REF` and `ALLOWED_VAULT_REFS`.

#### Phase B — Fund (on-chain deposit)
```typescript
import { depositToVault } from "@tachibtc/taurus-vault-core";

await userWallet.sync();
const deposit = await depositToVault({
  vault,
  userWallet,
  rpc,
  amountSats: 100_000n,
  feeRateSatVb: 2,
});
// deposit.txid — on-chain funding outpoint
```

> [!IMPORTANT]
> **Funding source prerequisite**: `depositToVault` spends from the operator's SegWit P2WPKH wallet, so that address needs coins first:
> - **Regtest**: use the regtest faucet (`regtest.tachibtcscan.com` / Discord) or mine blocks directly to your address (`bitcoin-cli -regtest -generate`).
> - **Signet**: use a public signet faucet + the Tachi daemon RPC.

#### Phase C — Ledger registration (TxVaultOpen)
Register the confirmed L1 UTXO on the Tachi ledger so Tachi indexes the vault and mints spendable VTXO state:

```typescript
import { registerVault, type TaprootSigner } from "@tachibtc/taurus-vault-core";

// Keystore produces the required TaprootSigner with Schnorr capabilities:
const keystore = Keystore.fromMnemonic(MNEMONIC, "", getNetwork("regtest"), "p2wpkh", 0);
const node = keystore.signerFor(false, 0);
const userSigner: TaprootSigner = {
  publicKey: Buffer.from(node.publicKey),
  sign: (h) => Buffer.from(node.sign(h)),
  signSchnorr: (h) => Buffer.from(node.signSchnorr!(h)),
};

const reg = await registerVault({
  vault,
  // Outpoint requires internal byte order:
  outpoint: {
    fundingTxid: Buffer.from(deposit.txid, "hex").reverse(),
    fundingVout: 0,
  },
  userSigner,
  inputs, // ledger VTXOs paying the (typically 0) open fee
  outputs, // change VTXOs
  feeSats: 0n,
  broadcast: { url: `${DAEMON_URL}/tachi_txBroadcastSync` },
  confirm: { baseUrl: DAEMON_URL },
  name: "drawbound-collateral",
});
// reg.vaultIdHex — now discoverable on-chain and via discoverVaults({ ... })
```
*`scripts/operator-live.mts register` automates this step.*

#### Phase D — Credit transition
Now that the vault holds registered VTXOs, build and sign the VTXO PSBT transfer offline:

```typescript
import {
  buildVtxoPsbt,
  verifyVtxoPsbt,
  signVtxoPsbtAsUser,
  finalizeVtxoPsbt,
  buildTachiTxTransfer,
  signTachiTx,
  encodeTachiTx,
} from "@tachibtc/taurus-vault-core";

const built = buildVtxoPsbt({
  vault,
  inputs: [{ txid: deposit.txid, vout: 0, valueSats: 100_000n, scriptPubKey: vault.p2tr.output.toString("hex") }],
  outputs: [
    { address: receiverAddr, valueSats: 40_000n },
    { address: vault.p2tr.address, valueSats: 59_000n }, // change
  ],
  feeSats: 1_000n,
});

const verifyOptions = { maxFeeSats: 10_000n };
verifyVtxoPsbt(built.psbt, vault, verifyOptions);
await signVtxoPsbtAsUser(built.psbt, userSigner, vault, verifyOptions);
// Optional, cooperative path only: finalizeVtxoPsbt assembles the BIP-341 script-path
// witness from the user signature PLUS the M-of-N quorum cosignatures, which an offline
// builder does not hold. `scripts/build-transition.mts` attempts it under FINALIZE_PSBT=1
// and reports the outcome; the ledger spend itself is authorized by the TachiTx signature.
finalizeVtxoPsbt(built.psbt, vault, verifyOptions);

// The nonce is replay protection: read it from the daemon, never guess. Signing with a
// stale nonce is rejected, and guessing "0" re-signs the first transition of the account.
const nonce = await getAccountNonce(Buffer.from(vault.userKey.xOnly), { baseUrl: DAEMON_URL });

const draft = buildTachiTxTransfer({
  vault,
  inputs: built.inputs,
  outputs: built.outputs,
  feeSats: 1_000n,
  nonce,
  psbt: built.psbt,
});
// `chainId` is deliberately omitted: binding a signature to a chain id is the correct
// long-term answer to cross-network replay, but a stock daemon only accepts the plain
// sighash today and would reject a bound one (see the vendor's tachiTxSigHash notes).
const signed = await signTachiTx(draft, userSigner);
const txHex = Buffer.from(encodeTachiTx(signed)).toString("hex");
```

Build it without touching the network with `corepack pnpm live:build -- <fundingTxid> <amountSats>`
(`scripts/build-transition.mts`): it verifies the daemon's chain id, checks the derived vault against
`TACHI_VAULT_REF`, takes the fee from `/tachi_feeEstimate`, refuses to invent an input VTXO, refuses to
sign with a nonce it could not read, and only prints `txHex` after `POST /tachi_txDecode` echoes back the
nonce, fee, inputs and outputs it actually sees.

Paste `txHex` into DrawBound's **Advanced** box in the Terminal UI (or supply it in `POST /api/{draw,repay,unlock}`). `LiveTachiAdapter.submitCreditTransition` then, in order:

1. refuses if `KILL_SWITCH=true` or the vault ref is not in `ALLOWED_VAULT_REFS`;
2. attests the daemon's chain id (`/tachi_nodeInfo`, cached for `LIVE_ATTESTATION_TTL_MS`) — a daemon that names no chain is refused unless it is on loopback;
3. requires a real locked-VTXO read for the vault (`LIVE_REQUIRE_CHAIN_READ`): a failed or truncated read denies instead of substituting modeled collateral;
4. sends the hex to `/tachi_txDecode` and checks the decoded fee against `LIVE_MAX_FEE_SATS` and the decoded outputs against the obligation this transition commits (`amount × CREDIT_UNIT_SATS`), bounded by `MAX_TEST_SATS`;
5. broadcasts to `POST /tachi_txBroadcastSync` — a non-zero `result.code` is a mempool rejection and is surfaced verbatim;
6. polls `/tachi_tx?hash=<txid>` until `state == "committed"`, up to `LIVE_CONFIRM_TIMEOUT_MS`.

The ledger is only written after step 6 succeeds. If confirmation times out the position is left untouched and the tx hash is journaled as `pendingTxHash` on the denial receipt, so the operator can reconcile with `scripts/operator-live.mts status <vaultRef>` rather than re-broadcast blind. `/tachi_txValidate` is not used anywhere in this path: current daemons report `valid: false` for transactions they have already committed, so its answer is not evidence.

Drawbound has not created a vault, funded collateral, or broadcast any transaction autonomously. Those steps remain strictly operator-controlled. Preflight both the gates and the daemon with `corepack pnpm live:check` (read-only; exits non-zero while anything blocking fails), and see `docs/deployment.md` for the runbook.

Run the read-only inventory with:

```bash
corepack pnpm spike:tachi
```

Set `TACHI_NETWORK=regtest` or `TACHI_BASE_URL` to target another documented daemon. Do not place API keys in source control or browser code.

## Recording requirement

Before any live write, record here: the exact official source URL, package/version, method or RPC name, network, vault reference, proof artifact shape, verifier key, and transaction reference. Mainnet is disabled by default.

| Field | Value |
|---|---|
| Live write executed | **none yet** (operator-gated; fail-closed safety policy enforced). The broadcast path and every gate around it are implemented and covered by mocked-daemon tests (`src/tests/live-adapter.test.ts`, `src/tests/live-mode-flow.test.ts`); the remaining step is an operator with a funded vault, which has not run. |
| Chain binding | expected chain id `tachi-signet-1` (signet) / `tachi-regtest-1` (regtest), asserted from `/tachi_nodeInfo` before any read or write; vault refs decoded with a BIP-173/350 implementation instead of a prefix sniff |
| Daemon | `https://rpc-signet.tachibtc.com` (reads verified 2026-09-18: health ok, block 322642, 7/7 validators, quorum 5/7) |
| Broadcast method | `POST /tachi_txBroadcastSync` via `TachiHttpClient.broadcastTxSync` |
| Vault read method | `GET /tachi_vtxoLocked?vault=<p2tr>` via `getLockedVtxos` |
