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
 * Canonical origin for absolute metadata URLs.
 *
 * NOTE: DrawBound has no deployed domain yet — the README and Dockerfile
 * reference 127.0.0.1 only, so this is the repository origin, not a live
 * site. Update to the real host when one exists; until then social crawlers
 * resolve the banner against this origin.
 */
const SITE_URL = "https://natureloved.github.io/DrawBound";

export const metadata: Metadata = {
  // Required so openGraph/twitter resolve /brand/banner.png to an absolute
  // URL. Without metadataBase, Next warns and emits a relative path that most
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
    title: "DrawBound: Credit that cannot outrun its proof",
    description:
      "Self-custodial native-BTC credit protocol. BTC collateral locked in TAURUS vaults, bounded by real-time HAT/RIP health proofs.",
    images: [
      { url: "/brand/banner.png", width: 1200, height: 630, alt: "DrawBound — native BTC credit protocol" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "DrawBound: Credit that cannot outrun its proof",
    description:
      "Self-custodial native-BTC credit protocol. BTC collateral locked in TAURUS vaults, bounded by real-time HAT/RIP health proofs.",
    images: ["/brand/banner.png"],
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
