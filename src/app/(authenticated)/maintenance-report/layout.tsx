import type { Metadata } from "next";

// The page is a client component, which cannot export metadata, so this server
// layout gives the route its own tab title (#5217); the root template appends
// the club name. The title is shared on purpose with `/lodge-maintenance/[token]`:
// the signed-in door and the QR-code door open the same form. Change both
// together; `/lodge-maintenance/[token]` is not in `ROUTES` because that table
// requires every title to be unique.
export const metadata: Metadata = {
  title: "Report a maintenance issue",
};

export default function MaintenanceReportLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
