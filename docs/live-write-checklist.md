# Live-Write Checklist (operator run, signet)

This is the checklist for the first funded disposable-signet live write: the
run that fills in the "Live write executed" row of
[docs/tachi-integration.md](tachi-integration.md). It is an **operator run** —
it happens on the operator's own PC, where the funded vault lives in the
Tachi vault browser extension. Nothing in this checklist broadcasts anything
by itself, and no step here touches mainnet.

## Safety rules

- The disposable signet mnemonic (or private key) **stays on the operator's
  machine only**. It is never pasted into chat, never shared with anyone,
  never committed to the repo. It is signet-only and disposable: it must
  never hold real funds.
- `ALLOW_MAINNET` stays `false`. The whole run is on `TACHI_NETWORK=signet`.
- One live write, one credit transition, small amounts only: the exposure cap
  is `MAX_TEST_SATS=5000` and the default draw in the sequenced driver is
  `DRAW_AMOUNT_SATS=1000`. Fund with at least 3× the draw amount.
- If any preflight gate fails, stop. Do not work around a gate.

## What the operator needs before starting

- pnpm 11.19.0 (see the repo's `packageManager` field) or corepack.
- A funded vault in the Tachi vault browser extension on the operator's PC:
  the vault's P2TR address funded with signet BTC (the runbook default is
  50,000 sats; the doc example is 100,000) and registered on the Tachi
  ledger (`TxVaultOpen`), so the confirmed UTXO is a spendable VTXO. An
  unregistered vault fails every transition with `vtxo not found`.
- The disposable signet mnemonic for the vault's user key, available only on
  the operator's machine (environment variable, never written to a file in
  the repo).

## Run sequence (on the operator's PC)

All commands run from the repo root.

```bash
# 1. Sequenced driver: derive -> fund -> register -> check -> build.
#    It stops before the write; it never broadcasts the credit transition.
OPERATOR_MNEMONIC="<disposable signet-only words>" pnpm live:onboard

# Resume after funding if the run was interrupted:
# OPERATOR_MNEMONIC="<...>" FUNDING_TXID=<txid> pnpm live:onboard

# Plan only, no keys, no network writes:
# pnpm live:onboard --dry-run
```

Manual equivalents, if the driver is not used:

```bash
pnpm exec tsx scripts/operator-live.mts derive                  # vault P2TR + ownership address
pnpm exec tsx scripts/operator-live.mts export-key              # mnemonic -> OPERATOR_PRIVATE_KEY (hex + WIF)
pnpm exec tsx scripts/operator-live.mts register <txid> [vout]  # register confirmed L1 funding UTXO (TxVaultOpen)
pnpm exec tsx scripts/operator-live.mts status <vaultRef>       # locked-VTXO read
pnpm exec tsx scripts/operator-live.mts fund-help               # funding + live-write procedure
```

```bash
# 2. Read-only preflight: every gate + a daemon probe. Must exit 0.
corepack pnpm live:check

# 3. Build and verify the signed transition hex (never broadcasts it).
corepack pnpm live:build -- <fundingTxid> <amountSats>
# (scripts/build-transition.mts: verifies the daemon chain id, checks the
# derived vault against TACHI_VAULT_REF, takes the fee from
# /tachi_feeEstimate, refuses to invent an input VTXO or sign with a nonce
# it could not read, and only prints txHex after POST /tachi_txDecode
# echoes back the nonce, fee, inputs and outputs it actually sees.)
```

```bash
# 4. Arm live mode in the app environment, then start the app.
LIVE_TACHI_ENABLED=true
PROOF_MODE=live
KILL_SWITCH=false
TACHI_NETWORK=signet
TACHI_VAULT_REF=tb1p<your-funded-signet-taurus-vault>
ALLOWED_VAULT_REFS=tb1p<your-funded-signet-taurus-vault>
ALLOW_MAINNET=false
corepack pnpm dev
```

```text
# 5. The only gated write: paste the txHex from step 3 into the Vault
#    Terminal's Advanced box and execute the draw (or supply it via
#    POST /api/draw). The live adapter decodes, fee-checks, broadcasts via
#    POST /tachi_txBroadcastSync, then polls /tachi_tx?hash= until
#    state == "committed". The ledger is only written after that.
```

Optional hardening for the run (not required for the first write):

```bash
HAT_ORACLE_URL=http://127.0.0.1:3109 PROOF_RELAY_PUBLIC_KEYS=<oraclePubkey>
REQUIRE_OWNERSHIP_PROOF=true
```

## What to report back after the run

Report **only** these six items — nothing else, and never the mnemonic or
any private key:

1. Transaction hash (txid) of the broadcast credit transition.
2. Daemon confirmation: `state == "committed"` from `/tachi_tx?hash=<txid>`.
3. Vault ref (the P2TR address).
4. Network: `tachi-signet-1`.
5. Block height at the time of the run.
6. Date of the run.

Those six values are what fill in the "Live write executed" row of
[docs/tachi-integration.md](tachi-integration.md). Until they are reported,
that row stays **none yet** — the 2026-10-16 commit message claim of a real
broadcast credit transition remains unverified, because no transaction hash
exists anywhere in this repo.

If confirmation times out, do **not** re-broadcast blind: the position is
left untouched and the hash is journaled as `pendingTxHash` on the denial
receipt. Reconcile with `scripts/operator-live.mts status <vaultRef>`.

## Known caveat

The daemon's Bitcoin RPC proxy (`getblockchaininfo` over `POST /`) times
out from some machines — observed from a cloud VM on 2026-11-06, where
`spike:tachi` failed on that step while every Tachi-native endpoint
answered fine. If `spike:tachi` fails on that step from the operator
machine, re-check from the operator machine first: the live-write path
(`POST /tachi_txDecode`, `POST /tachi_txBroadcastSync`,
`GET /tachi_tx?hash=`, `GET /tachi_vtxoLocked`) does not use the Bitcoin
RPC proxy, so that timeout does not block the write. If it persists, the
`getblockchaininfo` step of `spike:tachi` should be treated as optional.
