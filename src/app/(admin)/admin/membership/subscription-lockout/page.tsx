import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { BackLink } from "@/components/admin/back-link";
import { SubscriptionLockoutSettingsPanel } from "@/components/admin/subscription-lockout-settings-panel";
import { adminLink } from "@/lib/admin-hubs";

// Thin server wrapper. This page (support area) embeds a panel whose backing
// APIs enforce OTHER areas — membership-lockout-settings (membership), the four
// Xero endpoints (finance), and age-tier-settings (bookings). The matrix is
// computed server-side because definition-backed roles live in the DB and cannot
// be resolved client-side (same reason the layout precomputes it for the
// sidebar); it is passed down so the panel hides cross-area sections instead of
// fetching into a 403 or stalling on "Loading settings…" (#1598 / #1591 pattern).
// The layout already gates admin access; the session check here is
// belt-and-braces.
export default async function AdminSubscriptionLockoutPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      canLogin: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
    },
  });

  const permissionMatrix = member
    ? getAdminPermissionMatrix(member)
    : emptyAdminPermissionMatrix();

  return (
    <div className="space-y-8">
      <div>
        <BackLink {...adminLink("membership-setup")} />
        <h1 className="mt-2 text-2xl font-bold">Subscription lockout settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Turn the unpaid-subscription booking lockout on or off, set the
          financial year, and configure how a paid subscription is detected in
          Xero.
        </p>
      </div>

      <SubscriptionLockoutSettingsPanel permissionMatrix={permissionMatrix} />
    </div>
  );
}
