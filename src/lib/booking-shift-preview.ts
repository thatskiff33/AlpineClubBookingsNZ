import { NextResponse } from "next/server";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { usesActiveBookingEditLifecycle } from "@/lib/booking-edit-policy";
import {
  findBookingMemberNightConflicts,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import { dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import { addDaysDateOnly, eachDateOnlyInRange, parseDateOnly } from "@/lib/date-only";
import { getDefaultLodgeId } from "@/lib/lodges";
import { markCrossFamilyGuestsOnBooking } from "@/lib/member-guest-add-policy";
import { overCapacityNights } from "@/lib/over-capacity-confirmation";
import { prisma } from "@/lib/prisma";
import { storedDateOnly } from "@/lib/stored-calendar-day";

// Split verbatim out of `src/app/api/bookings/[id]/modify-quote/route.ts`
// (#3128), which was nine times its 250-line route budget. This branch of the
// handler shares none of the quote pipeline's request-scoped state — it takes a
// booking, two date strings and the club's day, and answers on its own — so it
// was the one seam in that file that could be cut without carrying a closure
// with it. Nothing was re-exported from the route: its `POST` imports this
// directly, and it is the only caller.

/**
 * Shift-mode admin override preview (issue #1668): a pure-translation quote that
 * must match {@link adminShiftBookingDates} exactly for the same input. Every
 * money field echoes the stored booking; the only thing that can vary is
 * whether the shifted nights are over capacity, which the UI surfaces as an
 * explicit confirm rather than a hard error.
 */
// TRANSCRIBED, not imported, by `booking-date-modification-frame-parity.test.ts`
// → `previewShift`: change this and update that oracle in the same commit (#3088).
export async function buildShiftPreviewResponse({
  booking,
  bookingId,
  actorMemberId,
  actorRole,
  newCheckInStr,
  newCheckOutStr,
  todayAtClub,
}: {
  booking: {
    memberId: string;
    status: string;
    checkIn: Date;
    checkOut: Date;
    lodgeId: string | null;
    totalPriceCents: number;
    discountCents: number;
    promoAdjustmentCents: number;
    finalPriceCents: number;
    guests: Array<{
      memberId?: string | null;
      stayStart: Date;
      stayEnd: Date;
      nights: Array<{ stayDate: Date }>;
    }>;
  };
  bookingId: string;
  actorMemberId: string;
  actorRole: "ADMIN" | "USER";
  newCheckInStr?: string;
  newCheckOutStr?: string;
  /**
   * The CLUB's calendar day, resolved once by `POST` and threaded in
   * (`INV-CONFIG-002`). Required and undefaulted: the person-night guard below
   * never resolves a day for itself, because its authoritative callers reach it
   * from inside locked booking-write transactions (`INV-LOCK-004`).
   */
  todayAtClub: CalendarDate;
}): Promise<NextResponse> {
  const oldCheckIn = storedDateOnly(booking.checkIn);
  const oldCheckOut = storedDateOnly(booking.checkOut);
  const originalNightCount = eachDateOnlyInRange(oldCheckIn, oldCheckOut).length;

  const providedCheckIn = newCheckInStr ? parseDateOnly(newCheckInStr) : null;
  const providedCheckOut = newCheckOutStr ? parseDateOnly(newCheckOutStr) : null;
  if (
    (providedCheckIn && Number.isNaN(providedCheckIn.getTime())) ||
    (providedCheckOut && Number.isNaN(providedCheckOut.getTime()))
  ) {
    return NextResponse.json({ error: "Invalid booking dates" }, { status: 400 });
  }

  let newCheckIn: Date;
  let newCheckOut: Date;
  if (providedCheckIn && providedCheckOut) {
    newCheckIn = providedCheckIn;
    newCheckOut = providedCheckOut;
  } else if (providedCheckIn) {
    newCheckIn = providedCheckIn;
    newCheckOut = addDaysDateOnly(providedCheckIn, originalNightCount);
  } else if (providedCheckOut) {
    newCheckOut = providedCheckOut;
    newCheckIn = addDaysDateOnly(providedCheckOut, -originalNightCount);
  } else {
    return NextResponse.json(
      { error: "Provide a new check-in or check-out date" },
      { status: 400 },
    );
  }

  if (newCheckOut <= newCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 },
    );
  }
  const newNightCount = eachDateOnlyInRange(newCheckIn, newCheckOut).length;
  if (newNightCount !== originalNightCount) {
    return NextResponse.json(
      {
        error:
          'Shift dates only moves the stay without changing its length — use "Recalculate price" to change the number of nights',
      },
      { status: 400 },
    );
  }

  // Whole-day delta between two UTC-midnight date-only values (DST-safe).
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const deltaDays = Math.round(
    (newCheckIn.getTime() - oldCheckIn.getTime()) / MS_PER_DAY,
  );

  const translatedRanges = booking.guests.map((guest) => ({
    memberId: guest.memberId ?? null,
    stayStart: addDaysDateOnly(storedDateOnly(guest.stayStart), deltaDays),
    stayEnd: addDaysDateOnly(storedDateOnly(guest.stayEnd), deltaDays),
    nights: guest.nights.map((night) =>
      addDaysDateOnly(storedDateOnly(night.stayDate), deltaDays),
    ),
  }));

  // C1 (privacy re-review of MG3 #2308, LOW-3). The source contract checks
  // EVERY person-night guard call, not just the first, and this file's one call
  // is checked like any other. Today it is unreachable except under
  // `adminOverride`, so `skipAuthorization` is always true here and the call
  // returns without a query — but that is a property of today's gating, not of
  // this function, and the whole point of C1 was that an unmarked party is a
  // silent read-out. Marking every caller uniformly costs nothing and cannot be
  // forgotten if the shift preview is ever opened up.
  //
  // This paragraph used to say "the file's SECOND guard call" and "the only
  // member-facing caller is the one above". Both were true in
  // `modify-quote/route.ts`, where this function lived until #3128 moved it
  // here; neither survived the move, and the second one argued — wrongly, from
  // here — that the mark below is redundant belt-and-braces. Recorded rather
  // than silently overwritten: prose that moves verbatim can still land false,
  // and this is what that looks like. The route's own guard call, the one that
  // WAS above, is still there.
  const translatedRangesForGuard = await markCrossFamilyGuestsOnBooking(
    prisma,
    booking.memberId,
    translatedRanges,
    { skipAuthorization: actorRole === "ADMIN", bookingId },
  );

  // Member-night conflicts hard-block the shift the same way apply does, so the
  // preview never shows a clean $0 quote for a move that would 409 on save.
  const memberNightConflicts = await findBookingMemberNightConflicts(prisma, {
    actorMemberId,
    actorRole,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests: translatedRangesForGuard,
    excludeBookingId: bookingId,
    today: dateOnlyInstantOf(todayAtClub),
  });
  if (memberNightConflicts.length > 0) {
    return NextResponse.json(
      getBookingMemberNightConflictResponse(memberNightConflicts),
      { status: 409 },
    );
  }

  const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(prisma));
  // Non-lifecycle statuses hold no capacity, so a shift cannot overbook — skip
  // the check exactly like adminShiftBookingDates does so preview matches apply.
  const capacity = usesActiveBookingEditLifecycle(booking.status)
    ? await checkCapacityForGuestRanges(
        bookingLodgeId,
        newCheckIn,
        newCheckOut,
        translatedRanges,
        bookingId,
      )
    : { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };

  return NextResponse.json({
    newTotalPriceCents: booking.totalPriceCents,
    newDiscountCents: booking.discountCents,
    newPromoAdjustmentCents: booking.promoAdjustmentCents,
    newFinalPriceCents: booking.finalPriceCents,
    priceDiffCents: 0,
    changeFeeCents: 0,
    netChargeCents: 0,
    settlementOptions: null,
    capacityAvailable: capacity.available,
    minimumStayValid: true,
    minimumStayViolations: [],
    exceptionReview: { violations: [], capacityMode: null },
    promoStillValid: true,
    // An admin date SHIFT holds every price as it stands, so no cap is re-run.
    promoCoverage: null,
    promoValidation: null,
    itemizedChanges: [
      {
        label: `Dates shifted by ${Math.abs(deltaDays)} night(s) — price unchanged`,
        amountCents: 0,
      },
    ],
    ...(capacity.available
      ? {}
      : {
          overCapacityConfirmRequired: true,
          nightDetails: overCapacityNights(capacity),
        }),
  });
}
