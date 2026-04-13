import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { parseDateOnly } from "@/lib/date-only";
import { validateRosterAllocationsForDate } from "@/lib/lodge-date-scoping";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const allocationSchema = z.object({
  choreTemplateId: z.string().min(1),
  bookingGuestId: z.string().min(1),
  bookingId: z.string().min(1),
});

const bodySchema = z.object({
  allocations: z.array(allocationSchema).min(1),
  overwrite: z.boolean().optional(),
});

/**
 * POST /api/lodge/roster/[date]/confirm
 * Saves the final roster with status CONFIRMED.
 * If overwrite=true, deletes existing assignments first.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const { error, status, tier } = await checkLodgeAuth(dateStr, { request: req });
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  // Roster confirmation requires hut-leader or admin tier
  if (tier !== "admin" && tier !== "hut-leader") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const allocationsAreValid = await validateRosterAllocationsForDate(
      parsed.data.allocations,
      date
    );
    if (!allocationsAreValid) {
      return NextResponse.json(
        {
          error:
            "Allocations must reference guests staying on this date for the matching booking",
        },
        { status: 400 }
      );
    }

    // Check for existing confirmed/completed assignments
    const existingConfirmed = await prisma.choreAssignment.count({
      where: {
        date,
        status: { in: ["CONFIRMED", "COMPLETED"] },
      },
    });

    if (existingConfirmed > 0 && !parsed.data.overwrite) {
      return NextResponse.json(
        { error: "Roster already confirmed. Set overwrite=true to replace." },
        { status: 409 }
      );
    }

    // Transaction: delete old assignments, create new ones as CONFIRMED
    await prisma.$transaction(async (tx) => {
      if (parsed.data.overwrite) {
        await tx.choreAssignment.deleteMany({ where: { date } });
      } else {
        // Delete only SUGGESTED ones
        await tx.choreAssignment.deleteMany({
          where: { date, status: "SUGGESTED" },
        });
      }

      await tx.choreAssignment.createMany({
        data: parsed.data.allocations.map((a) => ({
          choreTemplateId: a.choreTemplateId,
          bookingGuestId: a.bookingGuestId,
          bookingId: a.bookingId,
          date,
          status: "CONFIRMED" as const,
        })),
      });
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error confirming roster");
    return NextResponse.json({ error: "Failed to confirm roster" }, { status: 500 });
  }
}
