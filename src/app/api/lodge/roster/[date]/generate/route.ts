import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { addDaysDateOnly, parseDateOnly } from "@/lib/date-only";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  allocateChores,
  ChoreTemplateInput,
  ChoreHistoryEntry,
} from "@/lib/chore-allocator";
import { getLodgeCapacity, FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { getOperationalRosterGuestsForDate } from "@/lib/roster-eligibility";
import logger from "@/lib/logger";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

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
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, { request: req });
  const { error, status, tier } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  // Roster generation requires hut-leader or admin tier
  if (tier !== "admin" && tier !== "hut-leader") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!dateOnlyStringSchema.safeParse(dateStr).success) {
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
    const lodgeId = await resolveKioskLodgeId(authResult, prisma);

    // #2622: the kiosk used to keep its own copy of the admin roster's
    // eligibility query, and the two had already drifted — this one loaded no
    // explicit night rows, so a sparse stay's gap days looked like presence.
    // Deleting the duplicate in favour of the shared selector is safe here
    // because this endpoint runs no transaction at all: it is a read-only
    // preview that returns allocations for the wizard without saving them, so
    // there is no transaction for a shared call to widen. Every guard the
    // duplicate carried (D-12 consent on both the booking match and the guest
    // include, the pending-review filter, operational statuses, lodge scoping)
    // lives in `getOperationalRosterGuestsForDate` unchanged, and the wizard
    // now sees exactly the people the admin roster would.
    const guests = await getOperationalRosterGuestsForDate(date, lodgeId);

    // Get selected chore templates
    const choreTemplates = await prisma.choreTemplate.findMany({
      where: {
        id: { in: parsed.data.choreTemplateIds },
        active: true,
        ...lodgeNullTolerantScope(lodgeId),
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
    const lookbackDate = addDaysDateOnly(date, -4);

    const historyRecords = await prisma.choreAssignment.findMany({
      where: {
        date: { gte: lookbackDate, lt: date },
        bookingGuestId: { in: guests.map((g) => g.id) },
        booking: lodgeNullTolerantScope(lodgeId),
        choreTemplate: lodgeNullTolerantScope(lodgeId),
      },
    });

    const history: ChoreHistoryEntry[] = historyRecords
      .filter((h) => h.bookingGuestId !== null)
      .map((h) => ({
        guestId: h.bookingGuestId!,
        choreTemplateId: h.choreTemplateId,
        date: h.date,
      }));

    // #2021 (#1982/#2013 residual): scale per-chore people-counts by this
    // lodge's real resolved sleeping capacity (lodge-scoped), not the fixed
    // display constant. DB read failure or a non-positive resolution keeps the
    // constant fallback so roster generation never breaks.
    let capacity = FALLBACK_LODGE_CAPACITY;
    try {
      const resolved = await getLodgeCapacity(lodgeId);
      if (resolved > 0) capacity = resolved;
    } catch (capacityErr) {
      logger.warn(
        { err: capacityErr, lodgeId },
        "Falling back to default lodge capacity for chore people-count scaling",
      );
    }

    // Run allocator (no frequency filtering since wizard already selected chores)
    const allocations = allocateChores(templateInputs, guests, history, {
      includeNonEssential: true, // wizard explicitly chose chores
      capacity,
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

    // PRIVACY PROJECTION (#2622). The shared selector also carries
    // `bookingGroupLabel` — "Booking for <owner first name> <surname>" — which
    // the admin roster editor groups by. This endpoint answers a SHARED
    // hut-leader PIN session on a kiosk in the lodge, and the booking owner is
    // not necessarily anyone staying, so that label would name a person the
    // kiosk has no reason to show. The duplicate query this route used to keep
    // never produced it; list the fields explicitly so the wizard's shape stays
    // exactly what it was and nothing new leaks in by inheritance.
    const kioskGuests = guests.map((guest) => ({
      id: guest.id,
      bookingId: guest.bookingId,
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isArriving: guest.isArriving,
      isDeparting: guest.isDeparting,
    }));

    return NextResponse.json({
      date: dateStr,
      allocations: result,
      guests: kioskGuests,
    });
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    logger.error({ err }, "Error generating roster");
    return NextResponse.json({ error: "Failed to generate roster" }, { status: 500 });
  }
}
