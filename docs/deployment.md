# Deployment Guide

DrawBound ships as a single-instance Next.js application (standalone output) with a JSON-file store. This guide covers configuration, container deployment, CI, and the production hardening path.

## Requirements

- Node.js 22+ (developed on 24; WebCrypto and `fetch` are used at runtime)
- pnpm via corepack (`corepack enable`)
- Outbound HTTPS to the Tachi daemon (`rpc-signet.tachibtc.com` by default) for live reads

## Environment reference

Every variable is validated at boot (`src/lib/config/env.ts`); a malformed value crashes startup with a readable error instead of misbehaving at request time. See `.env.example` for the canonical annotated list.

| Variable | Default | Notes |
|---|---|---|
| `APP_MODE` / `PROOF_MODE` | `fixture` | `PROOF_MODE=live` also enables live writes |
| `LIVE_TACHI_ENABLED` | `false` | master switch for the live adapter |
| `KILL_SWITCH` | `true` | while `true`, ALL live broadcasts are refused |
| `ALLOW_MAINNET` | `false` | mainnet needs this + live enabled + kill switch off |
| `TACHI_NETWORK` | `signet` | `signet` / `regtest` / `mainnet` |
| `TACHI_BASE_URL` | per-network | override daemon URL |
| `TACHI_VAULT_REF` | — | operator's funded vault (live mode) |
| `ALLOWED_VAULT_REFS` | — | comma-separated; enforced on connect/reads/writes in live mode |
| `TACHI_EXPECTED_CHAIN_ID` | per-network | chain id the daemon must advertise (`tachi-signet-1` / `tachi-regtest-1`) |
| `LIVE_REQUIRE_CHAIN_ATTESTATION` | `true` | refuse live work when the daemon does not name the expected chain (loopback excepted) |
| `LIVE_REQUIRE_CHAIN_READ` | `true` | a failed/truncated locked-VTXO read denies instead of using modeled collateral |
| `LIVE_ATTESTATION_TTL_MS` | `60000` | how long a successful chain attestation is reused |
| `LIVE_REQUEST_TIMEOUT_MS` | `20000` | per-request daemon timeout |
| `LIVE_CONFIRM_TIMEOUT_MS` | `45000` | how long a broadcast is waited on before it is reported pending (tx hash journaled) |
| `LIVE_POLL_INTERVAL_MS` | `1500` | commit-poll cadence |
| `LIVE_MAX_FEE_SATS` | `5000` | a transaction whose decoded fee exceeds this is refused before broadcast |
| `HAT_ORACLE_URL` | — | external signed-attestation oracle (reference impl: `pnpm oracle`) |
| `PROOF_RELAY_PUBLIC_KEYS` | — | x-only hex, comma-separated; non-empty = STRICT signed-proof mode (enforced on connect refresh AND every draw) |
| `REQUIRE_OWNERSHIP_PROOF` | `false` | refuse connecting P2TR vaults without a valid BIP-322 ownership proof |
| `MIN_HEALTH_BPS` | `12500` | covenant minimum (125%) |
| `CREDIT_UNIT_SATS` | `10` | collateral sats per credit unit |
| `MAX_TEST_SATS` | `5000` | collateral cap for seeded positions, and the ceiling on the obligation a live transition may commit |
| `MAX_DRAWS_PER_POSITION` | `3` | 0 disables the cap |
| `PROOF_MAX_AGE_SECONDS` | `300` | derived-attestation freshness window |
| `SESSION_TTL_MINUTES` | `720` | browser session lifetime |
| `ADMIN_TOKEN` | — | required for `/api/reset`; generate with `openssl rand -hex 32` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `60` / `60000` | per-IP API budget |
| `DB_BACKEND` | `json` | `json` (single file, single instance) or `sqlite` (node:sqlite, durable, transactional; auto-imports an existing JSON store on first open) |
| `DATA_DIR` | `.data` | store location (`drawbound.json` / `drawbound.db`); mount a volume |
| `DEBUG_TACHI` | — | `true` logs redacted broadcast attempts |

## Docker

```bash
docker build -t drawbound .
docker run --rm -p 3000:3000 \
  -v drawbound-data:/app/.data \
  -e KILL_SWITCH=true \
  -e ADMIN_TOKEN=$(openssl rand -hex 32) \
  drawbound
```

The image uses the Next.js standalone output and runs as a non-root user. `DATA_DIR` defaults to `/app/.data`; persist it or state resets on container recreation. Liveness/readiness: `GET /api/health`.

## CI

`.github/workflows/ci.yml` runs typecheck, lint, tests, and a production build on every push/PR. The suite is hermetic: tests isolate `DATA_DIR` into temp directories and never touch the network (route tests drive handlers directly with a stubbed reader; the fixture adapter is the default).

## Storage backends & single-instance constraint

Two backends behind one `StorageBackend` interface (`src/lib/db/storage.ts`, `src/lib/db/sqlite.ts`):

- `DB_BACKEND=json` (default): atomic JSON-file writes, single file. **Single process only** — do not run multiple instances against the same `DATA_DIR`.
- `DB_BACKEND=sqlite` (recommended for any persistent deployment): Node 24 built-in `node:sqlite` (zero dependencies), WAL journal, transactional writes, indexed receipts, and a one-time automatic import of an existing `drawbound.json` (archived as `.imported`). Still a local-file store: one process per `DATA_DIR`, no serverless.

Sessions and rate-limit buckets are in-memory; a restart invalidates sessions (browsers reconnect automatically) and resets limits. For multi-instance deployments, front the app with a shared limiter and move sessions to signed cookies or Redis — route code does not change.

