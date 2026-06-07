import {
  formatDateOnly,
  isDateOnlyString,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";

export type BookingGuestStayRangeInput = {
  stayStart?: Date | string | null;
  stayEnd?: Date | string | null;
};

export type NormalizedBookingGuestStayRange = {
  stayStart: Date;
  stayEnd: Date;
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

    return normalizeDateOnlyForTimeZone(value);
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

export function normalizeGuestStayRange(
  guest: BookingGuestStayRangeInput,
  booking: { checkIn: Date; checkOut: Date },
  index: number
): NormalizedBookingGuestStayRange {
  const checkIn = normalizeDateOnlyForTimeZone(booking.checkIn);
  const checkOut = normalizeDateOnlyForTimeZone(booking.checkOut);
  const hasStayStart = hasDateValue(guest.stayStart);
  const hasStayEnd = hasDateValue(guest.stayEnd);
  const label = `Guest ${index + 1}`;

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

  if (stayStart < checkIn || stayEnd > checkOut) {
    throw new BookingGuestStayRangeValidationError(
      `${label}: guest dates must stay within ${formatDateOnly(checkIn)} to ${formatDateOnly(checkOut)}.`
    );
  }

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
