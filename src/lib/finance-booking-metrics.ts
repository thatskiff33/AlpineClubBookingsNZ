import {
  BookingStatus,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import { summarizeAdditionalLedgerGap } from "@/lib/additional-ledger-gap";
import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { getDefaultLodgeCapacity, getLodgeCapacity } from "@/lib/lodge-capacity";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { countActiveGuestsForNight } from "@/lib/booking-guest-stay-ranges";
import { type CalendarDate } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { formatDateOnly } from "@/lib/date-only";
import {
  OPERATIONAL_STAY_BOOKING_STATUSES,
  PAYMENT_OWED_BOOKING_STATUSES,
} from "@/lib/booking-status";
import {
  addUtcDays,
  allocateCentsEvenly,
  buildIsoDateRange,
  differenceInUtcDays,
  getFinanceBookingMetricsWindowDayCount,
  parseFinanceBookingMetricDate as parseIsoDate,
} from "@/lib/finance-booking-metric-calculations";

export const MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS = 366;
export { getFinanceBookingMetricsWindowDayCount };

export const FINANCE_REALIZED_BOOKING_STATUSES = [
  ...OPERATIONAL_STAY_BOOKING_STATUSES,
] as const;

export const FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES = [
  BookingStatus.PAID,
] as const;

export const FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  ...PAYMENT_OWED_BOOKING_STATUSES,
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
      stayStart: true,
      stayEnd: true,
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
      // #2408: the ledger, not just the summary columns. The guard below has to
      // tell a genuinely collected price increase (a captured ADDITIONAL row,
      // which is therefore already inside `amountCents`) from a column that
      // merely CLAIMS one, and only the transactions can answer that.
      //
      // ADDITIONAL rows only. The cash total comes from `Payment.amountCents`,
      // never from the ledger — a payment can be captured with no PRIMARY row
      // behind it (an organiser-settled group booking, anything written before
      // the ledger existed), and rebuilding the total from rows would report
      // such a booking as having collected nothing. So the primary rows are
      // not needed, and a range covering a season should not drag them across
      // the wire. `kind` is still selected and re-checked in code: the filter
      // is an optimisation, not the correctness boundary.
      transactions: {
        where: { kind: PaymentTransactionKind.ADDITIONAL },
        select: {
          kind: true,
          status: true,
          amountCents: true,
        },
      },
    },
  },
});

type BookingMetricsRecord = Prisma.BookingGetPayload<{
  select: typeof bookingMetricsSelect;
}>;

/**
 * How many booking ids to name in the ledger-gap alarm. Enough to act on,
 * bounded so one bad import cannot flood the log.
 */
const MAX_LOGGED_LEDGER_GAP_BOOKINGS = 20;

type RealizedBookingStatus = (typeof FINANCE_REALIZED_BOOKING_STATUSES)[number];
type ForwardCommittedBookingStatus =
  (typeof FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES)[number];
type ForwardAtRiskBookingStatus =
  (typeof FINANCE_FORWARD_AT_RISK_BOOKING_STATUSES)[number];
type FinancePaymentStatusKey = (typeof PAYMENT_STATUS_KEYS)[number];
type FinanceAdditionalPaymentStatusKey =
  (typeof ADDITIONAL_PAYMENT_STATUS_KEYS)[number];

interface FinanceBookingMetricsDateRangeInput {
  from: string;
  to: string;
}

interface FinanceRealizedStayMetricsQuery
  extends FinanceBookingMetricsDateRangeInput {
  cutoffDate?: string;
}

interface FinanceForwardBookingMetricsQuery
  extends FinanceBookingMetricsDateRangeInput {
  asOfDate?: string;
}

export interface FinanceBookingMetricsQuery {
  realized?: FinanceRealizedStayMetricsQuery;
  forward?: FinanceForwardBookingMetricsQuery;
  // Reporting lodge scope (multi-lodge). When set, metrics cover only that
  // lodge (its bookings, its capacity). When omitted, metrics cover ALL active
  // lodges and the occupancy denominator is the SUM of their capacities — a
  // deliberate, reporting-only exception to the "never sum across lodges"
  // scoping rule (see docs/multi-lodge/scoping-contract).
  lodgeId?: string | null;
}

