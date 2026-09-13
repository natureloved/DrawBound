"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { CreditPosition, DecisionReceipt } from "@/lib/domain/types";
import type { TachiReadOnlySnapshot } from "@/lib/tachi/read-only";
import { generateSessionKeypair } from "@/lib/wallet/canonical";
import { signTransitionRequest } from "@/lib/wallet/transition-builder";

/**
 * Vault terminal — self-custodial session flow.
 *
 * The browser generates an ephemeral Schnorr keypair on connect, registers the
 * public key with the server, and signs every draw/repay/unlock over the
 * canonical message DrawBound:v1:<positionId>:<vaultRef>:<action>:<amount>:<nonce>.
 * The private key never leaves this device. In LIVE mode, actions additionally
 * require a real Taurus-signed txHex pasted into the Advanced box (the server
 * refuses to broadcast anything synthetic).
 */

type ApiResult = {
  position?: CreditPosition;
  receipt?: DecisionReceipt;
  decision?: "ALLOW" | "DENY";
  reason?: string;
  error?: string;
  detail?: string;
  idempotent?: boolean;
};

interface StoredSession {
  vaultRef: string;
  positionId: string;
  sessionToken: string;
  privateKey: string;
  publicKey: string;
}

const SESSION_KEY = "drawbound:session";
const SESSION_HEADER = "x-drawbound-session";
const DEMO_VAULT = "tb1p9kkv8c66zf8qsz9kd9nq2n3fxrytcrde8cae8qzu9ahwlfv92fyqa4mzx3";

const formatDate = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("en", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(value))
    : "-";

const formatHealth = (bps?: number) => (bps == null ? "-" : `${(bps / 100).toFixed(2)}%`);