Serverless deployments remain unsupported (no durable local disk, ephemeral memory).

## Production hardening checklist

Before exposing DrawBound publicly:

1. **Storage**: switch to `DB_BACKEND=sqlite`; add backups for the store (receipts are the audit trail). Postgres is the next step beyond single-node file storage (reimplement `StorageBackend` once).
2. **Ownership proofs**: enable `REQUIRE_OWNERSHIP_PROOF=true` so every connected P2TR vault comes with a BIP-322 proof of key control. For a fully trustless binding, derive the vault address and ownership address from the same key via `scripts/operator-live.mts derive`.
3. **Strict proofs**: run the reference oracle (`ORACLE_PRIVATE_KEY=... pnpm oracle`), point `HAT_ORACLE_URL` at it, put its x-only key in `PROOF_RELAY_PUBLIC_KEYS`, and rotate that key on a schedule. Draws then verify signed attestations instead of trusting server self-computation.
4. **CSP**: move from `'unsafe-inline'` scripts to nonce-based CSP via middleware; self-host fonts with `next/font` to drop the Google origins.
5. **TLS/edge**: terminate TLS at a reverse proxy; HSTS is already sent. Put an edge rate limiter in front for multi-region traffic. If the proxy rewrites `X-Forwarded-For`, set `TRUSTED_PROXY_HOPS` to its hop count — otherwise the header is ignored and every client shares one bucket (safe, but coarse).
6. **Observability**: structured logging sink, error tracking, and uptime alerts on `/api/health`; alert on `killSwitch` state changes.
7. **Live validation**: complete a funded disposable-signet write (see the live execution runbook below and the `docs/tachi-integration.md` recording requirement) before considering any broader launch. `corepack pnpm live:check` is the read-only preflight; the recording table has never been filled with an executed write and should stay that way until an operator does it deliberately.
8. **Product economics**: the implemented model (BTC-denominated units via `CREDIT_UNIT_SATS`, single-operator treasury, zero interest, freeze-only risk policy) is recorded in [docs/credit-economics.md](credit-economics.md) together with the open decisions (price-oracle-denominated units, multi-lender pooling, proactive under-collateralization monitoring) that need sign-off before any real-value launch.

## Live execution runbook

Live writes are real transactions on a real network. The gates are the product; do not
short-circuit them. Everything below is read-only until step 6, and no step is executed by
the server on its own initiative.

Steps 1-5 are sequenced by `corepack pnpm live:onboard` (add `--dry-run` to see the plan);
it never broadcasts a credit transition. Run them by hand if you prefer — they are here in
full, because a driver that hides the money steps is worse than no driver.

```bash
# 1. Keys and vault identity (never put a mnemonic in the repo or a browser bundle).
OPERATOR_MNEMONIC="..." pnpm exec tsx scripts/operator-live.mts derive
OPERATOR_MNEMONIC="..." pnpm exec tsx scripts/operator-live.mts export-key

# 2. Fund the derived P2TR vault on signet (any wallet), wait for ~6 confirmations, then
#    register the L1 outpoint as a ledger VTXO (this one step DOES broadcast, by design).
corepack pnpm exec tsx scripts/operator-live.mts register <fundingTxid> [vout]

# 3. Point the app at that vault and arm live mode.
export TACHI_NETWORK=signet
export TACHI_VAULT_REF=tb1p...            # must equal the derived address
export ALLOWED_VAULT_REFS=tb1p...         # live mode refuses any other vault
export LIVE_TACHI_ENABLED=true PROOF_MODE=live
export HAT_ORACLE_URL=... | PROOF_RELAY_PUBLIC_KEYS=...   # live needs an external anchor
export KILL_SWITCH=false                  # last thing you set, first thing you revert

# 4. Preflight. Read-only. Exits non-zero while any blocking gate fails.
corepack pnpm live:check

# 5. Build and verify a transition offline-ish. Never broadcasts; refuses to invent an
#    input VTXO or to sign with a nonce it could not read.
corepack pnpm live:build -- <fundingTxid> <amountSats>

# 6. Broadcast through the app: paste the reported txHex into the Terminal's Advanced box
#    and execute the action. DrawBound re-decodes it on the daemon, enforces the fee and
#    obligation caps, broadcasts, and only writes its ledger after the daemon reports the
#    transaction committed. Re-run live:check if a step was refused.
```

Notes that save an afternoon:

- `live:check` reports the app's own readiness model (`src/lib/tachi/readiness.ts`) — the
  health endpoint and the Terminal banner show the same thing, so there is no separate
  "operator truth" to drift from.
- `/tachi_txValidate` is not consulted anywhere: current daemons answer `valid: false` even
  for transactions they committed, so it cannot gate anything. `/tachi_txDecode` is the
  pre-broadcast check, and both the vendor docs and `src/lib/tachi/signet.ts` say so.
- A `pendingTxHash` on a denial means the transaction was accepted and simply had not
  committed within `LIVE_CONFIRM_TIMEOUT_MS`. Do not retry the action; check
  `scripts/operator-live.mts status <vaultRef>` and let it commit.
- Outbound HTTPS to the daemon is required (`curl -sS "$TACHI_BASE_URL/health"` is the
  one-liner); an unreachable daemon shows up as a failed `daemon-attested` check, not a
  fallback.

## Smoke test

`corepack pnpm smoke` drives the full authenticated lifecycle over HTTP (connect → draw → idempotent replay → stale-nonce 409 → over-limit DENY → repay-from-frozen → unlock → disconnect-revokes). Point `SMOKE_BASE` at the target instance:

```bash
SMOKE_BASE=https://drawbound.example.com corepack pnpm smoke
```