interface FinanceBookingMetricsWindow {
  from: string;
  to: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  dayCount: number;
}

interface FinanceBookingOccupancySummary {
  occupiedBedNights: number;
  capacityBedNights: number;
  occupancyRate: number;
}

interface FinanceBookingStatusSummary {
  bookingCount: number;
  bookingNights: number;
  guestNights: number;
  bookedRevenueCents: number;
}

interface FinanceBookingDailyMetric {
  date: string;
  bookingCount: number;
  guestNights: number;
  occupiedBeds: number;
  availableBeds: number;
  occupancyRate: number;
  bookedRevenueCents: number;
}

interface FinanceBookingPipelineDailyMetric {
  date: string;
  committed: FinanceBookingDailyMetric;
  atRisk: FinanceBookingDailyMetric;
  totalPipeline: FinanceBookingDailyMetric;
}

interface FinanceBookingBucketSummary {
  bookingCount: number;
  bookingNights: number;
  guestNights: number;
  bookedRevenueCents: number;
  occupancy: FinanceBookingOccupancySummary;
}

interface FinanceBookingMetricsPaymentSummary {
  bookingCount: number;
  bookingsWithPayment: number;
  bookingsWithoutPayment: number;
  paymentStatusBreakdown: Record<FinancePaymentStatusKey, number>;
  additionalPaymentStatusBreakdown: Record<
    FinanceAdditionalPaymentStatusKey,
    number
  >;
  /**
   * Gross captured cash: `Payment.amountCents` summed over the payments whose
   * status says money was taken.
   *
   * `reconcilePaymentAggregates` (src/lib/payment-transactions.ts) sets that
   * column to the sum of EVERY captured ledger row — PRIMARY and ADDITIONAL
   * alike — so this figure ALREADY contains any collected price increase.
   * #2408 renamed it from `capturedPrimaryCents`, which read as "the primary
   * leg only" and invited exactly the double count it caused: the net below
   * used to add `capturedAdditionalCents` to it and report a $121 booking with
   * a collected $21 addition as $142 collected.
   */
  capturedGrossCents: number;
  /**
   * How much of `capturedGrossCents` came from a later price increase. A
   * BREAKDOWN of that total, never an addend beside it (#2408).
   */
  capturedAdditionalCents: number;
  /**
   * #2350: upward booking changes whose extra was never collected (PENDING,
   * FAILED, or a legacy null status). Priced into the booking total, so it is
   * money the club has counted as booked but does not hold.
   */
  outstandingAdditionalCents: number;
  outstandingAdditionalBookings: number;
  /**
   * #2408 guard. Money on payments that CLAIM a collected price increase
   * (`additionalPaymentStatus = "SUCCEEDED"`, non-zero `additionalAmountCents`)
   * with no captured ADDITIONAL `PaymentTransaction` behind it.
   *
   * That is the one shape in which `capturedGrossCents` does NOT contain the
   * addition, and therefore the one shape in which `netCollectedCents`
   * understates the cash — by up to this amount. It does not exist in healthy
   * data (`reconcilePaymentAggregates` derives both columns from the latest
   * ADDITIONAL row, so a SUCCEEDED status implies a captured row), but an
   * import, a repair pass, or a future write path could produce it, and a
   * finance figure must never be quietly wrong. Non-zero means: reconcile those
   * payments' ledgers before trusting the collected total.
   */
  additionalLedgerGapCents: number;
  additionalLedgerGapBookings: number;
  refundedCents: number;
  /**
   * Cash the club actually holds for these bookings:
   * `capturedGrossCents - refundedCents`, floored at zero. Never sums the gross
   * and additional columns — see `capturedGrossCents` (#2408).
   */
  netCollectedCents: number;
  creditAppliedCents: number;
  changeFeeCents: number;
}

interface FinanceRealizedStayMetrics {
  window: FinanceBookingMetricsWindow & {
    cutoffDate: string;
  };
  totals: FinanceBookingBucketSummary & {
    averageNightlyRevenueCents: number | null;
  };
  statusBreakdown: Record<RealizedBookingStatus, FinanceBookingStatusSummary>;
  byDate: FinanceBookingDailyMetric[];
}

