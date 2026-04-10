import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function requireActiveSessionUser(userId: string) {
  const activeMemberCount = await prisma.member.count({
    where: { id: userId, active: true },
  });

  if (activeMemberCount === 0) {
    return NextResponse.json(
      { error: "Account is deactivated" },
      { status: 403 }
    );
  }

  return null;
}
