import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import {
  BookingGuestStayRangeValidationError,
  type NormalizedBookingGuestStayRange,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { workPartyWindowOverlapsStay } from "@/lib/work-party";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const validateSchema = z
  .object({
    code: z.string().min(1).optional(),
    // Work party (working bee) event preview: resolves the event's internal
    // promo server-side; the internal code is never sent to or accepted
    // from the client.
    workPartyEventId: z.string().min(1).optional(),
    checkIn: dateOnlyString.transform(parseDateOnly),
    checkOut: dateOnlyString.transform(parseDateOnly),
    guests: z
      .array(
        z.object({
          ageTier: ageTierEnum,
          isMember: z.boolean(),
          memberId: z.string().min(1).optional(),
          stayStart: z.string().optional(),
          stayEnd: z.string().optional(),
        })
      )
      .min(1),
    forMemberId: z.string().optional(),
    promoGuestIndexes: z.array(z.number().int().min(0)).optional(),
  })
  .refine((data) => Boolean(data.code) !== Boolean(data.workPartyEventId), {
    message: "Provide either a promo code or a working bee event, not both",
  });

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingQuery, req);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;

  const parsed = validateSchema.safeParse(json.body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { code, checkIn, checkOut } = parsed.data;
  let guests: Array<(typeof parsed.data.guests)[number] & NormalizedBookingGuestStayRange>;
  try {
    guests = normalizeGuestStayRanges(parsed.data.guests, { checkIn, checkOut });
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  // Use target member for admin on-behalf bookings
  const effectiveMemberId = (parsed.data.forMemberId && session.user.role === "ADMIN")
    ? parsed.data.forMemberId
    : session.user.id;

  let promoCode:
    | (Awaited<ReturnType<typeof prisma.promoCode.findUnique>> & {
        assignments: { memberId: string }[];
      })
    | null = null;
  let workPartyEvent: { id: string; name: string; discountPercent: number } | null = null;

  if (parsed.data.workPartyEventId) {
    const event = await prisma.workPartyEvent.findUnique({
      where: { id: parsed.data.workPartyEventId },
      include: {
        promoCode: { include: { assignments: { select: { memberId: true } } } },
      },
    });
    if (!event) {
      return NextResponse.json(
        { valid: false, error: "Working bee event not found" },
        { status: 400 }
      );
    }
    if (!event.active || !event.promoCode.active || event.promoCode.archivedAt) {
      return NextResponse.json(
        { valid: false, error: "This working bee event is no longer active" },
        { status: 400 }
      );
    }
    if (!workPartyWindowOverlapsStay(event, checkIn, checkOut)) {
      return NextResponse.json(
        {
          valid: false,
          error: "This working bee event does not overlap your booking dates",
        },
        { status: 400 }
      );
    }
    promoCode = event.promoCode;
    workPartyEvent = {
      id: event.id,
      name: event.name,
      discountPercent: event.discountPercent,
    };
  } else if (code) {
    const normalizedCode = code.toUpperCase().trim();
    const found = await prisma.promoCode.findUnique({
      where: { code: normalizedCode },
      include: { assignments: { select: { memberId: true } } },
    });
    // Internal promos (work party events) are system-applied only; a
    // manually entered internal code behaves like a nonexistent one.
    promoCode = found && !found.internal ? found : null;
  }

  const assignedMemberIds = promoCode?.assignments?.length
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  // Calculate the booking price to determine discount
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: checkOut },
      endDate: { gte: checkIn },
    },
    include: { rates: true },
  });

  const seasonData: SeasonRateData[] = seasons.map((s) => ({
    seasonId: s.id,
    startDate: s.startDate,
    endDate: s.endDate,
    type: s.type,
    rates: s.rates.map((r) => ({
      ageTier: r.ageTier,
      isMember: r.isMember,
      pricePerNightCents: r.pricePerNightCents,
    })),
  }));

  let groupDiscount: GroupDiscountConfig | undefined;
  const gds = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });
  if (gds?.enabled) {
    groupDiscount = {
      minGroupSize: gds.minGroupSize,
      summerOnly: gds.summerOnly,
      enabled: true,
    };
  }

  try {
    const price = calculateBookingPrice(
      checkIn,
      checkOut,
      guests,
      seasonData,
      groupDiscount
    );

    const promoGuests = price.guests.map((g, index) => ({
      memberId: guests[index].memberId ?? null,
      isMember: g.isMember,
      perNightRates: g.perNightCents,
      // Dates the positional rates so internal work-party promos restrict
      // the discount to the event's night window.
      firstNight: guests[index].stayStart ?? checkIn,
    }));

    const application = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        memberId: effectiveMemberId,
        bookingCheckIn: checkIn,
        totalPriceCents: price.totalPriceCents,
        guests: promoGuests,
      },
      assignedMemberIds,
      { db: prisma, selectedGuestIndexes: parsed.data.promoGuestIndexes }
    );
    if (application.requiresGuestSelection) {
      return NextResponse.json({
        valid: false,
        requiresGuestSelection: true,
        error: application.error,
        code: promoCode!.code,
        description: promoCode!.description,
        type: promoCode!.type,
        selectableGuestIndexes: application.selectableGuestIndexes ?? [],
      });
    }
    if (application.error || !application.discount) {
      return NextResponse.json(
        { valid: false, error: application.error ?? "Promo code could not be applied" },
        { status: 400 }
      );
    }
    const promoResult = application.discount;

    return NextResponse.json({
      valid: true,
      // Never expose the internal code for work-party validations; the
      // client identifies the discount by the event instead.
      code: workPartyEvent ? null : promoCode!.code,
      description: workPartyEvent ? null : promoCode!.description,
      type: promoCode!.type,
      workPartyEvent,
      discountCents: promoResult.discountCents,
      promoAdjustmentCents: promoResult.priceAdjustmentCents,
      freeNightsUsed: promoResult.freeNightsUsed,
      eligibleGuestCount: promoResult.eligibleGuestCount,
      remainingFreeNights: application.remainingFreeNights,
      selectedGuestIndexes: application.selectedGuestIndexes,
      totalPriceCents: price.totalPriceCents,
      finalPriceCents: price.totalPriceCents + promoResult.priceAdjustmentCents,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to calculate price";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
