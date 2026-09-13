# DrawBound

DrawBound is a self-custodial native-BTC credit protocol for testnet. BTC collateral is represented by a TAURUS vault reference; a fresh HAT/RIP-shaped loan-health proof is the covenant that authorizes a SatVM credit transition. Unhealthy or stale evidence freezes new draws, while repayment and the documented unilateral exit path remain available.

## Quickstart

```bash
corepack pnpm install
corepack pnpm dev          # http://localhost:3000 — fixture mode on signet
```

Verify everything:

```bash
corepack pnpm typecheck    # tsc --noEmit
corepack pnpm lint         # eslint (flat config)
corepack pnpm test         # 62 unit + integration tests
corepack pnpm build        # production build
corepack pnpm smoke        # HTTP end-to-end run against SMOKE_BASE (default http://127.0.0.1:3107)
```

## How a session works

1. **Connect** — the browser generates an ephemeral Schnorr keypair (`@noble/curves`, BIP-340). The private key never leaves the device; the public key is registered with `POST /api/wallet/connect` together with the vault ref. The server reads the vault's real locked VTXOs from the Tachi signet daemon, creates (or **restores**, if previously connected) the position, and returns a session token.
2. **Act** — every draw/repay/unlock signs the canonical message

   ```
   DrawBound:v1:<positionId>:<vaultRef>:<action>:<amount>:<nonce>
   ```

   with the session key and presents the session token (`x-drawbound-session` header) plus the signature. The server verifies the signature, checks the nonce against position state (stale/replayed requests get `409`), evaluates the covenant, and records an independently hashed receipt.
3. **Replay safety** — the idempotency fingerprint is `positionId:action:amount:nonce`. A retried signed request returns the original receipt without re-executing; after success the nonce advances, so old signatures are permanently stale.

Honest scope of session auth: it authenticates the browser session that connected a vault — it does **not** prove on-chain vault ownership. Ownership is enforced at the chain level in live mode, where the credit transition must be a real Taurus-signed transaction for that vault.

## Modes

| Mode | Reads | Writes | Purpose |
|---|---|---|---|
| `FIXTURE` (default) | live signet reads (best-effort) | deterministic fixture transitions | rehearsal, demos, CI |
| `LIVE` | real locked-VTXO state | broadcasts operator-supplied signed `txHex` | funded signet/regtest validation |

`NATIVE` and `RELAY` remain reserved integration boundaries for verified official Tachi APIs; `RECORDED` (replay of a live trace) is not implemented.

### Live mode (writes are real and multiply gated)

```bash
LIVE_TACHI_ENABLED=true
KILL_SWITCH=false                # live writes are refused while the kill switch is engaged
TACHI_VAULT_REF=tb1p<your-funded-signet-taurus-vault>
ALLOWED_VAULT_REFS=tb1p<your-funded-signet-taurus-vault>
corepack pnpm dev
```

Safety gates — all fail closed:

- **Testnet only**: `TACHI_NETWORK` must be `signet`/`regtest`; mainnet is refused unless `ALLOW_MAINNET=true` + `LIVE_TACHI_ENABLED=true` + kill switch off.
- **Kill switch**: `KILL_SWITCH=true` (the default) blocks every live broadcast.
- **Vault allowlist**: only `ALLOWED_VAULT_REFS` entries can connect/read/transition in live mode.
- **Real transactions only**: the live adapter rejects the synthetic demo payload (tagged with the `dbdemo01` magic prefix) and any hex that is not a plausibly-sized serialized transaction. A live draw/repay/unlock without a real Taurus-signed `txHex` (paste it in the terminal's Advanced box) returns a `DENY` receipt.
- **Signed proofs (optional strict mode)**: set `PROOF_RELAY_PUBLIC_KEYS` to require every health proof to carry a valid BIP-340 signature from an allowlisted oracle key; unsigned server-derived attestations are then rejected. Configure `HAT_ORACLE_URL` to fetch such attestations.
- **Admin gate**: `POST /api/reset` (and live-mode position seeding) requires `x-admin-token` matching `ADMIN_TOKEN`; without `ADMIN_TOKEN` reset only works in fixture mode.

### Health attestations

- `source: "oracle"` — signed attestation from `HAT_ORACLE_URL` (when configured).
- `source: "derived"` — server-computed from real chain state: `healthBps = collateralSats / (debtUnits × CREDIT_UNIT_SATS) × 10000`, capped at 650%. Derived proofs are debt-aware: drawing reduces health, and the gate re-derives at decision time (no stale snapshots).
- `source: "fixture"` — deterministic rehearsal artifacts (healthy/unhealthy/stale/invalid), labeled as such, with no claim of proof security.

The draw gate (`evaluateDraw`) fails closed on: staleness, position/vault/network/covenant binding, minimum health, credit limit, draw caps, and nonce mismatch.

## API surface

All state-changing routes are rate-limited per IP and require a session; reads are public.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/wallet/connect` | POST | — | register session pubkey, create/restore position |
| `/api/wallet/disconnect` | POST | session | revoke session |
| `/api/draw` · `/api/repay` · `/api/unlock` | POST | session + signature | covenant-gated transitions |
| `/api/proofs` | POST | session | refresh the position's health attestation |
| `/api/positions` | GET / POST | — / admin(live) | session-scoped position, public list; seed a fixture position |
| `/api/receipts` | GET | — | decision audit trail (session-scoped by default) |
| `/api/reset` | POST | admin | destructive demo reset |
| `/api/tachi/diagnostics` | GET | — | read-only Tachi network inspection |
| `/api/health` | GET | — | liveness, mode, policy, counts |

## Storage & deployment

Positions, receipts, idempotency records, and proofs persist to a JSON store (`DATA_DIR`, default `.data/`) with atomic serialized writes that are awaited before responding. This supports a **single instance**; see [docs/deployment.md](docs/deployment.md) for Docker, CI, environment reference, and the SQLite/Postgres swap path.

## Documentation

- [docs/deployment.md](docs/deployment.md) — configuration, Docker, CI, production checklist
- [docs/tachi-integration.md](docs/tachi-integration.md) — SDK/Taurus integration record and live-write procedure
- [docs/threat-model.md](docs/threat-model.md) — trust assumptions and what the gates do (and do not) prove
- [docs/demo-script.md](docs/demo-script.md) — short demo flow

The TypeScript SDK (`@tachibtc/tachi-sdk-ts@0.2.1`) and Taurus packages (`@tachibtc/taurus-vault-core@0.3.4`, `@tachibtc/taurus-wallet-aggregator@0.4.5`) are pinned from public npm. Read-only inventory spikes: `corepack pnpm spike:tachi` / `spike:taurus`. Mainnet writes are disabled by default; never commit keys.
