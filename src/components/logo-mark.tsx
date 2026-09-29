/**
 * DrawBound brand mark — the single source of truth for the logo.
 *
 * The mark features the protocol's signature interlaced ribbon curves:
 * the solid gold curve represents credit drawn, intertwined with the dashed
 * proof-green curve representing the real-time covenant proof bound.
 *
 * This component exists so the mark is defined once with unique per-instance
 * gradient IDs (via React useId()) to avoid SVG ID collisions across the page.
 */

import { useId } from "react";

export type LogoMarkProps = {
  /** Rendered size in px (both width and height). */
  size?: number;
  /** Unique suffix. Defaults to a React useId() so multiple marks never collide. */
  uid?: string;
  className?: string;
  /** Set false to hide from screen readers (e.g. beside a text wordmark). */
  decorative?: boolean;
};

export function LogoMark({ size = 28, uid, className, decorative = true }: LogoMarkProps) {
  const auto = useId();
  const id = uid ?? auto;
  const grad = `dbLogoGrad${id}`;

  return (
    <svg
      viewBox="0 0 28 28"
      width={size}
      height={size}
      className={className}
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : "DrawBound logo"}
      focusable="false"
      fill="none"
    >
      <rect width="28" height="28" rx="7" fill="#0a0908" />
      <rect x="2" y="2" width="24" height="24" rx="6" fill="none" stroke={`url(#${grad})`} strokeWidth="1.5" />
      <path
        d="M8 18 Q14 8 20 14 Q14 20 8 12"
        fill="none"
        stroke="#e8a04e"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M8 14 Q14 20 20 10"
        fill="none"
        stroke="#5fb878"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="2 2"
      />
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e8a04e" />
          <stop offset="1" stopColor="#5fb878" />
        </linearGradient>
      </defs>
    </svg>
  );
}
