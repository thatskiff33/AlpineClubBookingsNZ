import type { FinanceAccessLevel, Role } from "@prisma/client";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildLoginPath } from "@/lib/auth-redirect";
import { prisma } from "@/lib/prisma";

export type FinanceAccessMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  financeAccessLevel: FinanceAccessLevel;
  active: boolean;
  forcePasswordChange: boolean;
};

export function hasFinanceViewerAccess(level: FinanceAccessLevel) {
  return level === "VIEWER" || level === "MANAGER";
}

export function hasFinanceManagerAccess(level: FinanceAccessLevel) {
  return level === "MANAGER";
}

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
      financeAccessLevel: true,
      active: true,
      forcePasswordChange: true,
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

  if (session.user.role === "LODGE") {
    redirect("/lodge/kiosk");
  }

  const member = await loadFinanceAccessMember(session.user.id);

  if (!member || !member.active) {
    redirect("/login");
  }

  if (member.forcePasswordChange) {
    redirect("/change-password");
  }

  if (!hasFinanceViewerAccess(member.financeAccessLevel)) {
    redirect("/dashboard");
  }

  return member;
}

export async function requireFinanceManager(
  callbackPath: string = "/finance"
): Promise<FinanceAccessMember> {
  const member = await requireFinanceViewer(callbackPath);

  if (!hasFinanceManagerAccess(member.financeAccessLevel)) {
    redirect("/finance");
  }

  return member;
}