interface FinanceForwardBookingMetrics {
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
    capturedGrossCents: 0,
    capturedAdditionalCents: 0,
    outstandingAdditionalCents: 0,
    outstandingAdditionalBookings: 0,
    additionalLedgerGapCents: 0,
    additionalLedgerGapBookings: 0,
    refundedCents: 0,
    netCollectedCents: 0,
    creditAppliedCents: 0,
    changeFeeCents: 0,
  };
}

function createEmptyDailyMetric(
  date: string,
  lodgeCapacity: number,
): FinanceBookingDailyMetric {
  return {
    date,
    bookingCount: 0,
    guestNights: 0,
    occupiedBeds: 0,
    availableBeds: lodgeCapacity,
    occupancyRate: 0,
    bookedRevenueCents: 0,
  };
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

  const dayCount = getFinanceBookingMetricsWindowDayCount(input.from, input.to);
  if (dayCount > MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS) {
    throw new Error(
      `${prefix} window cannot exceed ${MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS} days`
    );
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
    effectiveTo: effectiveToDate ? formatDateOnly(effectiveToDate) : null,
    effectiveToDate,
    dayCount: effectiveToDate
      ? differenceInUtcDays(base.fromDate, addUtcDays(effectiveToDate, 1))
      : 0,
  };
}

/**
 * `todayAtClub` is the default `asOfDate` — the cut-off deciding which stays
 * count as forward-booked rather than realised.
 *
 * It used to be read here from `todayDateOnlyForTimeZone()`, which answers from
 * the CONTAINER's timezone rather than the club's persisted one (#3123,
 * `INV-CONFIG-002`). A club whose configured zone differs from its deployment's
 * would split one day's stays across the realised/forward boundary depending
 * on which side of the container's midnight the report ran — the same
 * "different figures with no input changed" complaint #2682 fixed from the UTC
 * side. This helper is pure and sync, so the day is resolved once in
 * `getFinanceBookingMetrics` and passed down (`INV-DATE-019`,
 * `docs/invariants/booking-dates-and-capacity.md`).
 */
