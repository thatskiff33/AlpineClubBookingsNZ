import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";
import { ApiError } from "@/lib/api-error";
import logger from "@/lib/logger";
import { clubTime } from "@/lib/club-time/server";
import { clubFormatValues } from "@/lib/club-format-server";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { getDefaultLodgeId } from "@/lib/lodges";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { paidByOrganiser } from "@/lib/group-organiser-paid";
import { isQuotePricedBooking } from "@/lib/booking-modify-validation";
import { multiPromoCodesEnabled } from "@/lib/promo-redemption-slot";
import { findActiveWorkPartyEventsForRange } from "@/lib/work-party";
import { bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import { bookingOwner } from "@/lib/booking-owner";
import { prepareBatchModificationForCallerTransaction } from "@/lib/booking-batch-modification-service";
import { EditFinancialReviewPendingError } from "@/lib/edit-financial-review";
import { getXeroLockGuardErrorResponse } from "@/lib/xero-period-lock-guard";
import {
  addBookingToWorkParty,
  workPartyBookingEligibility,
  WorkPartyCorrectionFiguresChangedError,
} from "@/lib/work-party-booking-correction";

const centsField = z.number().int().min(-100_000_000).max(100_000_000);

const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("preview"), workPartyEventId: z.string().min(1) }),
  z.object({
    mode: z.literal("apply"),
    workPartyEventId: z.string().min(1),
    notifyMember: z.boolean().optional(),
    // The figures the officer was shown by the preview; the save refuses if
    // the booking would now come out differently (#4030 C4).
    expectedFigures: z.object({
      previousFinalPriceCents: centsField,
      newFinalPriceCents: centsField,
      priceDiffCents: centsField,
      accountCreditAmountCents: centsField,
      appliedCreditGivenBackCents: centsField,
      additionalAmountCents: centsField,
      refundAmountCents: centsField,
      settlementMethod: z.enum(["card", "credit"]),
    }),
  }),
]);

/**
 * The work parties this booking could be added to (fork #119): every open work
 * party whose window overlaps the stay, each with the shared eligibility rule's
 * answer, so the admin booking page lists them with the reason a refused one
 * cannot be chosen. Booking Officers and Full Admins (`bookings:view`).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({ permission: { area: "bookings", level: "view" } });
  if (!guard.ok) return guard.response;
  // The action exists only with the Work Parties module on: a switched-off
  // module can never affect a booking's price (as at booking create).
  if (!(await loadEffectiveModuleFlags()).workParties) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: {
      status: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      memberId: true,
      organiserSettled: true,
      parentBookingId: true,
      payment: { select: { source: true } },
      promoRedemptions: {
        select: {
          id: true,
          applicationOrder: true,
          promoCode: {
            select: { workPartyEvent: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  const redemptions = bookingPromoRedemptions(booking);
  const current =
    redemptions.find((row) => row.promoCode?.workPartyEvent)?.promoCode?.workPartyEvent ?? null;
  const [bookingLodgeId, today, quotePriced, multiPromoCodes, events] = await Promise.all([
    booking.lodgeId ?? getDefaultLodgeId(prisma),
    clubTodayDateOnlyInstant(),
    isQuotePricedBooking(prisma, id),
    multiPromoCodesEnabled(prisma),
    // Every lodge's, so one at another lodge is listed with its reason.
    findActiveWorkPartyEventsForRange(booking.checkIn, booking.checkOut, prisma),
  ]);
  const eligibilityBooking = {
    status: booking.status,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    hasWorkParty: current !== null,
    hasOtherPromoCode: redemptions.some((row) => row.promoCode && !row.promoCode.workPartyEvent),
    paidByOrganiser: paidByOrganiser(booking),
    quotePriced,
    memberOwned: Boolean(bookingOwner(booking).memberId),
  };

  return NextResponse.json({
    currentWorkParty: current,
    workParties: events.map((event) => {
      const eligibility = workPartyBookingEligibility(
        eligibilityBooking,
        { bookingLodgeId, today, multiPromoCodes },
        event,
      );
      return {
        id: event.id,
        name: event.name,
        startDate: calendarDateOfDateOnlyInstant(event.startDate),
        endDate: calendarDateOfDateOnlyInstant(event.endDate),
        discountPercent: event.discountPercent,
        lodgeName: event.lodge?.name ?? null,
        eligible: eligibility.ok,
        reason: eligibility.ok ? null : eligibility.reason,
      };
    }),
  });
}

/**
 * "Add booking to work party" (fork #119). `mode: "preview"` runs the whole
 * change and rolls it back, returning the figures for the confirm dialog;
 * `mode: "apply"` saves it, refusing if the figures moved since the preview.
 * Booking Officers and Full Admins (`bookings:edit`); the service re-authorises
 * the officer under its locks. The work and the money rules are in
 * `src/lib/work-party-booking-correction.ts`.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({ permission: { area: "bookings", level: "edit" } });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  if (!(await loadEffectiveModuleFlags()).workParties) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Everything the transaction must not read under its locks (INV-LOCK-004).
  const [club, format, preTransaction] = await Promise.all([
    clubTime(),
    clubFormatValues(),
    prepareBatchModificationForCallerTransaction({ audience: "admin" }),
  ]);
  const common = {
    bookingId: id,
    workPartyEventId: parsed.data.workPartyEventId,
    actorMemberId: session.user.id,
    ipAddress: getClientIp(req),
    todayAtClub: club.today(),
    format,
    preTransaction,
  };

  try {
    const result =
      parsed.data.mode === "preview"
        ? await addBookingToWorkParty({ ...common, dryRun: true })
        : await addBookingToWorkParty({
            ...common,
            dryRun: false,
            expectedFigures: parsed.data.expectedFigures,
            ...(parsed.data.notifyMember === undefined
              ? {}
              : { notifyMember: parsed.data.notifyMember }),
          });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkPartyCorrectionFiguresChangedError) {
      return NextResponse.json(
        { error: error.message, code: error.code, figures: error.actual },
        { status: 409 },
      );
    }
    const xeroLock = getXeroLockGuardErrorResponse(error);
    if (xeroLock) {
      return NextResponse.json(xeroLock.body, { status: xeroLock.status });
    }
    if (error instanceof EditFinancialReviewPendingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error(
      { err: error, bookingId: id, workPartyEventId: parsed.data.workPartyEventId },
      "Adding a booking to a work party failed",
    );
    return NextResponse.json(
      { error: "The booking could not be added to the work party. Nothing was changed." },
      { status: 500 },
    );
  }
}
