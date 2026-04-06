import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth } from "@/lib/lodge-auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  allocateChores,
  ChoreTemplateInput,
  GuestInput,
  ChoreHistoryEntry,
} from "@/lib/chore-allocator";
import logger from "@/lib/logger";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bodySchema = z.object({
  choreTemplateIds: z.array(z.string().min(1)).min(1),
});

/**
 * POST /api/lodge/roster/[date]/generate
 * Accepts selected choreTemplateIds, runs the allocator, and returns
 * the allocation WITHOUT saving to the database.
 * Used by the hut leader wizard step 3.
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
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);

    // Get guests staying on this date
    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: ["CONFIRMED", "COMPLETED"] },
        checkIn: { lte: date },
        checkOut: { gt: date },
      },
      include: { guests: true },
    });

    const guests: GuestInput[] = bookings.flatMap((b) =>
      b.guests.map((g) => ({
        id: g.id,
        bookingId: b.id,
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isArriving: b.checkIn.getTime() === date.getTime(),
        isDeparting: b.checkOut.getTime() === nextDay.getTime(),
      }))
    );

    // Get selected chore templates
    const choreTemplates = await prisma.choreTemplate.findMany({
      where: {
        id: { in: parsed.data.choreTemplateIds },
        active: true,
      },
      orderBy: { sortOrder: "asc" },
    });

    const templateInputs: ChoreTemplateInput[] = choreTemplates.map((t) => ({
      id: t.id,
      name: t.name,
      recommendedPeopleMin: t.recommendedPeopleMin,
      recommendedPeopleMax: t.recommendedPeopleMax,
      isEssential: t.isEssential,
      ageRestriction: t.ageRestriction,
      minAge: t.minAge,
      sortOrder: t.sortOrder,
      timeOfDay: t.timeOfDay,
      frequencyMode: t.frequencyMode,
      frequencyDays: t.frequencyDays,
      frequencyDaysOfWeek: t.frequencyDaysOfWeek,
    }));

    // 4-day lookback for guest chore history
    const lookbackDate = new Date(date);
    lookbackDate.setDate(lookbackDate.getDate() - 4);

    const historyRecords = await prisma.choreAssignment.findMany({
      where: {
        date: { gte: lookbackDate, lt: date },
        bookingGuestId: { in: guests.map((g) => g.id) },
      },
    });

    const history: ChoreHistoryEntry[] = historyRecords
      .filter((h) => h.bookingGuestId !== null)
      .map((h) => ({
        guestId: h.bookingGuestId!,
        choreTemplateId: h.choreTemplateId,
        date: h.date,
      }));

    // Run allocator (no frequency filtering since wizard already selected chores)
    const allocations = allocateChores(templateInputs, guests, history, {
      includeNonEssential: true, // wizard explicitly chose chores
    });

    // Return allocations with guest/chore names for display
    const guestMap = new Map(guests.map((g) => [g.id, g]));
    const choreMap = new Map(choreTemplates.map((t) => [t.id, t]));

    const result = allocations.map((a) => {
      const guest = guestMap.get(a.bookingGuestId);
      const chore = choreMap.get(a.choreTemplateId);
      return {
        choreTemplateId: a.choreTemplateId,
        choreTemplateName: chore?.name ?? "Unknown",
        choreTimeOfDay: chore?.timeOfDay ?? "ANYTIME",
        choreSortOrder: chore?.sortOrder ?? 0,
        bookingGuestId: a.bookingGuestId,
        guestName: guest ? `${guest.firstName} ${guest.lastName}` : "Unknown",
        guestAgeTier: guest?.ageTier ?? null,
        bookingId: a.bookingId,
      };
    });

    return NextResponse.json({
      date: dateStr,
      allocations: result,
      guests,
    });
  } catch (err) {
    logger.error({ err }, "Error generating roster");
    return NextResponse.json({ error: "Failed to generate roster" }, { status: 500 });
  }
}
