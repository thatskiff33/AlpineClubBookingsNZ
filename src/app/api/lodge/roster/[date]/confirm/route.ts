import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
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
