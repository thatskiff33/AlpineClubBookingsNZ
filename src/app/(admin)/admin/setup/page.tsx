import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { SetupPageClient } from "./setup-page-client";

// Thin server wrapper. The Setup page (support area) embeds cross-area cards —
// LodgeCapacityCard (lodge) and FinanceReportMappingsPanel (finance) — whose
// backing APIs enforce a different area than this route. The matrix is computed
// server-side because definition-backed roles live in the DB and cannot be
// resolved client-side (same reason the layout precomputes it for the sidebar);
// it is passed down so those cards render permission-aware instead of fetching
// into a 403 (#1548 / owner finding 11). The layout already gates admin access;
// the session check here is belt-and-braces.
export default async function SetupPage() {
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

  return <SetupPageClient permissionMatrix={permissionMatrix} />;
}
