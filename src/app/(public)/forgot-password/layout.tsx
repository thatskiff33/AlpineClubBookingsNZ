import type { Metadata } from "next";

// The page is a client component, which cannot export metadata, so this server
// layout gives the route its own tab title (#5217); the root template appends
// the club name. Fixed text only: the address typed into the form never reaches
// the title.
export const metadata: Metadata = {
  title: "Forgot your password",
};

export default function ForgotPasswordLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
