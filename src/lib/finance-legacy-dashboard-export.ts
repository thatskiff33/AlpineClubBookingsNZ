import { BookingStatus, Prisma } from "@prisma/client";
import {
  FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES,
  FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES,
  FINANCE_REALIZED_BOOKING_STATUSES,
} from "@/lib/finance-booking-metrics";
import { clubCalendarDateOf, type ClubTimeZone } from "@/lib/club-time";
import { formatDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MILLISECONDS_PER_DAY = 86_400_000;

const legacyDashboardBookingExportSelect =
  Prisma.validator<Prisma.BookingSelect>()({
    id: true,
    checkIn: true,
    checkOut: true,
    status: true,
    finalPriceCents: true,
    createdAt: true,
    guests: {
      select: {
        id: true,
      },
    },
  });

type LegacyDashboardBookingExportRecord = Prisma.BookingGetPayload<{
  select: typeof legacyDashboardBookingExportSelect;
}>;

interface LegacyDashboardBookingRow {
  booking_id: string;
  start_date: string;
  end_date: string;
  created_date: string;
  status: BookingStatus;
  guests: number;
  nights: number;
  guest_nights: number;
  total: number;
}

interface LegacyDashboardForwardBookingRow
  extends LegacyDashboardBookingRow {
  pipeline_bucket: "COMMITTED" | "AT_RISK";
  days_until_arrival: number;
  month_of_stay: string;
}

export interface LegacyDashboardBookingExportResult {
  generatedAt: string;
  historyStartDate: string;
  asOfDate: string;
  bookings: LegacyDashboardBookingRow[];
  forward_bookings: LegacyDashboardForwardBookingRow[];
}

function parseIsoDate(value: string, fieldName: string): Date {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (formatDateOnly(parsed) !== value) {
    throw new Error(`${fieldName} must be a valid date`);
  }

  return parsed;
}

function toIsoDate(value: Date): string {
  return formatDateOnly(value);
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MILLISECONDS_PER_DAY);
}

function differenceInUtcDays(start: Date, end: Date): number {
  return Math.max(
    Math.round((end.getTime() - start.getTime()) / MILLISECONDS_PER_DAY),
    0
  );
}

function allocateCentsEvenly(totalCents: number, parts: number): number[] {
  if (parts <= 0) {
    return [];
  }

  const base = Math.floor(totalCents / parts);
  let remainder = totalCents - base * parts;

  return Array.from({ length: parts }, () => {
    if (remainder > 0) {
      remainder -= 1;
      return base + 1;
    }

    return base;
  });
}

function getBookingDateRange(booking: LegacyDashboardBookingExportRecord) {
  return {
    checkInDate: new Date(
      `${formatDateOnly(booking.checkIn)}T00:00:00.000Z`
    ),
    checkOutDate: new Date(
      `${formatDateOnly(booking.checkOut)}T00:00:00.000Z`
    ),
  };
}

function getSlice(booking: LegacyDashboardBookingExportRecord, input: {
  fromDate: Date;
  toDateExclusive: Date;
}) {
  const { checkInDate, checkOutDate } = getBookingDateRange(booking);
  const overlapStart =
    checkInDate.getTime() >= input.fromDate.getTime()
      ? checkInDate
      : input.fromDate;
  const overlapEndExclusive =
    checkOutDate.getTime() <= input.toDateExclusive.getTime()
      ? checkOutDate
      : input.toDateExclusive;
  const totalStayNights = differenceInUtcDays(checkInDate, checkOutDate);

  if (totalStayNights < 1 || overlapStart.getTime() >= overlapEndExclusive.getTime()) {
    return null;
  }

  return {
    overlapStart,
    overlapEndExclusive,
    totalStayNights,
    overlapNights: differenceInUtcDays(overlapStart, overlapEndExclusive),
    bookingIndexOffset: differenceInUtcDays(checkInDate, overlapStart),
  };
}

function sumSliceRevenueCents(input: {
  totalCents: number;
  totalStayNights: number;
  bookingIndexOffset: number;
  overlapNights: number;
}) {
  const revenueByNight = allocateCentsEvenly(
    input.totalCents,
    input.totalStayNights
  );

  return revenueByNight
    .slice(
      input.bookingIndexOffset,
      input.bookingIndexOffset + input.overlapNights
    )
    .reduce((total, cents) => total + cents, 0);
}

