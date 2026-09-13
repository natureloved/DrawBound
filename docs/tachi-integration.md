# Tachi Integration Record

Status: official TypeScript SDK `0.2.1` installed and read-only spike wired; Taurus packages identified at `taurus-vault-core@0.3.4` and `taurus-wallet-aggregator@0.4.5`; write path remains fixture-only pending live verification (checked 2026-09-02).

The supplied Tachi docs identify `@tachibtc/tachi-sdk-ts` and the public daemon URLs `https://rpc-regtest.tachibtc.com` and `https://rpc-signet.tachibtc.com`. The TypeScript client exposes `getHealth`, `getLiveValidators`, `getLockedVtxos`, `listVaults`, `bitcoinRPC`, and `broadcastTxSync`. The supplied docs also identify `@tachibtc/taurus-vault-core` and `@tachibtc/taurus-wallet-aggregator` for P2TR vault creation, deposit, VTXO PSBT construction, and signing.

The `tachibtc` GitHub organization currently exposes the public source repositories [`tachibtc/tachi-sdk-ts`](https://github.com/tachibtc/tachi-sdk-ts) and [`tachibtc/tachi-sdk-go`](https://github.com/tachibtc/tachi-sdk-go), while its Packages tab shows no npm packages. A lookup for `@tachibtc/tachi-sdk-ts` at `https://npm.pkg.github.com` returned 404 on 2026-09-02, but the package is published publicly on npm at `0.2.1`. The public TypeScript repository has these tags: `v0.1.0` (`8ca99e621eb6e5b240099ecd4e6ddd896796ad13`) and `v0.2.1` (`b18b5ebfc8a2716b9961885c5d56ed5dea40634f`). Its `v0.2.1` package metadata reports version `0.2.1`, entrypoint `dist/index.js`, and a TypeScript build script. The Taurus packages are also published publicly on npm at `@tachibtc/taurus-vault-core@0.3.4` and `@tachibtc/taurus-wallet-aggregator@0.4.5`. Do not enable live writes based on package availability alone; verify the exact vault and transaction APIs first.

To verify whether the public TypeScript repository has a publishable release, run this read-only check outside the sandbox and record the output before installing anything:

```powershell
git ls-remote --tags https://github.com/tachibtc/tachi-sdk-ts.git
```

Only install a tagged release or an explicitly reviewed commit. Before using the Git tag, confirm that the tag contains the built `dist/` entrypoint or that the package defines a supported prepare/build lifecycle. Do not depend on the moving default branch in a production or live-funds path.

The implementation therefore uses a deterministic adapter boundary:

- `FixtureTachiAdapter` emits TAURUS-shaped vault references and SatVM-shaped transition references for rehearsal (default mode).
- `LiveTachiAdapter` is the real integration: `getVaultState` reads locked VTXOs for a real vault via `TachiHttpClient.getLockedVtxos`; `submitCreditTransition` broadcasts a signed `txHex` via `TachiHttpClient.broadcastTxSync` and records the real transaction hash. It is selected by `getTachiAdapter()` when `LIVE_TACHI_ENABLED=true` or `PROOF_MODE=live`.
- `fixtureTransport` preserves the `readState` / `submitTransition` contract expected by SDK, JSON-RPC, or CLI transports.
- `PROOF_MODE=fixture` runs official-shaped health fixtures through the same covenant and receipt paths.
- `TachiHttpClient` remains available as a dependency-free HTTP boundary for diagnostics and fallback.
- `createTachiSdkClient` constructs the official `@tachibtc/tachi-sdk-ts@0.2.1` client from `TACHI_BASE_URL` or the selected documented network.
- `scripts/spike-tachi.ts` uses the official SDK for read-only health, live-validator, and Bitcoin RPC checks.
- `SdkTransport` accepts an injected `TachiClient`-shaped object; it refuses to broadcast unless the caller supplies a verified `txHex` payload.

### Live write path (operator responsibilities)

`LiveTachiAdapter` performs no key handling and creates no vault. To exercise a live credit transition the operator must:

1. Run on `signet` or `regtest` with `LIVE_TACHI_ENABLED=true`.
2. Provide `TACHI_VAULT_REF` — a real, funded TAURUS P2TR vault they control — and list it in `ALLOWED_VAULT_REFS`.
3. Build and sign the SatVM credit-transition transaction offline with `@tachibtc/taurus-wallet-aggregator`, producing a `txHex`.
4. Submit that `txHex` on the draw/repay/unlock request body. Drawbound broadcasts it and records the returned hash; without it the transition fails closed (DENY).

Drawbound has not created a vault, funded collateral, or broadcast any transaction. Those steps remain the operator's, using a disposable testnet vault.


Run the read-only inventory with:

```powershell
corepack pnpm spike:tachi
```

Set `TACHI_NETWORK=regtest` or `TACHI_BASE_URL` to target another documented daemon. Do not place API keys in source control or browser code.

Before any live write, record the exact official source URL, package/version, method or RPC name, network, vault reference, proof artifact shape, verifier key, and transaction reference here. Mainnet is disabled by default.
