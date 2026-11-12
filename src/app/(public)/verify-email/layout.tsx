import type { Metadata } from "next";

// The page is a client component, which cannot export metadata, so this server
// layout gives the route its own tab title (#4951); the root template appends
// the club name. Fixed text only: a tab title lands in history and screenshots,
// so it never carries a name, an amount or a token.
export const metadata: Metadata = {
  title: "Verify your email",
};

export default function VerifyEmailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
