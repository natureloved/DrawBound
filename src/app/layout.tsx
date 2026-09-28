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

export const metadata: Metadata = {
  title: "DrawBound: Native BTC credit that cannot outrun its proof",
  description:
    "Self-custodial native-BTC credit protocol. BTC collateral locked in TAURUS vaults, bounded by real-time HAT/RIP health proofs.",
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
