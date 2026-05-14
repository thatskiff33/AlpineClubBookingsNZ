import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { getKioskAccessInfo } from "@/lib/kiosk-access";
import { parseDateOnly } from "@/lib/date-only";
import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/access?date=YYYY-MM-DD
 * Returns the user's kiosk access tier and capabilities for the given date.
 */
export async function GET(req: NextRequest) {
  const dateStr = req.nextUrl.searchParams.get("date");
  if (!dateStr || !dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid or missing date parameter" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const authResult = await checkLodgeAuth(dateStr, {
    request: req,
  });
  if (authResult.error) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status! });
  }

  if ("pinSession" in authResult && authResult.pinSession) {
    return NextResponse.json({
      tier: "hut-leader",
      dateRange: authResult.pinSession.dateRange,
      canManageRoster: true,
      canMarkAttendance: true,
      canCompleteChores: true,
    });
  }

  if (authResult.session?.user) {
    const access = await getKioskAccessInfo(
      authResult.session.user.id,
      authResult.session.user.role,
      date
    );

    return NextResponse.json(access);
  }

  return NextResponse.json({
    tier: "none",
    dateRange: null,
    canManageRoster: false,
    canMarkAttendance: false,
    canCompleteChores: false,
  });
}
