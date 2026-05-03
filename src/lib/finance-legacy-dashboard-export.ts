import { BookingStatus, Prisma } from "@prisma/client";
import {
  FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES,
  FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES,
  FINANCE_REALIZED_BOOKING_STATUSES,
} from "@/lib/finance-booking-metrics";
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

export interface LegacyDashboardBookingRow {
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

export interface LegacyDashboardForwardBookingRow
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
  if (parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} must be a valid date`);
  }

  return parsed;
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
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
      `${booking.checkIn.toISOString().slice(0, 10)}T00:00:00.000Z`
    ),
    checkOutDate: new Date(
      `${booking.checkOut.toISOString().slice(0, 10)}T00:00:00.000Z`
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
    created_date: input.booking.createdAt.toISOString().slice(0, 10),
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
    });

    if (!row) {
      continue;
    }

    const originalCheckInDate = new Date(
      `${booking.checkIn.toISOString().slice(0, 10)}T00:00:00.000Z`
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
