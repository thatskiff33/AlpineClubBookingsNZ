import {
  addDaysDateOnly,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";

export type BookingGuestStayRangeInput = {
  stayStart?: Date | string | null;
  stayEnd?: Date | string | null;
  // Explicit set of included nights (issue #713 — multi date range stays).
  // When present and non-empty, the guest stays exactly these nights (which may
  // be non-contiguous); stayStart/stayEnd are derived as the min/max envelope.
  nights?: ReadonlyArray<Date | string> | null;
};

export type NormalizedBookingGuestStayRange = {
  stayStart: Date;
  stayEnd: Date;
  // Present only when the guest was given an explicit night set; the booking
  // range is then auto-expanded by the caller to cover these nights.
  nights?: Date[];
};

export class BookingGuestStayRangeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingGuestStayRangeValidationError";
  }
}

function hasDateValue(value: Date | string | null | undefined): boolean {
  return value instanceof Date || (typeof value === "string" && value.trim() !== "");
}

function normalizeInputDate(value: Date | string, fieldName: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new BookingGuestStayRangeValidationError(`${fieldName} must be a valid date.`);
    }

    // A caller handing in a `Date` is handing in a stored calendar day, so read
    // it as one. The only live producer of this branch is a stored delta replay;
    // every member-supplied field on the input types is a string and takes the
    // `parseDateOnly` branch below.
    return storedDateOnly(value);
  }

  const trimmed = value.trim();
  if (!isDateOnlyString(trimmed)) {
    throw new BookingGuestStayRangeValidationError(`${fieldName} must use yyyy-mm-dd format.`);
  }

  const parsed = parseDateOnly(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new BookingGuestStayRangeValidationError(`${fieldName} must be a valid date.`);
  }

  return parsed;
}

/**
 * Normalize a guest's stay into a contiguous range or an explicit night set.
 *
 * Issue #713 replaced the old hard rejection of dates outside the booking
 * checkIn/checkOut with auto-expansion: this function no longer rejects
 * out-of-range dates. Instead it normalizes the guest's stay and the caller
 * expands the booking range to cover it (validating capacity + season-rate
 * coverage inside the advisory lock). The `booking` argument is still used to
 * default a guest with no dates to the whole booking range.
 */
export function normalizeGuestStayRange(
  guest: BookingGuestStayRangeInput,
  booking: { checkIn: Date; checkOut: Date },
  index: number
): NormalizedBookingGuestStayRange {
  // CT-4 (#2870), group F4b: THE STORED CALENDAR DAYS, read as themselves.
  //
  // These two lines were `normalizeDateOnlyForTimeZone`, which projected the
  // envelope through `APP_TIME_ZONE` — the identity for a club ahead of
  // Greenwich, the PREVIOUS DAY for one behind it. They default a guest who
  // supplied no dates of their own, which is what the member form sends for
  // every guest unless multi-range mode is open, so on a Denver club that guest
  // was priced, capacity-checked, frozen for an officer and executed a night
  // early. `checkIn`/`checkOut` are `@db.Date` lodge-night identities and take
  // no zone at all (`INV-DATE-019`, `INV-DATE-026`).
  //
  // BOTH callers of this default were affected, and the ledger recorded only
  // one. `resolveModificationStayRanges` normalises every ADDED guest here
  // against the final envelope, including a range-less one — while its own first
  // pass defaults that same guest to the unprojected envelope. So one call
  // computed the envelope in one frame and the guest's range in another, leaving
  // the guest a night outside the booking they were added to. Pinned on both the
  // environment and the host axis in
  // `__tests__/booking-range-less-guest-frame.test.ts`.
  const checkIn = storedDateOnly(booking.checkIn);
  const checkOut = storedDateOnly(booking.checkOut);
  const label = `Guest ${index + 1}`;

  // Explicit night set (multi date range mode): normalize, dedupe and sort.
  if (guest.nights && guest.nights.length > 0) {
    const byKey = new Map<string, Date>();
    guest.nights.forEach((night, nightIndex) => {
      const normalized = normalizeInputDate(
        night,
        `${label} night ${nightIndex + 1}`
      );
      byKey.set(formatDateOnly(normalized), normalized);
    });
    const sorted = [...byKey.values()].sort((a, b) => a.getTime() - b.getTime());
    if (sorted.length === 0) {
      throw new BookingGuestStayRangeValidationError(
        `${label}: select at least one night.`
      );
    }
    return {
      stayStart: sorted[0],
      stayEnd: addDaysDateOnly(sorted[sorted.length - 1], 1),
      nights: sorted,
    };
  }

  const hasStayStart = hasDateValue(guest.stayStart);
  const hasStayEnd = hasDateValue(guest.stayEnd);

  if (!hasStayStart && !hasStayEnd) {
    return { stayStart: checkIn, stayEnd: checkOut };
  }

  if (!hasStayStart || !hasStayEnd) {
    throw new BookingGuestStayRangeValidationError(
      `${label}: Date In and Date Out are both required.`
    );
  }

  const stayStart = normalizeInputDate(guest.stayStart as Date | string, `${label} Date In`);
  const stayEnd = normalizeInputDate(guest.stayEnd as Date | string, `${label} Date Out`);

  if (stayEnd <= stayStart) {
    throw new BookingGuestStayRangeValidationError(
      `${label}: Date Out must be after Date In.`
    );
  }

  // No range rejection: a guest whose dates fall outside the booking range
  // expands the booking range (issue #713). Single-range bookings whose guest
  // dates already sit within the range are unaffected.
  return { stayStart, stayEnd };
}

export function normalizeGuestStayRanges<Guest extends BookingGuestStayRangeInput>(
  guests: Guest[],
  booking: { checkIn: Date; checkOut: Date }
): Array<Guest & NormalizedBookingGuestStayRange> {
  return guests.map((guest, index) => ({
    ...guest,
    ...normalizeGuestStayRange(guest, booking, index),
  }));
}
