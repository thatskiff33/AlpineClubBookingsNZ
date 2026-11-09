import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  emptyAdminPermissionMatrix,
  getAdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { BackLink } from "@/components/admin/back-link";
import { adminLink } from "@/lib/admin-hubs";
import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager";

// Thin server wrapper. This page lives under the lodge area, but its manager's
// data comes entirely from the bed-allocation APIs, which enforce the BOOKINGS
// area (no route→area remap — see #1548 PR 2 precedent). The matrix is computed
// server-side (definition-backed roles live in the DB and cannot be resolved
// client-side) and passed down so the manager renders permission-aware instead
// of fetching into a 403 (#1598 / #1591 pattern). The layout already gates admin
// access; the session check here is belt-and-braces.
export default async function AdminRoomsBedsPage() {
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
    <div className="space-y-6">
      <BackLink {...adminLink("bookings-setup")} />
      <RoomsBedsManager permissionMatrix={permissionMatrix} />
    </div>
  );
}
