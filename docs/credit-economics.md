# Credit Economics — Decision Record

Status as of 2026-09-13. Items marked **DECIDED** are implemented and configurable; items marked **OPEN** need a product decision before any real-value launch. Nothing here is financial advice; DrawBound is a testnet demonstrator.

## 1. What a credit unit is worth — DECIDED

A credit unit is a fixed quantity of bitcoin: `CREDIT_UNIT_SATS` (default 10 sats per unit). The credit limit is `collateralSats / CREDIT_UNIT_SATS`.

- Consequence: health is sats-over-sats (collateral sats ÷ debt obligation sats), so **no price oracle is needed** and health only moves when debt or on-chain collateral changes.
- Consequence: the system is **BTC-denominated end to end** — a draw does not introduce USD volatility, but it also means the protocol does not model the market value of collateral at all.
- OPEN (if you ever want purchasing-power lending): a USD-pegged unit would require a price feed in the health computation and a redesign of `calculateCreditLimit`. Not recommended before a real oracle exists.

## 2. Who funds draws (the lender side) — PROPOSED, needs your sign-off

The recommended v0.3 stance is a **single-operator treasury**:

- Drawbound is the credit gate and the ledger of record (positions, receipts); it is **not** a pool. There is no lender matching, no shared liquidity.
- In fixture mode, drawn "credit" is bookkeeping only — nothing is transferred.
- In live mode, the economic transfer happens in the operator-built Taurus transaction (the signed txHex DrawBound broadcasts). The operator IS the counterparty: you fund the draw out of your own treasury, you receive the repayment tx the borrower signs.
- `ALLOWED_RECIPIENTS` is reserved for a future draw-destination allowlist (draws paying out to pre-approved addresses) and is intentionally not enforced yet.
- OPEN: multi-lender pooling, P2P matching, and on-chain loan notes are all out of scope for v0.3.

## 3. Interest and fees — DECIDED (zero) for v0.3

No interest accrues and no fees are charged by the protocol. Debt units are exactly what was drawn. A `rateBpsPerPeriod` knob can be added to `CreditPosition` later without breaking receipts; do not add it before deciding compounding periods and the accrual authority (protocol vs operator).

## 4. Liquidation policy — DECIDED (freeze-only), with a manual exit

The enforced policy today:

- Health below `MIN_HEALTH_BPS` **freezes new draws** (DENY receipts, state FROZEN).
- Repayment stays callable while frozen; unlock requires zero debt.
- There is **no forced/automated liquidation**. If collateral must be recovered, the operator exercises the Taurus unilateral-exit path themselves (`signUnilateralExitPsbtAsUser` / `signToLocalSelfExitPsbtAsUser` in `@tachibtc/taurus-vault-core`) — deliberately manual, because automating seizure is a custody decision, not a parameter.
- OPEN: under-collateralization at the *position* level (collateral shrink while debt is outstanding) currently surfaces only via live re-reads at gate time. A periodic re-health job (oracle pull per position on a schedule) would make freeze decisions proactive rather than draw-time. Cheap to add once an oracle is running (scripts/hat-oracle.ts).

## 5. What the gates actually bound

- `MAX_TEST_SATS` caps seeded collateral (testnet safety).
- `MAX_DRAWS_PER_POSITION` caps draw count per position (default 3).
- `MIN_HEALTH_BPS` is the covenant floor (default 12500 = 125%).
- Draw cap and health floor are per-position and enforced in `evaluateDraw`; the credit limit is enforced both at gate time and by position invariants (`debt ≤ creditLimit`).

## 6. Compliance, custody, mainnet — OUT OF SCOPE

Same posture as the threat model: no KYC/AML, no custody of user keys, no mainnet writes. Any real-value deployment needs legal review before touching `ALLOW_MAINNET`.