export default function VaultPage() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [position, setPosition] = useState<CreditPosition | null>(null);
  const [receipts, setReceipts] = useState<DecisionReceipt[]>([]);
  const [adapterMode, setAdapterMode] = useState("fixture");
  const [amount, setAmount] = useState("100");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "allow" | "deny" | "info"; text: string } | null>(null);
  const [tachiSnapshot, setTachiSnapshot] = useState<TachiReadOnlySnapshot | null>(null);
  const [tachiBusy, setTachiBusy] = useState(false);
  const [tachiError, setTachiError] = useState<string | null>(null);
  const [vaultInput, setVaultInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [customTxHex, setCustomTxHex] = useState("");
  const [refreshingProof, setRefreshingProof] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(0);

  const isLive = adapterMode === "live";

  // Keeps freshness checks honest without calling Date.now() during render.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const authHeaders = useCallback(
    (extra?: Record<string, string>): Record<string, string> => ({
      "content-type": "application/json",
      ...(session?.sessionToken ? { [SESSION_HEADER]: session.sessionToken } : {}),
      ...extra,
    }),
    [session],
  );

  const refresh = useCallback(async () => {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const storedRaw = window.localStorage.getItem(SESSION_KEY);
      const stored: StoredSession | null = storedRaw ? (JSON.parse(storedRaw) as StoredSession) : null;
      if (stored?.sessionToken) headers[SESSION_HEADER] = stored.sessionToken;
      const [p, r] = await Promise.all([
        fetch("/api/positions", { headers, cache: "no-store" }),
        fetch("/api/receipts", { headers, cache: "no-store" }),
      ]);
      if (!p.ok || !r.ok) throw new Error(`positions ${p.status} / receipts ${r.status}`);
      const positionData = await p.json();
      const receiptData = await r.json();
      setPosition(positionData.position ?? null);
      setAdapterMode(String(positionData.adapterMode ?? "fixture").toLowerCase());
      setReceipts(receiptData.receipts ?? []);
      setNowMs(Date.now());
    } catch {
      // background sync failure is non-fatal; the next action surfaces errors
    }
  }, []);

  // Restore a stored session on mount and validate it server-side.
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const raw = window.localStorage.getItem(SESSION_KEY);
      if (!raw) {
        await refresh();
        return;
      }
      let stored: StoredSession | null = null;
      try {
        stored = JSON.parse(raw) as StoredSession;
      } catch {
        window.localStorage.removeItem(SESSION_KEY);
        await refresh();
        return;
      }
      try {
        const res = await fetch("/api/positions", {
          headers: { [SESSION_HEADER]: stored.sessionToken },
          cache: "no-store",
        });
        if (cancelled) return;
        if (res.status === 401) {
          // Server restarted or session expired: drop it and show the connect panel.
          window.localStorage.removeItem(SESSION_KEY);
          await refresh();
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (!data.position) {
          window.localStorage.removeItem(SESSION_KEY);
          await refresh();
          return;
        }
        setSession(stored);
        setPosition(data.position);
        setAdapterMode(String(data.adapterMode ?? "fixture").toLowerCase());
        setNowMs(Date.now());
        const receiptsRes = await fetch("/api/receipts", { headers: { [SESSION_HEADER]: stored.sessionToken }, cache: "no-store" });
        if (receiptsRes.ok) {
          const receiptData = await receiptsRes.json();
          if (!cancelled) setReceipts(receiptData.receipts ?? []);
        }
      } catch {
        if (!cancelled) await refresh();
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const run = useCallback(
    async (path: string, body?: Record<string, unknown>) => {
      setBusy(true);
      setNotice(null);
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: authHeaders(),
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = (await response.json()) as ApiResult;
        if (response.status === 401 || response.status === 403) {
          setNotice({
            tone: "deny",
            text: data.detail ?? data.error ?? "Session rejected; please reconnect your vault",
          });
          if (response.status === 401) {
            window.localStorage.removeItem(SESSION_KEY);
            setSession(null);
          }
          return data;
        }
        if (data.position) setPosition(data.position);
        if (data.receipt) {
          setReceipts((current) =>
            data.idempotent || current.some((r) => r.id === data.receipt!.id)
              ? current
              : [data.receipt!, ...current],
          );
        }
        if (data.decision) {
          setNotice({
            tone: data.decision === "ALLOW" ? "allow" : "deny",
            text: `${data.decision}${data.idempotent ? " (idempotent replay)" : ""}: ${data.receipt?.reason ?? data.reason ?? ""}`,
          });
        } else if (data.error) {
          setNotice({ tone: "deny", text: data.detail ?? data.error });
        }
        return data;
      } catch {
        setNotice({ tone: "deny", text: "Request failed closed; no state transition applied" });
        return null;
      } finally {
        setBusy(false);
        setNowMs(Date.now());
      }
    },
    [authHeaders],
  );

  const connect = useCallback(
    async (ref: string) => {
      const vaultRef = ref.trim();
      if (!vaultRef) return;
      setConnecting(true);
      setConnectError(null);
      try {
        // Ephemeral browser keypair: the private key stays on this device.
        const keypair = generateSessionKeypair();
        const response = await fetch("/api/wallet/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vaultRef, sessionPublicKey: keypair.publicKey }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error((data as ApiResult).detail ?? (data as ApiResult).error ?? "Wallet connection failed");
        const stored: StoredSession = {
          vaultRef,
          positionId: String((data as { position?: CreditPosition }).position?.id ?? ""),
          sessionToken: String((data as { sessionToken?: string }).sessionToken ?? ""),
          privateKey: keypair.privateKey,
          publicKey: keypair.publicKey,
        };
        if (!stored.sessionToken) throw new Error("Server did not return a session token");
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(stored));
        setSession(stored);
        setNotice({
          tone: "allow",
          text: (data as { restored?: boolean }).restored
            ? `Session restored for vault · live locked collateral: ${(data as { lockedSats?: number }).lockedSats?.toLocaleString() ?? "n/a"} sats`
            : `Connected · live locked collateral: ${(data as { lockedSats?: number }).lockedSats?.toLocaleString() ?? "n/a"} sats`,
        });
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Wallet connection failed";
        setConnectError(message);
        setNotice({ tone: "deny", text: message });
      } finally {
        setConnecting(false);
      }
    },
    [refresh],
  );

  const disconnect = useCallback(async () => {
    try {
      await fetch("/api/wallet/disconnect", { method: "POST", headers: authHeaders() });
    } catch {
      // best effort revocation; local state is cleared regardless
    }
    window.localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setPosition(null);
    setReceipts([]);
    setNotice({ tone: "info", text: "Session disconnected; the position remains on record for this vault" });
    await refresh();
  }, [authHeaders, refresh]);

  const copyToClipboard = (text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const checkTachi = async () => {
    setTachiBusy(true);
    setTachiError(null);
    try {
      const response = await fetch("/api/tachi/diagnostics", { cache: "no-store" });
      const data = (await response.json()) as TachiReadOnlySnapshot & { error?: string; detail?: string };
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Tachi read failed");
      setTachiSnapshot(data);
    } catch (error) {
      setTachiSnapshot(null);
      setTachiError(error instanceof Error ? error.message : "Tachi read failed");
    } finally {
      setTachiBusy(false);
    }
  };

  const refreshLiveProof = useCallback(async () => {
    setRefreshingProof(true);
    try {
      await run("/api/proofs", { live: true });
      await refresh();
    } finally {
      setRefreshingProof(false);
    }
  }, [run, refresh]);

  /** Sign the canonical transition message with the session key and post the action. */
  const submitSigned = useCallback(
    async (path: string, action: "DRAW" | "REPAY" | "UNLOCK", actionAmount: number) => {
      if (!session || !position) {
        setNotice({ tone: "deny", text: "Connect your vault to authorize transitions" });
        return;
      }
      const nonce = position.nonce;
      const signature = signTransitionRequest(session.privateKey, {
        positionId: position.id,
        vaultRef: position.vaultRef,
        action,
        amount: actionAmount,
        nonce,
      });
      const txHex = customTxHex.trim();
      await run(path, {
        amount: actionAmount,
        nonce,
        signature,
        ...(txHex ? { txHex } : {}),
      });
    },
    [session, position, customTxHex, run],
  );

  const handleDraw = () => {
    if (!position) return;
    const drawAmount = Number(amount);
    if (!Number.isInteger(drawAmount) || drawAmount <= 0) {
      setNotice({ tone: "deny", text: "Draw amount must be a positive whole number of units" });
      return;
    }
    void submitSigned("/api/draw", "DRAW", drawAmount);
  };

  const handleRepay = () => {
    if (!position || !position.debtUnits) return;
    void submitSigned("/api/repay", "REPAY", position.debtUnits);
  };

  const handleUnlock = () => {
    if (!position) return;
    void submitSigned("/api/unlock", "UNLOCK", 0);
  };

  const proof = position?.latestProof;
  const isFresh = proof && nowMs > 0 ? new Date(proof.expiresAt).getTime() > nowMs : false;
  const proofStatus =
    proof && proof.verification === "VERIFIED" && isFresh && proof.healthBps >= (position?.minHealthBps ?? 12500)
      ? "HEALTHY"
      : "BLOCKED";
  const progress = useMemo(
    () => (position && position.creditLimitUnits > 0 ? Math.min(100, (position.debtUnits / position.creditLimitUnits) * 100) : 0),
    [position],
  );

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      {/* Ambient glows */}
      <div
        className="ambient-glow"
        style={{
          width: "600px",
          height: "600px",
          background: "rgba(232, 160, 78, 0.07)",
          top: "-200px",
          left: "-200px",
        }}
      />
      <div
        className="ambient-glow"
        style={{
          width: "500px",
          height: "500px",
          background: "rgba(95, 184, 120, 0.05)",
          top: "300px",
          right: "-150px",
        }}
      />

      {/* Topbar */}
      <header className="fixed top-0 left-0 right-0 z-50 nav-blur">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="relative w-7 h-7">
              <svg viewBox="0 0 28 28" className="w-7 h-7">
                <rect x="2" y="2" width="24" height="24" rx="6" fill="none" stroke="url(#logoGradVault)" strokeWidth="1.5" />
                <path d="M8 18 Q14 8 20 14 Q14 20 8 12" fill="none" stroke="#e8a04e" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M8 14 Q14 20 20 10" fill="none" stroke="#5fb878" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 2" />
                <defs>
                  <linearGradient id="logoGradVault" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#e8a04e" />
                    <stop offset="1" stopColor="#5fb878" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <span className="font-display text-lg font-medium tracking-tight">DrawBound</span>
            <span className="text-[10px] font-mono text-[var(--gold)] border border-[var(--border)] px-2 py-0.5 rounded ml-1">
              VAULT
            </span>
          </Link>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-mono text-[var(--text-muted)] border border-[var(--border)] px-3 py-1.5 rounded-lg bg-[var(--surface)]">
              <span className="pulse-dot" /> SIGNET · {isLive ? "LIVE" : "FIXTURE"}
            </span>
            <button
              onClick={refreshLiveProof}
              disabled={refreshingProof || busy || !session}
              className="btn-ghost px-3 py-1.5 rounded-lg text-xs font-mono"
            >
              {refreshingProof ? "Refreshing..." : "↻ Refresh Oracle"}
            </button>
            <Link href="/" className="btn-ghost px-3.5 py-1.5 rounded-lg text-xs font-mono">
              ← Back to Overview
            </Link>
          </div>
        </div>
      </header>

      {/* Main Terminal Shell */}
      <main className="pt-28 pb-20 px-6 lg:px-10 max-w-7xl mx-auto relative z-10">
        {/* Header Row */}
        <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 pb-6 border-b border-[var(--border-soft)]">
          <div>
            <div className="section-label mb-3">
              <span className="pulse-dot" />
              Live Self-Custodial Vault Terminal
            </div>
            <h1 className="headline text-[clamp(2.2rem,4vw,3.4rem)]">
              Taurus Credit <em>Terminal</em>
            </h1>
            <p className="text-sm text-[var(--text-muted)] font-light mt-2 max-w-xl">
              Lock native BTC in non-custodial Taurus Taproot vaults and authorize proof-causal SatVM credit transitions.
            </p>
          </div>
          {session && (
            <div className="mt-4 md:mt-0 text-right">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-dim)]">Session Identity</div>
              <div className="text-xs font-mono text-[var(--gold)] mt-0.5">
                {session.vaultRef.slice(0, 14)}…{session.vaultRef.slice(-8)}
              </div>
              <div className="text-[10px] font-mono text-[var(--text-dim)] mt-0.5">
                Schnorr session · key held on device
              </div>
            </div>
          )}
        </div>

        {/* Notices */}
        {notice && (
          <div
            className={`p-4 rounded-xl mb-8 flex items-center gap-3 text-sm font-mono border ${
              notice.tone === "allow"
                ? "bg-[rgba(95,184,120,0.1)] border-[var(--proof)] text-[var(--proof-soft)]"
                : notice.tone === "deny"
                  ? "bg-[rgba(226,109,105,0.1)] border-[var(--danger)] text-[var(--danger-soft)]"
                  : "bg-[var(--surface)] border-[var(--border)] text-[var(--text)]"
            }`}
          >
            <span>{notice.tone === "allow" ? "✓" : notice.tone === "deny" ? "✕" : "ℹ"}</span>
            <strong>{notice.text}</strong>
          </div>
        )}

        {/* 2-Column Grid */}
        <div className="grid lg:grid-cols-12 gap-6">
          {/* Column 1: Vault & Collateral Position */}
          <div className="lg:col-span-5 space-y-6">
            {/* Vault Connection Card */}
            <div className="card p-7">
              <div className="flex items-center justify-between mb-5">
                <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-dim)]">
                  TAURUS VAULT / WALLET
                </div>
                <span className={`status-tag ${session ? "online" : "idle"}`}>
                  {session ? "● CONNECTED" : "READY"}
                </span>
              </div>

              {session ? (
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between items-center text-xs text-[var(--text-muted)] mb-2 font-mono">
                      <span>Connected Taurus Vault</span>
                      <button
                        onClick={() => copyToClipboard(session.vaultRef, "vault")}
                        className="text-[var(--gold)] hover:text-[var(--gold-soft)] text-xs font-mono transition-colors"
                      >
                        {copiedKey === "vault" ? "Copied ✓" : "Copy Address"}
                      </button>
                    </div>
                    <code className="text-xs font-mono text-[var(--gold)] break-all block bg-[#090807] p-3.5 rounded-lg border border-[var(--border)] leading-relaxed">
                      {session.vaultRef}
                    </code>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--text-muted)] mb-2 font-mono">Session public key</div>
                    <code className="text-[10px] font-mono text-[var(--text-dim)] break-all block bg-[#090807] p-3 rounded-lg border border-[var(--border-soft)]">
                      {session.publicKey}
                    </code>
                  </div>
                  <button onClick={disconnect} className="btn-ghost w-full py-2.5 rounded-lg text-xs font-mono">
                    Disconnect Session
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <label className="block text-xs font-mono text-[var(--text-muted)]">
                      Taurus Vault Reference (P2TR)
                    </label>
                    <button
                      onClick={() => setVaultInput(DEMO_VAULT)}
                      className="text-[var(--gold)] hover:text-[var(--gold-soft)] text-xs font-mono border border-[var(--border)] px-2 py-0.5 rounded bg-[var(--surface-2)] transition-colors"
                    >
                      Use Demo Vault
                    </button>
                  </div>
                  <input
                    className="vault-input"
                    value={vaultInput}
                    onChange={(e) => setVaultInput(e.target.value)}
                    placeholder={DEMO_VAULT}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && vaultInput.trim()) void connect(vaultInput);
                    }}
                  />
                  <button
                    onClick={() => void connect(vaultInput)}
                    disabled={connecting || !vaultInput.trim()}
                    className="btn-primary w-full py-3 rounded-lg text-xs font-mono"
                  >
                    {connecting ? "Reading On-Chain VTXOs..." : "Connect Vault →"}
                  </button>
                  {connectError && <p className="text-xs font-mono text-[var(--danger)]">{connectError}</p>}
                  <p className="text-[10px] font-mono text-[var(--text-dim)] leading-relaxed">
                    Connecting generates an ephemeral Schnorr keypair on this device. Every transition you authorize is
                    signed with it; the private key never leaves your browser.
                  </p>
                </div>
              )}
            </div>

            {/* Collateral Metrics Card */}
            <div className="card p-7">
              <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-dim)] mb-5">
                Collateral & Debt Position
              </div>
              <div className="grid grid-cols-2 gap-4 mb-5">
                <div className="p-4 bg-[#090807] rounded-xl border border-[var(--border-soft)]">
                  <div className="text-xs font-mono text-[var(--text-dim)]">Locked Collateral</div>
                  <div className="font-display text-2xl font-light text-[var(--gold)] mt-1.5">
                    {position?.collateralSats.toLocaleString() ?? "0"}{" "}
                    <span className="text-xs font-mono text-[var(--text-muted)]">sats</span>
                  </div>
                </div>
                <div className="p-4 bg-[#090807] rounded-xl border border-[var(--border-soft)]">
                  <div className="text-xs font-mono text-[var(--text-dim)]">Debt Drawn</div>
                  <div className="font-display text-2xl font-light text-[var(--proof)] mt-1.5">
                    {position?.debtUnits ?? 0}{" "}
                    <span className="text-xs font-mono text-[var(--text-muted)]">units</span>
                  </div>
                </div>
              </div>
              <div className="mb-5">
                <div className="flex justify-between text-xs font-mono text-[var(--text-muted)] mb-2">
                  <span>Credit Utilization</span>
                  <span className="text-[var(--text)] font-medium">{progress.toFixed(0)}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
              </div>
              <div className="flex justify-between items-center text-xs font-mono text-[var(--text-muted)] border-t border-[var(--border-soft)] pt-4">
                <span>
                  Credit Cap: <strong className="text-[var(--text)]">{position?.creditLimitUnits ?? 0} units</strong>
                </span>
                <span>
                  Exit Status: <strong className="text-[var(--gold)]">{position?.exitStatus ?? "LOCKED"}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Column 2: Covenant Gate & Action Terminal */}
          <div className="lg:col-span-7 space-y-6">
            {/* Draw / Repay / Unlock Gate */}
            <div className="card p-7">
              <div className="flex items-center justify-between mb-5">
                <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-dim)]">
                  Covenant Credit Gate
                </div>
                <span className={`status-tag ${proofStatus === "HEALTHY" ? "healthy" : "blocked"}`}>
                  {proofStatus === "HEALTHY" ? "✓ COVENANT SATISFIED" : "✕ COVENANT FROZEN"}
                </span>
              </div>

              <div className="grid md:grid-cols-2 gap-5 mb-6">
                <div>
                  <label className="block text-xs font-mono text-[var(--text-muted)] mb-2">
                    Draw Amount (Credit Units)
                  </label>
                  <div className="amount-input">
                    <input
                      inputMode="numeric"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
                    />
                    <span>UNITS</span>
                  </div>
                  <div className="flex gap-2 mt-2.5">
                    {[50, 100, 250].map((val) => (
                      <button
                        key={val}
                        onClick={() => setAmount(String(val))}
                        className="btn-ghost px-3 py-1 rounded-md text-xs font-mono"
                      >
                        {val}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 bg-[#090807] p-4 rounded-xl border border-[var(--border-soft)] flex flex-col justify-center">
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="text-[var(--text-muted)]">Attested Health:</span>
                    <strong className="text-[var(--proof)]">{formatHealth(proof?.healthBps)}</strong>
                  </div>
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="text-[var(--text-muted)]">Required Min:</span>
                    <strong className="text-[var(--text)]">{formatHealth(position?.minHealthBps)}</strong>
                  </div>
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="text-[var(--text-muted)]">Proof Expires:</span>
                    <strong className={!isFresh ? "text-[var(--danger)]" : "text-[var(--text-dim)]"}>
                      {formatDate(proof?.expiresAt)}
                    </strong>
                  </div>
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="text-[var(--text-muted)]">Proof Source:</span>
                    <strong className="text-[var(--text-dim)]">{proof?.source ?? "—"}</strong>
                  </div>
                </div>
              </div>

              {/* Advanced: operator-signed transaction for LIVE mode */}
              <div className="mb-5 p-4 bg-[#090807] rounded-xl border border-[var(--border-soft)]">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-mono text-[var(--text-muted)]">
                    Advanced · Taurus-signed txHex {isLive && <strong className="text-[var(--danger)]">(required in LIVE mode)</strong>}
                  </span>
                </div>
                <textarea
                  className="vault-input min-h-[64px] resize-y"
                  value={customTxHex}
                  onChange={(e) => setCustomTxHex(e.target.value.replace(/[^0-9a-fA-F]/g, ""))}
                  placeholder={
                    isLive
                      ? "Paste the real signed transaction hex built with the Taurus wallet-aggregator"
                      : "Optional in fixture mode — the fixture adapter does not broadcast"
                  }
                  spellCheck={false}
                />
              </div>

              <div className="space-y-3">
                <button
                  onClick={handleDraw}
                  disabled={busy || !session || !position || !amount || Number(amount) <= 0}
                  className="btn-primary w-full py-3.5 rounded-lg text-xs font-mono text-center font-semibold"
                >
                  {busy ? "Authorizing..." : "Authorize Draw →"}
                </button>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={handleRepay}
                    disabled={busy || !session || !position?.debtUnits}
                    className="btn-ghost py-2.5 rounded-lg text-xs font-mono text-center"
                  >
                    Repay All
                  </button>
                  <button
                    onClick={handleUnlock}
                    disabled={busy || !session || position?.debtUnits !== 0 || position?.state === "EXITED"}
                    className="btn-ghost py-2.5 rounded-lg text-xs font-mono text-center"
                  >
                    Request Unlock
                  </button>
                </div>
                {!session && (
                  <p className="text-[10px] font-mono text-[var(--text-dim)] text-center">
                    Connect a vault to enable signed transitions.
                  </p>
                )}
              </div>
            </div>

            {/* Decision Audit Timeline */}
            <div className="card p-7">
              <div className="flex items-center justify-between mb-4">
                <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-dim)]">
                  Independent Decision Receipts
                </div>
                <span className="font-mono text-xs text-[var(--text-muted)]">{receipts.length} events</span>
              </div>

              {receipts.length === 0 ? (
                <div className="p-8 text-center text-xs font-mono text-[var(--text-dim)] border border-dashed border-[var(--border)] rounded-xl">
                  No credit transitions yet. The next draw will leave an immutable cryptographic receipt here.
                </div>
              ) : (
                <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
                  {receipts.slice(0, 8).map((r) => (
                    <div
                      key={r.id}
                      className="p-3.5 bg-[#090807] rounded-lg border border-[var(--border-soft)] text-xs font-mono flex items-center justify-between"
                    >
                      <div>
                        <span className="font-bold text-[var(--gold)] mr-2">{r.action}</span>
                        <span className={r.result === "ALLOW" ? "text-[var(--proof)]" : "text-[var(--danger)]"}>
                          [{r.result}]
                        </span>
                        <span className="text-[var(--text-dim)] ml-2">{r.reason}</span>
                      </div>
                      <time className="text-[var(--text-dim)] text-[10px]">{formatDate(r.createdAt)}</time>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Network Diagnostics Bar */}
        <div className="mt-8 p-6 card flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="pulse-dot" />
            <div className="font-mono text-xs">
              <span className="text-[var(--text-muted)]">Tachi Node Diagnostics: </span>
              <strong className="text-[var(--text)]">
                {tachiSnapshot
                  ? `${tachiSnapshot.node.chainId} · ${tachiSnapshot.health.advertisedValidators} validators · Quorum ${tachiSnapshot.quorum.threshold}/${tachiSnapshot.quorum.validatorCount}`
                  : "Signet RPC active (https://rpc-signet.tachibtc.com)"}
              </strong>
              {tachiError && <span className="text-[var(--danger)] ml-2">{tachiError}</span>}
            </div>
          </div>
          <button onClick={checkTachi} disabled={tachiBusy} className="btn-ghost px-4 py-2 rounded-lg text-xs font-mono">
            {tachiBusy ? "Checking Node..." : "Inspect Live Network"}
          </button>
        </div>
      </main>
    </div>
  );
}
