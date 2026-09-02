# Drawbound

Drawbound is a one-position, self-custodial native-BTC credit prototype. BTC collateral is represented by a TAURUS vault reference; a fresh HAT/RIP loan-health proof is the covenant that authorizes a SatVM credit transition. Unhealthy or stale evidence freezes new draws, while repayment and the documented unilateral exit path remain available.

## Run

```powershell
corepack pnpm install
corepack pnpm dev
```

Open `http://localhost:3000`. The default is deterministic `FIXTURE` mode on signet. Use the proof tabs to run the same draw request through healthy, unhealthy, and stale inputs.

The current Tachi event status, SDK, and verifier are intentionally unverified in this checkout because the official page was unavailable during the integration spike; see [docs/tachi-integration.md](docs/tachi-integration.md) before enabling live transport.

## Modes

`NATIVE` and `RELAY` are integration boundaries reserved for verified official Tachi APIs. `FIXTURE` is the current rehearsal mode and is labeled in the UI. `RECORDED` can be added from a successful live trace. Mainnet writes are disabled by default; never commit keys.

The supplied Tachi docs name `@tachibtc/tachi-sdk-ts`, `@tachibtc/taurus-vault-core`, and `@tachibtc/taurus-wallet-aggregator`. The TypeScript SDK is installed from public npm at the pinned `0.2.1` release; the Taurus packages are available from public npm at `0.3.4` and `0.4.5`. The read-only SDK inventory is available immediately:

```powershell
corepack pnpm spike:tachi
```

See [docs/tachi-integration.md](docs/tachi-integration.md), [docs/threat-model.md](docs/threat-model.md), and [docs/demo-script.md](docs/demo-script.md).

## Verification

```powershell
corepack pnpm test
corepack pnpm build
```
