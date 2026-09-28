"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { TAP_SPRING } from "./motion";

const NAV_ITEMS = [
  { href: "#thesis", label: "Thesis" },
  { href: "#how", label: "How it works" },
  { href: "#proof", label: "Proof gate" },
  { href: "#architecture", label: "Architecture" },
];

/**
 * Mobile navigation drawer.
 *
 * Details that matter on a phone:
 * - The backdrop and panel animate together, and the panel unmounts when closed
 *   (`AnimatePresence`), so its links are never tabbable while hidden.
 * - `body` scroll is locked while the drawer is open; without it, a finger
 *   swipe scrolls the page behind the overlay instead of closing it.
 * - `active` is derived from scroll position, so the highlighted item tracks
 *   the section you are actually reading.
 */
export function MobileNav({ ctaHref = "/vault", ctaLabel = "Open Vault Terminal" }: { ctaHref?: string; ctaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string>("");
  const reduced = useReducedMotion();

  // Scroll-lock while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Close on Escape — the Android back gesture also triggers it on many devices.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Track the section in view to mark the nav item.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const sections = NAV_ITEMS.map((item) => document.querySelector(item.href)).filter(
      (el): el is Element => Boolean(el),
    );
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActive(`#${visible.target.id}`);
      },
      { rootMargin: "-25% 0px -60% 0px", threshold: [0.01, 0.25, 0.5] },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-drawer"
        aria-label={open ? "Close menu" : "Open menu"}
        className="md:hidden inline-flex items-center justify-center w-11 h-11 -mr-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] active:scale-95 transition-transform"
      >
        <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
          {open ? (
            <>
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </>
          ) : (
            <>
              <path d="M3.5 7h17" />
              <path d="M3.5 12h17" />
              <path d="M3.5 17h17" />
            </>
          )}
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="backdrop"
              className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.2 }}
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            <motion.nav
              id="mobile-drawer"
              key="drawer"
              aria-label="Main navigation"
              className="fixed inset-x-0 top-0 z-[61] md:hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
              initial={reduced ? { opacity: 0 } : { y: "-100%" }}
              animate={reduced ? { opacity: 1 } : { y: 0 }}
              exit={reduced ? { opacity: 0 } : { y: "-100%" }}
              transition={reduced ? { duration: 0.15 } : { type: "spring", stiffness: 320, damping: 32 }}
            >
              <div className="mx-3 mt-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 h-14 border-b border-[var(--border-soft)]">
                  <span className="font-display text-base font-medium">Menu</span>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-[var(--text-muted)] active:scale-95 transition-transform"
                    aria-label="Close menu"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M6 6l12 12" />
                      <path d="M18 6L6 18" />
                    </svg>
                  </button>
                </div>
                <div className="flex flex-col p-2">
                  {NAV_ITEMS.map((item, i) => (
                    <motion.div
                      key={item.href}
                      initial={reduced ? { opacity: 0 } : { opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: reduced ? 0 : 0.04 + i * 0.045, ...TAP_SPRING }}
                    >
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        className={`flex items-center justify-between px-4 py-4 rounded-xl text-[15px] transition-colors ${
                          active === item.href
                            ? "text-[var(--gold)] bg-[rgba(232,160,78,0.08)]"
                            : "text-[var(--text-muted)]"
                        }`}
                      >
                        {item.label}
                        {active === item.href && <span className="w-1.5 h-1.5 rounded-full bg-[var(--gold)]" />}
                      </Link>
                    </motion.div>
                  ))}
                  <Link
                    href={ctaHref}
                    onClick={() => setOpen(false)}
                    className="btn-primary mt-2 mx-2 py-3.5 rounded-xl text-sm font-semibold text-center"
                  >
                    {ctaLabel} →
                  </Link>
                </div>
              </div>
            </motion.nav>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

/** Site header: sticky, blur-on-scroll, safe-area padded, mobile nav inline. */
export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 nav-blur transition-[background-color,border-color] duration-300 pt-[env(safe-area-inset-top)] ${
        scrolled ? "border-b border-[var(--border-soft)] bg-[rgba(10,9,8,0.85)]" : "border-b border-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-10 h-16 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span className="relative w-7 h-7 block">
            <svg viewBox="0 0 28 28" className="w-7 h-7">
              <rect x="2" y="2" width="24" height="24" rx="6" fill="none" stroke="url(#logoGradSite)" strokeWidth="1.5" />
              <path d="M8 18 Q14 8 20 14 Q14 20 8 12" fill="none" stroke="#e8a04e" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M8 14 Q14 20 20 10" fill="none" stroke="#5fb878" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 2" />
              <defs>
                <linearGradient id="logoGradSite" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#e8a04e" />
                  <stop offset="1" stopColor="#5fb878" />
                </linearGradient>
              </defs>
            </svg>
          </span>
          <span className="font-display text-lg font-medium tracking-tight">DrawBound</span>
        </Link>

        <div className="hidden md:flex items-center gap-7 text-sm text-[var(--text-muted)]">
          {NAV_ITEMS.map((item) => (
            <a key={item.href} href={item.href} className="hover:text-[var(--text)] transition-colors">
              {item.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <a
            href="https://github.com/natureloved/DrawBound"
            target="_blank"
            rel="noreferrer noopener"
            className="btn-ghost hidden sm:inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 .5C5.73.5.5 5.73.5 12.02c0 5.02 3.29 9.28 7.86 10.72.58.1.79-.25.79-.55v-2.1c-3.2.69-3.88-1.35-3.88-1.35-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.26 5.69.41.36.78 1.06.78 2.15v3.19c0 .31.2.66.8.55A11.5 11.5 0 0 0 23.5 12.02C23.5 5.73 18.27.5 12 .5z" />
            </svg>
            GitHub
          </a>
          <Link href="/vault" className="btn-primary inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold">
            Vault
          </Link>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