function toLegacyDashboardBookingRow(input: {
  booking: LegacyDashboardBookingExportRecord;
  overlapStart: Date;
  overlapEndExclusive: Date;
  overlapNights: number;
  totalStayNights: number;
  bookingIndexOffset: number;
  clubTimeZone: ClubTimeZone;
}): LegacyDashboardBookingRow | null {
  const guestCount = input.booking.guests.length;

  if (guestCount < 1 || input.overlapNights < 1) {
    return null;
  }

  const bookedRevenueCents = sumSliceRevenueCents({
    totalCents: input.booking.finalPriceCents,
    totalStayNights: input.totalStayNights,
    bookingIndexOffset: input.bookingIndexOffset,
    overlapNights: input.overlapNights,
  });

  return {
    booking_id: input.booking.id,
    start_date: toIsoDate(input.overlapStart),
    end_date: toIsoDate(input.overlapEndExclusive),
    // `createdAt` is a `DateTime` instant, unlike every other date in this row.
    // Truncating an instant to its UTC day is the pattern INV-DATE-019 forbids:
    // it reported the booking as created a day early for every booking made
    // before ~midday NZ, and mixed two definitions of "day" inside one payload
    // (#2697). The other dates here are true `@db.Date` lodge nights, whose UTC
    // midnight IS the encoding of a calendar day and not a moment
    // (INV-DATE-010), so they are correctly left on truncation — INV-DATE-019's
    // first exact boundary with INV-DATE-026, which is what blesses that decode
    // rather than INV-DATE-010 (#3080).
    //
    // The zone is the CLUB's persisted one, supplied by the caller (CT-5,
    // #2869). It used to default to `APP_TIME_ZONE` — `process.env.TZ` — so a
    // report column moved by a day when the container moved region, which is
    // precisely what issue #2869 s4 says a report date must never do.
    created_date: clubCalendarDateOf(input.booking.createdAt, input.clubTimeZone),
    status: input.booking.status,
    guests: guestCount,
    nights: input.overlapNights,
    guest_nights: guestCount * input.overlapNights,
    total: Number((bookedRevenueCents / 100).toFixed(2)),
  };
}

function getLegacyDashboardExportStatuses(): BookingStatus[] {
  return [
    ...new Set<BookingStatus>([
      ...FINANCE_REALIZED_BOOKING_STATUSES,
      ...FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES,
      ...FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES,
    ]),
  ];
}

export async function getLegacyDashboardBookingExport(input: {
  historyStartDate: string;
  asOfDate: string;
  /**
   * The club's persisted civil-time zone (`INV-CONFIG-002`). Required, with no
   * default: a default here would be the environment authority CT-5 removes.
   */
  clubTimeZone: ClubTimeZone;
}): Promise<LegacyDashboardBookingExportResult> {
  const historyStartDate = parseIsoDate(
    input.historyStartDate,
    "historyStartDate"
  );
  const asOfDate = parseIsoDate(input.asOfDate, "asOfDate");
  const forwardStartDate = addUtcDays(asOfDate, 1);

  const bookings = await prisma.booking.findMany({
    where: {
      checkOut: {
        gt: historyStartDate,
      },
      status: {
        in: getLegacyDashboardExportStatuses(),
      },
    },
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
    select: legacyDashboardBookingExportSelect,
  });

  const realizedRows: LegacyDashboardBookingRow[] = [];
  const forwardRows: LegacyDashboardForwardBookingRow[] = [];

  for (const booking of bookings) {
    if (FINANCE_REALIZED_BOOKING_STATUSES.includes(booking.status as never)) {
      const slice = getSlice(booking, {
        fromDate: historyStartDate,
        toDateExclusive: forwardStartDate,
      });

      if (slice) {
        const row = toLegacyDashboardBookingRow({
          booking,
          overlapStart: slice.overlapStart,
          overlapEndExclusive: slice.overlapEndExclusive,
          overlapNights: slice.overlapNights,
          totalStayNights: slice.totalStayNights,
          bookingIndexOffset: slice.bookingIndexOffset,
          clubTimeZone: input.clubTimeZone,
        });

        if (row) {
          realizedRows.push(row);
        }
      }
    }

    const pipelineBucket = FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES.includes(
      booking.status as never
    )
      ? "COMMITTED"
      : FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES.includes(booking.status as never)
        ? "AT_RISK"
        : null;

    if (!pipelineBucket) {
      continue;
    }

    const slice = getSlice(booking, {
      fromDate: forwardStartDate,
      toDateExclusive: addUtcDays(new Date("9999-12-31T00:00:00.000Z"), 1),
    });

    if (!slice) {
      continue;
    }

    const row = toLegacyDashboardBookingRow({
      booking,
      overlapStart: slice.overlapStart,
      overlapEndExclusive: slice.overlapEndExclusive,
      overlapNights: slice.overlapNights,
      totalStayNights: slice.totalStayNights,
      bookingIndexOffset: slice.bookingIndexOffset,
      clubTimeZone: input.clubTimeZone,
    });

    if (!row) {
      continue;
    }

    const originalCheckInDate = new Date(
      `${formatDateOnly(booking.checkIn)}T00:00:00.000Z`
    );

    forwardRows.push({
      ...row,
      pipeline_bucket: pipelineBucket,
      days_until_arrival: Math.max(
        differenceInUtcDays(asOfDate, originalCheckInDate),
        0
      ),
      month_of_stay: row.start_date.slice(0, 7),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    historyStartDate: input.historyStartDate,
    asOfDate: input.asOfDate,
    bookings: realizedRows,
    forward_bookings: forwardRows,
  };
}
