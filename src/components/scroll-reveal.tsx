"use client";

import { useEffect } from "react";

/**
 * Scroll-reveal driver for `.reveal` / `.reveal-stagger` elements.
 *
 * The CSS for these classes starts VISIBLE; this driver opts into the
 * animation by adding `reveal-anim` to <html>, then adds `in` as elements
 * scroll into view. If this never runs (JS off, observer unsupported,
 * reduced motion), content simply stays visible instead of stuck invisible.
 * Mount this once at the app root; it observes every `.reveal` element
 * currently on the page.
 *
 * Motion's `<Reveal>` component is preferred for new UI (it is spring-driven
 * and reduced-motion aware), but the landing page's long-form content still
 * uses the CSS classes, and both systems coexist safely.
 */
export function ScrollReveal() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;

    // Opt into the hidden-starting-state animation only now that JS is
    // running and an observer exists to finish it.
    document.documentElement.classList.add("reveal-anim");

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" },
    );

    const nodes = document.querySelectorAll(".reveal, .reveal-stagger");
    nodes.forEach((el) => observer.observe(el));

    // Late-arriving nodes (route change, conditionally rendered card) need to
    // be picked up too, so re-scan shortly after mount.
    const rescan = window.setTimeout(() => {
      document.querySelectorAll(".reveal:not(.in), .reveal-stagger:not(.in)").forEach((el) => observer.observe(el));
    }, 250);

    return () => {
      window.clearTimeout(rescan);
      observer.disconnect();
    };
  }, []);

  return null;
}
