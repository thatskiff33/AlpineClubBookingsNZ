import type { Metadata } from "next";
import { headers } from "next/headers";
import { SessionProvider } from "next-auth/react";
import { CspNonceProvider } from "@/components/security/csp-nonce-provider";
import { Toaster } from "@/components/ui/sonner";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import "./globals.css";

const baseUrl = process.env.NEXTAUTH_URL || "https://tokoroa.org.nz";

export const metadata: Metadata = {
  title: {
    template: "%s | Tokoroa Alpine Club",
    default: "Tokoroa Alpine Club — Mt Ruapehu Lodge",
  },
  description:
    "Tokoroa Alpine Club — 29-bed lodge on Mt Ruapehu, Whakapapa. Book a stay, join the club, and explore New Zealand's mountains. Est. 1969.",
  metadataBase: new URL(baseUrl),
  openGraph: {
    title: "Tokoroa Alpine Club — Mt Ruapehu Lodge",
    description:
      "29-bed lodge in the Whakapapa ski area. Book a stay, join the club, and explore New Zealand's mountains. Est. 1969.",
    url: baseUrl,
    siteName: "Tokoroa Alpine Club",
    images: [
      {
        url: "/logo.png",
        width: 1200,
        height: 630,
        alt: "Tokoroa Alpine Club Logo",
      },
    ],
    locale: "en_NZ",
    type: "website",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        <CspNonceProvider nonce={nonce}>
          <SessionProvider>{children}</SessionProvider>
          <Toaster richColors position="top-right" />
        </CspNonceProvider>
      </body>
    </html>
  );
}
