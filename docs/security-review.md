# DrawBound Security Review & Remediation

Scope: `natureloved/DrawBound` at `HEAD` (TypeScript / Next.js 16, ~7,800 LOC, 19 test files).
Method: static review + three parallel adversarial reviewers (auth/session layer, credit-gate &
state machine, doc-vs-code accuracy) + independent black-box attack probes against a live
server with real BIP-340 Schnorr signers.

Baseline before this work: `typecheck`, `lint`, `build` clean; 109/109 tests pass; no tracked
secrets. The vulnerabilities below were all *behind* a green test suite.

---

## Critical

### C1. Position-id collision → cross-position control (unauthorized draw)

`positionIdForVault` stripped non-alphanumerics from the vault ref and truncated to 32 chars:

```
vault:taurus:signet:demo    → vaulttaurussignetdemo    → pos_vaulttaurussignetdemo
vault-taurus-signet-demo    → vaulttaurussignetdemo    → pos_vaulttaurussignetdemo   ← same
```

An attacker connected a hyphenated spelling of a victim's vault ref, resolved to the victim's
position, and drew against their debt. **Reproduced end-to-end**: victim at debt 100; attacker
connected `vault-taurus-signet-alice7f2`, session restored the victim's position
(`restored: true`), drew 150 → victim debt 100 → 250.

**Fix** (`src/lib/store.ts`): position id is now the full SHA-256 of the vault ref,
`pos_<64 hex>`, so no two distinct refs can collide. Regression tests cover separator variants
and 32-char-prefix twins.

### C2. Sessions were not bound to the vault they acted on

`authenticateAction` resolved the position from `session.positionId` and never re-checked that
the position's vault matched the session's vault. Combined with C1 this was the actual damage
vector; even with C1 fixed, a session id alone should never authorize a position.

**Fix** (`src/lib/auth/action-auth.ts`): enforce `position.vaultRef === session.vaultRef`, 403 on
mismatch. Verified live: a session opened for vault B signing a request for position A → 403.

### C3. Anonymous position takeover via reconnect

`/api/wallet/connect` restored an existing position — with its outstanding debt and receipts —
with no proof of anything. Anyone who knew a vault ref inherited control of it.

**Fix** (`src/app/api/wallet/connect/route.ts`): restoring a position with an existing record
requires a valid BIP-322 ownership proof for that vault, or a valid admin token. New positions
still open normally. Verified live: second connect to a vault with debt → 403.

---

## High

### H1. Rate limiter bypassable via `X-Forwarded-For`

The limiter keyed on the client-supplied header, so rotating the value per request gave every
request a fresh bucket. Measured on the pre-fix server: same-IP → `{"200":42,"429":108}`;
rotating XFF → `{"200":150}`.

**Fix** (`src/lib/security/rate-limit.ts`): rewritten. `x-forwarded-for` / `x-real-ip` are honored
only when `TRUSTED_PROXY_HOPS` is set to the real hop count in front of the app; otherwise the key
falls back to the socket identity. Buckets are swept unconditionally, so the key map cannot grow
without bound. Verified live: rotating XFF now yields `{"429":200}`.

### H2. Unauthenticated data wipe via `POST /api/reset`

With `ADMIN_TOKEN` unset the route wiped all data for any anonymous caller outside live mode.

**Fix** (`src/app/api/_lib/http.ts`): `requireAdmin` fails closed. With `ADMIN_TOKEN` set the
header must match (constant-time); unset, the route is refused in every mode except an explicit
local-demo opt-in `ALLOW_INSECURE_RESET=true`. Verified live: no token → 403, wrong token → 403.

### H3. Position and receipt enumeration

`GET /api/positions` listed every position anonymously; `GET /api/receipts` enumerated receipts
by `positionId` with no authorization.

**Fix**: `positions` GET requires a session (or admin) for a specific `?id=`/`?vault=` read and
403s when the caller does not own it; the full list is admin-only and anonymous callers receive
`position: null, positions: []`. `receipts` GET requires a session or admin token. Verified live:
anonymous → 401, cross-owner → 403, and the anonymous list payload is empty rather than just 401.

### H4. Credit transitions were not serialized (lost updates)

Draw / repay / unlock read the position, decided, then wrote — as separate awaits across
concurrent requests.

**Fix** (`src/lib/store.ts` + routes): `withPositionLock(positionId, fn)` serializes
read-modify-write per position, and the routes re-read the position *inside* the lock. The
pre-lock snapshot (`before`) is a stale read by construction, so the nonce/debt checks must run
against `current`. Verified live: 8 concurrent draws with the same nonce → exactly 1 ALLOW,
7 × 409, final debt 100, `drawCount` 1.

Note: the original empirical probing (8 concurrent draws) showed one ALLOW *even without* the
lock, because the nonce check happened to run before the mutation. The lock is the structural
guarantee; the re-read is what actually closes the window, since every concurrent worker
previously validated against the same `nonce: 0` snapshot.

### H5. Non-atomic state + audit-trail writes

`savePosition` then `addReceipt` were two awaits; a crash between them left a receipt claiming a
decision the position never recorded, or a position that advanced with no receipt explaining it.

