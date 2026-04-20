import { BookingStatus, PaymentStatus, Prisma } from "@prisma/client";
import { LODGE_CAPACITY } from "@/lib/capacity";
import { prisma } from "@/lib/prisma";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MILLISECONDS_PER_DAY = 86_400_000;

export const FINANCE_REALIZED_BOOKING_STATUSES = [
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
] as const;

export const FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES = [
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
] as const;

export const FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES = [
  BookingStatus.PENDING,
] as const;

const FINANCE_CAPTURED_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
]);

const PAYMENT_STATUS_KEYS = [
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
  PaymentStatus.SUCCEEDED,
  PaymentStatus.FAILED,
  PaymentStatus.REFUNDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  "NONE",
] as const;

const ADDITIONAL_PAYMENT_STATUS_KEYS = [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "NONE",
] as const;

const bookingMetricsSelect = Prisma.validator<Prisma.BookingSelect>()({
  id: true,
  checkIn: true,
  checkOut: true,
  status: true,
  finalPriceCents: true,
  guests: {
    select: {
      id: true,
    },
  },
  payment: {
    select: {
      status: true,
      amountCents: true,
      refundedAmountCents: true,
      changeFeeCents: true,
      creditAppliedCents: true,
      additionalAmountCents: true,
      additionalPaymentStatus: true,
    },
  },
});

type BookingMetricsRecord = Prisma.BookingGetPayload<{
  select: typeof bookingMetricsSelect;
}>;

type RealizedBookingStatus = (typeof FINANCE_REALIZED_BOOKING_STATUSES)[number];
type ForwardCommittedBookingStatus =
  (typeof FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES)[number];
type ForwardAtRiskBookingStatus =
  (typeof FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES)[number];
type FinancePaymentStatusKey = (typeof PAYMENT_STATUS_KEYS)[number];
type FinanceAdditionalPaymentStatusKey =
  (typeof ADDITIONAL_PAYMENT_STATUS_KEYS)[number];

export interface FinanceBookingMetricsDateRangeInput {
  from: string;
  to: string;
}

export interface FinanceRealizedStayMetricsQuery
  extends FinanceBookingMetricsDateRangeInput {
  cutoffDate?: string;
}

export interface FinanceForwardBookingMetricsQuery
  extends FinanceBookingMetricsDateRangeInput {
  asOfDate?: string;
}

export interface FinanceBookingMetricsQuery {
  realized?: FinanceRealizedStayMetricsQuery;
  forward?: FinanceForwardBookingMetricsQuery;
}

export interface FinanceBookingMetricsWindow {
  from: string;
  to: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  dayCount: number;
}

export interface FinanceBookingOccupancySummary {
  occupiedBedNights: number;
  capacityBedNights: number;
  occupancyRate: number;
}

export interface FinanceBookingStatusSummary {
  bookingCount: number;
  bookingNights: number;
  guestNights: number;
  bookedRevenueCents: number;
}

export interface FinanceBookingDailyMetric {
  date: string;
  bookingCount: number;
  guestNights: number;
  occupiedBeds: number;
  availableBeds: number;
  occupancyRate: number;
  bookedRevenueCents: number;
}

export interface FinanceBookingPipelineDailyMetric {
  date: string;
  committed: FinanceBookingDailyMetric;
  atRisk: FinanceBookingDailyMetric;
  totalPipeline: FinanceBookingDailyMetric;
}

export interface FinanceBookingBucketSummary {
  bookingCount: number;
  bookingNights: number;
  guestNights: number;
  bookedRevenueCents: number;
  occupancy: FinanceBookingOccupancySummary;
}

export interface FinanceBookingMetricsPaymentSummary {
  bookingCount: number;
  bookingsWithPayment: number;
  bookingsWithoutPayment: number;
  paymentStatusBreakdown: Record<FinancePaymentStatusKey, number>;
  additionalPaymentStatusBreakdown: Record<
    FinanceAdditionalPaymentStatusKey,
    number
  >;
  capturedPrimaryCents: number;
  capturedAdditionalCents: number;
  refundedCents: number;
  netCollectedCents: number;
  creditAppliedCents: number;
  changeFeeCents: number;
}

