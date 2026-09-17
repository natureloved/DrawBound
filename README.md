# DrawBound

DrawBound is a self-custodial native-BTC credit protocol for testnet. BTC collateral is represented by a TAURUS vault reference; a fresh HAT/RIP-shaped loan-health proof is the covenant that authorizes a SatVM credit transition. Unhealthy or stale evidence freezes new draws, while repayment and the documented unilateral exit path remain available.

## Quickstart

```bash
corepack pnpm install
corepack pnpm dev          # http://localhost:3000 — fixture mode on signet
```

The app is two pages:

| Route | What it is |
|---|---|
| `/` | Landing page — what the protocol claims, with links into the terminal |
| `/vault` | **Vault Terminal** — the actual self-custodial session flow (connect, draw, repay, unlock) |

Every flow described below happens in `/vault`.

Verify everything:

```bash
corepack pnpm typecheck    # tsc --noEmit
corepack pnpm lint         # eslint (flat config)
corepack pnpm test         # 109 unit + integration tests
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

Honest scope of session auth: it authenticates the browser session that connected a vault — it does **not** by itself prove on-chain vault ownership. Ownership is enforced at the chain level in live mode, where the credit transition must be a real Taurus-signed transaction for that vault; an explicit BIP-322 **ownership proof** can additionally prove key control at connect time.

### Vault ownership proof (BIP-322, optional)

Connecting can prove control of the vault's user key:

1. Request a single-use challenge: `POST /api/wallet/challenge {vaultRef}` (or the **Request Challenge** button in the terminal).
2. Sign it with the vault user key (BIP-322 simple signature) and note the key's key-path P2TR **ownership address**.
3. Connect with `ownershipNonce`, `ownershipAddress`, `ownershipSignature`. The server consumes the challenge (single-use; wrong-ref attempts don't burn it) and verifies strictly — no loose BIP-137.

Sessions then carry `ownershipVerified: true`. With `REQUIRE_OWNERSHIP_PROOF=true`, connecting a P2TR vault address without a valid proof is refused. Deriving both the vault address and the ownership address from the same user key (see operator tooling) makes the binding by construction.

## Operator tooling

```bash
pnpm exec tsx scripts/operator-live.mts derive                 # vault P2TR + ownership address from your key (live signet quorum)
pnpm exec tsx scripts/operator-live.mts export-key             # mnemonic -> OPERATOR_PRIVATE_KEY (hex + WIF) for the step below
pnpm exec tsx scripts/operator-live.mts ownership <vaultRef>   # challenge -> signed connect body
pnpm exec tsx scripts/operator-live.mts status <vaultRef>      # locked-VTXO read
pnpm exec tsx scripts/operator-live.mts fund-help              # funding + live-write procedure
```

`derive` takes a mnemonic but `ownership` needs a 32-byte hex key, and the wallet
aggregator never exposes private keys — `export-key` is the bridge. Confirm its
`ownershipAddress` matches the one `derive` printed before connecting.

Reference oracle for strict proof mode (holds the signing key; DrawBound only ever sees the public key):

```bash
ORACLE_PRIVATE_KEY=$(openssl rand -hex 32) pnpm oracle
# then: HAT_ORACLE_URL=http://127.0.0.1:3109 PROOF_RELAY_PUBLIC_KEYS=<oraclePubkey> corepack pnpm dev
```

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
| `/api/wallet/challenge` | POST | — | issue a single-use BIP-322 ownership challenge |
| `/api/wallet/connect` | POST | — | register session pubkey (+ optional ownership proof), create/restore position |
| `/api/wallet/disconnect` | POST | session | revoke session |
| `/api/draw` · `/api/repay` · `/api/unlock` | POST | session + signature | covenant-gated transitions |
| `/api/proofs` | POST | session | refresh the position's health attestation |
| `/api/positions` | GET / POST | — / admin(live) | session-scoped position, public list; seed a fixture position |
| `/api/receipts` | GET | — | decision audit trail (session-scoped by default) |
| `/api/reset` | POST | admin | destructive demo reset |
| `/api/tachi/diagnostics` | GET | — | read-only Tachi network inspection |
| `/api/health` | GET | — | liveness, mode, policy, counts |

## Storage & deployment

Two interchangeable backends behind one `StorageBackend` interface, chosen with `DB_BACKEND`:

- `json` (default) — atomic serialized JSON-file writes at `DATA_DIR/drawbound.json`; single instance.
- `sqlite` — Node 24's built-in `node:sqlite` (zero dependencies), WAL journal, transactional, indexed receipts; auto-imports an existing JSON store on first open and archives it.

All writes are awaited before a decision is returned. See [docs/deployment.md](docs/deployment.md) for Docker, CI, environment reference, and the production hardening checklist; [docs/credit-economics.md](docs/credit-economics.md) records the credit-model decisions (unit definition, lender stance, zero interest, freeze-only risk policy).

## Documentation

- [docs/deployment.md](docs/deployment.md) — configuration, Docker, CI, production checklist
- [docs/credit-economics.md](docs/credit-economics.md) — credit model decisions and open product questions
- [docs/tachi-integration.md](docs/tachi-integration.md) — SDK/Taurus integration record and live-write procedure
- [docs/threat-model.md](docs/threat-model.md) — trust assumptions and what the gates do (and do not) prove
- [docs/demo-script.md](docs/demo-script.md) — short demo flow

The TypeScript SDK (`@tachibtc/tachi-sdk-ts@0.2.1`) and Taurus packages (`@tachibtc/taurus-vault-core@0.3.4`, `@tachibtc/taurus-wallet-aggregator@0.4.5`) are pinned from public npm. Read-only inventory spikes: `corepack pnpm spike:tachi` / `spike:taurus`. Mainnet writes are disabled by default; never commit keys.
