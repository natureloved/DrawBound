import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Google Fonts origins are required by src/app/layout.tsx.
const fontStyleSrc = "https://fonts.googleapis.com";
const fontSrc = "https://fonts.gstatic.com";

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js injects inline scripts and (in dev) needs eval for fast refresh.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  `style-src 'self' 'unsafe-inline' ${fontStyleSrc}`,
  `font-src 'self' ${fontSrc} data:`,
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
  // Dev-server only: allow local origins so the HMR/turbopack client (and thus
  // hydration) works when browsing via 127.0.0.1 or a LAN address.
  allowedDevOrigins: ["127.0.0.1", "localhost", "192.168.1.142"],
  // Emit a self-contained server bundle for slim container images.
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
