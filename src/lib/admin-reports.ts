import { BookingStatus, PaymentStatus } from "@prisma/client";
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import {
  addUtcDays,
  allocateCentsEvenly,
  buildIsoDateRange,
  differenceInUtcDays,
  parseFinanceBookingMetricDate,
} from "@/lib/finance-booking-metric-calculations";
import {
  getGuestStayEnd,
  getGuestStayStart,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { formatDateOnly } from "@/lib/date-only";

export type RevenueGranularity = "daily" | "weekly" | "monthly";

/**
 * The Base Reports population is deliberately positive and exhaustive. New
 * BookingStatus values do not silently become revenue merely because they are
 * not CANCELLED/BUMPED (#2368).
 */
export const REPORT_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.AWAITING_REVIEW,
  BookingStatus.COMPLETED,
] as const;

export type ReportBookingStatus = (typeof REPORT_BOOKING_STATUSES)[number];

export interface ReportGuestLike extends GuestStayRange {
  id: string;
  isMember: boolean;
}

export interface RevenueBookingLike {
  id: string;
  checkIn: Date;
  checkOut: Date;
  finalPriceCents: number;
  status: BookingStatus;
  guests: ReportGuestLike[];
}

export interface RevenueDataPoint {
  periodStart: string;
  periodEnd: string;
  label: string;
  tooltipLabel: string;
  revenueCents: number;
  bookingCount: number;
}

export interface BookingTrendDataPoint {
  week: string;
  total: number;
  pending: number;
  paymentPending: number;
  confirmed: number;
  paid: number;
  awaitingReview: number;
  completed: number;
}

export interface ReportGuestSummary {
  totalGuests: number;
  memberGuests: number;
  nonMemberGuests: number;
}

const MONDAY_WEEK = { weekStartsOn: 1 as const };

// test seam
export function getRevenueGranularity(rangeStart: Date, rangeEnd: Date): RevenueGranularity {
  const daySpan = differenceInCalendarDays(rangeEnd, rangeStart) + 1;
  if (daySpan <= 14) {
    return "daily";
  }
  if (daySpan <= 90) {
    return "weekly";
  }
  return "monthly";
}

export function getRevenueGranularityLabel(granularity: RevenueGranularity): string {
  if (granularity === "daily") {
    return "Day";
  }
  if (granularity === "weekly") {
    return "Week";
  }
  return "Month";
}

/**
 * Allocate the WHOLE booking price across all lodge nights, then return only
 * the inclusive selected range. The order is significant: a $1.00 three-night
 * stay is 34/33/33 cents even when the report selects only its second night.
 */
export function getBookingRevenueByNight(
  booking: Pick<RevenueBookingLike, "checkIn" | "checkOut" | "finalPriceCents">,
  rangeStart: Date,
  rangeEnd: Date,
): Array<{ date: string; revenueCents: number }> {
  const checkIn = toUtcDateOnly(booking.checkIn);
  const checkOut = toUtcDateOnly(booking.checkOut);
  const totalStayNights = differenceInUtcDays(checkIn, checkOut);
  if (totalStayNights < 1) return [];

  const allNightRevenue = allocateCentsEvenly(booking.finalPriceCents, totalStayNights);
  const selectedStart = maxDate(checkIn, toUtcDateOnly(rangeStart));
  const selectedEndExclusive = minDate(checkOut, addUtcDays(toUtcDateOnly(rangeEnd), 1));
  if (selectedStart >= selectedEndExclusive) return [];

  const offset = differenceInUtcDays(checkIn, selectedStart);
  const selectedDates = buildIsoDateRange(selectedStart, addUtcDays(selectedEndExclusive, -1));
  return selectedDates.map((date, index) => ({
    date,
    revenueCents: allNightRevenue[offset + index] ?? 0,
  }));
}

export function buildRevenueSeries(
  bookings: RevenueBookingLike[],
  rangeStart: Date,
  rangeEnd: Date,
): { granularity: RevenueGranularity; data: RevenueDataPoint[] } {
  const granularity = getRevenueGranularity(rangeStart, rangeEnd);
  const buckets = initializeBuckets(rangeStart, rangeEnd, granularity);
  const bookingIdsByBucket = new Map<string, Set<string>>();

  for (const booking of bookings) {
    if (!isReportBookingStatus(booking.status)) continue;
    for (const night of getBookingRevenueByNight(booking, rangeStart, rangeEnd)) {
      const key = getBucketKey(parseFinanceBookingMetricDate(night.date, "night"), granularity);
      const bucket = buckets.get(key);
      if (!bucket) continue;

      bucket.revenueCents += night.revenueCents;
      const bookingIds = bookingIdsByBucket.get(key) ?? new Set<string>();
      bookingIds.add(booking.id);
      bookingIdsByBucket.set(key, bookingIds);
      bucket.bookingCount = bookingIds.size;
    }
  }

  return {
    granularity,
    data: Array.from(buckets.values()),
  };
}

