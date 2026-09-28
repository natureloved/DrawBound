import type { Metadata, Viewport } from "next";
import { Inter, Fraunces, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jbmono",
  display: "swap",
});

/**
 * Canonical origin for absolute metadata URLs (canonical links, og:url).
 *
 * This is the live deployment. Vercel serves this project from main on every
 * push, so it is the origin a shared link should resolve to.
 */
const SITE_URL = "https://drawbound-eight.vercel.app";

/**
 * The social banner.
 *
 * Pointed at the deployment's own copy of the asset rather than the
 * repository, because a link preview should resolve to the site being shared.
 * The asset is committed at public/brand/banner.png (1200x630), and Vercel
 * serves public/ as static files, so `$SITE_URL/brand/banner.png` is the
 * canonical URL for it. raw.githubusercontent.com is kept as the documented
 * fallback only — do not point the tag back at the repo.
 */
const OG_IMAGE_URL = `${SITE_URL}/brand/banner.png`;

export const metadata: Metadata = {
  // Required so openGraph/twitter resolve relative URLs to absolute ones.
  // Without metadataBase Next warns and emits a relative path that most
  // crawlers and chat clients silently drop — which defeats the banner.
  metadataBase: new URL(SITE_URL),
  title: "DrawBound: Native BTC credit that cannot outrun its proof",
  description:
    "Self-custodial native-BTC credit protocol. BTC collateral locked in TAURUS vaults, bounded by real-time HAT/RIP health proofs.",
  // Brand assets live in public/brand/. The banner is the Open Graph card —
  // 1200x630 is the canonical size every major chat app and crawler crops to.
  icons: {
    icon: [
      { url: "/brand/logo.svg", type: "image/svg+xml" },
      { url: "/brand/logo-mark-128.png", sizes: "128x128", type: "image/png" },
    ],
    apple: [{ url: "/brand/logo-256.png", sizes: "256x256" }],
  },
  openGraph: {
    type: "website",
    siteName: "DrawBound",
    url: SITE_URL,
    title: "DrawBound: Credit that cannot outrun its proof",
    description:
      "Self-custodial native-BTC credit protocol. BTC collateral locked in TAURUS vaults, bounded by real-time HAT/RIP health proofs.",
    images: [
      {
        url: OG_IMAGE_URL,
        secureUrl: OG_IMAGE_URL,
        width: 1200,
        height: 630,
        alt: "DrawBound — credit that cannot outrun its proof. Native BTC credit protocol.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "DrawBound: Credit that cannot outrun its proof",
    description:
      "Self-custodial native-BTC credit protocol. BTC collateral locked in TAURUS vaults, bounded by real-time HAT/RIP health proofs.",
    images: [OG_IMAGE_URL],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "DrawBound",
  },
};

/**
 * Mobile-first viewport. `viewport-fit=cover` lets the page extend under the
 * notch/home-indicator so `env(safe-area-inset-*)` can pad it back; without it
 * iOS Safari renders a small white letterbox and content sits under the
 * Dynamic Island. `maximumScale` is deliberately NOT capped — shrinking the
 * page to fit a wide metrics table is a legitimate accessibility gesture.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0908" },
    { media: "(prefers-color-scheme: light)", color: "#0a0908" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
