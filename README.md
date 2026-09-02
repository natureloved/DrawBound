# Drawbound

Drawbound is a one-position, self-custodial native-BTC credit prototype. BTC collateral is represented by a TAURUS vault reference; a fresh HAT/RIP loan-health proof is the covenant that authorizes a SatVM credit transition. Unhealthy or stale evidence freezes new draws, while repayment and the documented unilateral exit path remain available.

## Run

```powershell
corepack pnpm install
corepack pnpm dev
```

Open `http://localhost:3000`. The default is deterministic `FIXTURE` mode on signet. Use the proof tabs to run the same draw request through healthy, unhealthy, and stale inputs. Use **Check live status** to run an explicit, read-only Tachi/Taurus network inspection without changing the fixture position.

The official Tachi SDK and Taurus vault verifier have been validated against the public Signet endpoint. The application still keeps all live financial writes disabled; fixture mode remains the only credit-transition writer until a funded, disposable Signet flow is separately approved and verified. See [docs/tachi-integration.md](docs/tachi-integration.md) before enabling live transport.

## Modes

`NATIVE` and `RELAY` are integration boundaries reserved for verified official Tachi APIs. `FIXTURE` is the current rehearsal mode and is labeled in the UI. `RECORDED` can be added from a successful live trace. Mainnet writes are disabled by default; never commit keys.

The supplied Tachi docs name `@tachibtc/tachi-sdk-ts`, `@tachibtc/taurus-vault-core`, and `@tachibtc/taurus-wallet-aggregator`. The TypeScript SDK is installed from public npm at the pinned `0.2.1` release; the Taurus packages are available from public npm at `0.3.4` and `0.4.5`. The read-only SDK inventory is available immediately:

```powershell
corepack pnpm spike:tachi
```

The Taurus vault derivation and Signet validator quorum can be checked without a wallet sync or transaction write:

```powershell
corepack pnpm spike:taurus
```

The dashboard's **Check live status** action calls `GET /api/tachi/diagnostics`. It reports public health, chain, validator, quorum, and write-policy metadata. Add `?vault=<p2tr-address>` to include a read-only locked-VTXO summary for a known vault address.

See [docs/tachi-integration.md](docs/tachi-integration.md), [docs/threat-model.md](docs/threat-model.md), and [docs/demo-script.md](docs/demo-script.md).

## Verification

```powershell
corepack pnpm test
corepack pnpm build
```
