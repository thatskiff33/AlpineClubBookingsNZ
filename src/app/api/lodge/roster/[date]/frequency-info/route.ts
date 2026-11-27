import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/lodge/roster/[date]/frequency-info
 * Returns the most recent roster date per chore template (for frequency UI).
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
  if (authResult.error) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status! },
    );
  }

  const date = parseDateOnly(dateStr);

  // Frequency history is per lodge: last-rostered dates only consider
  // assignments of this kiosk's lodge's chore templates.
  let kioskLodgeId: string;
  try {
    kioskLodgeId = await resolveKioskLodgeId(authResult, prisma);
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    throw err;
  }
  const lastRosteredRecords = await prisma.choreAssignment.groupBy({
    by: ["choreTemplateId"],
    where: {
      date: { lt: date },
      booking: lodgeNullTolerantScope(kioskLodgeId),
      choreTemplate: lodgeNullTolerantScope(kioskLodgeId),
    },
    _max: { date: true },
  });

  const lastRosteredDates: Record<string, string> = {};
  for (const rec of lastRosteredRecords) {
    if (rec._max.date) {
      lastRosteredDates[rec.choreTemplateId] =
        formatDateOnly(rec._max.date);
    }
  }

  return NextResponse.json({ lastRosteredDates });
}
