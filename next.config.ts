import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Comma-separated list of origins that may load dev resources (HMR / Turbopack
// client). Local defaults always apply; add LAN/remote origins via env.
const allowedDevOrigins = Array.from(
  new Set(
    [
      "localhost",
      "127.0.0.1",
      ...(process.env.ALLOWED_DEV_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ].map((value) => value.toLowerCase()),
  ),
);

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js injects inline scripts and (in dev) needs eval for fast refresh.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  // next/font self-hosts the webfonts at build time — no external font origins required.
  "style-src 'self' 'unsafe-inline'",
  `font-src 'self' data:`,
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins,
  // Emit a self-contained server bundle for slim container images.
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
