import type { AgeTier } from "@prisma/client";
import {
  calculateBookingPrice,
  type SeasonRateData,
} from "@/lib/pricing";
import { normalizeDateOnlyForTimeZone } from "@/lib/date-only";

export interface ExistingBookingEditGuest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  priceCents: number;
}

export interface AddedBookingEditGuest {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
}

export interface ProposedExistingGuestRange {
  guest: ExistingBookingEditGuest;
  stayStart: Date;
  stayEnd: Date;
  priceCents: number;
  oldFuturePriceCents: number;
  newFuturePriceCents: number;
  futureDeltaCents: number;
  removedFromFuture: boolean;
}

export interface ProposedAddedGuestRange {
  guest: AddedBookingEditGuest;
  stayStart: Date;
  stayEnd: Date;
  priceCents: number;
}

export interface BookingEditGuestRangePlan {
  proposedExistingGuests: ProposedExistingGuestRange[];
  proposedAddedGuests: ProposedAddedGuestRange[];
  remainingGuests: ExistingBookingEditGuest[];
  removedGuests: ExistingBookingEditGuest[];
  newTotalPriceCents: number;
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  futureExistingDeltaCents: number;
  futureActiveGuestCount: number;
  capacityGuestRanges: Array<{
    stayStart: Date;
    stayEnd: Date;
  }>;
}

export interface BuildInProgressGuestRangePlanInput {
  booking: {
    checkIn: Date;
    checkOut: Date;
    totalPriceCents: number;
    discountCents: number;
    promoAdjustmentCents: number;
    finalPriceCents: number;
    guests: ExistingBookingEditGuest[];
  };
  editableFrom: Date;
  newCheckOut: Date;
  addGuests?: AddedBookingEditGuest[];
  removeGuestIds?: string[];
  seasons: SeasonRateData[];
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

function priceGuestRangeCents(
  start: Date,
  end: Date,
  guest: Pick<ExistingBookingEditGuest, "ageTier" | "isMember">,
  seasons: SeasonRateData[]
): number {
  const normalizedStart = normalizeDateOnlyForTimeZone(start);
  const normalizedEnd = normalizeDateOnlyForTimeZone(end);
  if (normalizedEnd <= normalizedStart) {
    return 0;
  }

  return calculateBookingPrice(
    normalizedStart,
    normalizedEnd,
    [{ ageTier: guest.ageTier, isMember: guest.isMember }],
    seasons
  ).totalPriceCents;
}

function hasFutureOverlap(stayStart: Date, stayEnd: Date, editableFrom: Date) {
  return maxDate(stayStart, editableFrom) < stayEnd;
}

export function buildInProgressGuestRangePlan(
  input: BuildInProgressGuestRangePlanInput
): BookingEditGuestRangePlan {
  const editableFrom = normalizeDateOnlyForTimeZone(input.editableFrom);
  const bookingCheckIn = normalizeDateOnlyForTimeZone(input.booking.checkIn);
  const bookingCheckOut = normalizeDateOnlyForTimeZone(input.booking.checkOut);
  const newCheckOut = normalizeDateOnlyForTimeZone(input.newCheckOut);
  const addGuests = input.addGuests ?? [];
  const removeSet = new Set(input.removeGuestIds ?? []);

  if (newCheckOut < editableFrom) {
    throw new Error("Check-out cannot move before NZ tomorrow");
  }

  if (addGuests.length > 0 && newCheckOut <= editableFrom) {
    throw new Error("Guests can only be added when the booking has future nights");
  }

  const remainingGuests = input.booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = input.booking.guests.filter((g) => removeSet.has(g.id));
  const proposedExistingGuests = input.booking.guests.map((guest) => {
    const stayStart = normalizeDateOnlyForTimeZone(guest.stayStart ?? bookingCheckIn);
    const stayEnd = normalizeDateOnlyForTimeZone(guest.stayEnd ?? bookingCheckOut);
    const oldFutureStart = maxDate(stayStart, editableFrom);
    const oldFuturePriceCents = priceGuestRangeCents(
      oldFutureStart,
      stayEnd,
      guest,
      input.seasons
    );
    const removedFromFuture = removeSet.has(guest.id);
    const proposedStayEnd = removedFromFuture
      ? minDate(stayEnd, editableFrom)
      : newCheckOut;
    const newFutureStart = maxDate(stayStart, editableFrom);
    const newFuturePriceCents = removedFromFuture
      ? 0
      : priceGuestRangeCents(newFutureStart, proposedStayEnd, guest, input.seasons);
    const futureDeltaCents = newFuturePriceCents - oldFuturePriceCents;

    return {
      guest,
      stayStart,
      stayEnd: proposedStayEnd,
      priceCents: guest.priceCents + futureDeltaCents,
      oldFuturePriceCents,
      newFuturePriceCents,
      futureDeltaCents,
      removedFromFuture,
    };
  });

  const proposedAddedGuests = addGuests.map((guest) => ({
    guest,
    stayStart: editableFrom,
    stayEnd: newCheckOut,
    priceCents: priceGuestRangeCents(editableFrom, newCheckOut, guest, input.seasons),
  }));

  const futureActiveGuestCount =
    proposedExistingGuests.filter(
      (entry) =>
        !entry.removedFromFuture &&
        hasFutureOverlap(entry.stayStart, entry.stayEnd, editableFrom)
    ).length + proposedAddedGuests.length;

  if (newCheckOut > editableFrom && futureActiveGuestCount === 0) {
    throw new Error("Booking must have at least one guest for future nights");
  }

  const newTotalPriceCents =
    proposedExistingGuests.reduce((sum, entry) => sum + entry.priceCents, 0) +
    proposedAddedGuests.reduce((sum, entry) => sum + entry.priceCents, 0);
  const newDiscountCents = input.booking.discountCents;
  const newPromoAdjustmentCents = input.booking.promoAdjustmentCents;
  const newFinalPriceCents = newTotalPriceCents + newPromoAdjustmentCents;
  const priceDiffCents = newFinalPriceCents - input.booking.finalPriceCents;
  const futureExistingDeltaCents = proposedExistingGuests.reduce(
    (sum, entry) => sum + entry.futureDeltaCents,
    0
  );
  const capacityGuestRanges = [
    ...proposedExistingGuests
      .filter(
        (entry) =>
          !entry.removedFromFuture &&
          hasFutureOverlap(entry.stayStart, entry.stayEnd, editableFrom)
      )
      .map((entry) => ({
        stayStart: maxDate(entry.stayStart, editableFrom),
        stayEnd: entry.stayEnd,
      })),
    ...proposedAddedGuests.map((entry) => ({
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
    })),
  ];

  return {
    proposedExistingGuests,
    proposedAddedGuests,
    remainingGuests,
    removedGuests,
    newTotalPriceCents,
    newDiscountCents,
    newPromoAdjustmentCents,
    newFinalPriceCents,
    priceDiffCents,
    futureExistingDeltaCents,
    futureActiveGuestCount,
    capacityGuestRanges,
  };
}
