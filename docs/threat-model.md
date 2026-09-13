# Threat Model

DrawBound is a testnet credit-gate demonstrator, not a production lending protocol. The trust budget is explicit.

## Proof modes and what they prove

- **Fixture mode (default)**: deterministic official-shaped artifacts (`source: "fixture"`) exercise the same gate. No claim of proof security.
- **Derived attestations (`source: "derived"`)**: the server computes `healthBps` from a REAL live read of locked VTXOs (or modeled collateral when the vault is unfunded) against the position's actual debt. Honest self-attestation: the chain data is real, but the computation is the server's. A malicious or buggy server could misreport health.
- **Oracle attestations (`source: "oracle"`)**: with `HAT_ORACLE_URL` configured, an external service supplies the attestation. Its `verification: "VERIFIED"` claim is only as good as its signature.
- **Strict mode (`PROOF_RELAY_PUBLIC_KEYS` set)**: every proof must carry a valid BIP-340 Schnorr signature over its 32-byte digest from an allowlisted x-only key. Unsigned derived/fixture attestations fail closed. This removes the server's ability to self-attest health — recommended for any live deployment. The allowlisted verifier key is then the trust assumption (rotatable via env).
- `NATIVE` (SatVM verifies the artifact directly) and `RELAY` (allowlisted verifier signs `HealthAttestationV1`) remain reserved boundaries; `RECORDED` is not implemented.

## Session authentication

Connecting registers an ephemeral browser-generated Schnorr public key; every state-changing request must present the session token AND a signature over the canonical message `DrawBound:v1:<positionId>:<vaultRef>:<action>:<amount>:<nonce>`.

What this proves: the requester holds the private key registered for that session, and the request binds exactly one action/amount/nonce to one position. Replayed signatures hit either the idempotency cache (same fingerprint → original receipt) or the nonce check (advanced nonce → 409).

What this does NOT prove: on-chain ownership of the vault. Anyone who can reach the server may connect any vault ref allowed by policy and act on its position. In live mode this gap is closed at the chain layer — a credit transition only executes as a real Taurus-signed transaction that the operator must build with the vault's actual keys. Vault-key-level authentication (BIP-322 or PSBT challenge) is the documented next step for a public multi-user deployment.

Sessions live in process memory; a restart invalidates them and browsers reconnect automatically with their stored keypair.

## Authorization boundary

The authorization boundary is `evaluateDraw` (via `creditGate`) plus the Tachi adapter transition. UI flags cannot authorize a draw. Failing closed: proof freshness, position/vault/network/covenant binding, minimum health, nonce freshness, debt limit, draw caps, testnet policy, collateral caps, and rate limits. Repayment is callable while frozen. Unlock is denied until debt is zero and never re-runs on an exited position. Every decision binds its proof digest, prior state, result, resulting state, and transition reference in an independently hashed receipt.

The synthetic demo transition payload is tagged with a `dbdemo01` magic prefix; the live adapter rejects it (and any implausibly-sized hex) outright, so rehearsal artifacts can never reach the network.

## Destructive and administrative surface

- `POST /api/reset` requires `ADMIN_TOKEN` (constant-time compare) whenever one is configured, and is refused entirely in live mode without it.
- Live position seeding (`POST /api/positions`) passes the same admin gate plus `assertWritePolicy` (testnet + collateral caps).
- The kill switch (`KILL_SWITCH=true`, default) blocks every live broadcast regardless of other flags.

## Out of scope

Liquidation (unhealthy positions freeze draws but are never force-closed), oracle liveness/security beyond signature checks, custody, regulatory compliance, mainnet deployment, dynamic interest rates, lender matching, credit scoring, and multi-instance horizontal scaling (the JSON store is single-process by design; see docs/deployment.md).
