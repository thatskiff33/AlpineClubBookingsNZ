import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const seasonYear = getSeasonYear(new Date());
  const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;

  const sub = await prisma.memberSubscription.findFirst({
    where: { memberId: session.user.id, seasonYear },
    select: { status: true },
  });

  const status = sub?.status ?? "NOT_INVOICED";

  return NextResponse.json({ status, seasonDisplay });
}
