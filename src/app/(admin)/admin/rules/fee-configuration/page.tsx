import { redirect } from "next/navigation";
import { adminHref } from "@/lib/admin-hubs";

// The former Membership & Joining Fees page is now the Joining/Annual sections
// of the consolidated fee console (#1933, E7). This route redirects so old links
// and bookmarks keep working. It still resolves to the finance permission area
// via ROUTE_AREA_PREFIXES ("/admin/fee-configuration"), so admission is
// unchanged for anyone who reaches it directly.
export default function FeeConfigurationRedirect() {
  redirect(adminHref("fees"));
}
