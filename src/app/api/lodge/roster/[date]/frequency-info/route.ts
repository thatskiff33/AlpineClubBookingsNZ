import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/roster/[date]/frequency-info
 * Returns the most recent roster date per chore template (for frequency UI).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { error, status } = await checkLodgeAuth();
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  const { date: dateStr } = await params;
  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = new Date(dateStr + "T00:00:00");
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
        rec._max.date.toISOString().split("T")[0];
    }
  }

  return NextResponse.json({ lastRosteredDates });
}
