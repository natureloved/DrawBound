# Threat Model

Drawbound is a testnet prototype, not a production lending protocol. The trust budget is explicit:

- Native mode (future): SatVM/Tachi verifies the HAT/RIP artifact directly.
- Relay mode (future): an allowlisted verifier checks the authentic artifact and signs `HealthAttestationV1`; the verifier key is rotatable and is a trust assumption.
- Fixture mode (current default): deterministic official-shaped fixtures exercise the same gate, with no claim of proof security.
- Live mode (wired, gated): `LiveTachiAdapter` reads real vault state and broadcasts operator-supplied signed txHexes. It is fail-closed: testnet-only, kill-switch respected, mainnet refused unless every gate is explicitly enabled, no vault creation or funding, and no broadcast without a signed `txHex`.

The authorization boundary is `evaluateDraw` plus the Tachi adapter transition. UI flags cannot authorize a draw. Freshness, position/vault/network/covenant binding, minimum health, nonce, debt limit, testnet policy, and draw caps all fail closed. Repayment is callable while frozen. Unlock is denied until debt is zero, and every decision binds its proof digest, prior state, result, resulting state, and transition reference in an independently hashed receipt.

Out of scope: liquidation, oracle security, custody, regulatory compliance, mainnet deployment, dynamic rates, matching, and credit scoring.
