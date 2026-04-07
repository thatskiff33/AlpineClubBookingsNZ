import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getKioskAccessInfo } from "@/lib/kiosk-access";
import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/access?date=YYYY-MM-DD
 * Returns the user's kiosk access tier and capabilities for the given date.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const dateStr = req.nextUrl.searchParams.get("date");
  if (!dateStr || !dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid or missing date parameter" }, { status: 400 });
  }

  const date = new Date(dateStr + "T00:00:00");
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const access = await getKioskAccessInfo(session.user.id, session.user.role, date);

  return NextResponse.json(access);
}
