import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Drawbound | Proof-causal BTC credit",
  description: "Self-custodial native-BTC credit prototype",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
