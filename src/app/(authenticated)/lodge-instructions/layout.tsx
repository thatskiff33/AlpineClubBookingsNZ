import type { Metadata } from "next";

// The page is a client component, which cannot export metadata, so this server
// layout gives the route its own tab title (#4951); the root template appends
// the club name.
export const metadata: Metadata = {
  title: "Lodge instructions",
};

export default function LodgeInstructionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
