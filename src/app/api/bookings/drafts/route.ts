import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const drafts = await prisma.booking.findMany({
    where: {
      memberId: session.user.id,
      status: "DRAFT",
      draftExpiresAt: { gt: new Date() },
    },
    include: {
      guests: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ drafts });
}
