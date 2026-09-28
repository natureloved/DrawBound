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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#07060a",
};

import Script from "next/script";

export const metadata: Metadata = {
  title: "DrawBound: Native BTC credit that cannot outrun its proof",
  description: "Self-custodial native-BTC credit protocol. BTC collateral locked in TAURUS vaults, bounded by real-time HAT/RIP health proofs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}>
      <head>
        <Script
          id="extension-error-shield"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              window.addEventListener("error", function(e) {
                if (
                  (e.message && (e.message.includes("Cannot redefine property: ethereum") || e.message.includes("ethereum"))) ||
                  (e.filename && e.filename.startsWith("chrome-extension://"))
                ) {
                  e.stopImmediatePropagation();
                  e.preventDefault();
                }
              }, true);
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
