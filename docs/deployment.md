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
| `HAT_ORACLE_URL` | — | external signed-attestation oracle |
| `PROOF_RELAY_PUBLIC_KEYS` | — | x-only hex, comma-separated; non-empty = STRICT signed-proof mode |
| `MIN_HEALTH_BPS` | `12500` | covenant minimum (125%) |
| `CREDIT_UNIT_SATS` | `10` | collateral sats per credit unit |
| `MAX_TEST_SATS` | `5000` | collateral cap for seeded positions |
| `MAX_DRAWS_PER_POSITION` | `3` | 0 disables the cap |
| `PROOF_MAX_AGE_SECONDS` | `300` | derived-attestation freshness window |
| `SESSION_TTL_MINUTES` | `720` | browser session lifetime |
| `ADMIN_TOKEN` | — | required for `/api/reset`; generate with `openssl rand -hex 32` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `60` / `60000` | per-IP API budget |
| `DATA_DIR` | `.data` | JSON store location; mount a volume |
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

## Single-instance constraint

The JSON store and the in-memory session/rate-limit registries assume ONE process:

- Do not run multiple replicas against the same `DATA_DIR`.
- Serverless deployments are unsupported (no durable local disk, ephemeral memory).

This is a deliberate prototype-to-product boundary, not an oversight. The storage layer is isolated behind `StorageRepository` (`src/lib/db/storage.ts`); swapping in SQLite or Postgres means reimplementing that one class (its methods are already async and transaction-shaped). Sessions would move to a signed-cookie or Redis-backed registry; the rate limiter to an edge provider or Redis. No route or domain code changes.

## Production hardening checklist

Before exposing DrawBound publicly:

1. **Storage**: replace `StorageRepository` with SQLite/Postgres; add backups for receipts (they are the audit trail).
2. **Vault-key auth**: upgrade session auth to prove vault ownership (BIP-322 message signature or PSBT challenge against the vault's taproot key). Today's sessions authenticate the browser, not the vault holder.
3. **Strict proofs**: run a real HAT/RIP oracle at `HAT_ORACLE_URL`, put its x-only key in `PROOF_RELAY_PUBLIC_KEYS`, and rotate it on a schedule.
4. **CSP**: move from `'unsafe-inline'` scripts to nonce-based CSP via middleware; self-host fonts with `next/font` to drop the Google origins.
5. **TLS/edge**: terminate TLS at a reverse proxy; HSTS is already sent. Put an edge rate limiter in front for multi-region traffic.
6. **Observability**: structured logging sink, error tracking, and uptime alerts on `/api/health`; alert on `killSwitch` state changes.
7. **Live validation**: complete a funded disposable-signet write (see `docs/tachi-integration.md` recording requirement) before considering any broader launch.
8. **Product economics**: decide what a credit unit is worth, who funds draws, and the liquidation/exit policy. The current model (units = fixed sats ratio, freeze-on-unhealthy, no forced exit) is a demonstrator, not a lending business.

## Smoke test

`corepack pnpm smoke` drives the full authenticated lifecycle over HTTP (connect → draw → idempotent replay → stale-nonce 409 → over-limit DENY → repay-from-frozen → unlock → disconnect-revokes). Point `SMOKE_BASE` at the target instance:

```bash
SMOKE_BASE=https://drawbound.example.com corepack pnpm smoke
```
