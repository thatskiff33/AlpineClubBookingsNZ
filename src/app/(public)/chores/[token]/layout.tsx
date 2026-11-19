import type { Metadata } from "next";

// The page is a client component, which cannot export metadata, so this server
// layout gives the route its own tab title (#5217); the root template appends
// the club name. Fixed text only: a tab title lands in history and screenshots,
// so it never carries the guest's name or the token.
export const metadata: Metadata = {
  title: "Your chores",
};

export default function GuestChoreLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