export function buildBookingTrendSeries(
  bookings: RevenueBookingLike[],
  rangeStart: Date,
  rangeEnd: Date,
): BookingTrendDataPoint[] {
  const weeklyBuckets = initializeBuckets(rangeStart, rangeEnd, "weekly");
  const rows = new Map<string, BookingTrendDataPoint>();
  const bookingIdsByBucket = new Map<string, Set<string>>();

  for (const key of weeklyBuckets.keys()) {
    rows.set(key, emptyTrendRow(key));
  }

  for (const booking of bookings) {
    if (!isReportBookingStatus(booking.status)) continue;
    const touchedBuckets = new Set(
      getBookingRevenueByNight(booking, rangeStart, rangeEnd).map((night) =>
        getBucketKey(parseFinanceBookingMetricDate(night.date, "night"), "weekly"),
      ),
    );

    for (const key of touchedBuckets) {
      const row = rows.get(key);
      if (!row) continue;
      const bookingIds = bookingIdsByBucket.get(key) ?? new Set<string>();
      bookingIds.add(booking.id);
      bookingIdsByBucket.set(key, bookingIds);
      row.total = bookingIds.size;
      row[trendStatusKey(booking.status)] += 1;
    }
  }

  return Array.from(rows.values());
}

/**
 * Count each overlapping BookingGuest row once, even on a multi-night stay.
 *
 * EVERY KEY IN HERE IS A CALENDAR DAY AND NO ZONE TOUCHES ANY OF THEM (CT-4,
 * #2870). `BookingGuest.stayStart`/`stayEnd` and `Booking.checkIn`/`checkOut`
 * are `@db.Date`, and the route hands `rangeStart`/`rangeEnd` in the same
 * encoding, so all four sides are UTC-midnight encodings of a day and not
 * moments (INV-DATE-010), and `formatDateOnly` is the whole of the decoding —
 * INV-DATE-019's first exact boundary with INV-DATE-026, which are the citation
 * for a decode where INV-DATE-010 is not (#3080).
 *
 * BOTH SIDES USED TO BE ZONE-DEPENDENT, in two DIFFERENT zones, and that is the
 * defect rather than a tidy-up. The guest keys went through
 * `formatDateOnlyForTimeZone`, which projects the value into `APP_TIME_ZONE`;
 * the range keys went through date-fns `format`, which reads the HOST's zone.
 * Both are the identity for a zone at or ahead of UTC, so New Zealand never saw
 * it. Measured for a club behind UTC: with the host at UTC and the club zone
 * `America/Denver`, the guest keys slide back a day while the range keys do not,
 * and a guest holding the last night of the window drops out of the count
 * entirely. Making only the guest half zone-free would break the mirror image —
 * a Denver HOST, where the range keys slide and the guest keys would not — so
 * both halves move together or neither does.
 */
export function summarizeOverlappingGuests(
  bookings: RevenueBookingLike[],
  rangeStart: Date,
  rangeEnd: Date,
): ReportGuestSummary {
  const selectedStartKey = formatDateOnly(toUtcDateOnly(rangeStart));
  const selectedEndExclusiveKey = formatDateOnly(
    addUtcDays(toUtcDateOnly(rangeEnd), 1),
  );
  const guests = new Map<string, ReportGuestLike>();

  for (const booking of bookings) {
    for (const guest of booking.guests) {
      const guestStartKey = formatDateOnly(getGuestStayStart(guest, booking));
      const guestEndKey = formatDateOnly(getGuestStayEnd(guest, booking));
      if (
        guestStartKey < selectedEndExclusiveKey &&
        guestEndKey > selectedStartKey
      ) {
        guests.set(guest.id, guest);
      }
    }
  }

  const rows = Array.from(guests.values());
  const memberGuests = rows.filter((guest) => guest.isMember).length;
  return {
    totalGuests: rows.length,
    memberGuests,
    nonMemberGuests: rows.length - memberGuests,
  };
}

/**
 * Cash is payment-derived and deliberately NOT allocated over stay nights.
 * `Payment.amountCents` already contains captured additions (#2408); rebuilding
 * it from transaction rows would undercount legacy/group captures or double
 * count a later addition.
 */
export function summarizeNetCollectedCash(
  payments: Array<{
    status: PaymentStatus | null;
    amountCents: number;
    refundedAmountCents: number;
  } | null>,
): number {
  let capturedGrossCents = 0;
  let refundedCents = 0;
  for (const payment of payments) {
    if (!payment) continue;
    if (
      payment.status === PaymentStatus.SUCCEEDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED ||
      payment.status === PaymentStatus.REFUNDED
    ) {
      capturedGrossCents += payment.amountCents;
    }
    refundedCents += payment.refundedAmountCents;
  }
  return Math.max(capturedGrossCents - refundedCents, 0);
}

