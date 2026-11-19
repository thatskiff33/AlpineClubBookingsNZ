import type { Metadata } from "next";

// Gives the route its own tab title (#5217); the root template appends the
// club name. It sits here, not in the page, because the page is already over
// its size budget. Fixed text only: a tab title lands in history and
// screenshots, so it never carries the member's name.
export const metadata: Metadata = {
  title: "Profile",
};

export default function ProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
