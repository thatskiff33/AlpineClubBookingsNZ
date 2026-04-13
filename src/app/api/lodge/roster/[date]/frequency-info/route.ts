import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/roster/[date]/frequency-info
 * Returns the most recent roster date per chore template (for frequency UI).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const { error, status } = await checkLodgeAuth(dateStr, { request: req });
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }
  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const lastRosteredRecords = await prisma.choreAssignment.groupBy({
    by: ["choreTemplateId"],
    where: { date: { lt: date } },
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
