import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { getSanitizedLodgeInstructions } from "@/lib/lodge-instructions";
import { prisma } from "@/lib/prisma";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

/**
 * GET /api/lodge/instructions?date=YYYY-MM-DD
 * Kiosk surface for the lodge instruction documents. Only the signed-in
 * hut leader tier qualifies: a valid hut leader PIN session, a member with
 * a hut leader assignment covering the date, or an admin. The shared lodge
 * account and staying guests do not see the documents.
 */
export async function GET(req: NextRequest) {
  const dateStr = req.nextUrl.searchParams.get("date") ?? undefined;
  if (dateStr !== undefined && !dateOnlyStringSchema.safeParse(dateStr).success) {
    return NextResponse.json(
      { error: "Invalid date parameter" },
      { status: 400 },
    );
  }

  const authResult = await checkLodgeAuth(dateStr, {
    request: req,
    allowPreview: true,
  });
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

  // The kiosk is lodge-bound server-side: resolve the device's lodge the
  // same way the other kiosk routes do, so a lodge's override documents
  // replace the club-wide ones on that lodge's kiosk — with text tokens
  // ({{club-name}} etc.) resolved for display.
  let lodgeId: string;
  try {
    lodgeId = await resolveKioskLodgeId(authResult, prisma);
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    throw err;
  }
  const documents = await getSanitizedLodgeInstructions({
    lodgeId,
    resolveTokens: true,
  });
  return NextResponse.json({ documents });
}
