import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { findLodgeGuestForDate } from "@/lib/lodge-date-scoping";
import { parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bodySchema = z.object({
  bookingGuestId: z.string().min(1),
});

/**
 * PUT /api/lodge/guests/[date]/depart
 * Mark a guest as departed (sets departedAt timestamp).
 * Sending again toggles off (clears departedAt).
 * Requires tier >= lodge (staying-guest cannot mark departures).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const { error, status, tier } = await checkLodgeAuth(dateStr, { request: req });
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  // Staying guests cannot mark departures
  if (tier === "staying-guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }
  const date = parseDateOnly(dateStr);

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
    const guest = await findLodgeGuestForDate(parsed.data.bookingGuestId, date);

    if (!guest) {
      return NextResponse.json(
        { error: "Guest not found for this date" },
        { status: 404 }
      );
    }

    // Toggle: if already departed, clear; otherwise set
    const departedAt = guest.departedAt ? null : new Date();

    await prisma.$transaction(async (tx) => {
      await tx.bookingGuest.update({
        where: { id: parsed.data.bookingGuestId },
        data: { departedAt },
      });

      if (departedAt) {
        await tx.choreAssignment.deleteMany({
          where: {
            bookingGuestId: parsed.data.bookingGuestId,
            date: { gt: date },
            status: "SUGGESTED",
          },
        });
      }
    });

    return NextResponse.json({ success: true, departedAt: departedAt?.toISOString() ?? null });
  } catch (err) {
    logger.error({ err }, "Error marking guest departure");
    return NextResponse.json({ error: "Failed to update guest" }, { status: 500 });
  }
}
