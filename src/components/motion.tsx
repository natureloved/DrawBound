"use client";

import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Shared motion primitives for the DrawBound front end.
 *
 * Two rules govern everything here:
 *
 * 1. **Reduced motion is respected, not approximated.** `useReducedMotion`
 *    short-circuits every transform/opacity animation to a plain crossfade (or
 *    nothing). A user who has asked their OS to stop animation gets a static
 *    page, not a slower version of the animated one.
 * 2. **Nothing animates on first paint until it is on screen.** In-view
 *    animations use IntersectionObserver with `once: true`, so scrolling back
 *    up does not re-trigger them and the list below the fold never costs
 *    layout.
 */

export const SPRING = { type: "spring", stiffness: 260, damping: 24, mass: 0.9 } as const;

/** A gentle, non-bouncy spring used for anything the user drags or taps. */
export const TAP_SPRING = { type: "spring", stiffness: 500, damping: 30 } as const;

export function useInView<T extends HTMLElement>(options?: IntersectionObserverInit) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // No observer support (or SSR): reveal immediately rather than leaving
      // the content hidden. Deferred to a microtask so the state update runs
      // after the effect, not synchronously inside it.
      queueMicrotask(() => setInView(true));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      }
    }, options ?? { rootMargin: "0px 0px -12% 0px", threshold: 0.15 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [options]);

  return { ref, inView };
}

interface RevealProps {
  children: ReactNode;
  /** Seconds of delay, used to cascade sibling elements. */
  delay?: number;
  /** Vertical travel in px. Reduced-motion users get 0 (opacity only). */
  y?: number;
  className?: string;
  as?: "div" | "section" | "li" | "article" | "header" | "footer";
}

/**
 * Scroll-triggered entrance. Fades and lifts, once, when the element first
 * enters the viewport.
 */
export function Reveal({ children, delay = 0, y = 22, className, as = "div" }: RevealProps) {
  const reduced = useReducedMotion();
  const { ref, inView } = useInView<HTMLDivElement>();

  // A single typed motion component is used for every tag; the element type is
  // controlled by `as`. Typing `motion[as]` directly makes the ref union
  // unassignable, so the common case is cast once here.
  const Tag = motion[as] as typeof motion.div;

  return (
    <Tag
      ref={ref}
      className={className}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y }}
      animate={inView ? { opacity: 1, y: 0 } : undefined}
      transition={reduced ? { duration: 0.25, delay } : { type: "spring", stiffness: 220, damping: 26, delay }}
    >
      {children}
    </Tag>
  );
}

/**
 * A thin reading-progress bar pinned to the top of the page. Uses a spring-
 * smoothed `scaleY` on a transform (never `height`, which triggers layout on
 * every scroll frame).
 */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 30, restDelta: 0.001 });

  return <motion.div className="scroll-progress-bar" style={{ scaleX }} aria-hidden="true" />;
}

/**
 * Parallax wrapper: the child drifts at a fraction of the scroll speed.
 * Disabled entirely under reduced motion so the layout is static.
 */
export function Parallax({ children, distance = 40, className }: { children: ReactNode; distance?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], [distance, -distance]);

  return (
    <div ref={ref} className={className}>
      <motion.div style={reduced ? undefined : { y }}>{children}</motion.div>
    </div>
  );
}

/**
 * Tap/press feedback that works the same with a finger, a mouse and a pen.
 * CSS `:active` is unreliable on touch (it can stick after a scroll), so the
 * scale is driven by pointer state instead.
 */
export function TapScale({
  children,
  scale = 0.97,
  className,
  as = "div",
}: {
  children: ReactNode;
  scale?: number;
  className?: string;
  as?: "div" | "button" | "li";
}) {
  const reduced = useReducedMotion();
  const Tag = motion[as];
  return (
    <Tag className={className} whileTap={reduced ? undefined : { scale }} transition={TAP_SPRING}>
      {children}
    </Tag>
  );
}
