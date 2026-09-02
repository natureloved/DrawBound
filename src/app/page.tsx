"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CreditPosition, DecisionReceipt, LoanHealthProof } from "@/lib/domain/types";

type ProofKind = "healthy" | "unhealthy" | "stale";
type ApiResult = { position?: CreditPosition; receipt?: DecisionReceipt; decision?: "ALLOW" | "DENY"; reason?: string; proof?: LoanHealthProof; idempotent?: boolean };

const formatDate = (value?: string) => value ? new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "-";
const formatHealth = (bps?: number) => bps == null ? "-" : `${(bps / 100).toFixed(2)}%`;

export default function Home() {
  const [position, setPosition] = useState<CreditPosition | null>(null);
  const [receipts, setReceipts] = useState<DecisionReceipt[]>([]);
  const [adapterMode, setAdapterMode] = useState("FIXTURE");
  const [proofKind, setProofKind] = useState<ProofKind>("healthy");
  const [amount, setAmount] = useState("100");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "allow" | "deny" | "info"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const [p, r] = await Promise.all([fetch("/api/positions"), fetch("/api/receipts")]);
    const positionData = await p.json();
    const receiptData = await r.json();
    setPosition(positionData.position);
    setAdapterMode(String(positionData.adapterMode ?? "fixture").toUpperCase());
    setReceipts(receiptData.receipts ?? []);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json() as ApiResult;
      if (data.position) setPosition(data.position);
      if (data.receipt) setReceipts((current) => data.idempotent || current.some((receipt) => receipt.id === data.receipt!.id) ? current : [data.receipt!, ...current]);
      if (data.decision) setNotice({ tone: data.decision === "ALLOW" ? "allow" : "deny", text: data.receipt?.reason ?? data.reason ?? data.decision });
      return data;
    } catch {
      setNotice({ tone: "deny", text: "Request failed closed; no state transition was applied" });
      return null;
    } finally { setBusy(false); }
  };

  const loadProof = async (kind: ProofKind) => {
    setProofKind(kind);
    await run("/api/proofs", { kind });
    await refresh();
  };

  const reset = async () => { await run("/api/reset"); setProofKind("healthy"); await refresh(); };
  const proof = position?.latestProof;
  const remaining = position ? position.creditLimitUnits - position.debtUnits : 0;
  const isFresh = proof ? new Date(proof.expiresAt).getTime() > Date.now() : false;
  const proofStatus = proof && proof.verification === "VERIFIED" && isFresh && proof.healthBps >= (position?.minHealthBps ?? 12500) ? "HEALTHY" : "BLOCKED";
  const progress = useMemo(() => position ? Math.min(100, (position.debtUnits / position.creditLimitUnits) * 100) : 0, [position]);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">db</span><span>DRAWBOUND</span><small>proof-causal BTC credit</small></div>
        <div className="top-actions"><span className="network-dot" /> SIGNET <span className="mode-chip">{adapterMode} MODE</span><button className="ghost-button" onClick={reset} disabled={busy}>Reset demo</button></div>
      </header>

      <section className="hero-row">
        <div><p className="eyebrow">TREASURY POSITION / POS_DEMO_01</p><h1>One proof. One credit decision.</h1><p className="lede">Native BTC stays locked in a TAURUS vault. A fresh HAT/RIP health proof is the covenant that makes a draw possible.</p></div>
        <div className="hero-badge"><span className="pulse" /> LIVE REHEARSAL <strong>01</strong></div>
      </section>

      {notice && <div className={`notice ${notice.tone}`}><span>{notice.tone === "allow" ? "+" : notice.tone === "deny" ? "!" : "i"}</span><strong>{notice.tone === "allow" ? "COVENANT ALLOWED" : notice.tone === "deny" ? "COVENANT DENIED" : "NOTICE"}</strong><span>{notice.text}</span></div>}

      <section className="grid-main">
        <article className="panel position-panel">
          <div className="panel-head"><div><p className="eyebrow">TAURUS VAULT</p><h2>Position health</h2></div><span className={`state-tag ${position?.state.toLowerCase()}`}>{position?.state.replaceAll("_", " ") ?? "LOADING"}</span></div>
          <div className="metrics">
            <div className="metric primary"><span>Collateral</span><strong>{position?.collateralSats.toLocaleString() ?? "-"} <em>sats</em></strong><small>native BTC / vault locked</small></div>
            <div className="metric"><span>Debt drawn</span><strong>{position?.debtUnits ?? "-"} <em>units</em></strong><small>{remaining} units remaining</small></div>
            <div className="metric"><span>Credit limit</span><strong>{position?.creditLimitUnits ?? "-"} <em>units</em></strong><small>single-position cap</small></div>
          </div>
          <div className="debt-track"><div style={{ width: `${progress}%` }} /></div><div className="track-label"><span>Utilization</span><span>{progress.toFixed(0)}%</span></div>
          <div className="position-foot"><span>Exit status</span><strong>{position?.exitStatus ?? "-"}</strong><span className="separator" /><span>Draws</span><strong>{position?.drawCount ?? 0} / 3</strong></div>
        </article>

        <article className="panel proof-panel">
          <div className="panel-head"><div><p className="eyebrow">HAT / RIP ATTESTATION</p><h2>Loan health proof</h2></div><span className={`proof-status ${proofStatus === "HEALTHY" ? "good" : "bad"}`}><span />{proofStatus}</span></div>
          <div className="segmented" role="tablist" aria-label="Proof fixture"><button className={proofKind === "healthy" ? "selected" : ""} onClick={() => loadProof("healthy")}>Healthy</button><button className={proofKind === "unhealthy" ? "selected" : ""} onClick={() => loadProof("unhealthy")}>Unhealthy</button><button className={proofKind === "stale" ? "selected" : ""} onClick={() => loadProof("stale")}>Stale</button></div>
          <div className="proof-score"><div className="score-ring"><strong>{formatHealth(proof?.healthBps)}</strong><span>health</span></div><div className="proof-copy"><div><span>Threshold</span><strong>{formatHealth(position?.minHealthBps)}</strong></div><div><span>Observed</span><strong>{formatDate(proof?.observedAt)}</strong></div><div><span>Expires</span><strong className={!isFresh ? "danger-text" : ""}>{formatDate(proof?.expiresAt)}</strong></div></div></div>
          <div className="digest-row"><span>Proof digest</span><code>{proof?.digest ? `${proof.digest.slice(0, 18)}...${proof.digest.slice(-10)}` : "-"}</code><span className="verified-pill">[verified]</span></div>
          <div className="binding-row"><span>Bound vault</span><code>{position?.vaultRef ?? "-"}</code></div>
        </article>

        <article className="panel draw-panel">
          <div className="panel-head"><div><p className="eyebrow">COVENANT GATE</p><h2>Request credit</h2></div><span className="lock-icon">[]</span></div>
          <label className="field-label" htmlFor="amount">Draw amount <span>units</span></label><div className="amount-input"><input id="amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} /><span>UNITS</span></div>
          <div className="quick-amounts">{[50, 100, 250].map((value) => <button key={value} onClick={() => setAmount(String(value))}>{value}</button>)}</div>
          <button className="primary-button" onClick={() => run("/api/draw", { amount: Number(amount) })} disabled={busy || !amount}><span>Authorize draw</span><span>-&gt;</span></button>
          <div className="action-row"><button onClick={() => run("/api/repay", { amount: position?.debtUnits ?? 0 })} disabled={busy || !position?.debtUnits}>Repay all</button><button onClick={() => run("/api/unlock")} disabled={busy || position?.debtUnits !== 0}>Request unlock</button></div>
          <p className="microcopy">Repayment remains available when draws are frozen. Collateral exits only at zero debt.</p>
        </article>
      </section>

      <section className="lower-grid">
        <article className="panel receipt-panel"><div className="panel-head"><div><p className="eyebrow">INDEPENDENT RECEIPTS</p><h2>Decision timeline</h2></div><span className="receipt-count">{receipts.length} events</span></div>{receipts.length === 0 ? <div className="empty-state">No transitions yet. The next draw will leave an inspectable receipt here.</div> : <div className="timeline">{receipts.slice(0, 5).map((receipt) => <div className="timeline-item" key={receipt.id}><div className={`timeline-dot ${receipt.result.toLowerCase()}`} /><div className="timeline-content"><div className="timeline-title"><strong>{receipt.action}</strong><span className={`result ${receipt.result.toLowerCase()}`}>{receipt.result}</span><time>{formatDate(receipt.createdAt)}</time></div><p>{receipt.reason}</p><div className="receipt-meta"><code>{receipt.proofDigest ? `proof ${receipt.proofDigest.slice(0, 12)}...` : "no proof required"}</code>{receipt.transitionRef && <code>{receipt.transitionRef}</code>}<span className="receipt-valid">[verified]</span></div></div></div>)}</div>}</article>
        <aside className="panel guard-panel"><p className="eyebrow">GUARDRAILS</p><h2>Fail closed by design</h2><div className="guard-list"><div><span className="guard-check">+</span><span>Signet writes only</span><strong>ACTIVE</strong></div><div><span className="guard-check">+</span><span>Max test collateral</span><strong>5,000 sats</strong></div><div><span className="guard-check">+</span><span>Proof freshness</span><strong>5 min</strong></div><div><span className="guard-check">+</span><span>Relay trust</span><strong>FIXTURE V1</strong></div></div><div className="trust-note"><span>i</span><p>Fixture mode runs the same proof and receipt contracts used by the relay path. Live Tachi package and verifier details remain unverified pending event access.</p></div></aside>
      </section>
      <footer><span>DRAWBOUND / TACHI OP_FREEDOM</span><span>native BTC / no custodian / no bridge</span></footer>
    </main>
  );
}
