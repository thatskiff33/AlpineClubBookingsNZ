import type { Metadata } from "next";

// The page is a client component, which cannot export metadata, so this server
// layout gives the route its own tab title (#5217); the root template appends
// the club name.
export const metadata: Metadata = {
  title: "Lodge induction",
};

export default function InductionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
