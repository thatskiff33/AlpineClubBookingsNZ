import type { Role } from "@prisma/client";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  hasLodgeAccess,
  type AccessRoleAssignmentInput,
} from "@/lib/access-roles";
import {
  hasFinanceManagerAccess,
  hasFinanceViewerAccess,
} from "@/lib/admin-permissions";
import { MEMBER_PRIVILEGE_CHECK_SELECT } from "@/lib/access-role-definitions";
import { buildLoginPath } from "@/lib/auth-redirect";
import { prisma } from "@/lib/prisma";
import {
  buildTwoFactorGatePath,
  isTwoFactorSessionBlocked,
} from "@/lib/two-factor-gate";

export type FinanceAccessMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  accessRoles: Array<AccessRoleAssignmentInput>;
  /** Required so the finance checks apply the login-disabled rule (#3603). */
  canLogin: boolean;
  active: boolean;
  forcePasswordChange: boolean;
  twoFactorEnabled: boolean;
};

// `hasFinanceViewerAccess` / `hasFinanceManagerAccess` are defined once, in
// `@/lib/admin-permissions`, and imported from there everywhere. This module
// used to wrap them (#3264), which gave the same guard two import paths.
// Requires the member's accessRoles rows and `canLogin` to be selected with
// MEMBER_PRIVILEGE_CHECK_SELECT, so definitions resolve and a login-disabled
// member resolves to no finance access (#3603).

export async function loadFinanceAccessMember(
  memberId: string
): Promise<FinanceAccessMember | null> {
  return prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      ...MEMBER_PRIVILEGE_CHECK_SELECT,
      active: true,
      forcePasswordChange: true,
      twoFactorEnabled: true,
    },
  });
}

export async function requireFinanceViewer(
  callbackPath: string = "/finance"
): Promise<FinanceAccessMember> {
  const session = await auth();

  if (!session?.user) {
    redirect(buildLoginPath(callbackPath));
  }

  const member = await loadFinanceAccessMember(session.user.id);

  if (!member || !member.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  if (
    isTwoFactorSessionBlocked({
      sessionUser: session.user,
      member,
    })
  ) {
    redirect(
      buildTwoFactorGatePath({
        sessionUser: session.user,
        member,
        callbackPath,
      }),
    );
  }

  if (!hasFinanceViewerAccess(member)) {
    if (hasLodgeAccess(member)) {
      redirect("/lodge/kiosk");
    }
    redirect("/dashboard");
  }

  return member;
}

// test seam
export async function requireFinanceManager(
  callbackPath: string = "/finance"
): Promise<FinanceAccessMember> {
  const member = await requireFinanceViewer(callbackPath);

  if (!hasFinanceManagerAccess(member)) {
    redirect("/finance");
  }

  return member;
}
