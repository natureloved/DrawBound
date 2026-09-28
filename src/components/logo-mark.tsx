/**
 * DrawBound brand mark — the single source of truth for the logo.
 *
 * The mark encodes the protocol's core invariant: the dashed green line is
 * the *proof bound*, the solid gold line is the credit drawn against it, and
 * the two vertical ticks show that credit is bounded by proof rather than
 * trailing behind it.
 *
 * This component exists so the mark is defined once. It was previously
 * copy-pasted as an inline SVG in three places (site header, vault topbar,
 * landing footer), each with a differently-named gradient id
 * (`logoGradSite` / `logoGradVault` / `logoGrad2`). Duplicate SVG gradient
 * ids across a page are legal but fragile — ids must be unique per document,
 * so the site-header and vault-topbar copies collide whenever both are
 * ever mounted on one page, and the wrong gradient can resolve.
 *
 * `uid` keeps ids unique per instance when that is needed (e.g. the favicon
 * route and several instances on one page). The raster `logo.svg` in
 * `public/brand/` is a pre-rendered companion for Open Graph and README use.
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
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : "DrawBound logo"}
      focusable="false"
    >
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#0a0908" />
      <rect x="2" y="2" width="60" height="60" rx="14" fill="none" stroke={`url(#${grad})`} strokeWidth="2" />
      {/* the proof bound (upper, dashed) */}
      <path
        d="M18 26 Q32 14 46 24"
        fill="none"
        stroke="#5fb878"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="3 3"
        opacity="0.9"
      />
      {/* the drawn credit line (lower, solid) */}
      <path d="M18 38 Q32 48 46 34" fill="none" stroke="#e8a04e" strokeWidth="2.5" strokeLinecap="round" />
      {/* bound markers */}
      <path d="M24 32.5 L24 33.5" stroke="#5fb878" strokeWidth="2" strokeLinecap="round" />
      <path d="M32 42.5 L32 26.5" stroke="#5fb878" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
      <path d="M40 31.5 L40 33.5" stroke="#5fb878" strokeWidth="2" strokeLinecap="round" />
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e8a04e" />
          <stop offset="1" stopColor="#5fb878" />
        </linearGradient>
      </defs>
    </svg>
  );
}
