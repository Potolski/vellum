import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, IBM_Plex_Mono, Lora } from "next/font/google";
import "./globals.css";

// Serif for voice, mono for the record. Never a sans-serif.
const serif = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});
const text = Lora({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  variable: "--font-text",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

const description =
  "Compliant and confidential tokenized stocks on Solana. KYC and jurisdiction rules enforced; balances encrypted.";

// Link previews need absolute image URLs. Vercel provides the production
// domain at build time; elsewhere Next falls back to localhost.
const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const metadata: Metadata = {
  metadataBase: productionHost ? new URL(`https://${productionHost}`) : undefined,
  title: "Vellum · The confidential share register",
  description,
  openGraph: {
    title: "Vellum · The confidential share register",
    description,
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: "#1a1816",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${text.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