function initializeBuckets(
  rangeStart: Date,
  rangeEnd: Date,
  granularity: RevenueGranularity,
): Map<string, RevenueDataPoint> {
  const buckets = new Map<string, RevenueDataPoint>();
  const endKey = toDateKey(rangeEnd);

  if (granularity === "daily") {
    for (
      let cursor = new Date(rangeStart);
      toDateKey(cursor) <= endKey;
      cursor = addDays(cursor, 1)
    ) {
      buckets.set(toDateKey(cursor), createBucket(cursor, cursor, granularity));
    }
    return buckets;
  }

  if (granularity === "weekly") {
    for (
      let cursor = startOfWeek(rangeStart, MONDAY_WEEK);
      toDateKey(cursor) <= endKey;
      cursor = addWeeks(cursor, 1)
    ) {
      const periodEnd = clampToRangeEnd(endOfWeek(cursor, MONDAY_WEEK), rangeEnd);
      buckets.set(toDateKey(cursor), createBucket(cursor, periodEnd, granularity));
    }
    return buckets;
  }

  for (
    let cursor = startOfMonth(rangeStart);
    toDateKey(cursor) <= endKey;
    cursor = addMonths(cursor, 1)
  ) {
    const periodEnd = clampToRangeEnd(endOfMonth(cursor), rangeEnd);
    buckets.set(toDateKey(cursor), createBucket(cursor, periodEnd, granularity));
  }

  return buckets;
}

function createBucket(
  periodStart: Date,
  periodEnd: Date,
  granularity: RevenueGranularity,
): RevenueDataPoint {
  return {
    periodStart: toDateKey(periodStart),
    periodEnd: toDateKey(periodEnd),
    label: formatBucketLabel(periodStart, granularity),
    tooltipLabel: formatBucketTooltip(periodStart, periodEnd, granularity),
    revenueCents: 0,
    bookingCount: 0,
  };
}

function formatBucketLabel(periodStart: Date, granularity: RevenueGranularity): string {
  if (granularity === "daily") return format(periodStart, "EEE d MMM");
  if (granularity === "weekly") return `Week of ${format(periodStart, "d MMM")}`;
  return format(periodStart, "MMM yyyy");
}

function formatBucketTooltip(
  periodStart: Date,
  periodEnd: Date,
  granularity: RevenueGranularity,
): string {
  if (granularity === "daily") return format(periodStart, "EEEE d MMMM yyyy");
  if (granularity === "weekly") {
    return `Week of ${format(periodStart, "d MMM yyyy")} to ${format(periodEnd, "d MMM yyyy")}`;
  }
  return format(periodStart, "MMMM yyyy");
}

function getBucketKey(date: Date, granularity: RevenueGranularity): string {
  if (granularity === "daily") return toDateKey(date);
  if (granularity === "weekly") return toDateKey(startOfWeek(date, MONDAY_WEEK));
  return toDateKey(startOfMonth(date));
}

function clampToRangeEnd(periodEnd: Date, rangeEnd: Date): Date {
  return isAfter(periodEnd, rangeEnd) ? rangeEnd : periodEnd;
}

function toDateKey(value: Date): string {
  return format(value, "yyyy-MM-dd");
}

function toUtcDateOnly(value: Date): Date {
  return parseFinanceBookingMetricDate(formatDateOnly(value), "date");
}

function minDate(left: Date, right: Date): Date {
  return left <= right ? left : right;
}

function maxDate(left: Date, right: Date): Date {
  return left >= right ? left : right;
}

function emptyTrendRow(week: string): BookingTrendDataPoint {
  return {
    week,
    total: 0,
    pending: 0,
    paymentPending: 0,
    confirmed: 0,
    paid: 0,
    awaitingReview: 0,
    completed: 0,
  };
}

function trendStatusKey(status: ReportBookingStatus): Exclude<keyof BookingTrendDataPoint, "week" | "total"> {
  switch (status) {
    case BookingStatus.PENDING:
      return "pending";
    case BookingStatus.PAYMENT_PENDING:
      return "paymentPending";
    case BookingStatus.CONFIRMED:
      return "confirmed";
    case BookingStatus.PAID:
      return "paid";
    case BookingStatus.AWAITING_REVIEW:
      return "awaitingReview";
    case BookingStatus.COMPLETED:
      return "completed";
  }
}

function isReportBookingStatus(status: BookingStatus): status is ReportBookingStatus {
  return (REPORT_BOOKING_STATUSES as readonly BookingStatus[]).includes(status);
}
