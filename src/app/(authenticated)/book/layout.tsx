import type { Metadata } from "next";

// The page is a client component, which cannot export metadata, so this server
// layout gives the route its own tab title (#5217); the root template appends
// the club name. `/book/whole-lodge` sits under this layout and sets its own
// title, which wins there.
export const metadata: Metadata = {
  title: "Book a stay",
};

export default function BookLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
