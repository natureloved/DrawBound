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
  const [ownershipChallenge, setOwnershipChallenge] = useState<{ challenge: string; nonce: string; expiresAt: string } | null>(null);
  const [ownershipAddress, setOwnershipAddress] = useState("");
  const [ownershipSignature, setOwnershipSignature] = useState("");
  const [ownershipVerified, setOwnershipVerified] = useState(false);
  const [customTxHex, setCustomTxHex] = useState("");
  const [refreshingProof, setRefreshingProof] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showOwnershipProof, setShowOwnershipProof] = useState(false);
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
    async (ref: string, ownership?: { nonce: string; ownershipAddress: string; ownershipSignature: string }) => {
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
          body: JSON.stringify({ vaultRef, sessionPublicKey: keypair.publicKey, ...(ownership ?? {}) }),
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
        setOwnershipVerified(Boolean((data as { ownershipVerified?: boolean }).ownershipVerified));
        setOwnershipChallenge(null);
        setOwnershipSignature("");
        setNotice({
          tone: "allow",
          text: (data as { restored?: boolean }).restored
            ? `Session restored for vault · ownership: ${(data as { ownershipVerified?: boolean }).ownershipVerified ? "VERIFIED" : "unproven"}`
            : `Connected · ownership: ${(data as { ownershipVerified?: boolean }).ownershipVerified ? "VERIFIED (BIP-322)" : "unproven"} · locked: ${(data as { lockedSats?: number }).lockedSats?.toLocaleString() ?? "n/a"} sats`,
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

  const requestOwnershipChallenge = useCallback(async () => {
    const vaultRef = vaultInput.trim();
    if (!vaultRef) return;
    try {
      const response = await fetch("/api/wallet/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vaultRef }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Challenge request failed");
      setOwnershipChallenge(data);
      setNotice({ tone: "info", text: "Challenge issued — sign it with the vault user key, then connect" });
    } catch (error) {
      setNotice({ tone: "deny", text: error instanceof Error ? error.message : "Challenge request failed" });
    }
  }, [vaultInput]);

  const disconnect = useCallback(async () => {
    try {
      await fetch("/api/wallet/disconnect", { method: "POST", headers: authHeaders() });
    } catch {
      // best effort revocation; local state is cleared regardless
    }
    window.localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setOwnershipVerified(false);
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
          width: "750px",
          height: "750px",
          background: "radial-gradient(circle, rgba(232, 160, 78, 0.22) 0%, rgba(244, 201, 138, 0.08) 40%, transparent 70%)",
          top: "-250px",
          left: "-200px",
        }}
      />
      <div
        className="ambient-glow"
        style={{
          width: "650px",
          height: "650px",
          background: "radial-gradient(circle, rgba(95, 184, 120, 0.18) 0%, rgba(107, 158, 255, 0.07) 45%, transparent 70%)",
          top: "300px",
          right: "-180px",
        }}
      />

      {/* Topbar */}
      <header className="fixed top-0 left-0 right-0 z-50 nav-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-10 h-16 flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2.5 sm:gap-3 group shrink-0">
            <div className="vault-logo-glow w-7 h-7 sm:w-8 sm:h-8 shrink-0">
              <svg viewBox="0 0 28 28" className="w-7 h-7 sm:w-8 sm:h-8">
                <rect x="2" y="2" width="24" height="24" rx="7" fill="rgba(16,14,12,0.8)" stroke="url(#logoGradVault)" strokeWidth="1.5" />
                <path d="M8 18 Q14 8 20 14 Q14 20 8 12" fill="none" stroke="#e8a04e" strokeWidth="1.75" strokeLinecap="round" />
                <path d="M8 14 Q14 20 20 10" fill="none" stroke="#5fb878" strokeWidth="1.75" strokeLinecap="round" strokeDasharray="2 2" />
                <defs>
                  <linearGradient id="logoGradVault" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#e8a04e" />
                    <stop offset="1" stopColor="#5fb878" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-display text-lg sm:text-xl font-medium tracking-tight text-white group-hover:text-gold transition-colors">
                DrawBound
              </span>
              <span className="vault-badge text-3xs px-1.5 py-0.5 sm:px-2">
                <span className="hidden sm:inline">VAULT TERMINAL</span>
                <span className="sm:hidden">VAULT</span>
              </span>
            </div>
          </Link>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="hidden md:inline-flex items-center gap-2 text-xs font-mono text-muted border border-soft px-3 py-1.5 rounded-lg bg-surface">
              <span className="pulse-dot" />
              <span>SIGNET · <strong className={isLive ? "text-proof" : "text-gold"}>{isLive ? "LIVE" : "FIXTURE"}</strong></span>
            </div>
            <button
              onClick={refreshLiveProof}
              disabled={refreshingProof || busy || !session}
              className="btn-ghost px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-mono whitespace-nowrap"
              title="Query Tachi signet or external HAT oracle for fresh loan-health attestation"
            >
              <span className="hidden sm:inline">{refreshingProof ? "Refreshing..." : "↻ Refresh Oracle"}</span>
              <span className="sm:hidden">{refreshingProof ? "…" : "↻ Oracle"}</span>
            </button>
            <Link href="/" className="btn-ghost px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-mono whitespace-nowrap">
              ← Overview
            </Link>
          </div>
        </div>
      </header>

      {/* Main Terminal Shell */}
      <main className="pt-24 sm:pt-28 pb-16 sm:pb-20 px-4 sm:px-6 lg:px-10 max-w-7xl mx-auto relative z-10">
        {/* Header / Hero Row */}
        <div className="flex flex-col md:flex-row md:items-end justify-between mb-6 sm:mb-8 pb-5 sm:pb-6 border-b border-soft gap-5 sm:gap-6">
          <div>
            <div className="section-label mb-2 sm:mb-3">
              <span className="pulse-dot" />
              Tachi SatVM // Non-Custodial BTC Credit Suite
            </div>
            <h1 className="headline text-2xl sm:text-4xl lg:text-5xl font-light mb-2.5 sm:mb-3">
              Taurus Credit <em>Terminal</em>
            </h1>
            <p className="text-xs sm:text-base text-muted font-light max-w-2xl leading-relaxed">
              Lock native Bitcoin in non-custodial Taurus Taproot vaults and authorize real-time proof-bounded SatVM credit transitions.
            </p>
          </div>

          {/* Session Indicator Card */}
          <div className="card p-4 w-full md:w-auto md:min-w-[280px] md:text-right shrink-0 bg-surface border border-soft">
            <div className="flex items-center md:justify-end gap-2 mb-1.5">
              <span className={`status-tag ${session ? "online" : "idle"}`}>
                {session ? "● SESSION ACTIVE" : "○ SESSION IDLE"}
              </span>
            </div>
            {session ? (
              <div>
                <div className="flex items-center md:justify-end gap-2">
                  <span className="text-xs font-mono text-gold font-semibold break-all">
                    {session.vaultRef.slice(0, 12)}…{session.vaultRef.slice(-8)}
                  </span>
                  <button
                    onClick={() => copyToClipboard(session.vaultRef, "vault-header")}
                    className="text-xs font-mono text-muted hover:text-gold transition-colors p-1"
                    title="Copy connected vault address"
                  >
                    {copiedKey === "vault-header" ? "✓" : "⎘"}
                  </button>
                </div>
                <div className="text-3xs font-mono text-dim mt-1">
                  BIP-340 Schnorr session · Ephemeral tab key
                </div>
              </div>
            ) : (
              <div>
                <div className="text-xs font-mono text-muted font-medium">
                  Wallet Disconnected
                </div>
                <div className="text-3xs font-mono text-dim mt-1">
                  Connect below to open self-custodial session
                </div>
              </div>
            )}
          </div>
        </div>

        {/* The Protocol Banner */}
        <div className="vault-banner mb-6 sm:mb-8">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 sm:gap-5">
            <div className="flex items-start gap-3 sm:gap-4">
              <div
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
                style={{
                  background: isLive ? "rgba(95, 184, 120, 0.15)" : "rgba(232, 160, 78, 0.15)",
                  border: `1px solid ${isLive ? "rgba(95, 184, 120, 0.35)" : "rgba(232, 160, 78, 0.35)"}`,
                }}
              >
                {isLive ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5fb878" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8a04e" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="6" x2="12" y2="12" />
                    <line x1="12" y1="12" x2="16" y2="14" />
                  </svg>
                )}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <span className="font-mono text-xs font-bold uppercase tracking-wider" style={{ color: isLive ? "var(--proof)" : "var(--gold)" }}>
                    {isLive ? "Live Tachi Signet Protocol Active" : "Fixture Rehearsal Simulation Active"}
                  </span>
                  <span className="banner-chip text-3xs py-0.5 px-2">
                    {isLive ? "ON-CHAIN BROADCASTS" : "DETERMINISTIC SANDBOX"}
                  </span>
                </div>
                <p className="text-xs text-muted font-light leading-relaxed max-w-3xl">
                  {isLive
                    ? "Operating directly against Tachi Bitcoin Signet RPC at rpc-signet.tachibtc.com. Live credit transitions require a valid Taurus-signed txHex and verified loan-health attestations before broadcast."
                    : "Zero testnet coins required. Client-side BIP-340 Schnorr signatures are verified against real covenant invariants. Exceeding your borrowing limit triggers real covenant freeze & deny receipts."}
                </p>
              </div>
            </div>

            {/* Banner Stat Chips */}
            <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 shrink-0 pt-3 lg:pt-0 border-t border-[rgba(255,255,255,0.06)] lg:border-t-0">
              <span className="banner-chip proof justify-center sm:justify-start">
                <span>Covenant:</span> <strong>≥125% Health</strong>
              </span>
              <span className="banner-chip accent justify-center sm:justify-start">
                <span>Ratio:</span> <strong>10 Sats/Unit</strong>
              </span>
              <span className="banner-chip justify-center sm:justify-start">
                <span>Auth:</span> <strong>BIP-340 Schnorr</strong>
              </span>
              <span className="banner-chip justify-center sm:justify-start">
                <span>Replay:</span> <strong>Nonces Enforced</strong>
              </span>
            </div>
          </div>
        </div>

        {/* Notices */}
        {notice && (
          <div
            className={`p-4 rounded-xl mb-8 flex items-center gap-3 text-sm font-mono border ${
              notice.tone === "allow"
                ? "bg-[rgba(95,184,120,0.1)] border-[var(--proof)] text-proof-soft"
                : notice.tone === "deny"
                  ? "bg-[rgba(226,109,105,0.1)] border-[var(--danger)] text-danger-soft"
                  : "bg-surface border-default text-white"
            }`}
          >
            <span className="text-lg">{notice.tone === "allow" ? "✓" : notice.tone === "deny" ? "✕" : "ℹ"}</span>
            <strong className="leading-relaxed">{notice.text}</strong>
          </div>
        )}

        {/* 2-Column Grid with balanced layout */}
        <div className="grid lg:grid-cols-12 gap-8 items-start">
          {/* Column 1: Vault & Collateral Position (5 cols) */}
          <div className="lg:col-span-5 space-y-6">
            {/* Vault Connection Card */}
            <div className="card p-7">
              <div className="flex items-center justify-between mb-5">
                <div className="text-xs font-mono uppercase tracking-widest text-dim">
                  TAURUS VAULT / WALLET
                </div>
                <span className={`status-tag ${session ? "online" : "idle"}`}>
                  {session ? "● CONNECTED" : "READY"}
                </span>
              </div>

              {session ? (
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between items-center text-xs text-muted mb-2 font-mono">
                      <span>Connected Taurus Vault</span>
                      <button
                        onClick={() => copyToClipboard(session.vaultRef, "vault")}
                        className="text-gold hover:text-gold-soft text-xs font-mono transition-colors"
                      >
                        {copiedKey === "vault" ? "Copied ✓" : "Copy Address"}
                      </button>
                    </div>
                    <code className="text-xs font-mono text-gold break-all block bg-well p-3.5 rounded-lg border border-soft leading-relaxed">
                      {session.vaultRef}
                    </code>
                  </div>
                  <div>
                    <div className="text-xs text-muted mb-2 font-mono">Session Public Key (Schnorr)</div>
                    <code className="text-3xs font-mono text-dim break-all block bg-well p-3 rounded-lg border border-soft">
                      {session.publicKey}
                    </code>
                  </div>
                  <div className="flex items-center justify-between text-xs font-mono p-3 bg-well rounded-lg border border-soft">
                    <span className="text-muted">Vault Ownership (BIP-322)</span>
                    <strong className={ownershipVerified ? "text-proof" : "text-dim"}>
                      {ownershipVerified ? "✓ VERIFIED ON-CHAIN" : "UNPROVEN (FIXTURE)"}
                    </strong>
                  </div>
                  <button onClick={disconnect} className="btn-ghost w-full py-2.5 rounded-lg text-xs font-mono">
                    Disconnect Session
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <label className="block text-xs font-mono text-muted">
                      Taurus Vault Reference (P2TR)
                    </label>
                    <button
                      onClick={() => setVaultInput(DEMO_VAULT)}
                      className="text-gold hover:text-gold-soft text-xs font-mono border border-default px-2.5 py-1 rounded bg-surface-2 transition-colors"
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
                    onClick={() => {
                      const nonce = ownershipChallenge?.nonce ?? "";
                      const addr = ownershipAddress.trim();
                      const sig = ownershipSignature.trim();
                      void connect(vaultInput, nonce && addr && sig ? { nonce, ownershipAddress: addr, ownershipSignature: sig } : undefined);
                    }}
                    disabled={connecting || !vaultInput.trim()}
                    className="btn-primary w-full py-3.5 rounded-lg text-xs font-mono"
                  >
                    {connecting ? "Reading On-Chain VTXOs..." : "Connect Vault →"}
                  </button>
                  {connectError && <p className="text-xs font-mono text-danger">{connectError}</p>}
                  <p className="text-3xs font-mono text-dim leading-relaxed">
                    Connecting generates an ephemeral Schnorr keypair on this device. Every transition you authorize is
                    signed with it; the private key never leaves your browser.
                  </p>

                  {/* Optional BIP-322 ownership proof accordion */}
                  <div className="pt-4 border-t border-soft">
                    <button
                      type="button"
                      onClick={() => setShowOwnershipProof(!showOwnershipProof)}
                      className="flex items-center justify-between w-full text-xs font-mono text-muted hover:text-gold transition-colors py-1"
                    >
                      <span>BIP-322 Ownership Proof <span className="text-dim">· optional</span></span>
                      <span className="text-xs">{showOwnershipProof ? "▲ Hide" : "▼ Expand"}</span>
                    </button>

                    {showOwnershipProof && (
                      <div className="space-y-3 mt-3 pt-3 border-t border-soft">
                        <div className="flex justify-between items-center">
                          <span className="text-xs font-mono text-dim">Challenge Nonce:</span>
                          <button
                            onClick={() => void requestOwnershipChallenge()}
                            disabled={!vaultInput.trim()}
                            className="text-gold hover:text-gold-soft text-xs font-mono border border-default px-2.5 py-1 rounded bg-surface-2 transition-colors"
                          >
                            Request Challenge
                          </button>
                        </div>
                        {ownershipChallenge && (
                          <div>
                            <div className="flex justify-between items-center text-3xs font-mono text-dim mb-1">
                              <span>Sign this message with the vault user key:</span>
                              <button
                                onClick={() => copyToClipboard(ownershipChallenge.challenge, "challenge")}
                                className="text-gold hover:text-gold-soft"
                              >
                                {copiedKey === "challenge" ? "Copied ✓" : "Copy"}
                              </button>
                            </div>
                            <code className="text-3xs font-mono text-white break-all block bg-well p-3 rounded-lg border border-soft">
                              {ownershipChallenge.challenge}
                            </code>
                          </div>
                        )}
                        <input
                          className="vault-input"
                          value={ownershipAddress}
                          onChange={(e) => setOwnershipAddress(e.target.value)}
                          placeholder="Ownership address (key-path P2TR of the vault user key)"
                          spellCheck={false}
                        />
                        <textarea
                          className="vault-input min-h-[56px] resize-y"
                          value={ownershipSignature}
                          onChange={(e) => setOwnershipSignature(e.target.value)}
                          placeholder="BIP-322 signature (base64) — see scripts/operator-live.mts ownership"
                          spellCheck={false}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Collateral Metrics Card */}
            <div className="card p-7">
              <div className="text-xs font-mono uppercase tracking-widest text-dim mb-5">
                Collateral & Debt Position
              </div>
              <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-5">
                <div className="metric-tile p-3 sm:p-4">
                  <div className="text-xs font-mono text-dim">Locked Collateral</div>
                  <div className="font-display text-lg sm:text-2xl font-light text-gold mt-1 sm:mt-1.5 truncate">
                    {position?.collateralSats.toLocaleString() ?? "0"}{" "}
                    <span className="text-3xs sm:text-xs font-mono text-muted">sats</span>
                  </div>
                </div>
                <div className="metric-tile p-3 sm:p-4">
                  <div className="text-xs font-mono text-dim">Debt Drawn</div>
                  <div className="font-display text-lg sm:text-2xl font-light text-proof mt-1 sm:mt-1.5 truncate">
                    {position?.debtUnits ?? 0}{" "}
                    <span className="text-3xs sm:text-xs font-mono text-muted">units</span>
                  </div>
                </div>
              </div>
              <div className="mb-5">
                <div className="flex justify-between text-xs font-mono text-muted mb-2">
                  <span>Credit Utilization</span>
                  <span className="text-white font-medium">{progress.toFixed(0)}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
              </div>
              <div className="flex justify-between items-center text-xs font-mono text-muted border-t border-soft pt-4">
                <span>
                  Credit Cap: <strong className="text-white">{position?.creditLimitUnits ?? 0} units</strong>
                </span>
                <span>
                  Exit Status: <strong className="text-gold">{position?.exitStatus ?? "LOCKED"}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Column 2: Covenant Gate & Action Terminal (7 cols) */}
          <div className="lg:col-span-7 space-y-6">
            {/* Draw / Repay / Unlock Gate */}
            <div className="card p-7">
              <div className="flex items-center justify-between mb-5">
                <div className="text-xs font-mono uppercase tracking-widest text-dim">
                  Covenant Credit Gate
                </div>
                <span className={`status-tag ${proofStatus === "HEALTHY" ? "healthy" : "blocked"}`}>
                  {proofStatus === "HEALTHY" ? "✓ COVENANT SATISFIED" : "✕ COVENANT FROZEN"}
                </span>
              </div>

              <div className="grid md:grid-cols-2 gap-5 mb-6">
                <div>
                  <label className="block text-xs font-mono text-muted mb-2">
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
                  <div className="grid grid-cols-4 sm:flex gap-2 mt-2.5">
                    {[50, 100, 250].map((val) => (
                      <button
                        key={val}
                        onClick={() => setAmount(String(val))}
                        className="btn-ghost py-2 sm:px-3 sm:py-1 rounded-md text-xs font-mono text-center"
                      >
                        {val}
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        if (position) {
                          const maxAvailable = Math.max(0, position.creditLimitUnits - position.debtUnits);
                          setAmount(String(maxAvailable));
                        }
                      }}
                      className="btn-ghost py-2 sm:px-3 sm:py-1 rounded-md text-xs font-mono text-gold text-center"
                      title="Set to max available credit before exceeding cap"
                    >
                      Max
                    </button>
                  </div>
                </div>

                <div className="space-y-3 bg-well p-4 rounded-xl border border-soft flex flex-col justify-center">
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="text-muted">Attested Health:</span>
                    <strong className="text-proof">{formatHealth(proof?.healthBps)}</strong>
                  </div>
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="text-muted">Required Min:</span>
                    <strong className="text-white">{formatHealth(position?.minHealthBps)}</strong>
                  </div>
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="text-muted">Proof Status:</span>
                    <strong className={!isFresh ? "text-danger" : "text-proof"}>
                      {isFresh ? "● FRESH" : "✕ EXPIRED"} ({formatDate(proof?.expiresAt)})
                    </strong>
                  </div>
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="text-muted">Proof Source:</span>
                    <strong className="text-dim uppercase">{proof?.source ?? "—"}</strong>
                  </div>
                </div>
              </div>

              {/* Advanced: operator-signed transaction for LIVE mode */}
              <div className="mb-5 p-4 bg-well rounded-xl border border-soft">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-mono text-muted">
                    Advanced · Taurus-signed txHex {isLive && <strong className="text-danger">(required in LIVE mode)</strong>}
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
                  {busy ? "Authorizing Transition..." : "Authorize Draw →"}
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
                  <p className="text-3xs font-mono text-dim text-center">
                    Connect a vault above to enable signed transitions.
                  </p>
                )}
              </div>
            </div>

            {/* Decision Audit Timeline */}
            <div className="card p-7">
              <div className="flex items-center justify-between mb-4">
                <div className="text-xs font-mono uppercase tracking-widest text-dim">
                  Independent Decision Receipts
                </div>
                <span className="font-mono text-xs text-muted">{receipts.length} events</span>
              </div>

              {receipts.length === 0 ? (
                <div className="p-8 text-center text-xs font-mono text-dim border border-dashed border-default rounded-xl">
                  No credit transitions yet. The next draw will record an immutable cryptographic receipt here.
                </div>
              ) : (
                <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                  {receipts.slice(0, 8).map((r, index) => (
                    <div
                      key={`${r.id}-${r.createdAt ?? index}`}
                      className="audit-receipt-item flex-col sm:flex-row items-start sm:items-center justify-between gap-1.5 sm:gap-3"
                    >
                      <div>
                        <span className="font-bold text-gold mr-2">{r.action}</span>
                        <span className={r.result === "ALLOW" ? "text-proof font-bold" : "text-danger font-bold"}>
                          [{r.result}]
                        </span>
                        <span className="text-dim ml-2">{r.reason}</span>
                      </div>
                      <time className="text-dim text-3xs shrink-0 self-end sm:self-auto">{formatDate(r.createdAt)}</time>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Network Diagnostics Bar */}
        <div className="mt-8 p-4 sm:p-6 card flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="pulse-dot shrink-0" />
            <div className="font-mono text-xs">
              <span className="text-muted">Tachi Node Diagnostics: </span>
              <strong className="text-white block sm:inline mt-1 sm:mt-0">
                {tachiSnapshot
                  ? `${tachiSnapshot.node.chainId} · ${tachiSnapshot.health.advertisedValidators} validators · Quorum ${tachiSnapshot.quorum.threshold}/${tachiSnapshot.quorum.validatorCount}`
                  : "Signet RPC active (https://rpc-signet.tachibtc.com)"}
              </strong>
              {tachiError && <span className="text-danger ml-2">{tachiError}</span>}
            </div>
          </div>
          <button onClick={checkTachi} disabled={tachiBusy} className="btn-ghost w-full md:w-auto px-4 py-2.5 rounded-lg text-xs font-mono text-center">
            {tachiBusy ? "Checking Node..." : "Inspect Live Network"}
          </button>
        </div>
      </main>
    </div>
  );
}
