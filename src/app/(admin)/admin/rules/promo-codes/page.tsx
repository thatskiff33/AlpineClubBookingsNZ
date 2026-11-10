import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { PromoCodesPageClient } from "./promo-codes-page-client";

// Thin server wrapper. This page is bookings area, but its create/edit form
// pulls Xero reference data (chart-of-accounts + items) from the finance area.
// The matrix is computed server-side (definition-backed roles live in the DB and
// cannot be resolved client-side) and passed down so the form only fetches Xero
// data for a finance viewer and degrades to manual code entry otherwise, instead
// of erroring on a 403 (#1598 / #1591 pattern). The layout already gates admin
// access; the session check here is belt-and-braces.
export default async function PromoCodesPage() {
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

  return <PromoCodesPageClient permissionMatrix={permissionMatrix} />;
}
