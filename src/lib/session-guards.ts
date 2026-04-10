import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function requireActiveSessionUser(userId: string) {
  const member = await prisma.member.findUnique({
    where: { id: userId },
    select: { active: true },
  });

  if (!member?.active) {
    return NextResponse.json(
      { error: "Account is deactivated" },
      { status: 403 }
    );
  }

  return null;
}