**Fix**: `commitTransition(position, receipt)` added to the `StorageBackend` interface and both
backends — SQLite wraps both in a transaction; the JSON backend mutates memory once, then writes
the single file.

### H6. `nonceConflict` 409 leaked the live nonce

The response body named the current nonce, handing a replay attacker the exact value needed.

**Fix**: generic message. Verified live: the 409 body contains no nonce value.

### H7. Nonce-based idempotency broke legitimate retries — and then broke differently

The fingerprint bound the raw signature bytes. BIP-340 signing is randomized, so the same request
signed twice yields different bytes: the fingerprint changed, and a retry re-executed the
transition instead of returning the original receipt.

**Fix**: `transitionFingerprint(positionId, action, amount, nonce, signature?)` where `signature`
is the **signer's public key**, hashed and appended. Retries of the same transition now return the
original receipt; the same tuple signed by a different key still separates.

---

## Medium

| # | Issue | Fix |
|---|-------|-----|
| M1 | `verifyProofSignature` accepted any key when `PROOF_RELAY_PUBLIC_KEYS` was unset, so an arbitrary x-only pubkey passed and forged oracle attestations were accepted | allowlist-only; unset → `false` (`src/lib/proofs/verify.ts`) |
| M2 | Remote attestation failure silently degraded to a self-derived proof | no silent degradation; `MAX_HEALTH_BPS` sanity bound (`src/lib/proofs/oracle-client.ts`) |
| M3 | Credit limit widened on collateral loss: `creditLimitUnits = Math.max(calculateCreditLimit(collateral), existing.debtUnits)` | limit is purely collateral-derived; debt is separately clamped so `debt <= limit` holds |
| M4 | `safeEqual` leaked the admin token's length via early return | both sides hashed to a fixed width before `timingSafeEqual` |
| M5 | `redactSecret` revealed ~40% of a short secret | length-independent masking, `[redacted:N]` |
| M6 | Session map grew without bound (`MAX_TRACKED_CHALLENGES` bounded the challenge map, sessions nothing) | `sweepExpiredSessions` on access + hard cap of 10,000 |
| M7 | Body-borne bearer token was accepted alongside the header, making every authenticated route a CSRF target | header-only (`x-drawbound-session`) |
| M8 | `policy.adapterMode` and `assertWritePolicy` read raw `process.env`, so a caller could name `mainnet` and skip the testnet gate | validated `env.proofMode()` / `env.network()`; boot-time `validatePolicy()` |
| M9 | FROZEN permitted DRAW | FROZEN denies DRAW, still permits REPAY/UNLOCK so the unilateral exit stays reachable |
| M10 | Private session key persisted in `localStorage` | signing key is in module memory only; cleared on disconnect/reload; the UI prompts a reconnect instead of drawing with a missing key |
| M11 | Landing page claimed `issuance.sol`, "settled on Bitcoin L1", "no committee, no sequencer, no operator can interpose", "not operator honesty" — none of which the code implements | copy rewritten to describe the implemented model; vault terminal labels fixture vs. live mode |
| M12 | `fast-check` unused devDependency | removed |

---

## Notes / accepted

- **CSRF**: no httpOnly cookie is used and none is needed. Every mutating route is
  `application/json` + custom header + Schnorr signature over the canonical message. A
  cross-origin form cannot set a custom header without a CORS preflight, and no route accepts
  `form-data`/`urlencoded`, so the header-only token is a structural defense. If a cookie-based
  flow is ever added, it must ship with `SameSite=Strict` and a CSRF token.
- **On-chain ownership**: connecting a vault does not prove on-chain ownership. This is stated
  plainly in `docs/threat-model.md`; `REQUIRE_OWNERSHIP_PROOF` defaults to `false`. Not a code
  defect, but the landing page previously implied otherwise (M11).
- **Live write path**: the operator's node broadcasts; this app is one client, not a settlement
  layer. Documented as such now.
- **Storage scope**: single process per `DATA_DIR`, no serverless. Sessions and rate-limit
  buckets are in memory.

---

## Verification

```
typecheck   clean
lint        clean
build       success
tests       128 passed (128)   (baseline 109; +19 in hardening-regressions.test.ts)
```

Black-box verification against a live server (defaults, no `ALLOW_INSECURE_RESET`):

- C1 separator variants → distinct position ids ✓
- C2 cross-vault session → 403 ✓
- C3 anonymous restore to a vault with debt → 403 ✓
- H1 rotating `X-Forwarded-For` → `{"429":200}` (was `{"200":150}`) ✓
- H2 anon / wrong-token reset → 403 ✓
- H3 anonymous enumeration → empty payload; cross-owner reads → 403 ✓
- H4 8 concurrent draws, same nonce → 1 ALLOW, 7 × 409, debt 100, `drawCount` 1 ✓
- H6 replay 409 body contains no nonce ✓
- H7 idempotent retry returns the original receipt ✓
- M9 FROZEN denies DRAW, permits REPAY/UNLOCK ✓
- FROZEN → repay → REPAID → unlock → EXITED, debt 0 ✓
