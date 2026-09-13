"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const utilValRef = useRef<HTMLDivElement | null>(null);
  const headroomValRef = useRef<HTMLDivElement | null>(null);
  const utilBarRef = useRef<HTMLDivElement | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // --- Scroll Tracking & Progress Bar (Direct DOM update: 0 re-renders, 0 hydration mismatch) ---
  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? Math.min(1, Math.max(0, currentScrollY / docHeight)) : 0;
      if (progressBarRef.current) {
        progressBarRef.current.style.transform = `scaleX(${progress})`;
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // --- Scroll Reveal with IntersectionObserver ---
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" },
    );

    document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // --- Hero Canvas Visualization (High-performance 60fps loop via Direct DOM refs) ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let w = 0;
    let h = 0;
    let t = 0;
    let dpr = 1;

    const particles: Array<{ x: number; speed: number; size: number; opacity: number }> = [];
    for (let i = 0; i < 50; i++) {
      particles.push({
        x: Math.random(),
        speed: 0.0006 + Math.random() * 0.0014,
        size: 0.8 + Math.random() * 1.8,
        opacity: 0.25 + Math.random() * 0.55,
      });
    }

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, w * dpr);
      canvas.height = Math.max(1, h * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };

    const proofY = (x: number, time: number) => {
      const cx = x;
      return (
        h * 0.32 +
        Math.sin(cx * 5 + time) * 22 +
        Math.sin(cx * 11 - time * 0.7) * 10 +
        Math.sin(cx * 3 + time * 0.4) * 7
      );
    };

    const creditY = (x: number, time: number) => {
      const py = proofY(x, time);
      const utilization = 0.42 + Math.sin(x * 4 - time * 0.8) * 0.18 + Math.sin(x * 8 + time * 0.5) * 0.08;
      const gap = 35 + utilization * 90;
      return py + gap;
    };

    const draw = () => {
      if (w < 2 || h < 2) {
        resize();
        animId = requestAnimationFrame(draw);
        return;
      }
      t += 0.008;
      ctx.clearRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = "rgba(245, 241, 234, 0.025)";
      ctx.lineWidth = 1;
      const gridSize = 32;
      for (let x = 0; x <= w; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
        ctx.stroke();
      }

      // Fill headroom zone
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const x = i / 120;
        const px = x * w;
        const py = proofY(x, t);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      for (let i = 120; i >= 0; i--) {
        const x = i / 120;
        const px = x * w;
        const cy = creditY(x, t);
        ctx.lineTo(px, cy);
      }
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(95, 184, 120, 0.10)");
      grad.addColorStop(0.5, "rgba(95, 184, 120, 0.04)");
      grad.addColorStop(1, "rgba(232, 160, 78, 0.06)");
      ctx.fillStyle = grad;
      ctx.fill();

      // Dashed bound markers between proof and credit
      ctx.strokeStyle = "rgba(245, 241, 234, 0.08)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      for (let i = 1; i < 8; i++) {
        const x = i / 8;
        const px = x * w;
        ctx.beginPath();
        ctx.moveTo(px, proofY(x, t));
        ctx.lineTo(px, creditY(x, t));
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Proof line (upper bound)
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const x = i / 120;
        const px = x * w;
        const py = proofY(x, t);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = "rgba(95, 184, 120, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.shadowColor = "rgba(95, 184, 120, 0.55)";
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Credit line
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const x = i / 120;
        const px = x * w;
        const cy = creditY(x, t);
        if (i === 0) ctx.moveTo(px, cy);
        else ctx.lineTo(px, cy);
      }
      ctx.strokeStyle = "rgba(232, 160, 78, 0.95)";
      ctx.lineWidth = 2;
      ctx.shadowColor = "rgba(232, 160, 78, 0.5)";
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Particles along credit line
      particles.forEach((p) => {
        p.x += p.speed;
        if (p.x > 1) p.x -= 1;
        const px = p.x * w;
        const py = creditY(p.x, t);
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(244, 201, 138, ${p.opacity})`;
        ctx.fill();
      });

      // Update metrics directly to DOM without causing React re-renders or hydration mismatches
      const sampleX = 0.5;
      const pyMid = proofY(sampleX, t);
      const cyMid = creditY(sampleX, t);
      const used = cyMid - pyMid;
      const utilPct = Math.max(0, Math.min(1, used / 130));
      const headroomPct = 1 - utilPct;

      if (utilValRef.current) utilValRef.current.textContent = Math.round(utilPct * 100) + "%";
      if (headroomValRef.current) headroomValRef.current.textContent = Math.round(headroomPct * 100) + "%";
      if (utilBarRef.current) utilBarRef.current.style.width = Math.round(utilPct * 100) + "%";

      animId = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    draw();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animId);
    };
  }, []);

  return (
    <>
      {/* Top Reading Progress Bar */}
      <div
        ref={progressBarRef}
        className="scroll-progress-bar"
        style={{ transform: "scaleX(0)" }}
      />

      {/* Ambient glows */}
      <div
        className="ambient-glow"
        style={{
          width: "600px",
          height: "600px",
          background: "rgba(232, 160, 78, 0.08)",
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
          top: "400px",
          right: "-150px",
        }}
      />

      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 nav-blur">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="relative w-7 h-7">
              <svg viewBox="0 0 28 28" className="w-7 h-7">
                <rect x="2" y="2" width="24" height="24" rx="6" fill="none" stroke="url(#logoGrad)" strokeWidth="1.5" />
                <path d="M8 18 Q14 8 20 14 Q14 20 8 12" fill="none" stroke="#e8a04e" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M8 14 Q14 20 20 10" fill="none" stroke="#5fb878" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 2" />
                <defs>
                  <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#e8a04e" />
                    <stop offset="1" stopColor="#5fb878" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <span className="font-display text-lg font-medium tracking-tight">DrawBound</span>
          </Link>

          <div className="hidden md:flex items-center gap-8 text-sm text-[var(--text-muted)]">
            <a href="#thesis" className="hover:text-[var(--text)] transition-colors">
              Thesis
            </a>
            <a href="#how" className="hover:text-[var(--text)] transition-colors">
              Mechanism
            </a>
            <a href="#proof" className="hover:text-[var(--text)] transition-colors">
              Proof
            </a>
            <a href="#architecture" className="hover:text-[var(--text)] transition-colors">
              Architecture
            </a>
            <Link href="/vault" className="hover:text-[var(--text)] text-[var(--gold)] font-medium transition-colors">
              Vault Terminal
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <a
              href="https://github.com/natureloved/DrawBound"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost hidden sm:inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12 12 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
              </svg>
              GitHub
            </a>
            <Link href="/vault" className="btn-primary inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold">
              Read the spec
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 5l7 7-7 7" />
              </svg>
            </Link>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 -mr-2 text-[var(--text-muted)]"
              aria-label="Toggle Menu"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="mobile-menu open md:hidden absolute top-16 left-0 right-0 bg-[var(--bg-2)] border-b border-[var(--border)] px-6 py-6 flex flex-col gap-4 text-[var(--text-muted)]">
            <a href="#thesis" onClick={() => setMobileMenuOpen(false)} className="hover:text-[var(--text)]">
              Thesis
            </a>
            <a href="#how" onClick={() => setMobileMenuOpen(false)} className="hover:text-[var(--text)]">
              Mechanism
            </a>
            <a href="#proof" onClick={() => setMobileMenuOpen(false)} className="hover:text-[var(--text)]">
              Proof
            </a>
            <a href="#architecture" onClick={() => setMobileMenuOpen(false)} className="hover:text-[var(--text)]">
              Architecture
            </a>
            <Link href="/vault" onClick={() => setMobileMenuOpen(false)} className="text-[var(--gold)]">
              Launch App →
            </Link>
          </div>
        )}
      </nav>

      {/* HERO */}
      <section className="relative pt-32 pb-20 lg:pt-40 lg:pb-28 px-6 lg:px-10 overflow-hidden">
        <div className="max-w-7xl mx-auto relative z-10">
          <div className="grid lg:grid-cols-12 gap-10 lg:gap-8 items-center">
            {/* Left: Headline */}
            <div className="lg:col-span-7 reveal">
              <div className="section-label mb-8">
                <span className="pulse-dot" />
                Native BTC credit protocol
              </div>

              <h1
                className="headline mb-7"
                style={{ fontSize: "clamp(calc(2.6rem + 4px), calc(6.5vw + 4px), calc(5.2rem + 4px))" }}
              >
                Credit that <em>cannot</em>
                <br />
                outrun its proof.
              </h1>

              <p className="text-base lg:text-lg text-[var(--text-muted)] max-w-xl leading-relaxed mb-8 font-light">
                DrawBound issues credit against native Bitcoin with zero wrappers, zero bridges, and zero custodial trust. Every unit
                drawn is bounded, in real time, by cryptographic proof of the collateral that backs it.
              </p>

              <div className="flex flex-wrap items-center gap-3 mb-6">
                <Link href="/vault" className="btn-primary inline-flex items-center gap-2.5 px-6 py-3 rounded-lg text-base font-bold">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                  Connect Vault &amp; Explore
                </Link>
              </div>

              {/* Stats in a single horizontal line with dot dividers */}
              <div className="pt-4 border-t border-[var(--border-soft)]" style={{ marginTop: "20px" }}>
                <div className="flex flex-wrap items-center gap-x-4 sm:gap-x-6 gap-y-2 text-xs sm:text-sm font-mono text-[var(--text-muted)]">
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className="font-semibold text-sm sm:text-base text-[var(--gold)]">100%</span>
                    <span>Native BTC</span>
                  </span>
                  <span className="text-[var(--border)] text-sm select-none">•</span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className="font-semibold text-sm sm:text-base text-[var(--proof)]">0</span>
                    <span>Custodians</span>
                  </span>
                  <span className="text-[var(--border)] text-sm select-none">•</span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className="font-semibold text-sm sm:text-base text-[var(--text)]">∞</span>
                    <span>Proof-bounded</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Right: Visualization */}
            <div className="lg:col-span-5 reveal" style={{ transitionDelay: "0.15s" }}>
              <div className="relative">
                <div className="absolute -inset-4 bg-gradient-to-br from-[rgba(232,160,78,0.08)] to-[rgba(95,184,120,0.05)] rounded-3xl blur-2xl" />
                <div className="relative card p-1.5 aspect-[4/5] min-h-[420px]">
                  <div className="relative w-full h-full rounded-xl overflow-hidden bg-[#0c0a08] min-h-[400px]">
                    <canvas ref={canvasRef} id="hero-viz" style={{ width: "100%", height: "100%", display: "block" }} />
                    <div className="absolute top-4 left-4 right-4 flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-[var(--text-dim)]">
                      <span>Live · credit vs. proof</span>
                      <span className="flex items-center gap-1.5">
                        <span className="pulse-dot" />
                        attested
                      </span>
                    </div>
                    <div className="absolute bottom-4 left-4 right-4 bg-[#0c0a08]/80 backdrop-blur-sm p-3 rounded-lg border border-[var(--border-soft)]">
                      <div className="flex items-end justify-between mb-2">
                        <div>
                          <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-dim)]">Utilization</div>
                          <div ref={utilValRef} className="font-display text-2xl font-light text-[var(--gold)]">42%</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-dim)]">Bound headroom</div>
                          <div ref={headroomValRef} className="font-display text-2xl font-light text-[var(--proof)]">58%</div>
                        </div>
                      </div>
                      <div className="h-1.5 bg-[var(--border-soft)] rounded-full overflow-hidden">
                        <div
                          ref={utilBarRef}
                          id="utilBar"
                          className="h-full bg-gradient-to-r from-[var(--proof)] to-[var(--gold)] transition-all duration-300"
                          style={{ width: "42%" }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Marquee */}
      <section className="border-y border-[var(--border-soft)] py-5 overflow-hidden bg-[var(--bg-2)]">
        <div className="marquee text-[var(--text-dim)] font-mono text-sm uppercase tracking-widest">
          <span className="flex items-center gap-3">No wrappers <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">No bridges <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">No custodial risk <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">Proof-bounded issuance <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">L1-anchored settlement <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">Non-rehypothecatable <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">No wrappers <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">No bridges <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">No custodial risk <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">Proof-bounded issuance <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">L1-anchored settlement <span className="text-[var(--gold)]">/</span></span>
          <span className="flex items-center gap-3">Non-rehypothecatable <span className="text-[var(--gold)]">/</span></span>
        </div>
      </section>

      {/* THESIS */}
      <section id="thesis" className="relative py-24 lg:py-36 px-6 lg:px-10">
        <div className="max-w-5xl mx-auto">
          <div className="reveal section-label mb-8">01 / Thesis</div>
          <div className="grid lg:grid-cols-12 gap-10">
            <div className="lg:col-span-7 reveal">
              <h2 className="headline text-[clamp(2rem,4vw,3.4rem)] mb-8">
                Credit without proof
                <br />
                is just <em>leverage</em> with a logo.
              </h2>
              <div className="space-y-5 text-[var(--text-muted)] text-lg leading-relaxed font-light">
                <p>
                  Every BTC credit product today is, at its core, a promise. Wrapped BTC promises 1:1 backing. Custodial
                  lenders promise reserves. Bridges promise redemption. None of these promises are verifiable in real
                  time, and when they break, they break catastrophically.
                </p>
                <p>
                  DrawBound takes a different position:{" "}
                  <span className="text-[var(--text)]">
                    credit issuance is a function of proof, not a function of trust.
                  </span>{" "}
                  The protocol cannot mint, draw, or extend credit beyond what is cryptographically attested on Bitcoin at
                  the moment of issuance.
                </p>
                <p>
                  This is not a policy. It is not a risk framework. It is a structural invariant, enforced in the
                  issuance path itself.
                </p>
              </div>
            </div>
            <div className="lg:col-span-5 reveal" style={{ transitionDelay: "0.1s" }}>
              <div className="card p-7">
                <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-dim)] mb-5">
                  The core invariant
                </div>
                <div className="code-block p-5 mb-5">
                  <div>
                    <span className="code-comment">{"// enforced at issuance, not at audit"}</span>
                  </div>
                  <div>
                    <span className="code-keyword">assert</span>(credit_drawn <span className="code-keyword">&lt;=</span>{" "}
                    proof_verified);
                  </div>
                  <div className="mt-2">
                    <span className="code-comment">{"// credit cannot outrun proof"}</span>
                  </div>
                  <div>
                    <span className="code-keyword">require</span>(proof.<span className="code-fn">fresh</span>(){" "}
                    <span className="code-keyword">&amp;&amp;</span> proof.<span className="code-fn">bound</span>());
                  </div>
                </div>
                <div className="space-y-3 text-sm">
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--proof)]" />
                    <span className="text-[var(--text-muted)]">Issuance halts if proof is stale</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--proof)]" />
                    <span className="text-[var(--text-muted)]">No credit ahead of attestation</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--proof)]" />
                    <span className="text-[var(--text-muted)]">No rehypothecation, ever</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="section-ash relative py-24 lg:py-36 px-6 lg:px-10">
        <div className="max-w-7xl mx-auto">
          <div className="max-w-3xl mb-16">
            <div className="reveal section-label mb-6">02 / Mechanism</div>
            <h2 className="reveal headline text-[clamp(2rem,4vw,3.4rem)] mb-6">
              Four movements.
              <br />
              One <em>bound</em> curve.
            </h2>
            <p className="reveal text-[var(--text-muted)] text-lg font-light max-w-xl">
              The lifecycle of a DrawBound position. Each step is deterministic; each transition is provable.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
            {/* Step 1 */}
            <div className="reveal card p-7 relative">
              <div className="flex items-center justify-between mb-6">
                <div className="feat-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M7 7h10v10H7z" />
                    <circle cx="12" cy="12" r="2" />
                  </svg>
                </div>
                <span className="font-mono text-xs text-[var(--text-dim)]">01</span>
              </div>
              <h3 className="font-display text-xl font-medium mb-2">Lock</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                Deposit native BTC into a non-custodial vault on Bitcoin L1. The collateral never leaves mainchain; it is
                never wrapped, never bridged.
              </p>
            </div>

            {/* Step 2 */}
            <div className="reveal card p-7 relative" style={{ transitionDelay: "0.08s" }}>
              <div className="flex items-center justify-between mb-6">
                <div className="feat-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                </div>
                <span className="font-mono text-xs text-[var(--text-dim)]">02</span>
              </div>
              <h3 className="font-display text-xl font-medium mb-2">Prove</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                A cryptographic attestation of the vault state is generated and broadcast. The proof binds the collateral to
                a specific moment in Bitcoin history.
              </p>
            </div>

            {/* Step 3 */}
            <div className="reveal card p-7 relative" style={{ transitionDelay: "0.16s" }}>
              <div className="flex items-center justify-between mb-6">
                <div className="feat-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12h4l3-8 4 16 3-8h4" />
                  </svg>
                </div>
                <span className="font-mono text-xs text-[var(--text-dim)]">03</span>
              </div>
              <h3 className="font-display text-xl font-medium mb-2">Draw</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                Credit is issued on the execution layer, but only up to the bound defined by the live proof. Draw attempts
                beyond the bound are rejected at the protocol level.
              </p>
            </div>

            {/* Step 4 */}
            <div className="reveal card p-7 relative" style={{ transitionDelay: "0.24s" }}>
              <div className="flex items-center justify-between mb-6">
                <div className="feat-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9" />
                    <path d="M3 4v5h5" />
                  </svg>
                </div>
                <span className="font-mono text-xs text-[var(--text-dim)]">04</span>
              </div>
              <h3 className="font-display text-xl font-medium mb-2">Settle</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                Repay, rebalance, or close. Proof refreshes on every state transition, reconciling outstanding credit against
                current collateral continuously on-chain.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* PROOF MECHANISM */}
      <section id="proof" className="relative py-24 lg:py-36 px-6 lg:px-10">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-12 gap-12 lg:gap-16 items-start">
            <div className="lg:col-span-6">
              <div className="reveal section-label mb-6">03 / The bound</div>
              <h2 className="reveal headline text-[clamp(2rem,4vw,3.4rem)] mb-8">
                The proof is the <em>limit.</em>
                <br />
                Not the audit.
              </h2>
              <div className="reveal space-y-5 text-[var(--text-muted)] text-lg leading-relaxed font-light mb-10">
                <p>
                  Traditional credit systems audit after the fact: a lender says &quot;trust me, I have the reserves,&quot; and a
                  quarterly attestation attempts to verify the claim after the credit has already been issued.
                </p>
                <p>
                  DrawBound inverts the order. The proof is generated <span className="text-[var(--text)]">before</span> the
                  credit is drawn, and the issuance logic is structurally incapable of exceeding it. There is no after-the-fact
                  reconciliation, because there is no gap in which credit can outrun proof.
                </p>
                <p>This is the difference between a speed limit sign and a governor on the engine.</p>
              </div>

              <div className="reveal grid grid-cols-2 gap-4">
                <div className="card p-5">
                  <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-dim)] mb-2">Traditional</div>
                  <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-1">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e26d69" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                    Credit issued on promise
                  </div>
                  <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-1">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e26d69" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                    Reconciliation post-hoc
                  </div>
                  <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e26d69" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                    Failure mode: insolvency
                  </div>
                </div>
                <div className="card p-5" style={{ borderColor: "rgba(95, 184, 120, 0.25)" }}>
                  <div className="text-xs font-mono uppercase tracking-widest text-[var(--proof)] mb-2">DrawBound</div>
                  <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-1">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5fb878" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    Credit issued on proof
                  </div>
                  <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-1">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5fb878" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    Bound enforced a priori
                  </div>
                  <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5fb878" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    Failure mode: issuance halt
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Detailed code/diagram */}
            <div className="lg:col-span-6 reveal" style={{ transitionDelay: "0.1s" }}>
              <div className="card p-7">
                <div className="flex items-center justify-between mb-5">
                  <div className="text-xs font-mono uppercase tracking-widest text-[var(--text-dim)]">
                    issuance.sol · core logic
                  </div>
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-[#e26d69]" />
                    <div className="w-2.5 h-2.5 rounded-full bg-[var(--gold)]" />
                    <div className="w-2.5 h-2.5 rounded-full bg-[var(--proof)]" />
                  </div>
                </div>
                <div className="code-block p-5 overflow-x-auto">
                  <pre style={{ margin: 0, whiteSpace: "pre" }}>
                    <span className="code-comment">{"// DrawBound issuance: proof is the bound"}</span>
                    {"\n"}
                    <span className="code-keyword">function</span> <span className="code-fn">draw</span>(uint256 amount){" "}
                    <span className="code-keyword">external</span> {"{"}
                    {"\n"}    Proof.<span className="code-fn">Attestation</span> memory att = proof.
                    <span className="code-fn">current</span>();
                    {"\n"}    {"\n"}    <span className="code-comment">{"// proof must be live: stale proof halts issuance"}</span>
                    {"\n"}    <span className="code-keyword">require</span>(
                    {"\n"}        block.timestamp - att.timestamp <span className="code-keyword">&lt;</span>{" "}
                    <span className="code-number">FRESHNESS</span>,
                    {"\n"}        <span className="code-string">&quot;proof stale&quot;</span>
                    {"\n"}    );
                    {"\n"}    {"\n"}    <span className="code-comment">{"// the bound: credit cannot exceed verified collateral"}</span>
                    {"\n"}    uint256 bound = (att.collateral <span className="code-keyword">*</span> LTV) /{" "}
                    <span className="code-number">BASIS</span>;
                    {"\n"}    uint256 projected = positions[msg.sender].drawn <span className="code-keyword">+</span> amount;
                    {"\n"}    {"\n"}    <span className="code-keyword">require</span>(
                    {"\n"}        projected <span className="code-keyword">&lt;=</span> bound,
                    {"\n"}        <span className="code-string">&quot;credit cannot outrun proof&quot;</span>
                    {"\n"}    );
                    {"\n"}    {"\n"}    positions[msg.sender].drawn = projected;
                    {"\n"}    emit <span className="code-fn">Drawn</span>(msg.sender, amount, bound);
                    {"\n"}
                    {"}"}
                  </pre>
                </div>
                <div className="mt-5 pt-5 border-t border-[var(--border-soft)] grid grid-cols-3 gap-4 text-center">
                  <div>
                    <div className="font-mono text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Freshness</div>
                    <div className="font-display text-lg text-[var(--gold)]">~6s</div>
                  </div>
                  <div>
                    <div className="font-mono text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Settlement</div>
                    <div className="font-display text-lg text-[var(--proof)]">L1</div>
                  </div>
                  <div>
                    <div className="font-mono text-xs text-[var(--text-dim)] uppercase tracking-wider mb-1">Trust</div>
                    <div className="font-display text-lg text-[var(--cool)]">0</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PROPERTIES */}
      <section className="section-ash relative py-24 lg:py-36 px-6 lg:px-10">
        <div className="max-w-7xl mx-auto">
          <div className="max-w-3xl mb-16">
            <div className="reveal section-label mb-6">04 / Properties</div>
            <h2 className="reveal headline text-[clamp(2rem,4vw,3.4rem)] mb-6">
              What you get when
              <br />
              proof is the <em>structure</em>.
            </h2>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            <div className="reveal card p-8">
              <div className="feat-icon mb-5">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M15 9.5C15 8 13.5 7 12 7s-3 1-3 2.5" />
                  <path d="M8 14c1 1.5 2.5 2 4 2s3-.5 4-2" />
                </svg>
              </div>
              <h3 className="font-display text-xl font-medium mb-3">Native BTC</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                Collateral stays on Bitcoin mainchain. No wBTC, no tBTC, no synthetic representation. Your sats never leave
                L1.
              </p>
            </div>

            <div className="reveal card p-8" style={{ transitionDelay: "0.05s" }}>
              <div className="feat-icon mb-5">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M12 8v4M10 10h4" />
                </svg>
              </div>
              <h3 className="font-display text-xl font-medium mb-3">Proof-bounded</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                The credit ceiling is not a parameter, it is a function of the live proof. Issuance beyond the bound is
                structurally impossible.
              </p>
            </div>

            <div className="reveal card p-8" style={{ transitionDelay: "0.1s" }}>
              <div className="feat-icon mb-5">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <path d="M9 9h6v6H9z" />
                </svg>
              </div>
              <h3 className="font-display text-xl font-medium mb-3">Non-custodial</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                No custodian holds your keys, your BTC, or your credit. The protocol enforces vault access via Bitcoin
                script and proof, not operator honesty.
              </p>
            </div>

            <div className="reveal card p-8" style={{ transitionDelay: "0.15s" }}>
              <div className="feat-icon mb-5">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
                </svg>
              </div>
              <h3 className="font-display text-xl font-medium mb-3">Real-time attestation</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                Proofs refresh continuously as Bitcoin blocks confirm. The bound tracks collateral in real time with zero
                snapshots or stale state.
              </p>
            </div>

            <div className="reveal card p-8" style={{ transitionDelay: "0.2s" }}>
              <div className="feat-icon mb-5">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2M9 21h6M12 17v4M4 7h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V7z" />
                </svg>
              </div>
              <h3 className="font-display text-xl font-medium mb-3">Non-rehypothecatable</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                Collateral cannot be lent, re-pledged, or re-used. The vault is a one-way function: BTC in, proof out,
                credit drawn with nothing in between.
              </p>
            </div>

            <div className="reveal card p-8" style={{ transitionDelay: "0.25s" }}>
              <div className="feat-icon mb-5">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19" />
                </svg>
              </div>
              <h3 className="font-display text-xl font-medium mb-3">Censorship-resistant</h3>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                Settlement finality is anchored to Bitcoin L1. No committee, no sequencer, no operator can interpose between
                you and your collateral.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ARCHITECTURE */}
      <section id="architecture" className="relative py-20 lg:py-28 px-6 lg:px-10 scroll-mt-20">
        <div className="max-w-7xl mx-auto">
          <div className="max-w-3xl mb-12">
            <div className="reveal section-label mb-6">05 / Architecture</div>
            <h2 className="reveal headline text-[clamp(2rem,4vw,3.4rem)] mb-6">
              Three layers.
              <br />
              One <em>source of truth</em>.
            </h2>
            <p className="reveal text-[var(--text-muted)] text-lg font-light max-w-xl">
              DrawBound is split across Bitcoin L1, an attestation layer, and an execution layer. Each has a narrow job;
              none can overstep the others.
            </p>
          </div>

          <div className="reveal relative">
            <div className="card p-6 sm:p-8 lg:p-10">
              <div className="flex flex-col lg:flex-row items-center justify-between gap-4 lg:gap-6">
                {/* L1 */}
                <div className="arch-node w-full lg:flex-1 text-center lg:text-left">
                  <div className="flex items-center gap-3 mb-4 justify-center lg:justify-start">
                    <div className="w-8 h-8 rounded-lg bg-[rgba(232,160,78,0.1)] border border-[rgba(232,160,78,0.2)] flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e8a04e" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M9 8h6M9 12h6M9 16h4" />
                      </svg>
                    </div>
                    <div className="font-mono text-xs uppercase tracking-widest text-[var(--gold)]">Layer 1</div>
                  </div>
                  <h3 className="font-display text-2xl font-medium mb-3">Bitcoin</h3>
                  <p className="text-sm text-[var(--text-muted)] mb-5 leading-relaxed">
                    Collateral vaults live here. Native BTC is locked in non-custodial script; settlement finality is
                    Bitcoin&apos;s finality.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center lg:justify-start">
                    <span className="text-[10px] font-mono px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text-dim)] border border-[var(--border-soft)]">
                      VAULT
                    </span>
                    <span className="text-[10px] font-mono px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text-dim)] border border-[var(--border-soft)]">
                      SETTLE
                    </span>
                  </div>
                </div>

                {/* Arrow 1 */}
                <div className="hidden lg:flex flex-col items-center justify-center px-2">
                  <span className="text-[10px] font-mono text-[var(--proof)] mb-1">prove</span>
                  <svg width="36" height="14" viewBox="0 0 36 14" fill="none">
                    <path d="M0 7H32M26 1L32 7L26 13" stroke="#5fb878" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className="lg:hidden flex justify-center py-1">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5fb878" strokeWidth="2">
                    <path d="M12 5v14M5 12l7 7 7-7" />
                  </svg>
                </div>

                {/* Attestation */}
                <div className="arch-node w-full lg:flex-1 text-center lg:text-left">
                  <div className="flex items-center gap-3 mb-4 justify-center lg:justify-start">
                    <div className="w-8 h-8 rounded-lg bg-[rgba(95,184,120,0.1)] border border-[rgba(95,184,120,0.2)] flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5fb878" strokeWidth="2">
                        <path d="M12 2L4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z" />
                      </svg>
                    </div>
                    <div className="font-mono text-xs uppercase tracking-widest text-[var(--proof)]">Attestation</div>
                  </div>
                  <h3 className="font-display text-2xl font-medium mb-3">Proof layer</h3>
                  <p className="text-sm text-[var(--text-muted)] mb-5 leading-relaxed">
                    Generates and broadcasts cryptographic attestations of vault state. The bound is computed here; the
                    execution layer consumes it.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center lg:justify-start">
                    <span className="text-[10px] font-mono px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text-dim)] border border-[var(--border-soft)]">
                      ATTEST
                    </span>
                    <span className="text-[10px] font-mono px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text-dim)] border border-[var(--border-soft)]">
                      BOUND
                    </span>
                  </div>
                </div>

                {/* Arrow 2 */}
                <div className="hidden lg:flex flex-col items-center justify-center px-2">
                  <span className="text-[10px] font-mono text-[var(--cool)] mb-1">bound</span>
                  <svg width="36" height="14" viewBox="0 0 36 14" fill="none">
                    <path d="M0 7H32M26 1L32 7L26 13" stroke="#6b9eff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className="lg:hidden flex justify-center py-1">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6b9eff" strokeWidth="2">
                    <path d="M12 5v14M5 12l7 7 7-7" />
                  </svg>
                </div>

                {/* Execution */}
                <div className="arch-node w-full lg:flex-1 text-center lg:text-left">
                  <div className="flex items-center gap-3 mb-4 justify-center lg:justify-start">
                    <div className="w-8 h-8 rounded-lg bg-[rgba(107,158,255,0.1)] border border-[rgba(107,158,255,0.2)] flex items-center justify-center">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6b9eff" strokeWidth="2">
                        <path d="M3 12h4l3-8 4 16 3-8h4" />
                      </svg>
                    </div>
                    <div className="font-mono text-xs uppercase tracking-widest text-[var(--cool)]">Execution</div>
                  </div>
                  <h3 className="font-display text-2xl font-medium mb-3">Credit layer</h3>
                  <p className="text-sm text-[var(--text-muted)] mb-5 leading-relaxed">
                    Issues and tracks credit positions. Draws are accepted only up to the bound supplied by the proof layer,
                    never beyond.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center lg:justify-start">
                    <span className="text-[10px] font-mono px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text-dim)] border border-[var(--border-soft)]">
                      DRAW
                    </span>
                    <span className="text-[10px] font-mono px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text-dim)] border border-[var(--border-soft)]">
                      REPAY
                    </span>
                  </div>
                </div>
              </div>

              {/* Loop back indicator */}
              <div className="mt-8 pt-6 border-t border-[var(--border-soft)] flex items-center justify-center gap-3 text-xs font-mono text-[var(--text-dim)] uppercase tracking-widest">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 9-9M3 4v5h5" />
                </svg>
                Settlement reconciles back to L1: closing the loop
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section id="cta" className="relative py-24 lg:py-36 px-6 lg:px-10 overflow-hidden scroll-mt-20">
        <div
          className="ambient-glow"
          style={{
            width: "700px",
            height: "700px",
            background: "rgba(232, 160, 78, 0.06)",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
          }}
        />
        <div className="max-w-4xl mx-auto text-center relative z-10">
          <div className="reveal section-label justify-center mb-8" style={{ display: "inline-flex" }}>
            06 / Get involved
          </div>
          <h2 className="reveal headline text-[clamp(2.2rem,5vw,4rem)] mb-7">
            Build credit that <em>provably</em>
            <br />
            cannot outrun its backing.
          </h2>
          <p className="reveal text-[var(--text-muted)] text-lg lg:text-xl font-light max-w-2xl mx-auto mb-10 leading-relaxed">
            DrawBound is open-source and in active development. Read the spec, audit the mechanism, or launch the live terminal.
          </p>

          <div className="reveal flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/vault"
              className="btn-primary inline-flex items-center gap-2.5 px-7 py-3.5 rounded-lg text-sm font-semibold"
            >
              Launch Vault Terminal
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 5l7 7-7 7" />
              </svg>
            </Link>
            <a
              href="https://github.com/natureloved/DrawBound"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost inline-flex items-center gap-2.5 px-7 py-3.5 rounded-lg text-sm font-medium"
            >
              Explore the repository
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17L17 7M7 7h10v10" />
              </svg>
            </a>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-[var(--border-soft)] py-12 px-6 lg:px-10 bg-[var(--bg-2)]">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-6">
          <div className="flex flex-wrap items-center gap-3 text-center sm:text-left justify-center sm:justify-start">
            <Link href="/" className="flex items-center gap-2.5">
              <svg viewBox="0 0 28 28" className="w-6 h-6">
                <rect x="2" y="2" width="24" height="24" rx="6" fill="none" stroke="url(#logoGrad2)" strokeWidth="1.5" />
                <path d="M8 18 Q14 8 20 14 Q14 20 8 12" fill="none" stroke="#e8a04e" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M8 14 Q14 20 20 10" fill="none" stroke="#5fb878" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 2" />
                <defs>
                  <linearGradient id="logoGrad2" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#e8a04e" />
                    <stop offset="1" stopColor="#5fb878" />
                  </linearGradient>
                </defs>
              </svg>
              <span className="font-display text-base font-medium">DrawBound</span>
            </Link>
            <span className="hidden sm:inline text-[var(--border)]">•</span>
            <p className="text-xs text-[var(--text-muted)]">
              Native BTC credit that cannot outrun its proof.
            </p>
          </div>
          <div className="text-xs text-[var(--text-dim)] font-mono text-center sm:text-right">
            © 2025 DrawBound · MIT License · Not financial advice
          </div>
        </div>
      </footer>
    </>
  );
}