function normalizeForwardWindow(
  input: FinanceForwardBookingMetricsQuery,
  todayAtClub: CalendarDate,
): NormalizedForwardWindow {
  const base = normalizeDateWindow(input, "forward");
  const asOfDate = input.asOfDate ?? todayAtClub;
  const asOf = parseIsoDate(asOfDate, "forward.asOfDate");
  const effectiveFromDate = maxDate(base.fromDate, addUtcDays(asOf, 1));
  const hasEffectiveWindow =
    effectiveFromDate.getTime() <= base.toDate.getTime();

  return {
    ...base,
    asOfDate,
    effectiveFrom: hasEffectiveWindow ? formatDateOnly(effectiveFromDate) : null,
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

function initializeDateMetrics(
  dates: string[],
  lodgeCapacity: number,
): FinanceBookingDailyMetric[] {
  return dates.map((date) => createEmptyDailyMetric(date, lodgeCapacity));
}

function getDailyMetricMap(
  rows: FinanceBookingDailyMetric[]
): Map<string, FinanceBookingDailyMetric> {
  return new Map(rows.map((row) => [row.date, row]));
}

function toOccupancySummary(
  guestNights: number,
  dayCount: number,
  lodgeCapacity: number,
): FinanceBookingOccupancySummary {
  const capacityBedNights = dayCount * lodgeCapacity;

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
  dayCount: number,
  lodgeCapacity: number,
): FinanceBookingBucketSummary {
  return {
    bookingCount: accumulator.bookingIds.size,
    bookingNights: accumulator.bookingNights,
    guestNights: accumulator.guestNights,
    bookedRevenueCents: accumulator.bookedRevenueCents,
    occupancy: toOccupancySummary(
      accumulator.guestNights,
      dayCount,
      lodgeCapacity,
    ),
  };
}

function applyDailyMetrics<Status extends string>(
  accumulator: BucketAccumulator<Status>,
  dailyMetricMap: Map<string, FinanceBookingDailyMetric>,
  lodgeCapacity: number,
) {
  for (const [date, dailyAccumulator] of accumulator.byDate.entries()) {
    const row = dailyMetricMap.get(date);

    if (!row) {
      continue;
    }

    row.bookingCount = dailyAccumulator.bookingCount;
    row.guestNights = dailyAccumulator.guestNights;
    row.occupiedBeds = dailyAccumulator.guestNights;
    row.availableBeds = lodgeCapacity - dailyAccumulator.guestNights;
    row.occupancyRate =
      lodgeCapacity > 0
        ? Number((dailyAccumulator.guestNights / lodgeCapacity).toFixed(4))
        : 0;
    row.bookedRevenueCents = dailyAccumulator.bookedRevenueCents;
  }
}

function getPaymentStatusKey(
  booking: BookingMetricsRecord
): FinancePaymentStatusKey {
  return booking.payment?.status ?? "NONE";
}

/**
 * Which bucket of the additional-payment split does this booking belong in?
 *
 * PENDING and FAILED mean "still owed", and they are gated on the SAME
 * `isAdditionalPaymentOwed` predicate as `outstandingAdditionalCents` /
 * `outstandingAdditionalBookings` below — because the finance panel renders the
 * three side by side as a split and its total. Without the gate they measured
 * different populations: the metrics window includes PENDING and
 * PAYMENT_PENDING bookings, and a PAYMENT_PENDING booking can legitimately
 * carry a delta (adding a guest to a booking with an issued Xero invoice raises
 * one), so "Awaiting payment 3 / Payment failed 0 / Total outstanding across 1
 * booking" was a panel disagreeing with itself. Legacy null-status rows read as
 * PENDING for the same reason — the owed test counts them, so the split must.
 *
 * SUCCEEDED stays ungated: it is a fact about the money, not about the queue,
 * and it is not part of the outstanding split. Everything else — including an
 * uncollected delta on a booking the owed test excludes — is NONE, meaning "not
 * in this queue", which is exactly what the total says about it too.
 */
function getAdditionalPaymentStatusKey(
  booking: BookingMetricsRecord
): FinanceAdditionalPaymentStatusKey {
  if (booking.payment?.additionalPaymentStatus === "SUCCEEDED") {
    return "SUCCEEDED";
  }

  if (
    !isAdditionalPaymentOwed({
      bookingStatus: booking.status,
      payment: booking.payment,
    })
  ) {
    return "NONE";
  }

  return booking.payment?.additionalPaymentStatus === "FAILED"
    ? "FAILED"
    : "PENDING";
}

function summarizePayments(
  bookings: BookingMetricsRecord[]
): FinanceBookingMetricsPaymentSummary {
  const summary = createZeroPaymentSummary();
  const ledgerGap = summarizeAdditionalLedgerGap(bookings);

  summary.bookingCount = bookings.length;
  summary.additionalLedgerGapCents = ledgerGap.additionalLedgerGapCents;
  summary.additionalLedgerGapBookings = ledgerGap.additionalLedgerGapBookings;

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

    // #2408. `Payment.amountCents` is the GROSS capture, not the primary leg:
    // `reconcilePaymentAggregates` (src/lib/payment-transactions.ts) sets it to
    // the sum of ALL captured ledger rows, PRIMARY and ADDITIONAL alike. So a
    // $121 booking whose $21 addition captured already carries
    // `amountCents = 121`, and the old net added the same $21 a second time to
    // report $142 collected. The addition is counted ONCE, here, by counting
    // the gross figure and nothing else.
    //
    // `capturedAdditionalCents` survives as the BREAKDOWN — how much of that
    // gross came from a later price increase — and must never be added back.
    //
    // Read from the COLUMN, never rebuilt by summing ledger rows. A captured
    // payment can legitimately have no PRIMARY row — an organiser-settled group
    // booking, or anything settled before the ledger existed — so a
    // ledger-derived total would report a booking that collected $121 as having
    // collected nothing, or (worse, once an addition exists) as having
    // collected only the $21.
    const capturedGrossCents = FINANCE_CAPTURED_PAYMENT_STATUSES.has(
      payment.status
    )
      ? payment.amountCents
      : 0;
    const claimsCollectedAdditional =
      payment.additionalPaymentStatus === "SUCCEEDED" &&
      payment.additionalAmountCents > 0;
    const capturedAdditionalCents = claimsCollectedAdditional
      ? payment.additionalAmountCents
      : 0;

    summary.capturedGrossCents += capturedGrossCents;
    summary.capturedAdditionalCents += capturedAdditionalCents;
    if (
      isAdditionalPaymentOwed({ bookingStatus: booking.status, payment })
    ) {
      summary.outstandingAdditionalCents += payment.additionalAmountCents;
      summary.outstandingAdditionalBookings += 1;
    }
    summary.refundedCents += payment.refundedAmountCents;
    summary.creditAppliedCents += payment.creditAppliedCents;
    summary.changeFeeCents += payment.changeFeeCents;
  }

  summary.netCollectedCents = Math.max(
    summary.capturedGrossCents - summary.refundedCents,
    0
  );

  if (ledgerGap.bookingIds.length > 0) {
    logger.error(
      {
        bookingIds: ledgerGap.bookingIds.slice(
          0,
          MAX_LOGGED_LEDGER_GAP_BOOKINGS
        ),
        bookingCount: summary.additionalLedgerGapBookings,
        additionalLedgerGapCents: summary.additionalLedgerGapCents,
        netCollectedCents: summary.netCollectedCents,
      },
      "Finance metrics: payments record a collected additional payment with no captured ADDITIONAL PaymentTransaction behind it. Net collected cash may understate by additionalLedgerGapCents. Reconcile those payments' ledgers (reconcilePaymentAggregates) before trusting the collected figure."
    );
  }

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
  const activeGuestCounts = contributingDates.map((date) =>
    countActiveGuestsForNight(
      booking.guests,
      new Date(`${date}T00:00:00.000Z`),
      booking
    )
  );
  const activeDateCount = activeGuestCounts.filter((count) => count > 0).length;
  const guestNightCount = activeGuestCounts.reduce(
    (total, count) => total + count,
    0
  );

  if (guestNightCount < 1 || activeDateCount < 1) {
    return;
  }

  bucket.bookingIds.add(booking.id);
  bucket.bookingNights += activeDateCount;
  bucket.guestNights += guestNightCount;

  const statusAccumulator = bucket.statusBreakdown[bucketStatus];
  statusAccumulator.bookingIds.add(booking.id);
  statusAccumulator.bookingNights += activeDateCount;
  statusAccumulator.guestNights += guestNightCount;

  for (const [index, date] of contributingDates.entries()) {
    const activeGuestCount = activeGuestCounts[index] ?? 0;
    if (activeGuestCount < 1) {
      continue;
    }

    const dailyAccumulator = bucket.byDate.get(date);
    const nightlyRevenue = revenueByNight[bookingIndexOffset + index] ?? 0;

    if (!dailyAccumulator) {
      continue;
    }

    dailyAccumulator.bookingCount += 1;
    dailyAccumulator.guestNights += activeGuestCount;
    dailyAccumulator.bookedRevenueCents += nightlyRevenue;

    bucket.bookedRevenueCents += nightlyRevenue;
    statusAccumulator.bookedRevenueCents += nightlyRevenue;
  }
}

function getBookingDateRange(booking: BookingMetricsRecord) {
  return {
    checkInDate: new Date(formatDateOnly(booking.checkIn) + "T00:00:00.000Z"),
    checkOutDate: new Date(
      formatDateOnly(booking.checkOut) + "T00:00:00.000Z"
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
  contributingBookingIds: Set<string>,
  lodgeCapacity: number,
): FinanceRealizedStayMetrics {
  const dates =
    window.effectiveFromDate && window.effectiveToDate
      ? buildIsoDateRange(window.effectiveFromDate, window.effectiveToDate)
      : [];
  const byDate = initializeDateMetrics(dates, lodgeCapacity);
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

  applyDailyMetrics(bucket, getDailyMetricMap(byDate), lodgeCapacity);

  const totals = finalizeBucketSummary(bucket, window.dayCount, lodgeCapacity);

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
  right: FinanceBookingDailyMetric,
  lodgeCapacity: number,
): FinanceBookingDailyMetric {
  const occupiedBeds = left.occupiedBeds + right.occupiedBeds;

  return {
    date,
    bookingCount: left.bookingCount + right.bookingCount,
    guestNights: left.guestNights + right.guestNights,
    occupiedBeds,
    availableBeds: lodgeCapacity - occupiedBeds,
    occupancyRate:
      lodgeCapacity > 0
        ? Number((occupiedBeds / lodgeCapacity).toFixed(4))
        : 0,
    bookedRevenueCents:
      left.bookedRevenueCents + right.bookedRevenueCents,
  };
}

function buildForwardMetrics(
  window: NormalizedForwardWindow,
  bookings: BookingMetricsRecord[],
  contributingBookingIds: Set<string>,
  lodgeCapacity: number,
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
  const committedByDate = initializeDateMetrics(dates, lodgeCapacity);
  const atRiskByDate = initializeDateMetrics(dates, lodgeCapacity);

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

  applyDailyMetrics(
    committedBucket,
    getDailyMetricMap(committedByDate),
    lodgeCapacity,
  );
  applyDailyMetrics(
    atRiskBucket,
    getDailyMetricMap(atRiskByDate),
    lodgeCapacity,
  );

  const byDate = dates.map((date, index) => ({
    date,
    committed: committedByDate[index],
    atRisk: atRiskByDate[index],
    totalPipeline: combineDailyMetrics(
      date,
      committedByDate[index],
      atRiskByDate[index],
      lodgeCapacity,
    ),
  }));

  const committedTotals = finalizeBucketSummary(
    committedBucket,
    window.dayCount,
    lodgeCapacity,
  );
  const atRiskTotals = finalizeBucketSummary(
    atRiskBucket,
    window.dayCount,
    lodgeCapacity,
  );

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
          window.dayCount,
          lodgeCapacity,
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

/**
 * Resolve the occupancy capacity denominator and the booking lodge filter for a
 * metrics query. A specific lodge uses that lodge's capacity and its bookings
 * (tolerating legacy null-lodge rows only when it is the default lodge); the
 * all-lodges view sums active-lodge capacity (the reporting-only exception to
 * the no-cross-lodge-sum rule) and counts every lodge's bookings.
 */
export async function resolveMetricsCapacityAndScope(
  lodgeId: string | null | undefined,
): Promise<{ capacity: number; bookingLodgeWhere: Prisma.BookingWhereInput }> {
  // Structural test mocks may omit the lodge delegate; fall back to the
  // default-lodge capacity (single-lodge behaviour), mirroring
  // getDefaultLodgeCapacity. In production the delegate is always present.
  const lodgeClient = prisma as { lodge?: { findMany?: unknown } };
  if (!lodgeClient.lodge?.findMany) {
    return {
      capacity: await getDefaultLodgeCapacity(),
      bookingLodgeWhere: lodgeId ? { lodgeId } : {},
    };
  }
  if (lodgeId) {
    const [capacity, defaultLodgeId] = await Promise.all([
      getLodgeCapacity(lodgeId),
      getDefaultLodgeId(prisma),
    ]);
    const bookingLodgeWhere: Prisma.BookingWhereInput =
      lodgeId === defaultLodgeId ? lodgeNullTolerantScope(lodgeId) : { lodgeId };
    return { capacity, bookingLodgeWhere };
  }
  const activeLodges = await prisma.lodge.findMany({
    where: { active: true },
    select: { id: true },
  });
  if (activeLodges.length === 0) {
    return { capacity: await getDefaultLodgeCapacity(), bookingLodgeWhere: {} };
  }
  const capacities = await Promise.all(
    activeLodges.map((lodge) => getLodgeCapacity(lodge.id)),
  );
  return {
    capacity: capacities.reduce((sum, value) => sum + value, 0),
    bookingLodgeWhere: {},
  };
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
  // ONE read of the club's persisted timezone and ONE clock read for this
  // report (#3123). `club-time/server` rather than the CLI-safe reader: nothing
  // outside a React request reaches this module, so the memo is free.
  const forwardWindow = query.forward
    ? normalizeForwardWindow(query.forward, (await clubTime()).today())
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

  const { capacity: lodgeCapacity, bookingLodgeWhere } =
    await resolveMetricsCapacityAndScope(query.lodgeId);
  const bookings =
    activeWindows.length > 0
      ? await prisma.booking.findMany({
          where: {
            ...bookingLodgeWhere,
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
    ? buildRealizedMetrics(
        realizedWindow,
        bookings,
        contributingBookingIds,
        lodgeCapacity,
      )
    : undefined;
  const forward = forwardWindow
    ? buildForwardMetrics(
        forwardWindow,
        bookings,
        contributingBookingIds,
        lodgeCapacity,
      )
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
