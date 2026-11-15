import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

/**
 * GET /api/lodge/roster/[date]/chores
 * Returns active chore templates for roster setup.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, {
    request: req,
    allowPreview: true,
  });
  const { error, status, tier } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  if (tier !== "admin" && tier !== "hut-leader") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!dateOnlyStringSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  let lodgeId: string;
  try {
    lodgeId = await resolveKioskLodgeId(authResult, prisma);
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    throw err;
  }

  const templates = await prisma.choreTemplate.findMany({
    where: { active: true, ...lodgeNullTolerantScope(lodgeId) },
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json({ templates });
}
