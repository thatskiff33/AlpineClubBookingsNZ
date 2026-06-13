import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { getSanitizedLodgeInstructions } from "@/lib/lodge-instructions";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/instructions?date=YYYY-MM-DD
 * Kiosk surface for the lodge instruction documents. Only the signed-in
 * hut leader tier qualifies: a valid hut leader PIN session, a member with
 * a hut leader assignment covering the date, or an admin. The shared lodge
 * account and staying guests do not see the documents.
 */
export async function GET(req: NextRequest) {
  const dateStr = req.nextUrl.searchParams.get("date") ?? undefined;
  if (dateStr !== undefined && !dateSchema.safeParse(dateStr).success) {
    return NextResponse.json(
      { error: "Invalid date parameter" },
      { status: 400 },
    );
  }

  const authResult = await checkLodgeAuth(dateStr, { request: req });
  if (authResult.error) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status! },
    );
  }

  const isHutLeaderSurface =
    authResult.tier === "admin" || authResult.tier === "hut-leader";

  if (!isHutLeaderSurface) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const documents = await getSanitizedLodgeInstructions();
  return NextResponse.json({ documents });
}
