# 90-Second Demo Script

Fixture mode on signet. Start `corepack pnpm dev` and open the Vault Terminal (`/vault`).

1. **Connect** — click **Use Demo Vault** (or paste any P2TR ref) then **Connect Vault**. The browser generates an ephemeral Schnorr keypair; the server reads the vault's real locked VTXOs from the signet daemon, creates or restores the position, and returns a session token. Note the connected vault, session public key, and the derived health attestation (650% at zero debt).
2. **Draw** — leave the amount at 100 and **Authorize Draw**. The browser signs the canonical message and the gate allows it. Point to the green `ALLOW` receipt: proof digest, prior/resulting state, and the SatVM transition reference.
3. **Drive health down (the wow moment)** — keep drawing. Each draw raises debt, so the re-derived attestation reports a lower health ratio (500% → 250% → 166% → …). Around debt 480 the health falls below the 125% covenant minimum and the exact same 100-unit request now emits a red `DENY — Loan health is below covenant threshold`, freezing the position. Credit could not outrun its proof.
4. **Show replay safety** — the draw buttons sign a fresh nonce each time; a captured request replayed after the nonce advanced returns `409` (stale), and an exact in-flight duplicate returns the original receipt flagged idempotent.
5. **Repay all** — click **Repay All** to show repayment remains available while frozen; the position returns to `REPAID` / `AVAILABLE` at zero debt.
6. **Unlock** — click **Request Unlock** at zero debt to reach `EXITED` and the available recovery status.
7. **Inspect the network** — **Inspect Live Network** calls `/api/tachi/diagnostics` for a read-only signet snapshot (chain, validators, quorum).

For a scripted, click-free run of the same lifecycle (connect → draw → replay → stale-nonce → over-limit deny → repay → unlock → disconnect), use `corepack pnpm smoke` against a running instance.

Current rehearsal mode is `FIXTURE` on signet. Replace with a recorded live trace only after the official Tachi write APIs and a real disposable test vault are verified (see tachi-integration.md).
