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
| `HAT_ORACLE_URL` | — | external signed-attestation oracle (reference impl: `pnpm oracle`) |
| `PROOF_RELAY_PUBLIC_KEYS` | — | x-only hex, comma-separated; non-empty = STRICT signed-proof mode (enforced on connect refresh AND every draw) |
| `REQUIRE_OWNERSHIP_PROOF` | `false` | refuse connecting P2TR vaults without a valid BIP-322 ownership proof |
| `MIN_HEALTH_BPS` | `12500` | covenant minimum (125%) |
| `CREDIT_UNIT_SATS` | `10` | collateral sats per credit unit |
| `MAX_TEST_SATS` | `5000` | collateral cap for seeded positions |
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
5. **TLS/edge**: terminate TLS at a reverse proxy; HSTS is already sent. Put an edge rate limiter in front for multi-region traffic.
6. **Observability**: structured logging sink, error tracking, and uptime alerts on `/api/health`; alert on `killSwitch` state changes.
7. **Live validation**: complete a funded disposable-signet write (see `docs/tachi-integration.md` recording requirement) before considering any broader launch.
8. **Product economics**: the implemented model (BTC-denominated units via `CREDIT_UNIT_SATS`, single-operator treasury, zero interest, freeze-only risk policy) is recorded in [docs/credit-economics.md](credit-economics.md) together with the open decisions (price-oracle-denominated units, multi-lender pooling, proactive under-collateralization monitoring) that need sign-off before any real-value launch.

## Smoke test

`corepack pnpm smoke` drives the full authenticated lifecycle over HTTP (connect → draw → idempotent replay → stale-nonce 409 → over-limit DENY → repay-from-frozen → unlock → disconnect-revokes). Point `SMOKE_BASE` at the target instance:

```bash
SMOKE_BASE=https://drawbound.example.com corepack pnpm smoke
```
