import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  canAccessConsolidatedFeesPage,
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
  getFirstAccessibleAdminHref,
} from "@/lib/admin-permissions";
import { feesSectionEditAccess } from "./_components/fees-access";
import { FeesPageClient } from "./_components/fees-page-client";

// Consolidated fee console (#1933, E7). Admission is OR (bookings OR finance
// view); the layout already enforces it, and this server guard is belt-and-
// braces. The permission matrix is resolved server-side (definition-backed roles
// live in the DB) so each section receives the right per-area edit flag.
export default async function FeesPage() {
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

  if (!canAccessConsolidatedFeesPage(permissionMatrix)) {
    redirect(
      (member && getFirstAccessibleAdminHref(member)) ?? "/dashboard",
    );
  }

  const { hutFeesCanEdit, financeCanEdit } =
    feesSectionEditAccess(permissionMatrix);

  return (
    <FeesPageClient
      hutFeesCanEdit={hutFeesCanEdit}
      financeCanEdit={financeCanEdit}
    />
  );
}