export interface FinanceRealizedStayMetrics {
  window: FinanceBookingMetricsWindow & {
    cutoffDate: string;
  };
  totals: FinanceBookingBucketSummary & {
    averageNightlyRevenueCents: number | null;
  };
  statusBreakdown: Record<RealizedBookingStatus, FinanceBookingStatusSummary>;
  byDate: FinanceBookingDailyMetric[];
}

export interface FinanceForwardBookingMetrics {
  window: FinanceBookingMetricsWindow & {
    asOfDate: string;
  };
  totals: {
    committed: FinanceBookingBucketSummary & {
      statusBreakdown: Record<
        ForwardCommittedBookingStatus,
        FinanceBookingStatusSummary
      >;
    };
    atRisk: FinanceBookingBucketSummary & {
      statusBreakdown: Record<
        ForwardAtRiskBookingStatus,
        FinanceBookingStatusSummary
      >;
    };
    totalPipeline: FinanceBookingBucketSummary;
  };
  byDate: FinanceBookingPipelineDailyMetric[];
}

export interface FinanceBookingMetricsResult {
  generatedAt: string;
  bookingCount: number;
  paymentSummary: FinanceBookingMetricsPaymentSummary;
  realized?: FinanceRealizedStayMetrics;
  forward?: FinanceForwardBookingMetrics;
}

type DailyMetricAccumulator = {
  bookingCount: number;
  guestNights: number;
  bookedRevenueCents: number;
};

type StatusAccumulator = {
  bookingIds: Set<string>;
  bookingNights: number;
  guestNights: number;
  bookedRevenueCents: number;
};

type BucketAccumulator<Status extends string> = {
  bookingIds: Set<string>;
  bookingNights: number;
  guestNights: number;
  bookedRevenueCents: number;
  byDate: Map<string, DailyMetricAccumulator>;
  statusBreakdown: Record<Status, StatusAccumulator>;
};

type NormalizedDateWindow = {
  from: string;
  to: string;
  fromDate: Date;
  toDate: Date;
};

type NormalizedRealizedWindow = NormalizedDateWindow & {
  cutoffDate: string;
  effectiveFrom: string | null;
  effectiveFromDate: Date | null;
  effectiveTo: string | null;
  effectiveToDate: Date | null;
  dayCount: number;
};

type NormalizedForwardWindow = NormalizedDateWindow & {
  asOfDate: string;
  effectiveFrom: string | null;
  effectiveFromDate: Date | null;
  effectiveTo: string | null;
  effectiveToDate: Date | null;
  dayCount: number;
};

function zeroStatusBreakdown<Status extends string>(
  statuses: readonly Status[]
): Record<Status, number> {
  return statuses.reduce(
    (accumulator, status) => {
      accumulator[status] = 0;
      return accumulator;
    },
    {} as Record<Status, number>
  );
}

function createZeroPaymentSummary(): FinanceBookingMetricsPaymentSummary {
  return {
    bookingCount: 0,
    bookingsWithPayment: 0,
    bookingsWithoutPayment: 0,
    paymentStatusBreakdown: zeroStatusBreakdown(PAYMENT_STATUS_KEYS),
    additionalPaymentStatusBreakdown: zeroStatusBreakdown(
      ADDITIONAL_PAYMENT_STATUS_KEYS
    ),
    capturedPrimaryCents: 0,
    capturedAdditionalCents: 0,
    refundedCents: 0,
    netCollectedCents: 0,
    creditAppliedCents: 0,
    changeFeeCents: 0,
  };
}

