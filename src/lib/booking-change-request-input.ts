import { z } from "zod";

import { GUEST_CHANGE_LIST_BOUND } from "@/lib/booking-guest-stay-range-input";

import {
  addedGuestNightsRefusal,
  changeRequestAddGuestsSchema,
  changeRequestGuestStayRangesSchema,
  guestStayRangesRefusal,
  isAppliedChangeRequestRange,
  requestedDatesIgnoredByNightsRefusal,
  type ChangeRequestAddGuest,
} from "@/lib/booking-change-request-guests";
import { changeRequestPromoChangeSchema } from "@/lib/booking-change-request-promo";
import { calendarDateOfDateOnlyInstant, dateOnlyInstantOf, parseCalendarDate } from "@/lib/club-time";
import type { LiveGuestStayRow } from "@/lib/booking-modification-stay-ranges";
import { storedDateOnly } from "@/lib/stored-calendar-day";

/** The proposal both submission and its added-guest estimate validate (INV-REQ-011). */
export const changeRequestDeltaSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: changeRequestAddGuestsSchema.optional(),
  removeGuestIds: z.array(z.string().trim().min(1)).max(...GUEST_CHANGE_LIST_BOUND).optional(),
  guestStayRanges: changeRequestGuestStayRangesSchema.optional(),
  requestedEffectiveDate: z.string().optional(),
});

/** The merged editor-and-card proposal, as both routes parse it. */
export type ChangeRequestDelta = z.infer<typeof changeRequestDeltaSchema>;

/**
 * `POST /api/bookings/[id]/change-requests` (ALP-794, `INV-SSOT`): the change,
 * the member's note to the officer and, #4533, an officer's promo correction
 * of a finished stay (Edit Booking).
 */
export const changeRequestCreateSchema = changeRequestDeltaSchema.extend({
  reason: z.string().max(2000).optional(),
  promoChange: changeRequestPromoChangeSchema.optional(),
});

/**
 * What the AI app action `request_booking_change` offers: the member's own
 * request, without the officer's promo correction, which the route refuses a
 * connection in any case.
 */
export const changeRequestConnectionCreateSchema = changeRequestCreateSchema.omit({ promoChange: true });

/**
 * `POST /api/bookings/[id]/change-requests/quote` (#4030 Part A): the guests a
 * request card adds, priced inside the whole proposal; only they are priced,
 * the rest of the proposal is validated.
 */
export const changeRequestEstimateSchema = z.object({
  addGuests: changeRequestAddGuestsSchema.nonempty(),
  editorChanges: changeRequestDeltaSchema.optional(),
});

/**
 * Preserve editor-first ordering at quote, estimate and submission
 * (INV-SSOT-001): the editor's added guests, then the card's.
 */
export function mergeChangeRequestGuests<Changes extends { addGuests?: readonly ChangeRequestAddGuest[] }>(
  editorChanges: Changes,
  cardGuests: readonly ChangeRequestAddGuest[],
): Changes {
  if (cardGuests.length === 0) return editorChanges;
  return {
    ...editorChanges,
    addGuests: [...(editorChanges.addGuests ?? []), ...cardGuests],
  };
}

export const CHANGE_REQUEST_UNKNOWN_REMOVED_GUEST_MESSAGE = "One or more guests were not found on this booking";
export const CHANGE_REQUEST_UNKNOWN_RANGE_GUEST_MESSAGE =
  "One or more guest stay ranges referenced a guest not found on this booking";

/**
 * #4203: a removal or a stay range naming a guest who is not on this booking,
 * refused the same way at submission and at the estimate, so neither reads (or
 * counts) a guest of another booking.
 */
export function unknownChangeRequestGuestRefusal(
  guests: ReadonlyArray<{ id: string }>,
  input: Pick<ChangeRequestDelta, "removeGuestIds" | "guestStayRanges">,
): string | null {
  const onBooking = new Set(guests.map((guest) => guest.id));
  if ((input.removeGuestIds ?? []).some((guestId) => !onBooking.has(guestId))) {
    return CHANGE_REQUEST_UNKNOWN_REMOVED_GUEST_MESSAGE;
  }
  if ((input.guestStayRanges ?? []).some((range) => !onBooking.has(range.guestId))) {
    return CHANGE_REQUEST_UNKNOWN_RANGE_GUEST_MESSAGE;
  }
  return null;
}

function normalizeOptionalDateOnly(value: string | undefined) {
  if (!value) return null;
  const parsed = parseCalendarDate(value);
  return parsed === null ? null : dateOnlyInstantOf(parsed);
}

/** Submission's date and night checks, in their original order, shared with quote. */
export function validateChangeRequestDatesAndNights(
  booking: { checkIn: Date; checkOut: Date; guests: ReadonlyArray<LiveGuestStayRow & { firstName: string; lastName: string }> },
  input: z.infer<typeof changeRequestDeltaSchema>,
) {
  const { checkIn, checkOut, addGuests, removeGuestIds, guestStayRanges: sentGuestStayRanges, requestedEffectiveDate } = input;
  const requestedCheckIn = normalizeOptionalDateOnly(checkIn);
  const requestedCheckOut = normalizeOptionalDateOnly(checkOut);
  const effectiveDate = normalizeOptionalDateOnly(requestedEffectiveDate);
  if ((checkIn && !requestedCheckIn) || (checkOut && !requestedCheckOut) || (requestedEffectiveDate && !effectiveDate)) {
    return { error: "Invalid booking date" };
  }

  const nextCheckIn = requestedCheckIn ?? storedDateOnly(booking.checkIn);
  const nextCheckOut = requestedCheckOut ?? storedDateOnly(booking.checkOut);
  if (nextCheckOut <= nextCheckIn) return { error: "Check-out must be after check-in" };

  const stay = { checkIn: calendarDateOfDateOnlyInstant(nextCheckIn), checkOut: calendarDateOfDateOnlyInstant(nextCheckOut) };
  const refusal =
    addedGuestNightsRefusal(addGuests ?? [], stay) ??
    guestStayRangesRefusal(sentGuestStayRanges ?? [], stay, booking.guests) ??
    requestedDatesIgnoredByNightsRefusal({
      booking,
      guests: booking.guests,
      input: {
        checkIn: requestedCheckIn,
        checkOut: requestedCheckOut,
        addGuests,
        removeGuestIds,
        guestStayRanges: sentGuestStayRanges?.filter(isAppliedChangeRequestRange),
      },
      movesCheckIn: Boolean(checkIn && checkIn !== calendarDateOfDateOnlyInstant(booking.checkIn)),
      movesCheckOut: Boolean(checkOut && checkOut !== calendarDateOfDateOnlyInstant(booking.checkOut)),
    });
  if (refusal) return { error: refusal };
  return { requestedCheckIn, requestedCheckOut, effectiveDate, nextCheckIn, nextCheckOut };
}
