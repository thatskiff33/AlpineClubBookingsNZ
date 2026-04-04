import type { Metadata } from "next";
import { SessionProvider } from "next-auth/react";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    template: "%s | Tokoroa Alpine Club",
    default: "Tokoroa Alpine Club — Mt Ruapehu Lodge",
  },
  description:
    "Tokoroa Alpine Club — 29-bed lodge on Mt Ruapehu, Whakapapa. Book a stay, join the club, and explore New Zealand's mountains. Est. 1969.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        <SessionProvider>{children}</SessionProvider>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