function createEmptyDailyMetric(date: string): FinanceBookingDailyMetric {
  return {
    date,
    bookingCount: 0,
    guestNights: 0,
    occupiedBeds: 0,
    availableBeds: LODGE_CAPACITY,
    occupancyRate: 0,
    bookedRevenueCents: 0,
  };
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

function normalizeDateWindow(
  input: FinanceBookingMetricsDateRangeInput,
  prefix: string
): NormalizedDateWindow {
  const fromDate = parseIsoDate(input.from, `${prefix}.from`);
  const toDate = parseIsoDate(input.to, `${prefix}.to`);

  if (fromDate.getTime() > toDate.getTime()) {
    throw new Error(`${prefix}.to must be on or after ${prefix}.from`);
  }

  return {
    from: input.from,
    to: input.to,
    fromDate,
    toDate,
  };
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function maxDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function minDateFromList(values: Date[]): Date {
  return values.reduce((currentMin, value) => minDate(currentMin, value));
}

function maxDateFromList(values: Date[]): Date {
  return values.reduce((currentMax, value) => maxDate(currentMax, value));
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

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function buildIsoDateRange(start: Date, endInclusive: Date): string[] {
  const dates: string[] = [];

  for (
    let cursor = start;
    cursor.getTime() <= endInclusive.getTime();
    cursor = addUtcDays(cursor, 1)
  ) {
    dates.push(toIsoDate(cursor));
  }

  return dates;
}

function getCurrentIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeRealizedWindow(
  input: FinanceRealizedStayMetricsQuery
): NormalizedRealizedWindow {
  const base = normalizeDateWindow(input, "realized");
  const cutoffDate = input.cutoffDate ?? input.to;
  const cutoff = parseIsoDate(cutoffDate, "realized.cutoffDate");
  const effectiveToDate =
    cutoff.getTime() < base.fromDate.getTime()
      ? null
      : minDate(base.toDate, cutoff);

  return {
    ...base,
    cutoffDate,
    effectiveFrom: effectiveToDate ? base.from : null,
    effectiveFromDate: effectiveToDate ? base.fromDate : null,
    effectiveTo: effectiveToDate ? toIsoDate(effectiveToDate) : null,
    effectiveToDate,
    dayCount: effectiveToDate
      ? differenceInUtcDays(base.fromDate, addUtcDays(effectiveToDate, 1))
      : 0,
  };
}

function normalizeForwardWindow(
  input: FinanceForwardBookingMetricsQuery
): NormalizedForwardWindow {
  const base = normalizeDateWindow(input, "forward");
  const asOfDate = input.asOfDate ?? getCurrentIsoDate();
  const asOf = parseIsoDate(asOfDate, "forward.asOfDate");
  const effectiveFromDate = maxDate(base.fromDate, addUtcDays(asOf, 1));
  const hasEffectiveWindow =
    effectiveFromDate.getTime() <= base.toDate.getTime();

  return {
    ...base,
    asOfDate,
    effectiveFrom: hasEffectiveWindow ? toIsoDate(effectiveFromDate) : null,
    effectiveFromDate: hasEffectiveWindow ? effectiveFromDate : null,
    effectiveTo: hasEffectiveWindow ? base.to : null,
    effectiveToDate: hasEffectiveWindow ? base.toDate : null,
    dayCount: hasEffectiveWindow
      ? differenceInUtcDays(effectiveFromDate, addUtcDays(base.toDate, 1))
      : 0,
  };
}

function createBucketAccumulator<Status extends string>(
  dates: string[],
  statuses: readonly Status[]
): BucketAccumulator<Status> {
  const byDate = new Map<string, DailyMetricAccumulator>();
  for (const date of dates) {
    byDate.set(date, {
      bookingCount: 0,
      guestNights: 0,
      bookedRevenueCents: 0,
    });
  }

  return {
    bookingIds: new Set<string>(),
    bookingNights: 0,
    guestNights: 0,
    bookedRevenueCents: 0,
    byDate,
    statusBreakdown: statuses.reduce(
      (accumulator, status) => {
        accumulator[status] = {
          bookingIds: new Set<string>(),
          bookingNights: 0,
          guestNights: 0,
          bookedRevenueCents: 0,
        };
        return accumulator;
      },
      {} as Record<Status, StatusAccumulator>
    ),
  };
}

function initializeDateMetrics(dates: string[]): FinanceBookingDailyMetric[] {
  return dates.map(createEmptyDailyMetric);
}

function getDailyMetricMap(
  rows: FinanceBookingDailyMetric[]
): Map<string, FinanceBookingDailyMetric> {
  return new Map(rows.map((row) => [row.date, row]));
}

function toOccupancySummary(
  guestNights: number,
  dayCount: number
): FinanceBookingOccupancySummary {
  const capacityBedNights = dayCount * LODGE_CAPACITY;

  return {
    occupiedBedNights: guestNights,
    capacityBedNights,
    occupancyRate:
      capacityBedNights > 0
        ? Number((guestNights / capacityBedNights).toFixed(4))
        : 0,
  };
}

function finalizeStatusBreakdown<Status extends string>(
  accumulators: Record<Status, StatusAccumulator>
): Record<Status, FinanceBookingStatusSummary> {
  const breakdown = {} as Record<Status, FinanceBookingStatusSummary>;

  for (const status of Object.keys(accumulators) as Status[]) {
    const accumulator = accumulators[status];

    breakdown[status] = {
      bookingCount: accumulator.bookingIds.size,
      bookingNights: accumulator.bookingNights,
      guestNights: accumulator.guestNights,
      bookedRevenueCents: accumulator.bookedRevenueCents,
    };
  }

  return breakdown;
}

function finalizeBucketSummary<Status extends string>(
  accumulator: BucketAccumulator<Status>,
  dayCount: number
): FinanceBookingBucketSummary {
  return {
    bookingCount: accumulator.bookingIds.size,
    bookingNights: accumulator.bookingNights,
    guestNights: accumulator.guestNights,
    bookedRevenueCents: accumulator.bookedRevenueCents,
    occupancy: toOccupancySummary(accumulator.guestNights, dayCount),
  };
}

function applyDailyMetrics<Status extends string>(
  accumulator: BucketAccumulator<Status>,
  dailyMetricMap: Map<string, FinanceBookingDailyMetric>
) {
  for (const [date, dailyAccumulator] of accumulator.byDate.entries()) {
    const row = dailyMetricMap.get(date);

    if (!row) {
      continue;
    }

    row.bookingCount = dailyAccumulator.bookingCount;
    row.guestNights = dailyAccumulator.guestNights;
    row.occupiedBeds = dailyAccumulator.guestNights;
    row.availableBeds = LODGE_CAPACITY - dailyAccumulator.guestNights;
    row.occupancyRate =
      LODGE_CAPACITY > 0
        ? Number((dailyAccumulator.guestNights / LODGE_CAPACITY).toFixed(4))
        : 0;
    row.bookedRevenueCents = dailyAccumulator.bookedRevenueCents;
  }
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

function getPaymentStatusKey(
  booking: BookingMetricsRecord
): FinancePaymentStatusKey {
  return booking.payment?.status ?? "NONE";
}

function getAdditionalPaymentStatusKey(
  booking: BookingMetricsRecord
): FinanceAdditionalPaymentStatusKey {
  if (!booking.payment?.additionalPaymentStatus) {
    return "NONE";
  }

  if (booking.payment.additionalPaymentStatus === "PENDING") {
    return "PENDING";
  }

  if (booking.payment.additionalPaymentStatus === "SUCCEEDED") {
    return "SUCCEEDED";
  }

  return "FAILED";
}

function summarizePayments(
  bookings: BookingMetricsRecord[]
): FinanceBookingMetricsPaymentSummary {
  const summary = createZeroPaymentSummary();

  summary.bookingCount = bookings.length;

  for (const booking of bookings) {
    const payment = booking.payment;

    if (!payment) {
      summary.bookingsWithoutPayment += 1;
      summary.paymentStatusBreakdown.NONE += 1;
      summary.additionalPaymentStatusBreakdown.NONE += 1;
      continue;
    }

    summary.bookingsWithPayment += 1;
    summary.paymentStatusBreakdown[getPaymentStatusKey(booking)] += 1;
    summary.additionalPaymentStatusBreakdown[
      getAdditionalPaymentStatusKey(booking)
    ] += 1;

    const capturedPrimaryCents = FINANCE_CAPTURED_PAYMENT_STATUSES.has(
      payment.status
    )
      ? payment.amountCents
      : 0;
    const capturedAdditionalCents =
      payment.additionalPaymentStatus === "SUCCEEDED"
        ? payment.additionalAmountCents
        : 0;

    summary.capturedPrimaryCents += capturedPrimaryCents;
    summary.capturedAdditionalCents += capturedAdditionalCents;
    summary.refundedCents += payment.refundedAmountCents;
    summary.creditAppliedCents += payment.creditAppliedCents;
    summary.changeFeeCents += payment.changeFeeCents;
  }

  summary.netCollectedCents = Math.max(
    summary.capturedPrimaryCents +
      summary.capturedAdditionalCents -
      summary.refundedCents,
    0
  );

  return summary;
}

function accumulateBookingIntoBucket<Status extends string>(input: {
  booking: BookingMetricsRecord;
  bucket: BucketAccumulator<Status>;
  bucketStatus: Status;
  contributingDates: string[];
  revenueByNight: number[];
  bookingIndexOffset: number;
}) {
  const {
    booking,
    bucket,
    bucketStatus,
    contributingDates,
    revenueByNight,
    bookingIndexOffset,
  } = input;
  const guestCount = booking.guests.length;

  if (guestCount < 1 || contributingDates.length < 1) {
    return;
  }

  bucket.bookingIds.add(booking.id);
  bucket.bookingNights += contributingDates.length;
  bucket.guestNights += guestCount * contributingDates.length;

  const statusAccumulator = bucket.statusBreakdown[bucketStatus];
  statusAccumulator.bookingIds.add(booking.id);
  statusAccumulator.bookingNights += contributingDates.length;
  statusAccumulator.guestNights += guestCount * contributingDates.length;

  for (const [index, date] of contributingDates.entries()) {
    const dailyAccumulator = bucket.byDate.get(date);
    const nightlyRevenue = revenueByNight[bookingIndexOffset + index] ?? 0;

    if (!dailyAccumulator) {
      continue;
    }

    dailyAccumulator.bookingCount += 1;
    dailyAccumulator.guestNights += guestCount;
    dailyAccumulator.bookedRevenueCents += nightlyRevenue;

    bucket.bookedRevenueCents += nightlyRevenue;
    statusAccumulator.bookedRevenueCents += nightlyRevenue;
  }
}

function getBookingDateRange(booking: BookingMetricsRecord) {
  return {
    checkInDate: new Date(booking.checkIn.toISOString().slice(0, 10) + "T00:00:00.000Z"),
    checkOutDate: new Date(
      booking.checkOut.toISOString().slice(0, 10) + "T00:00:00.000Z"
    ),
  };
}

function getContributingDates(input: {
  booking: BookingMetricsRecord;
  effectiveFromDate: Date | null;
  effectiveToDate: Date | null;
}) {
  if (!input.effectiveFromDate || !input.effectiveToDate) {
    return {
      dates: [] as string[],
      bookingIndexOffset: 0,
      totalStayNights: 0,
    };
  }

  const { checkInDate, checkOutDate } = getBookingDateRange(input.booking);
  const totalStayNights = differenceInUtcDays(checkInDate, checkOutDate);

  if (totalStayNights < 1) {
    return {
      dates: [] as string[],
      bookingIndexOffset: 0,
      totalStayNights: 0,
    };
  }

  const effectiveEndExclusive = addUtcDays(input.effectiveToDate, 1);
  const overlapStart = maxDate(checkInDate, input.effectiveFromDate);
  const overlapEndExclusive = minDate(checkOutDate, effectiveEndExclusive);

  if (overlapStart.getTime() >= overlapEndExclusive.getTime()) {
    return {
      dates: [] as string[],
      bookingIndexOffset: 0,
      totalStayNights,
    };
  }

  return {
    dates: buildIsoDateRange(overlapStart, addUtcDays(overlapEndExclusive, -1)),
    bookingIndexOffset: differenceInUtcDays(checkInDate, overlapStart),
    totalStayNights,
  };
}

function buildRealizedMetrics(
  window: NormalizedRealizedWindow,
  bookings: BookingMetricsRecord[],
  contributingBookingIds: Set<string>
): FinanceRealizedStayMetrics {
  const dates =
    window.effectiveFromDate && window.effectiveToDate
      ? buildIsoDateRange(window.effectiveFromDate, window.effectiveToDate)
      : [];
  const byDate = initializeDateMetrics(dates);
  const bucket = createBucketAccumulator(
    dates,
    FINANCE_REALIZED_BOOKING_STATUSES
  );

  for (const booking of bookings) {
    if (!FINANCE_REALIZED_BOOKING_STATUSES.includes(booking.status as never)) {
      continue;
    }

    const { dates: contributingDates, bookingIndexOffset, totalStayNights } =
      getContributingDates({
        booking,
        effectiveFromDate: window.effectiveFromDate,
        effectiveToDate: window.effectiveToDate,
      });

    if (contributingDates.length < 1 || totalStayNights < 1) {
      continue;
    }

    contributingBookingIds.add(booking.id);

    accumulateBookingIntoBucket({
      booking,
      bucket,
      bucketStatus: booking.status as RealizedBookingStatus,
      contributingDates,
      revenueByNight: allocateCentsEvenly(
        booking.finalPriceCents,
        totalStayNights
      ),
      bookingIndexOffset,
    });
  }

  applyDailyMetrics(bucket, getDailyMetricMap(byDate));

  const totals = finalizeBucketSummary(bucket, window.dayCount);

  return {
    window: {
      from: window.from,
      to: window.to,
      cutoffDate: window.cutoffDate,
      effectiveFrom: window.effectiveFrom,
      effectiveTo: window.effectiveTo,
      dayCount: window.dayCount,
    },
    totals: {
      ...totals,
      averageNightlyRevenueCents:
        totals.bookingNights > 0
          ? Math.round(totals.bookedRevenueCents / totals.bookingNights)
          : null,
    },
    statusBreakdown: finalizeStatusBreakdown(bucket.statusBreakdown),
    byDate,
  };
}

function combineDailyMetrics(
  date: string,
  left: FinanceBookingDailyMetric,
  right: FinanceBookingDailyMetric
): FinanceBookingDailyMetric {
  const occupiedBeds = left.occupiedBeds + right.occupiedBeds;

  return {
    date,
    bookingCount: left.bookingCount + right.bookingCount,
    guestNights: left.guestNights + right.guestNights,
    occupiedBeds,
    availableBeds: LODGE_CAPACITY - occupiedBeds,
    occupancyRate:
      LODGE_CAPACITY > 0
        ? Number((occupiedBeds / LODGE_CAPACITY).toFixed(4))
        : 0,
    bookedRevenueCents:
      left.bookedRevenueCents + right.bookedRevenueCents,
  };
}

function buildForwardMetrics(
  window: NormalizedForwardWindow,
  bookings: BookingMetricsRecord[],
  contributingBookingIds: Set<string>
): FinanceForwardBookingMetrics {
  const dates =
    window.effectiveFromDate && window.effectiveToDate
      ? buildIsoDateRange(window.effectiveFromDate, window.effectiveToDate)
      : [];
  const committedBucket = createBucketAccumulator(
    dates,
    FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES
  );
  const atRiskBucket = createBucketAccumulator(
    dates,
    FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES
  );
  const committedByDate = initializeDateMetrics(dates);
  const atRiskByDate = initializeDateMetrics(dates);

  for (const booking of bookings) {
    const committedStatus = FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES.includes(
      booking.status as never
    );
    const atRiskStatus = FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES.includes(
      booking.status as never
    );

    if (!committedStatus && !atRiskStatus) {
      continue;
    }

    const { dates: contributingDates, bookingIndexOffset, totalStayNights } =
      getContributingDates({
        booking,
        effectiveFromDate: window.effectiveFromDate,
        effectiveToDate: window.effectiveToDate,
      });

    if (contributingDates.length < 1 || totalStayNights < 1) {
      continue;
    }

    contributingBookingIds.add(booking.id);

    const revenueByNight = allocateCentsEvenly(
      booking.finalPriceCents,
      totalStayNights
    );

    if (committedStatus) {
      accumulateBookingIntoBucket({
        booking,
        bucket: committedBucket,
        bucketStatus: booking.status as ForwardCommittedBookingStatus,
        contributingDates,
        revenueByNight,
        bookingIndexOffset,
      });
    } else {
      accumulateBookingIntoBucket({
        booking,
        bucket: atRiskBucket,
        bucketStatus: booking.status as ForwardAtRiskBookingStatus,
        contributingDates,
        revenueByNight,
        bookingIndexOffset,
      });
    }
  }

  applyDailyMetrics(committedBucket, getDailyMetricMap(committedByDate));
  applyDailyMetrics(atRiskBucket, getDailyMetricMap(atRiskByDate));

  const byDate = dates.map((date, index) => ({
    date,
    committed: committedByDate[index],
    atRisk: atRiskByDate[index],
    totalPipeline: combineDailyMetrics(
      date,
      committedByDate[index],
      atRiskByDate[index]
    ),
  }));

  const committedTotals = finalizeBucketSummary(committedBucket, window.dayCount);
  const atRiskTotals = finalizeBucketSummary(atRiskBucket, window.dayCount);

  return {
    window: {
      from: window.from,
      to: window.to,
      asOfDate: window.asOfDate,
      effectiveFrom: window.effectiveFrom,
      effectiveTo: window.effectiveTo,
      dayCount: window.dayCount,
    },
    totals: {
      committed: {
        ...committedTotals,
        statusBreakdown: finalizeStatusBreakdown(committedBucket.statusBreakdown),
      },
      atRisk: {
        ...atRiskTotals,
        statusBreakdown: finalizeStatusBreakdown(atRiskBucket.statusBreakdown),
      },
      totalPipeline: {
        bookingCount:
          committedTotals.bookingCount + atRiskTotals.bookingCount,
        bookingNights:
          committedTotals.bookingNights + atRiskTotals.bookingNights,
        guestNights:
          committedTotals.guestNights + atRiskTotals.guestNights,
        bookedRevenueCents:
          committedTotals.bookedRevenueCents + atRiskTotals.bookedRevenueCents,
        occupancy: toOccupancySummary(
          committedTotals.guestNights + atRiskTotals.guestNights,
          window.dayCount
        ),
      },
    },
    byDate,
  };
}

function getStatusFilter(query: FinanceBookingMetricsQuery): BookingStatus[] {
  const statuses = new Set<BookingStatus>();

  if (query.realized) {
    for (const status of FINANCE_REALIZED_BOOKING_STATUSES) {
      statuses.add(status);
    }
  }

  if (query.forward) {
    for (const status of FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES) {
      statuses.add(status);
    }

    for (const status of FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES) {
      statuses.add(status);
    }
  }

  return [...statuses];
}

export async function getFinanceBookingMetrics(
  query: FinanceBookingMetricsQuery
): Promise<FinanceBookingMetricsResult> {
  if (!query.realized && !query.forward) {
    throw new Error("At least one finance booking metrics section is required");
  }

  const realizedWindow = query.realized
    ? normalizeRealizedWindow(query.realized)
    : null;
  const forwardWindow = query.forward
    ? normalizeForwardWindow(query.forward)
    : null;

  const activeWindows = [
    realizedWindow?.effectiveFromDate && realizedWindow.effectiveToDate
      ? {
          fromDate: realizedWindow.effectiveFromDate,
          toDate: realizedWindow.effectiveToDate,
        }
      : null,
    forwardWindow?.effectiveFromDate && forwardWindow.effectiveToDate
      ? {
          fromDate: forwardWindow.effectiveFromDate,
          toDate: forwardWindow.effectiveToDate,
        }
      : null,
  ].filter(
    (
      value
    ): value is {
      fromDate: Date;
      toDate: Date;
    } => Boolean(value)
  );

  const bookings =
    activeWindows.length > 0
      ? await prisma.booking.findMany({
          where: {
            checkIn: {
              lte: maxDateFromList(
                activeWindows.map((window) => window.toDate)
              ),
            },
            checkOut: {
              gt: minDateFromList(
                activeWindows.map((window) => window.fromDate)
              ),
            },
            status: {
              in: getStatusFilter(query),
            },
          },
          orderBy: [{ checkIn: "asc" }, { id: "asc" }],
          select: bookingMetricsSelect,
        })
      : [];
  const contributingBookingIds = new Set<string>();
  const realized = realizedWindow
    ? buildRealizedMetrics(realizedWindow, bookings, contributingBookingIds)
    : undefined;
  const forward = forwardWindow
    ? buildForwardMetrics(forwardWindow, bookings, contributingBookingIds)
    : undefined;
  const paymentSummary = summarizePayments(
    bookings.filter((booking) => contributingBookingIds.has(booking.id))
  );

  return {
    generatedAt: new Date().toISOString(),
    bookingCount: contributingBookingIds.size,
    paymentSummary,
    ...(realized ? { realized } : {}),
    ...(forward ? { forward } : {}),
  };
}
