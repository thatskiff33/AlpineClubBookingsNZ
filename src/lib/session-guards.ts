import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type RequireActiveSessionUserOptions = {
  allowForcePasswordChange?: boolean;
};

export async function requireActiveSessionUser(
  userId: string,
  options: RequireActiveSessionUserOptions = {}
) {
  const member = await prisma.member.findUnique({
    where: { id: userId },
    select: {
      active: true,
      forcePasswordChange: true,
    },
  });

  if (!member?.active) {
    return NextResponse.json(
      { error: "Account is deactivated" },
      { status: 403 }
    );
  }

  if (member.forcePasswordChange && !options.allowForcePasswordChange) {
    return NextResponse.json(
      { error: "Password change required" },
      { status: 403 }
    );
  }

  return null;
}
